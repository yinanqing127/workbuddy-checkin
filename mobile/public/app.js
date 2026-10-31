'use strict';

// 手机端逻辑：凭证只存在本机 localStorage；通过同源 /api/status、/api/checkin 代理完成签到。

const STORE_KEY = 'wb_cred_v1';
const THEME_KEY = 'wb_theme_v1';
const DID_KEY = 'wb_did_v1';

const $ = (id) => document.getElementById(id);

let state = 'idle';

// ---------------- 设备标识 ----------------
// 只用于桌面端「使用统计」按设备去重：本机随机生成、不含任何个人信息，
// 也不会被用来识别用户身份。清空浏览器数据后会变成一台"新设备"。
function randomHex(bytesLen) {
  const bytes = new Uint8Array(bytesLen);
  try {
    (window.crypto || window.msCrypto).getRandomValues(bytes);
  } catch (_) {
    for (let i = 0; i < bytesLen; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getDeviceId() {
  try {
    const saved = localStorage.getItem(DID_KEY);
    if (saved && /^[a-f0-9]{16,32}$/.test(saved)) return saved;
  } catch (_) {}
  const id = randomHex(8);
  try {
    localStorage.setItem(DID_KEY, id);
  } catch (_) {}
  return id;
}

// ---------------- 凭证存取 ----------------

function getCred() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch (_) {
    return null;
  }
}
function setCred(c) {
  localStorage.setItem(STORE_KEY, JSON.stringify(c));
}
function clearCred() {
  localStorage.removeItem(STORE_KEY);
}

// 判断一串文本"看起来像"桌面端导出的凭证码（而不是 token / Cookie / cURL）。
// 用途：当凭证码被截断导致解不开时，能给出"码不完整"的准确提示，
// 而不是把它当成 token 去请求、最后收到 401 被误报成"登录态已过期"。
function looksLikeExportCode(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s || s.length < 16) return false;
  if (/^eyJ/.test(s)) return false; // JWT token
  if (/^curl\b/i.test(s)) return false; // cURL
  if (s.includes('=') && s.includes(';')) return false; // Cookie 字符串
  return /^[A-Za-z0-9+/=_-]+$/.test(s); // base64 / base64url 形态
}

// 解析桌面端导出的 base64 凭证码（容忍微信等转发带入的换行与空格）
function decodeExportCode(code) {
  const cleaned = String(code || '').replace(/\s+/g, '');
  if (!cleaned) throw new Error('凭证码为空');
  let json;
  try {
    json = atob(cleaned.replace(/-/g, '+').replace(/_/g, '/'));
  } catch (_) {
    throw new Error('凭证码不是完整的 base64（可能被截断）');
  }
  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(escape(json)));
  } catch (_) {
    try {
      payload = JSON.parse(json);
    } catch (e2) {
      throw new Error('凭证码内容不完整（JSON 未闭合，通常是被截断）');
    }
  }
  if (!payload || !payload.accessToken) throw new Error('凭证码不含有效凭证');
  return {
    accessToken: String(payload.accessToken || '').trim(),
    uid: String(payload.uid || '').trim(),
    userAgent: String(payload.userAgent || '').trim(),
    domain: String(payload.domain || 'www.codebuddy.cn'),
    expectedLen: payload.tokenLen != null ? Number(payload.tokenLen) : null,
  };
}

// 支持直接粘 cURL / Bearer token / Cookie
function extractFromCurl(text) {
  const m =
    text.match(/-b\s+'([^']*)'/s) ||
    text.match(/-b\s+"([^"]*)"/s) ||
    text.match(/-H\s+'cookie:\s*([^']*)'/is) ||
    text.match(/-H\s+"cookie:\s*([^"]*)"/is);
  if (m && m[1]) return m[1].trim();
  const a =
    text.match(/-H\s+'authorization:\s*(?:bearer\s+)?([^']*)'/is) ||
    text.match(/-H\s+"authorization:\s*(?:bearer\s+)?([^"]*)"/is);
  if (a && a[1]) return a[1].trim();
  return null;
}
function extractUserAgent(text) {
  const m =
    text.match(/-H\s+'user-agent:\s*([^']*)'/is) ||
    text.match(/-H\s+"user-agent:\s*([^"]*)"/is) ||
    text.match(/-A\s+'([^']*)'/s) ||
    text.match(/-A\s+"([^"]*)"/s);
  return m && m[1] ? m[1].trim() : '';
}
function normalizeToken(raw) {
  let t = String(raw || '').trim();
  if (/^curl\b/i.test(t) || /(^|\s)-b\s+['"]/.test(t) || /-H\s+['"]cookie:/i.test(t)) {
    const ex = extractFromCurl(t);
    if (ex) return ex;
  }
  t = t.replace(/^["'`]|["'`]$/g, '').trim();
  t = t.replace(/^authorization\s*:\s*/i, '').trim();
  t = t.replace(/^bearer\s+/i, '').trim();
  t = t.replace(/^cookie\s*:\s*/i, '').trim();
  return t;
}
function normalizeUid(raw) {
  let u = String(raw || '').trim();
  u = u.replace(/^["'`]|["'`]$/g, '').trim();
  u = u.replace(/^x-user-id\s*:\s*/i, '').trim();
  return u;
}

// ---------------- 状态机 ----------------

function setStats(stats) {
  if (!stats) return;
  $('streak').textContent = stats.streak_days != null ? stats.streak_days : '--';
  $('today').textContent = stats.today_credit != null ? stats.today_credit : '--';
  $('total').textContent = stats.total_credits != null ? stats.total_credits : '--';
}

function setState(s, payload = {}) {
  state = s;
  const btn = $('checkin-btn');
  const msg = $('msg');
  btn.className = 'btn';
  btn.disabled = false;
  msg.className = 'msg';
  msg.textContent = '';

  switch (s) {
    case 'loading':
      btn.disabled = true;
      btn.textContent = '签到中…';
      break;
    case 'success':
      btn.textContent = '签到成功 ✓';
      btn.classList.add('success');
      btn.disabled = true;
      msg.textContent = payload.message || '签到成功';
      msg.classList.add('ok');
      break;
    case 'already':
      btn.textContent = '今日已签 ✓';
      btn.classList.add('already');
      btn.disabled = true;
      msg.textContent = payload.message || '今天已经签到啦';
      msg.classList.add('ok');
      break;
    case 'error':
      btn.textContent = '签到失败';
      btn.classList.add('error');
      msg.textContent = payload.message || '出错了，请重试';
      msg.classList.add('err');
      break;
    case 'need_token':
      btn.textContent = '请先配置凭证';
      btn.disabled = true;
      msg.textContent = payload.message || '尚未配置登录凭证，点下方「登录凭证」填写';
      msg.classList.add('err');
      break;
    default:
      btn.textContent = '立即签到';
      if (payload.message) msg.textContent = payload.message;
  }
  if (payload.stats) setStats(payload.stats);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------- 网络 ----------------

// 线上部署要求所有请求带上 sharecode，否则网关会直接返回 403（HTML）。
// 相对路径的 fetch 不会继承地址栏的查询参数，所以必须手动补上。
// 若从主屏幕打开导致取不到，则回退到首次访问时记下的值。
const SHARE = (function () {
  let s = '';
  try {
    s = new URLSearchParams(location.search).get('sharecode') || '';
  } catch (_) {}
  if (s) {
    try {
      localStorage.setItem('wb_share_v1', s);
    } catch (_) {}
    return s;
  }
  try {
    return localStorage.getItem('wb_share_v1') || '';
  } catch (_) {
    return '';
  }
})();

function apiUrl(path) {
  if (!SHARE) return path;
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + encodeURIComponent(SHARE);
}

async function postJson(path, payload) {
  const r = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {}
  if (!data) {
    if (r.status === 403) {
      throw new Error('访问链接不完整（缺少 sharecode 参数），请从分享链接重新打开本页，或删除主屏幕图标后重新添加');
    }
    throw new Error(`服务返回异常（HTTP ${r.status}），请检查网络后重试`);
  }
  return data;
}

async function api(path, cred) {
  // 带上设备标识：服务端据此统计"哪些设备在用、最近有没有签到成功"
  return postJson(path, { ...cred, did: getDeviceId() });
}

async function refreshStatus() {
  const cred = getCred();
  if (!cred || !cred.accessToken) {
    setState('need_token');
    return;
  }
  try {
    const res = await api('/api/status', cred);
    if (res.action === 'already') {
      setState('already', { message: `今天已签到（连续 ${res.streak_days != null ? res.streak_days : 0} 天）`, stats: res });
    } else if (res.action === 'idle') {
      setState('idle', { stats: res });
    } else if (res.action === 'token_expired') {
      setState('need_token', { message: '登录态无效或已过期。若刚粘贴过凭证码，请点「登录凭证」确认粘贴的是完整内容' });
    } else if (res.action === 'need_token') {
      setState('need_token');
    } else {
      setState('error', { message: res.message || '状态查询失败' });
    }
  } catch (e) {
    setState('error', { message: `状态查询失败：${e.message}` });
  }
}

async function doCheckin() {
  const cred = getCred();
  if (!cred || !cred.accessToken) {
    setState('need_token');
    return;
  }
  setState('loading');
  try {
    const res = await api('/api/checkin', cred);
    switch (res.action) {
      case 'ok':
        setState('success', { message: res.message, stats: res });
        break;
      case 'already':
        setState('already', { message: res.message, stats: res });
        break;
      case 'token_expired':
        setState('need_token', { message: '登录态无效或已过期。若刚粘贴过凭证码，请确认粘贴内容完整' });
        break;
      case 'need_token':
        setState('need_token');
        break;
      default:
        setState('error', { message: res.message || '未知错误' });
    }
  } catch (e) {
    setState('error', { message: `请求失败：${e.message}` });
  }
}

// ---------------- 配对码同步 ----------------

function pairHint(text, isErr) {
  const el = $('pair-hint');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'save-hint' + (isErr ? ' err' : '');
}

const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// 用配对码在本地派生密钥并解密（密钥只在手机端算出，服务端无法解开）
async function decryptPair(code, blob) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(blob.salt), iterations: 100000, hash: 'SHA-256' },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(blob.iv) }, key, b64ToBytes(blob.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function claimPair() {
  const code = String($('pair-input').value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  $('pair-input').value = code;
  if (code.length !== 8) {
    pairHint('请输入 8 位配对码（字母或数字）', true);
    return;
  }
  if (!(window.crypto && window.crypto.subtle)) {
    pairHint('当前环境不支持本地解密（需用 https 打开页面），请改用下面的粘贴方式', true);
    return;
  }
  pairHint('正在取回…');
  try {
    const j = await postJson('/api/pair/claim', { code, did: getDeviceId() });
    if (!j || !j.ok) {
      pairHint((j && j.error) || '取回失败，请重试', true);
      return;
    }
    let p;
    try {
      p = await decryptPair(code, j);
    } catch (_) {
      pairHint('解密失败：配对码可能输错，或已在其它设备领取过（只能领一次）', true);
      return;
    }
    if (!p.accessToken) {
      pairHint('解密结果缺少凭证，请在桌面端重新生成配对码', true);
      return;
    }
    setCred({
      accessToken: String(p.accessToken).trim(),
      uid: String(p.uid || '').trim(),
      userAgent: String(p.userAgent || '').trim(),
      domain: String(p.domain || 'www.codebuddy.cn'),
    });
    $('cred-input').value = '';
    $('uid-input').value = String(p.uid || '');
    $('domain-input').value = String(p.domain || 'www.codebuddy.cn');
    pairHint('已取回凭证，正在验证…');
    const v = await verifyCred();
    if (v === 'ok') {
      pairHint('');
      hideCred();
      credHint('');
      await refreshStatus();
    } else {
      pairHint(v === 'expired' ? '凭证已取回但已失效，请在桌面端重新登录后再生成配对码' : '验证未通过：' + v, true);
    }
  } catch (e) {
    pairHint('取回失败：' + e.message, true);
  }
}

// ---------------- 主题 ----------------

function applyTheme(t) {
  let resolved = t || 'system';
  if (resolved === 'system') {
    try {
      resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      resolved = 'light';
    }
  }
  document.documentElement.setAttribute('data-theme', resolved);
  try {
    localStorage.setItem(THEME_KEY, t || 'system');
  } catch (_) {}
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// ---------------- 事件 ----------------

function showCred() {
  $('credential-panel').classList.remove('hidden');
}
function hideCred() {
  $('credential-panel').classList.add('hidden');
}

function credHint(text, isErr) {
  const el = $('cred-hint');
  el.textContent = text || '';
  el.className = 'save-hint' + (isErr ? ' err' : '');
}

async function saveCred() {
  const raw = $('cred-input').value;
  let accessToken, uid, userAgent, domain;

  let decoded = null;
  let decodeErr = null;
  try {
    decoded = decodeExportCode(raw);
  } catch (e) {
    decodeErr = e;
  }

  if (decoded) {
    accessToken = decoded.accessToken;
    uid = decoded.uid;
    userAgent = decoded.userAgent;
    domain = decoded.domain;
    $('domain-input').value = domain;
    // 桌面端若带了原始长度，可校验是否在转发中被截断
    if (decoded.expectedLen && accessToken.length !== decoded.expectedLen) {
      credHint(
        `凭证码不完整（应为 ${decoded.expectedLen} 字符，实际 ${accessToken.length}）。请回到桌面端重新点「导出凭证码」，复制完整内容再粘贴。`,
        true
      );
      return;
    }
  } else if (looksLikeExportCode(raw)) {
    // 形态像凭证码却解不开 → 几乎一定是复制/转发时被截断，不能再降级成 token 去猜
    credHint(
      '凭证码不完整：' + (decodeErr ? decodeErr.message : '无法解析') +
        '。请回到桌面端「设置 → 手机端同步 → 导出凭证码」重新复制完整内容（微信转发容易被截断，建议直接长按复制或改用文件传输）。',
      true
    );
    return;
  } else {
    // 退化为直接粘 token / Cookie / cURL
    accessToken = normalizeToken(raw);
    uid = normalizeUid($('uid-input').value);
    userAgent = extractUserAgent(raw);
    domain = $('domain-input').value.trim() || 'www.codebuddy.cn';
  }

  if (!accessToken || accessToken.length < 8) {
    credHint('无法识别凭证：请粘贴桌面端导出的凭证码，或完整的 token / Cookie / cURL', true);
    return;
  }

  setCred({ accessToken, uid, userAgent, domain });
  credHint('凭证已保存，正在验证…');
  // 先验证再收起面板：验证不过就把面板留在原地，方便直接改，不必反复开关
  const r = await verifyCred();
  if (r === 'ok') {
    hideCred();
    credHint('');
    await refreshStatus();
  } else {
    credHint(
      r === 'expired'
        ? '凭证无效或已过期。请确认粘贴的是完整凭证码；若确认完整，则需要在桌面端重新登录后再次导出。'
        : '验证失败：' + (r || '网络异常') + '，可稍后点「刷新状态」重试。',
      true
    );
  }
}

// 保存后立即验证一次，返回 'ok' / 'expired' / 错误文本
async function verifyCred() {
  const cred = getCred();
  if (!cred || !cred.accessToken) return 'no_cred';
  try {
    const res = await api('/api/status', cred);
    if (res.action === 'token_expired' || res.action === 'need_token') return 'expired';
    if (res.action === 'already' || res.action === 'idle') return 'ok';
    return res.message || 'unknown';
  } catch (e) {
    return e.message;
  }
}

$('checkin-btn').addEventListener('click', doCheckin);
$('refresh-btn').addEventListener('click', refreshStatus);
$('credential-btn').addEventListener('click', showCred);
$('close-credential').addEventListener('click', hideCred);
$('save-cred-btn').addEventListener('click', saveCred);
if ($('pair-btn')) $('pair-btn').addEventListener('click', claimPair);
if ($('pair-input')) {
  $('pair-input').addEventListener('input', (e) => {
    e.target.value = String(e.target.value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
  });
  $('pair-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') claimPair();
  });
}
$('theme-btn').addEventListener('click', toggleTheme);

// 启动
(async () => {
  applyTheme((function () { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (_) { return 'system'; } })());
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').addEventListener) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      try {
        if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme('system');
      } catch (_) {}
    });
  }
  const cred = getCred();
  if (!cred || !cred.accessToken) {
    setState('need_token', { message: '首次使用：点「登录凭证」粘贴桌面端的导出码即可' });
    showCred();
  } else {
    setState('idle');
    await refreshStatus();
  }
  // 注册 Service Worker 以支持"添加到主屏幕"的离线壳
  if ('serviceWorker' in navigator) {
    try {
      // 带上 sharecode，避免被网关拦成 403 导致离线壳注册失败
      navigator.serviceWorker.register(apiUrl('sw.js'));
    } catch (_) {}
  }
})();
