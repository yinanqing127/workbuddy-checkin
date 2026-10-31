'use strict';

// 配置读写 + 本地 API 服务器（仅主进程 / 测试加载，依赖 electron）。

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { runCheckin, fetchStatus } = require('./checkin');

const DEFAULT_DOMAIN = 'www.codebuddy.cn';
const DEFAULT_CHECKIN_TIME = '09:00';

// 手机端已发布地址（配对码同步要用它当中转）。可用环境变量覆盖。
const MOBILE_BASE = process.env.WB_MOBILE_BASE || 'https://your-app.example.com';
const MOBILE_SHARE = process.env.WB_MOBILE_SHARE || 'YOUR_SHARECODE';

// 配对码字符集：去掉 0/O/1/I/L 等易混字符，8 位约 8.5e11 种组合
const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function genPairCode(len = 8) {
  let out = '';
  while (out.length < len) {
    const buf = crypto.randomBytes(len * 2);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      // 拒绝采样，避免取模偏置
      if (buf[i] < 248) out += PAIR_ALPHABET[buf[i] % PAIR_ALPHABET.length];
    }
  }
  return out;
}

// 用配对码派生 AES-256-GCM 密钥加密凭证：服务端只拿到密文，配对码本身也不外发。
function pairEncrypt(code, plaintext) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(code, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // WebCrypto 的 GCM 也是 ct||tag，格式一致
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: Buffer.concat([enc, tag]).toString('base64'),
  };
}

function httpRequestJson(fullUrl, { method = 'GET', body = null, timeoutMs = 10000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(fullUrl);
    } catch (e) {
      reject(new Error('地址无效'));
      return;
    }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : JSON.stringify(body);
    const hdrs = { ...headers };
    if (payload) {
      hdrs['Content-Type'] = 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = mod.request(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers: hdrs },
      (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (s += c));
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(s);
          } catch (_) {}
          resolve({ status: res.statusCode, data: j, raw: s });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

function httpsPostJson(fullUrl, obj, timeoutMs = 10000) {
  return httpRequestJson(fullUrl, { method: 'POST', body: obj, timeoutMs });
}

function getConfigPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'config.json');
}

/** 把 'H:M' / 'HH:MM' 规范成 'HH:MM'，非法值回落到默认 09:00 */
function normalizeTime(value) {
  const s = String(value == null ? '' : value).trim();
  const m = s.match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
  if (!m) return DEFAULT_CHECKIN_TIME;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) {
    return DEFAULT_CHECKIN_TIME;
  }
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function parseTime(value) {
  const t = normalizeTime(value);
  return { hour: Number(t.slice(0, 2)), minute: Number(t.slice(3, 5)) };
}

const BOOL_KEYS = ['autoLaunch', 'autoCheckin', 'autoRetry', 'closeToTray', 'catchUp', 'desktopNotify'];
const USAGE_KEYS = ['pairCreated', 'exportCount', 'importCount'];

// ownerId：本机的"统计主体"随机标识（32 位 hex）。桌面端生成配对码时随码一起上传，
// 手机端服务据此把"谁领了码、之后有没有签到"归到这台电脑名下；不含任何个人信息。
function normOwnerId(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(s) ? s : '';
}

function normUsage(v) {
  const out = {};
  for (const k of USAGE_KEYS) {
    const n = Number(v && v[k]);
    out[k] = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1e9) : 0;
  }
  return out;
}

// desktopNotify：定时/补签成功、凭证过期时是否弹 Windows 原生通知（默认开）
// maxRetries：自动签到失败后的最大重试次数（仅当 autoRetry 开启时生效，1~5，默认 3）
// theme：'system' | 'light' | 'dark'，控制界面深浅色（默认跟随系统）
function normMaxRetries(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.floor(n)));
}
function normTheme(v) {
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** 完整默认配置（新增字段集中在这里，便于向后兼容旧 config.json） */
function defaultConfig() {
  return {
    domain: DEFAULT_DOMAIN,
    accessToken: '',
    uid: '',
    userAgent: '',
    autoLaunch: false, // 开机自启（写入系统登录项）
    autoCheckin: true, // 自动签到总开关
    checkinTime: DEFAULT_CHECKIN_TIME, // 自定义自动签到时间
    autoRetry: true, // 自动签到失败后是否自动重试
    closeToTray: true, // 关闭窗口时最小化到托盘（而不是退出）
    catchUp: true, // 错过时间点（如当时关机）后，启动时补签当天
    desktopNotify: true, // 定时/补签结果、凭证过期时弹系统通知
    maxRetries: 3, // 自动签到失败重试次数（autoRetry 开启时生效）
    theme: 'system', // 界面主题：跟随系统 / 浅色 / 深色
    ownerId: '', // 统计主体标识（首次生成配对码时创建）
    usage: { pairCreated: 0, exportCount: 0, importCount: 0 }, // 本机用量计数
  };
}

function loadConfig(configPath) {
  configPath = configPath || getConfigPath();
  const base = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const c = { ...base, ...raw };
    // 规范化：任何缺失/非法值都回落到安全默认，避免坏配置把程序带崩
    if (!c.domain) c.domain = DEFAULT_DOMAIN;
    if (typeof c.accessToken !== 'string') c.accessToken = '';
    if (typeof c.uid !== 'string') c.uid = '';
    if (typeof c.userAgent !== 'string') c.userAgent = '';
    for (const k of BOOL_KEYS) c[k] = !!c[k];
    c.checkinTime = normalizeTime(c.checkinTime);
    c.ownerId = normOwnerId(c.ownerId);
    c.usage = normUsage(c.usage);
    return c;
  } catch (_) {
    return base;
  }
}

/**
 * 保存配置：**局部合并**语义。
 * 只有传入对象里出现（且不为 undefined）的字段才会被覆盖，其余保持原值。
 * 这样"保存设置"绝不会把已保存的 accessToken / uid / userAgent 清空。
 */
function saveConfig(cfg, configPath) {
  configPath = configPath || getConfigPath();
  const prev = loadConfig(configPath);
  const next = { ...prev };
  if (cfg && typeof cfg === 'object') {
    if (cfg.domain !== undefined) next.domain = String(cfg.domain || DEFAULT_DOMAIN).trim() || DEFAULT_DOMAIN;
    if (cfg.accessToken !== undefined) next.accessToken = String(cfg.accessToken || '');
    if (cfg.uid !== undefined) next.uid = String(cfg.uid || '');
    if (cfg.userAgent !== undefined) next.userAgent = String(cfg.userAgent || '');
    for (const k of BOOL_KEYS) {
      if (cfg[k] !== undefined) next[k] = !!cfg[k];
    }
    if (cfg.maxRetries !== undefined) next.maxRetries = normMaxRetries(cfg.maxRetries);
    if (cfg.theme !== undefined) next.theme = normTheme(cfg.theme);
    if (cfg.checkinTime !== undefined) next.checkinTime = normalizeTime(cfg.checkinTime);
    if (cfg.ownerId !== undefined) next.ownerId = normOwnerId(cfg.ownerId);
    if (cfg.usage !== undefined) next.usage = normUsage({ ...normUsage(next.usage), ...(cfg.usage || {}) });
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
  return next;
}

/** 确保存在"统计主体"ID：只在缺失时生成一次并落盘，不触碰凭证与其它设置 */
function ensureOwnerId(configPath) {
  const cfg = loadConfig(configPath);
  if (cfg.ownerId) return cfg.ownerId;
  const ownerId = crypto.randomBytes(16).toString('hex');
  saveConfig({ ownerId }, configPath);
  return ownerId;
}

/** 本机用量计数 +1（局部写盘，不动 token / 设置） */
function bumpUsage(configPath, key, delta = 1) {
  if (!USAGE_KEYS.includes(key)) return null;
  const cfg = loadConfig(configPath);
  const usage = { ...normUsage(cfg.usage) };
  usage[key] = Math.max(0, Math.floor((usage[key] || 0) + delta));
  saveConfig({ usage }, configPath);
  return usage;
}

// 将配置中的 autoLaunch 应用到操作系统登录项（开机自启）。
// openAtLogin=true 时以 --hidden 启动，仅留在托盘，不弹窗；false 时移除登录项。
function applyAutoLaunch(enabled) {
  try {
    const { app } = require('electron');
    if (!app || typeof app.setLoginItemSettings !== 'function') return false;
    // 开发模式（electron .）：execPath 是 electron.exe，必须额外给出应用目录，Electron 才知道加载谁；
    // 安装版（打包态）：execPath 就是最终的 exe，只需传 --hidden 表示静默启动，不能再传目录参数。
    const args = enabled ? (app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']) : [];
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(s);
}

// ---------------- 运行日志 ----------------

function logFilePath(configPath) {
  return path.join(path.dirname(configPath), 'checkin-log.jsonl');
}

const ACTION_LABEL = {
  ok: '签到成功',
  already: '今日已签',
  token_expired: '凭证已过期',
  need_token: '未配置凭证',
  error: '失败',
};

function readLogs(configPath, limit) {
  const file = logFilePath(configPath);
  let items = [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    items = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    items = [];
  }
  const total = items.length;
  // 新的在前，便于界面直接展示
  items.reverse();
  if (limit > 0) items = items.slice(0, limit);
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(file).size;
  } catch (_) {}
  return {
    items: items.map((it) => ({ ...it, label: ACTION_LABEL[it.action] || it.action || '事件' })),
    total,
    sizeBytes,
    path: file,
  };
}

/** 从日志汇总统计：上次签到时间、本月签到天数 */
function computeStats(configPath, cfg) {
  const { items } = readLogs(configPath, 0);
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  let lastCheckin = null;
  let lastResult = null;
  const days = new Set();
  // items 已是最新在前
  for (const it of items) {
    const d = it.ts ? new Date(it.ts) : null;
    if (!d || isNaN(d.getTime())) continue;
    if (!lastResult && (it.action === 'ok' || it.action === 'already' || it.action === 'error')) {
      lastResult = it;
    }
    if (it.action === 'already') {
      // 已签也说明当天确实有签到记录，但为了"本月签到天数"更准确，只统计 ok 与 already 的当天
    }
    if (it.action === 'ok' || it.action === 'already') {
      if (!lastCheckin) lastCheckin = it.ts;
      if (d.getFullYear() === y && d.getMonth() === mo) {
        days.add(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
      }
    }
  }
  const next = computeNextRun(cfg);
  return {
    lastCheckin: lastCheckin,
    lastResult: lastResult
      ? { action: lastResult.action, ts: lastResult.ts, message: lastResult.message || '' }
      : null,
    monthDays: days.size,
    nextRunAt: next ? next.toISOString() : null,
  };
}

/** 计算下一次自动签到时间；未开启自动签到时返回 null */
function computeNextRun(cfg, now) {
  if (!cfg || !cfg.autoCheckin) return null;
  now = now || new Date();
  const { hour, minute } = parseTime(cfg.checkinTime);
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

// ---------------- 本地 API ----------------

/**
 * 创建本地 API 服务，渲染进程通过 fetch 调用。
 * @param {object} opts
 * @param {number} [opts.port=3000]
 * @param {string} [opts.configPath]
 * @param {(result:object)=>void} [opts.onCheckinResult] 每次签到后回调（用于写日志）
 * @param {()=>void} [opts.onSettingsChanged] 设置变更后回调（主进程重排调度）
 */
function createApiServer({ port = 3000, configPath, onCheckinResult, onSettingsChanged } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const fullUrl = req.url || '';
        const [url, qs] = fullUrl.split('?');
        const query = new URLSearchParams(qs || '');

        if (req.method === 'GET' && url === '/api/config') {
          const cfg = loadConfig(configPath);
          sendJson(res, 200, { domain: cfg.domain, hasToken: !!cfg.accessToken });
          return;
        }
        if (req.method === 'POST' && url === '/api/saveConfig') {
          const data = body ? JSON.parse(body) : {};
          saveConfig(data, configPath);
          if (onSettingsChanged) onSettingsChanged();
          sendJson(res, 200, { ok: true });
          return;
        }

        // ---- 配对码同步（推荐给手机用）----
        // 凭证码有 8000+ 字符，手机上粘贴极易被截断（截断后表现为"登录态已过期"）。
        // 这里改成：桌面端生成 8 位配对码 → 加密上传到手机端服务的临时存储（10 分钟、一次性）
        // → 手机只输 8 个字符就能取回并本地解密。服务端既无明文也无配对码原文。
        if (req.method === 'POST' && url === '/api/pair-create') {
          const cfg = loadConfig(configPath);
          if (!cfg.accessToken) {
            sendJson(res, 400, { ok: false, error: '尚未配置登录凭证，无法生成配对码' });
            return;
          }
          const pairCode = genPairCode();
          // 统计主体：首次生成配对码时创建，之后一直复用（不含任何个人信息）
          let ownerId = '';
          try {
            ownerId = ensureOwnerId(configPath);
          } catch (_) {}
          const payload = JSON.stringify({
            domain: cfg.domain || DEFAULT_DOMAIN,
            accessToken: cfg.accessToken,
            uid: cfg.uid || '',
            userAgent: cfg.userAgent || '',
          });
          const enc = pairEncrypt(pairCode, payload);
          // 只上传"首 2 + 尾 2"的掩码用于统计列表展示，绝不上传配对码原文
          const mask = `${pairCode.slice(0, 2)}••••${pairCode.slice(-2)}`;
          try {
            const r = await httpsPostJson(
              `${MOBILE_BASE}/api/pair/publish?sharecode=${encodeURIComponent(MOBILE_SHARE)}`,
              { code: pairCode, owner: ownerId, mask, ...enc }
            );
            if (!r.data || !r.data.ok) {
              sendJson(res, 502, {
                ok: false,
                error: (r.data && r.data.error) || `上传失败（HTTP ${r.status}），请检查网络`,
              });
              return;
            }
            try {
              bumpUsage(configPath, 'pairCreated');
            } catch (_) {}
            sendJson(res, 200, {
              ok: true,
              code: pairCode,
              expiresIn: r.data.expiresIn || 600,
              mobileUrl: `${MOBILE_BASE}/?sharecode=${encodeURIComponent(MOBILE_SHARE)}`,
            });
          } catch (e) {
            sendJson(res, 502, { ok: false, error: `连接手机端服务失败：${e.message}` });
          }
          return;
        }

        // ---- 配置导出 / 导入：用于把桌面端凭证同步到手机端 PWA ----
        // 导出：返回一段 base64 文本（含 token/uid/UA/domain），用户在桌面端复制后发到手机，
        // 在手机端"导入"即可，无需重新抓包。采用局部合并，绝不覆盖已保存的其它设置。
        if (req.method === 'POST' && url === '/api/export') {
          const cfg = loadConfig(configPath);
          const payload = {
            v: 1,
            domain: cfg.domain || DEFAULT_DOMAIN,
            accessToken: cfg.accessToken || '',
            uid: cfg.uid || '',
            userAgent: cfg.userAgent || '',
          };
          const code = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
          try {
            bumpUsage(configPath, 'exportCount');
          } catch (_) {}
          sendJson(res, 200, { ok: true, hasToken: !!cfg.accessToken, code });
          return;
        }
        if (req.method === 'POST' && url === '/api/import') {
          const data = body ? JSON.parse(body) : {};
          const code = String(data && data.code ? data.code : '').trim();
          if (!code) {
            sendJson(res, 400, { ok: false, error: '缺少导入码' });
            return;
          }
          let payload;
          try {
            payload = JSON.parse(Buffer.from(code, 'base64').toString('utf8'));
          } catch (_) {
            sendJson(res, 400, { ok: false, error: '导入码无效或已损坏' });
            return;
          }
          if (!payload || typeof payload !== 'object' || !payload.accessToken) {
            sendJson(res, 400, { ok: false, error: '导入码不含有效凭证' });
            return;
          }
          saveConfig(
            {
              domain: payload.domain || DEFAULT_DOMAIN,
              accessToken: String(payload.accessToken || ''),
              uid: String(payload.uid || ''),
              userAgent: String(payload.userAgent || ''),
            },
            configPath
          );
          if (onSettingsChanged) onSettingsChanged();
          try {
            bumpUsage(configPath, 'importCount');
          } catch (_) {}
          sendJson(res, 200, { ok: true, hasToken: true });
          return;
        }

        // ---- 使用统计：向手机端服务查询"有多少设备用我的配对码取过凭证、之后用没用" ----
        // 服务端只认 ownerId（本机随机 32 位 hex），不传也不回任何凭证内容。
        if (req.method === 'GET' && url === '/api/usage-stats') {
          const cfg = loadConfig(configPath);
          let ownerId = cfg.ownerId || '';
          if (!ownerId) {
            try {
              ownerId = ensureOwnerId(configPath);
            } catch (_) {}
          }
          const local = {
            ownerIdShort: ownerId ? ownerId.slice(-6) : '',
            pairCreated: (cfg.usage && cfg.usage.pairCreated) || 0,
            exportCount: (cfg.usage && cfg.usage.exportCount) || 0,
            importCount: (cfg.usage && cfg.usage.importCount) || 0,
            hasToken: !!cfg.accessToken,
            mobileUrl: `${MOBILE_BASE}/?sharecode=${encodeURIComponent(MOBILE_SHARE)}`,
          };
          if (!ownerId) {
            sendJson(res, 200, { ok: false, local, remote: null, error: '无法生成统计标识（配置目录不可写）' });
            return;
          }
          try {
            const r = await httpRequestJson(
              `${MOBILE_BASE}/api/pair/stats?owner=${encodeURIComponent(ownerId)}&sharecode=${encodeURIComponent(
                MOBILE_SHARE
              )}`,
              { timeoutMs: 7000 }
            );
            if (r.status === 404 || r.status === 405) {
              sendJson(res, 200, {
                ok: false,
                local,
                remote: null,
                error: '手机端服务还是旧版本（无统计接口），重新发布一次 mobile/ 目录即可',
              });
              return;
            }
            if (!r.data || !r.data.ok) {
              sendJson(res, 200, {
                ok: false,
                local,
                remote: null,
                error: (r.data && r.data.error) || `统计接口异常（HTTP ${r.status}）`,
              });
              return;
            }
            sendJson(res, 200, { ok: true, local, remote: r.data });
          } catch (e) {
            sendJson(res, 200, { ok: false, local, remote: null, error: `连接手机端服务失败：${e.message}` });
          }
          return;
        }

        // ---- 设置（只处理偏好项，绝不读写 token，也不会清空已保存的凭证）----
        if (req.method === 'GET' && url === '/api/settings') {
          const cfg = loadConfig(configPath);
          sendJson(res, 200, {
            autoCheckin: cfg.autoCheckin,
            checkinTime: cfg.checkinTime,
            autoLaunch: cfg.autoLaunch,
            autoRetry: cfg.autoRetry,
            closeToTray: cfg.closeToTray,
            catchUp: cfg.catchUp,
            desktopNotify: cfg.desktopNotify,
            maxRetries: cfg.maxRetries,
            theme: cfg.theme,
            // 只告诉界面"是否已配置"，不返回、也不索取明文凭证
            hasToken: !!cfg.accessToken,
            nextRunAt: (computeNextRun(cfg) || null) ? computeNextRun(cfg).toISOString() : null,
          });
          return;
        }
        if (req.method === 'POST' && url === '/api/settings') {
          const data = body ? JSON.parse(body) : {};
          const patch = {};
          if (data.autoCheckin !== undefined) patch.autoCheckin = !!data.autoCheckin;
          if (data.autoRetry !== undefined) patch.autoRetry = !!data.autoRetry;
          if (data.closeToTray !== undefined) patch.closeToTray = !!data.closeToTray;
          if (data.catchUp !== undefined) patch.catchUp = !!data.catchUp;
          if (data.desktopNotify !== undefined) patch.desktopNotify = !!data.desktopNotify;
          if (data.maxRetries !== undefined) patch.maxRetries = normMaxRetries(data.maxRetries);
          if (data.theme !== undefined) patch.theme = normTheme(data.theme);
          if (data.checkinTime !== undefined) {
            const before = String(data.checkinTime);
            const normalized = normalizeTime(before);
            // 明确给了非法时间就报错，而不是悄悄改成默认值
            if (normalized !== before && !/^\d{1,2}\s*[:：]\s*\d{1,2}$/.test(before)) {
              sendJson(res, 400, { ok: false, error: '时间格式应为 HH:MM' });
              return;
            }
            patch.checkinTime = normalized;
          }
          const cfg = saveConfig(patch, configPath);
          let applied = null;
          if (data.autoLaunch !== undefined) {
            cfg.autoLaunch = !!data.autoLaunch;
            saveConfig({ autoLaunch: cfg.autoLaunch }, configPath);
            applied = applyAutoLaunch(cfg.autoLaunch);
          }
          if (onSettingsChanged) onSettingsChanged();
          sendJson(res, 200, {
            ok: true,
            applied,
            settings: {
              autoCheckin: cfg.autoCheckin,
              checkinTime: cfg.checkinTime,
              autoLaunch: cfg.autoLaunch,
              autoRetry: cfg.autoRetry,
              closeToTray: cfg.closeToTray,
              catchUp: cfg.catchUp,
              desktopNotify: cfg.desktopNotify,
              maxRetries: cfg.maxRetries,
              theme: cfg.theme,
              nextRunAt: (computeNextRun(cfg) || null) ? computeNextRun(cfg).toISOString() : null,
            },
          });
          return;
        }

        // 兼容旧接口（开机自启单独开关）
        if (req.method === 'GET' && url === '/api/autoLaunch') {
          const cfg = loadConfig(configPath);
          sendJson(res, 200, { autoLaunch: !!cfg.autoLaunch });
          return;
        }
        if (req.method === 'POST' && url === '/api/autoLaunch') {
          const data = body ? JSON.parse(body) : {};
          const enabled = !!data.enabled;
          saveConfig({ autoLaunch: enabled }, configPath);
          const applied = applyAutoLaunch(enabled);
          if (onSettingsChanged) onSettingsChanged();
          sendJson(res, 200, { ok: true, autoLaunch: enabled, applied });
          return;
        }

        // ---- 运行日志 ----
        if (req.method === 'GET' && url === '/api/logs') {
          const limit = Number(query.get('limit') || 50);
          sendJson(res, 200, readLogs(configPath, Number.isFinite(limit) && limit > 0 ? limit : 50));
          return;
        }
        if (req.method === 'POST' && url === '/api/logs/clear') {
          const file = logFilePath(configPath);
          try {
            fs.writeFileSync(file, '');
          } catch (_) {}
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && url === '/api/openLogFolder') {
          let ok = false;
          try {
            const { shell } = require('electron');
            const file = logFilePath(configPath);
            if (fs.existsSync(file)) shell.showItemInFolder(file);
            else shell.openPath(path.dirname(file));
            ok = true;
          } catch (_) {}
          sendJson(res, 200, { ok });
          return;
        }

        // ---- 汇总统计（界面上"上次签到 / 本月已签"用）----
        if (req.method === 'GET' && url === '/api/summary') {
          const cfg = loadConfig(configPath);
          sendJson(res, 200, computeStats(configPath, cfg));
          return;
        }

        if (req.method === 'POST' && url === '/api/status') {
          const cfg = loadConfig(configPath);
          const result = await fetchStatus({
            accessToken: cfg.accessToken,
            uid: cfg.uid,
            domain: cfg.domain,
            userAgent: cfg.userAgent,
          });
          sendJson(res, 200, result);
          return;
        }
        if (req.method === 'POST' && url === '/api/checkin') {
          const cfg = loadConfig(configPath);
          const result = await runCheckin({
            accessToken: cfg.accessToken,
            uid: cfg.uid,
            domain: cfg.domain,
            userAgent: cfg.userAgent,
          });
          if (onCheckinResult) {
            try {
              onCheckinResult(result);
            } catch (_) {}
          }
          sendJson(res, 200, result);
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    });
  });
  server.port = port;
  return server;
}

module.exports = {
  loadConfig,
  saveConfig,
  createApiServer,
  getConfigPath,
  applyAutoLaunch,
  normalizeTime,
  parseTime,
  computeNextRun,
  computeStats,
  readLogs,
  logFilePath,
  defaultConfig,
  ensureOwnerId,
  bumpUsage,
  httpRequestJson,
  DEFAULT_CHECKIN_TIME,
};
