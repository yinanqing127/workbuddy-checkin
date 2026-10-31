'use strict';

// 手机端 PWA 服务：托管 public/ 下的静态文件，并提供与桌面端同名的代理接口。
// 关键安全点：
//   1) 代理只允许转发到白名单域名（见 proxy-core ALLOWED_HOSTS），杜绝 SSRF。
//   2) 服务端不保存任何 token；凭证只活在用户手机的 localStorage。
//   3) 按来源 IP 做简单限速，避免被拿来刷接口。
//   4) 限制请求体大小，拒绝非法/超大输入。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runCheckin, fetchStatus, ALLOWED_HOSTS } = require('./src/proxy-core');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_BODY = 64 * 1024; // 64KB 足够装下凭证与 UA
const RATE = { windowMs: 60 * 1000, max: 30 }; // 每 IP 每分钟最多 30 次
const hit = new Map();

// ---- 配对码中转：让"桌面端 → 手机"不必再手动粘 8000 多字符的凭证 ----
// 服务端只保存【已加密】的密文，密钥由用户在桌面端生成、只在手机端用配对码重新算出，
// 服务端既拿不到配对码原文（表里存的是它的 SHA-256），也解不开密文。
const PAIR_TTL = 10 * 60 * 1000; // 10 分钟
const PAIR_MAX_TRY = 10; // 同一 IP 领取失败上限
const PAIR_MAX_CLAIM = 3; // 同一配对码最多可被领取 3 次（容忍手机端解密/网络偶发失败后重试）
const pairs = new Map(); // codeHash -> { salt, iv, data, exp, claims }
let pairFails = new Map();

function pairKey(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function gcPairs() {
  const now = Date.now();
  for (const [k, v] of pairs) if (v.exp < now) pairs.delete(k);
}

// ---- 使用统计 ----
// 只在服务端记"事件级"数据：某台设备用某个配对码取走了凭证、之后有没有签到。
// 绝不保存 token、配对码原文、完整 UA、IP；设备用手机端本地生成的随机 ID 去重。
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data');
const STATS_FILE = path.join(DATA_DIR, 'usage-stats.json');
const MAX_OWNERS = 200; // 最多保留多少个"统计主体"（每台电脑一个）
const MAX_CODES_PER_OWNER = 60;
const MAX_DEVICES_PER_OWNER = 50;

const usage = { version: 1, owners: {} };
const didOwner = new Map(); // 设备 ID -> 统计主体
let usageDirty = false;
let usageTimer = null;
let usageWritable = true;

function normalizeDid(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
}

function normalizeOwner(v) {
  const id = String(v || '').toLowerCase();
  return /^[a-f0-9]{24,64}$/.test(id) ? id : '';
}

function platformOf(ua) {
  const s = String(ua || '');
  if (/Android/i.test(s)) return 'android';
  if (/iPhone|iPad|iPod/i.test(s)) return 'ios';
  if (/Windows/i.test(s)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(s)) return 'mac';
  if (/Linux/i.test(s)) return 'linux';
  return 'other';
}

function browserOf(ua) {
  const s = String(ua || '');
  if (/MicroMessenger/i.test(s)) return '微信';
  if (/Edg\//.test(s)) return 'Edge';
  if (/; wv\)/.test(s)) return 'WebView';
  if (/CriOS|Chrome\//.test(s)) return 'Chrome';
  if (/Firefox\/|FxiOS/.test(s)) return 'Firefox';
  if (/Safari\//.test(s)) return 'Safari';
  return '';
}

function loadUsage() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (raw && raw.owners && typeof raw.owners === 'object') {
      for (const [owner, rec] of Object.entries(raw.owners)) {
        if (!rec || typeof rec !== 'object') continue;
        if (!Array.isArray(rec.codes)) rec.codes = [];
        if (!rec.devices || typeof rec.devices !== 'object') rec.devices = {};
        usage.owners[owner] = rec;
        for (const key of Object.keys(rec.devices)) didOwner.set(key, owner);
      }
    }
  } catch (e) {
    // 文件不存在是常态；只有写权限问题才标记为不可持久化
    if (e && (e.code === 'EACCES' || e.code === 'EROFS' || e.code === 'EPERM')) usageWritable = false;
  }
}

function flushUsage() {
  if (!usageDirty) return;
  usageDirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(usage));
    fs.renameSync(tmp, STATS_FILE);
    usageWritable = true;
  } catch (_) {
    usageWritable = false; // 部署环境磁盘只读时降级为"本次运行期间内存统计"
  }
}

function saveUsageSoon() {
  usageDirty = true;
  if (usageTimer) return;
  usageTimer = setTimeout(() => {
    usageTimer = null;
    flushUsage();
  }, 1500);
  if (usageTimer.unref) usageTimer.unref();
}

function usageOwner(owner) {
  const id = normalizeOwner(owner);
  if (!id) return null;
  let rec = usage.owners[id];
  if (!rec) {
    const keys = Object.keys(usage.owners);
    if (keys.length >= MAX_OWNERS) {
      keys.sort((a, b) => (usage.owners[a].lastAt || 0) - (usage.owners[b].lastAt || 0));
      for (let i = 0; i < keys.length - MAX_OWNERS + 1; i++) delete usage.owners[keys[i]];
    }
    rec = usage.owners[id] = { firstAt: Date.now(), lastAt: Date.now(), codes: [], devices: {} };
  }
  rec.lastAt = Date.now();
  return rec;
}

/** 取/建设备记录；返回 { key, dev } */
function usageDevice(rec, did, ua, ip, ownerId) {
  let key = normalizeDid(did);
  const real = !!key;
  if (!key) {
    // 没带设备 ID（旧版页面）时用 IP+UA 的短哈希兜底，仍然能按"设备"去重
    key = 'x' + crypto.createHash('sha256').update(String(ip || '') + '|' + String(ua || '')).digest('hex').slice(0, 11);
  }
  let dev = rec.devices[key];
  if (!dev) {
    const keys = Object.keys(rec.devices);
    if (keys.length >= MAX_DEVICES_PER_OWNER) {
      keys.sort((a, b) => (rec.devices[a].lastAt || 0) - (rec.devices[b].lastAt || 0));
      delete rec.devices[keys[0]];
    }
    dev = rec.devices[key] = {
      firstAt: Date.now(),
      lastAt: Date.now(),
      claims: 0,
      checkins: 0,
      platform: platformOf(ua),
      browser: browserOf(ua),
    };
  }
  dev.lastAt = Date.now();
  if (ua) {
    dev.platform = platformOf(ua);
    dev.browser = browserOf(ua);
  }
  if (real && ownerId) didOwner.set(key, ownerId);
  return { key, dev };
}

/** 某个配对码被成功领取：计入"领取次数"和对应设备 */
function recordClaim(owner, codeHash, mask, did, ua, ip) {
  const rec = usageOwner(owner);
  if (!rec) return;
  const ownerId = normalizeOwner(owner);
  let item = rec.codes.find((c) => c.h === codeHash);
  if (!item) {
    item = { h: codeHash, mask: String(mask || '').slice(0, 16) || '••••••••', at: Date.now(), claims: 0 };
    rec.codes.push(item);
    if (rec.codes.length > MAX_CODES_PER_OWNER) rec.codes.splice(0, rec.codes.length - MAX_CODES_PER_OWNER);
  }
  item.claims = (item.claims || 0) + 1;
  item.lastClaimAt = Date.now();
  const { dev } = usageDevice(rec, did, ua, ip, ownerId);
  dev.claims = (dev.claims || 0) + 1;
  dev.lastClaimAt = Date.now();
  saveUsageSoon();
}

/** 手机端每次查状态/签到：更新"使用情况"（结果、连续天数、最近活跃） */
function recordActivity(did, ua, ip, result) {
  const key = normalizeDid(did);
  if (!key || !result) return;
  const owner = didOwner.get(key);
  if (!owner) return; // 没通过配对码同步过的设备，不计入统计
  const rec = usage.owners[owner];
  if (!rec) return;
  const { dev } = usageDevice(rec, key, ua, ip, owner);
  dev.lastAt = Date.now();
  dev.lastAction = result.action || '';
  if (result.streak_days != null) dev.streak = result.streak_days;
  if (result.today_credit != null) dev.todayCredit = result.today_credit;
  if (result.action === 'ok' || result.action === 'already') {
    dev.lastResult = result.action;
    dev.lastCheckinAt = Date.now();
    if (result.action === 'ok') dev.checkins = (dev.checkins || 0) + 1;
  } else if (result.action === 'error' || result.action === 'token_expired') {
    dev.lastResult = result.action;
  }
  saveUsageSoon();
}

function buildUsageStats(owner) {
  const id = normalizeOwner(owner);
  if (!id) return null;
  const rec = usage.owners[id];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const devices = rec
    ? Object.entries(rec.devices).map(([key, d]) => ({
        id: key,
        platform: d.platform || 'other',
        browser: d.browser || '',
        firstAt: d.firstAt || 0,
        lastAt: d.lastAt || 0,
        claims: d.claims || 0,
        checkins: d.checkins || 0,
        lastResult: d.lastResult || '',
        lastCheckinAt: d.lastCheckinAt || 0,
        streak: d.streak != null ? d.streak : null,
        todayCredit: d.todayCredit != null ? d.todayCredit : null,
      }))
    : [];
  devices.sort((a, b) => b.lastAt - a.lastAt);
  const codes = rec
    ? rec.codes
        .slice()
        .reverse()
        .map((c) => {
          const live = pairs.get(c.h);
          const status = (c.claims || 0) >= PAIR_MAX_CLAIM ? 'used' : live && live.exp > now ? 'active' : 'expired';
          return {
            mask: c.mask || '••••••••',
            at: c.at || 0,
            claims: c.claims || 0,
            lastClaimAt: c.lastClaimAt || 0,
            status,
          };
        })
    : [];
  return {
    ok: true,
    updatedAt: now,
    totals: {
      devices: devices.length,
      claims: devices.reduce((n, d) => n + d.claims, 0),
      codes: codes.length,
      checkins: devices.reduce((n, d) => n + d.checkins, 0),
      activeToday: devices.filter((d) => now - d.lastAt < DAY).length,
      signedToday: devices.filter((d) => d.lastCheckinAt && now - d.lastCheckinAt < DAY).length,
    },
    devices,
    codes,
    persisted: usageWritable,
  };
}


function rateLimited(ip) {
  const now = Date.now();
  const rec = hit.get(ip) || { count: 0, reset: now + RATE.windowMs };
  if (now > rec.reset) {
    rec.count = 0;
    rec.reset = now + RATE.windowMs;
  }
  rec.count += 1;
  hit.set(ip, rec);
  return rec.count > RATE.max;
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  // 防目录穿越
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 兜底：未知路径回 index.html
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    fs.readFile(filePath, (e, buf) => {
      if (e) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      res.end(buf);
    });
  });
}

function parseCreds(body) {
  const data = typeof body === 'string' && body ? JSON.parse(body) : body || {};
  // 手机端粘贴常带入换行/空格：外层一律裁掉；非 Cookie 形态的 token 连内部空白也去掉
  let accessToken = String(data.accessToken || '').trim();
  if (!(accessToken.includes('=') && accessToken.includes(';'))) {
    accessToken = accessToken.replace(/\s+/g, '');
  }
  accessToken = accessToken.replace(/[\r\n\t]+/g, '');
  const uid = String(data.uid || '').replace(/[\r\n\t]+/g, '').trim();
  const userAgent = String(data.userAgent || '').replace(/[\r\n\t]+/g, ' ').trim();
  const domain = ALLOWED_HOSTS.includes(data.domain) ? data.domain : ALLOWED_HOSTS[0];
  if (!accessToken || accessToken.length < 8) {
    const err = new Error('缺少有效凭证');
    err.code = 400;
    throw err;
  }
  if (accessToken.length > 8192) {
    const err = new Error('凭证过长');
    err.code = 400;
    throw err;
  }
  return { accessToken, uid, userAgent, domain };
}

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const [urlPath, search] = (req.url || '/').split('?');
  const query = new URLSearchParams(search || '');

  // ---- 代理接口（同源，手机端直接 fetch('https://部署地址/api/...')）----
  if (urlPath === '/api/status' || urlPath === '/api/checkin') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (rateLimited(ip)) {
      sendJson(res, 429, { error: '请求过于频繁，请稍后再试' });
      return;
    }
    try {
      const raw = await readBody(req);
      const creds = parseCreds(raw);
      const result = urlPath === '/api/status' ? await fetchStatus(creds) : await runCheckin(creds);
      // 使用情况：这台设备是否真的在签到、结果如何（不记录凭证内容）
      try {
        let did = '';
        try {
          did = JSON.parse(raw).did || '';
        } catch (_) {}
        recordActivity(did, req.headers['user-agent'], ip, result);
      } catch (_) {}
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, e.code === 400 ? 400 : 500, { error: e.message });
    }
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/health') {
    sendJson(res, 200, { ok: true, ts: Date.now() });
    return;
  }

  // ---- 使用统计：桌面端凭 ownerId 读取"有多少设备用过我的配对码/凭证" ----
  if (req.method === 'GET' && urlPath === '/api/pair/stats') {
    if (rateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      return;
    }
    const data = buildUsageStats(query.get('owner'));
    if (!data) {
      sendJson(res, 400, { ok: false, error: '缺少或非法的统计标识' });
      return;
    }
    sendJson(res, 200, data);
    return;
  }

  // ---- 配对码中转：桌面端 publish，手机端 claim ----
  if (req.method === 'POST' && (urlPath === '/api/pair/publish' || urlPath === '/api/pair/claim')) {
    try {
      const raw = await readBody(req);
      const data = raw ? JSON.parse(raw) : {};
      const code = String(data.code || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      if (!/^[A-Z0-9]{8}$/.test(code)) {
        sendJson(res, 400, { ok: false, error: '配对码格式不正确（应为 8 位字母数字）' });
        return;
      }
      const k = pairKey(code);
      gcPairs();

      if (urlPath === '/api/pair/publish') {
        const salt = String(data.salt || '');
        const iv = String(data.iv || '');
        const payload = String(data.data || '');
        if (!salt || !iv || !payload) {
          sendJson(res, 400, { ok: false, error: '缺少加密参数' });
          return;
        }
        if (salt.length > 128 || iv.length > 128 || payload.length > 40000) {
          sendJson(res, 400, { ok: false, error: '数据过大' });
          return;
        }
        const owner = normalizeOwner(data.owner);
        const mask = String(data.mask || '').slice(0, 16);
        pairs.set(k, { salt, iv, data: payload, exp: Date.now() + PAIR_TTL, claims: 0, owner, mask });
        if (owner) {
          // 生成事件也记一笔，便于"生成了几个码、其中几个被用过"的对比
          const rec = usageOwner(owner);
          if (rec && !rec.codes.some((c) => c.h === k)) {
            rec.codes.push({ h: k, mask: mask || '••••••••', at: Date.now(), claims: 0 });
            if (rec.codes.length > MAX_CODES_PER_OWNER) {
              rec.codes.splice(0, rec.codes.length - MAX_CODES_PER_OWNER);
            }
            saveUsageSoon();
          }
        }
        sendJson(res, 200, { ok: true, expiresIn: Math.floor(PAIR_TTL / 1000) });
        return;
      }

      // claim：一次性取出（取出即删），并限制失败次数防暴力猜码
      if (rateLimited(ip)) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
        return;
      }
      const rec = pairFails.get(ip) || { n: 0, reset: Date.now() + PAIR_TTL };
      if (Date.now() > rec.reset) {
        rec.n = 0;
        rec.reset = Date.now() + PAIR_TTL;
      }
      if (rec.n >= PAIR_MAX_TRY) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请在桌面端重新生成配对码' });
        return;
      }
      const found = pairs.get(k);
      if (!found) {
        rec.n += 1;
        pairFails.set(ip, rec);
        sendJson(res, 404, { ok: false, error: '配对码不存在或已过期（有效期 10 分钟），请在电脑端重新生成' });
        return;
      }
      // 允许有限次重复领取：手机端若解密失败/网络中断，不必回电脑端重新生成
      if ((found.claims || 0) >= PAIR_MAX_CLAIM) {
        pairs.delete(k);
        sendJson(res, 404, { ok: false, error: '配对码领取次数已用完，请在电脑端重新生成' });
        return;
      }
      found.claims = (found.claims || 0) + 1;
      // 领取即统计：谁领的（设备）+ 领的哪个码
      try {
        recordClaim(found.owner, k, found.mask, data.did, req.headers['user-agent'], ip);
      } catch (_) {}
      sendJson(res, 200, { ok: true, salt: found.salt, iv: found.iv, data: found.data });
      return;
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
      return;
    }
  }

  // ---- 静态资源 ----
  serveStatic(req, res, urlPath);
});

loadUsage();
// 退出前落盘，避免最后几次领取/签到的统计丢掉
process.on('exit', flushUsage);
process.on('SIGTERM', () => {
  flushUsage();
  process.exit(0);
});
process.on('SIGINT', () => {
  flushUsage();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`[workbuddy-mobile] 手机端服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`[workbuddy-mobile] 统计文件: ${STATS_FILE}${usageWritable ? '' : '（不可写，仅本次运行内存统计）'}`);
});

module.exports = server;
