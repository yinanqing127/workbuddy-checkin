'use strict';

// 渲染进程：状态机 + 退避重试 + 设置/日志/凭证三个互斥面板。仅通过 fetch 调用本地 API。

const BASE = window.api.baseUrl;
const $ = (id) => document.getElementById(id);

let state = 'idle';
let retryCount = 0;
const BACKOFF = [0, 800, 1500]; // 第 1/2/3 次重试前的等待毫秒数

// 设置项缓存（界面渲染用；真正持久化在主进程的 config.json）
let settings = {
  autoCheckin: true,
  checkinTime: '09:00',
  autoLaunch: false,
  autoRetry: true,
  closeToTray: true,
  catchUp: true,
  desktopNotify: true, // 定时/补签结果、凭证过期时弹系统通知
  maxRetries: 3, // 自动签到失败重试次数（1~5）
  theme: 'system', // system | light | dark
  hasToken: false,
  nextRunAt: null,
};

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
  const retry = $('retry-btn');
  const msg = $('msg');

  btn.className = 'btn';
  btn.disabled = false;
  retry.classList.add('hidden');
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
      retry.classList.remove('hidden');
      break;
    case 'need_token':
      btn.textContent = '请先配置凭证';
      btn.disabled = true;
      msg.textContent = payload.message || '尚未配置登录凭证，请点下方「登录凭证」填写';
      msg.classList.add('err');
      break;
    case 'idle':
    default:
      btn.textContent = '立即签到';
      btn.disabled = false;
      if (payload.message) msg.textContent = payload.message;
  }

  if (payload.stats) setStats(payload.stats);
}

// ---------------- 面板管理：入口按钮即开关（点一次打开，再点一次收起） ----------------
// 统一约定：凡是"打开某面板"的按钮，第二次点击都关闭并回到主界面；面板里的「关闭」等价于同一动作。
// 四个面板互斥，同一个时刻只显示一个。

const PANELS = [
  { id: 'settings-panel', entry: 'settings-btn', afterClose: () => syncAfterSettings() },
  { id: 'logs-panel', entry: 'logs-btn' },
  { id: 'credential-panel', entry: 'credential-btn' },
  { id: 'stats-panel', entry: 'stats-btn' },
];

const ENTRY_TITLE = {
  'settings-btn': ['打开设置（再点一次「设置」即可关闭）', '再点一次「设置」即可关闭'],
  'logs-btn': ['打开运行日志（再点一次收起）', '再点一次「运行日志」收起'],
  'credential-btn': ['打开登录凭证（再点一次收起）', '再点一次「登录凭证」收起'],
  'stats-btn': ['打开使用统计（再点一次收起）', '再点一次「使用统计」收起'],
};

function panelOpen(id) {
  const el = $(id);
  return !!el && !el.classList.contains('hidden');
}

// 让入口按钮的外观/无障碍状态始终与面板开合一致
function syncPanelButtons() {
  for (const p of PANELS) {
    const btn = $(p.entry);
    if (!btn) continue;
    const open = panelOpen(p.id);
    btn.classList.toggle('is-active', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const t = ENTRY_TITLE[p.entry];
    if (t) btn.title = open ? t[1] : t[0];
  }
}

function showPanel(id) {
  for (const p of PANELS) $(p.id).classList.toggle('hidden', p.id !== id);
  syncPanelButtons();
}

function hidePanels() {
  for (const p of PANELS) $(p.id).classList.add('hidden');
  syncPanelButtons();
}

// 关闭单个面板并执行其收尾（例如设置面板关闭后要重算"下次自动签到"倒计时）
function closePanel(id) {
  if (!panelOpen(id)) return;
  hidePanels();
  const p = PANELS.find((x) => x.id === id);
  if (p && p.afterClose) p.afterClose();
}

// 同一个入口按钮：开着就关，关着就开
function togglePanel(id, openFn) {
  if (panelOpen(id)) {
    closePanel(id);
    return;
  }
  if (openFn) openFn();
  else showPanel(id);
}

// 设置面板：只读写偏好项，不读取、也不索取 token
async function openSettingsPanel() {
  showPanel('settings-panel');
  settingsHint('');
  await loadSettings();
}

// 凭证面板：与设置完全独立，只在用户主动点击（或首次无凭证）时打开
async function openCredentialPanel() {
  showPanel('credential-panel');
  credentialHint('');
}

// ---------------- 设置 ----------------

function settingsHint(text, isErr) {
  const el = $('settings-hint');
  el.textContent = text || '';
  el.className = 'save-hint' + (isErr ? ' err' : '');
}

function renderSettings() {
  $('auto-checkin-input').checked = !!settings.autoCheckin;
  $('checkin-time-input').value = settings.checkinTime || '09:00';
  $('checkin-time-input').disabled = !settings.autoCheckin;
  $('catchup-input').checked = !!settings.catchUp;
  $('catchup-input').disabled = !settings.autoCheckin;
  $('autoretry-input').checked = !!settings.autoRetry;
  $('autolaunch-input').checked = !!settings.autoLaunch;
  $('closetotray-input').checked = !!settings.closeToTray;
  // 新增：桌面通知 / 重试次数 / 主题
  if ($('desktop-notify-input')) $('desktop-notify-input').checked = !!settings.desktopNotify;
  if ($('max-retries-input')) $('max-retries-input').value = settings.maxRetries || 3;
  if ($('theme-input')) $('theme-input').value = settings.theme || 'system';
  $('cred-state').textContent = settings.hasToken ? '已配置（无需重新输入）' : '未配置';
  applyTheme();
}

async function loadSettings() {
  try {
    const r = await fetch(`${BASE}/api/settings`);
    const s = await r.json();
    settings = { ...settings, ...s };
    renderSettings();
    renderSubLine();
  } catch (e) {
    settingsHint(`读取设置失败：${e.message}`, true);
  }
}

// 把 'HH:MM' 换算成本地时间点；已过则视为明天
function nextRunFrom(cfg) {
  const t = String((cfg && cfg.checkinTime) || '09:00');
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  const h = m ? Number(m[1]) : 9;
  const mi = m ? Number(m[2]) : 0;
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

function fmtRemain(ms) {
  if (ms <= 0) return '即将执行';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时后`;
  if (h > 0) return `${h} 小时 ${m} 分后`;
  return `${Math.max(m, 1)} 分钟后`;
}

function renderSubLine() {
  const el = $('sub-line');
  if (!settings.autoCheckin) {
    el.textContent = '自动签到已关闭 · 仅手动签到';
    return;
  }
  const next = nextRunFrom(settings);
  const hh = String(next.getHours()).padStart(2, '0');
  const mm = String(next.getMinutes()).padStart(2, '0');
  const today = new Date();
  const isToday =
    next.getFullYear() === today.getFullYear() &&
    next.getMonth() === today.getMonth() &&
    next.getDate() === today.getDate();
  el.textContent = `下次自动签到 ${isToday ? '今天' : '明天'} ${hh}:${mm} · ${fmtRemain(
    next.getTime() - Date.now()
  )}`;
}

async function saveSettings() {
  const payload = {
    autoCheckin: $('auto-checkin-input').checked,
    checkinTime: $('checkin-time-input').value || '09:00',
    catchUp: $('catchup-input').checked,
    autoRetry: $('autoretry-input').checked,
    autoLaunch: $('autolaunch-input').checked,
    closeToTray: $('closetotray-input').checked,
    // 新增偏好项
    desktopNotify: $('desktop-notify-input') ? $('desktop-notify-input').checked : undefined,
    maxRetries: $('max-retries-input') ? Number($('max-retries-input').value) || 3 : undefined,
    theme: $('theme-input') ? $('theme-input').value || 'system' : undefined,
  };
  if (payload.autoCheckin && !/^\d{2}:\d{2}$/.test(payload.checkinTime)) {
    settingsHint('请选择合法的签到时间', true);
    return;
  }
  const btn = $('save-settings-btn');
  btn.disabled = true;
  try {
    const r = await fetch(`${BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const res = await r.json();
    if (!r.ok || !res.ok) throw new Error(res.error || '保存失败');
    if (res.settings) settings = { ...settings, ...res.settings };
    renderSettings();
    renderSubLine();
    let tip = '设置已保存';
    if (payload.autoLaunch !== undefined && res.applied === false) {
      tip += '（开机自启写入失败，请检查系统权限）';
    }
    settingsHint(tip, res.applied === false);
    await refreshSummary();
  } catch (e) {
    settingsHint(`保存失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 统计与状态 ----------------

async function refreshStatus() {
  try {
    const r = await fetch(`${BASE}/api/status`, { method: 'POST' });
    const res = await r.json();
    switch (res.action) {
      case 'already':
        setState('already', {
          message: `今天已签到（连续 ${res.streak_days != null ? res.streak_days : 0} 天）`,
          stats: res,
        });
        break;
      case 'idle':
        setState('idle', { stats: res });
        break;
      case 'token_expired':
        setState('need_token', { message: '登录态已过期，请点「登录凭证」重新粘贴一次' });
        break;
      case 'need_token':
        setState('need_token');
        break;
      default:
        setState('error', { message: res.message || '状态查询失败' });
    }
  } catch (e) {
    setState('error', { message: `状态查询失败：${e.message}` });
  }
  await refreshSummary();
}

async function refreshSummary() {
  try {
    const r = await fetch(`${BASE}/api/summary`);
    const s = await r.json();
    const parts = [];
    if (s.lastCheckin) {
      const d = new Date(s.lastCheckin);
      const pad = (n) => String(n).padStart(2, '0');
      parts.push(`上次签到 ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
    } else {
      parts.push('暂无签到记录');
    }
    parts.push(`本月已签 ${s.monthDays || 0} 天`);
    $('meta-line').textContent = parts.join(' · ');
  } catch (_) {}
}

async function loadConfig() {
  try {
    const r = await fetch(`${BASE}/api/config`);
    const cfg = await r.json();
    $('domain-input').value = cfg.domain || 'www.codebuddy.cn';
    if (cfg.hasToken) {
      setState('idle');
      await refreshStatus();
    } else {
      setState('need_token', { message: '首次使用：请先在下方「登录凭证」里粘贴一次 cURL' });
      await refreshSummary();
      // 仅首次（完全没有凭证）时主动展开凭证页，属于必要引导；与"设置"无关
      showPanel('credential-panel');
    }
  } catch (e) {
    setState('error', { message: `无法连接本地服务：${e.message}` });
  }
}

// ---------------- 签到 ----------------

async function doCheckin() {
  setState('loading');
  try {
    const r = await fetch(`${BASE}/api/checkin`, { method: 'POST' });
    const res = await r.json();
    retryCount = 0;
    switch (res.action) {
      case 'ok':
        setState('success', { message: res.message, stats: res });
        break;
      case 'already':
        setState('already', { message: res.message, stats: res });
        break;
      case 'token_expired':
        setState('need_token', { message: '登录态已过期，请点「登录凭证」重新粘贴一次' });
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
  await refreshSummary();
}

function onRetry() {
  if (retryCount < BACKOFF.length - 1) retryCount++;
  const wait = BACKOFF[retryCount];
  const retry = $('retry-btn');
  retry.disabled = true;
  if (wait) {
    setTimeout(() => {
      retry.disabled = false;
      doCheckin();
    }, wait);
  } else {
    retry.disabled = false;
    doCheckin();
  }
}

// ---------------- 运行日志 ----------------

const TAG_CLASS = {
  ok: 'ok',
  already: 'already',
  error: 'err',
  token_expired: 'warn',
  need_token: 'warn',
};

const TAG_TEXT = {
  ok: '成功',
  already: '已签',
  error: '失败',
  token_expired: '过期',
  need_token: '无凭证',
};

function renderLogs(data) {
  const box = $('logs-list');
  const items = (data && data.items) || [];
  if (!items.length) {
    box.innerHTML = '<p class="empty">暂无记录</p>';
  } else {
    box.innerHTML = items
      .map((it) => {
        const d = it.ts ? new Date(it.ts) : null;
        const pad = (n) => String(n).padStart(2, '0');
        const time = d ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '--';
        const cls = TAG_CLASS[it.action] || 'warn';
        const label = it.label || TAG_TEXT[it.action] || '事件';
        const extra = [];
        if (it.streak_days != null) extra.push(`连续 ${it.streak_days} 天`);
        if (it.today_credit != null) extra.push(`+${it.today_credit}`);
        if (it.trigger === 'schedule') extra.push('定时');
        if (it.trigger === 'catchup') extra.push('补签');
        if (it.attempt > 1) extra.push(`第 ${it.attempt} 次`);
        const text = [it.message || '', extra.join(' · ')].filter(Boolean).join('  ');
        return `<div class="log-item"><span class="log-time">${time}</span><span class="log-body"><span class="log-tag ${cls}">${label}</span><span class="log-text">${escapeHtml(
          text
        )}</span></span></div>`;
      })
      .join('');
  }
  const size = data && data.sizeBytes ? (data.sizeBytes / 1024).toFixed(1) + ' KB' : '0 KB';
  $('logs-meta').textContent = `共 ${(data && data.total) || 0} 条 · ${size}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadLogs() {
  try {
    const r = await fetch(`${BASE}/api/logs?limit=100`);
    renderLogs(await r.json());
  } catch (e) {
    $('logs-list').innerHTML = `<p class="empty">读取失败：${escapeHtml(e.message)}</p>`;
  }
}

async function openLogsPanel() {
  showPanel('logs-panel');
  await loadLogs();
}

// ---------------- 凭证（原有逻辑保持不变） ----------------

function credentialHint(text, isErr) {
  const el = $('credential-hint');
  el.textContent = text || '';
  el.className = 'save-hint' + (isErr ? ' err' : '');
}

// 用户在 DevTools 里复制时，常常会把 "Bearer " 前缀、引号、空白一起带进来，
// 这里统一清洗，避免因为格式问题反复粘贴失败。
// 还支持直接粘贴整段 "复制为 cURL" 的文本，自动从中抽出 Cookie / Authorization。
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

// 服务端把会话和 UA 绑定，UA 不一致会 401，所以从 cURL 里把真实 UA 也一起取出来
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

  // 看起来像一整段 cURL，就先从里面抽
  if (/^curl\b/i.test(t) || /(^|\s)-b\s+['"]/.test(t) || /-H\s+['"]cookie:/i.test(t)) {
    const extracted = extractFromCurl(t);
    if (extracted) return extracted;
  }

  t = t.replace(/^["'`]|["'`]$/g, '').trim(); // 去掉首尾引号
  t = t.replace(/^authorization\s*:\s*/i, '').trim(); // 去掉 "Authorization:" 字样
  t = t.replace(/^bearer\s+/i, '').trim(); // 去掉 "Bearer " 前缀
  t = t.replace(/^cookie\s*:\s*/i, '').trim(); // 去掉 "Cookie:" 字样（Cookie 鉴权场景）
  return t;
}

function normalizeUid(raw) {
  let u = String(raw || '').trim();
  u = u.replace(/^["'`]|["'`]$/g, '').trim();
  u = u.replace(/^x-user-id\s*:\s*/i, '').trim(); // 去掉 "X-User-Id:" 字样
  return u;
}

async function saveCredential() {
  const raw = $('token-input').value;
  const token = normalizeToken(raw);
  const userAgent = extractUserAgent(raw);
  const uid = normalizeUid($('uid-input').value);
  const domain = $('domain-input').value.trim() || 'www.codebuddy.cn';

  if (!token) {
    credentialHint('accessToken（或 Cookie）必须填写', true);
    return;
  }
  if (token.length < 20) {
    credentialHint('accessToken 看起来不完整，请重新复制', true);
    return;
  }

  try {
    await fetch(`${BASE}/api/saveConfig`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: token, uid, domain, userAgent }),
    });
    // 回填清洗后的值，让用户确认
    $('token-input').value = token;
    $('uid-input').value = uid;
    hidePanels();
    setState('idle', { message: '凭证已保存，可以点「立即签到」了' });
    await loadSettings();
    await refreshStatus();
  } catch (e) {
    credentialHint(`保存失败：${e.message}`, true);
  }
}

// ---------------- 主题 ----------------

// 把"深色/浅色/跟随系统"应用到界面；跟随系统时用系统偏好决定
function applyTheme() {
  const t = settings.theme || 'system';
  let resolved = t;
  if (t === 'system') {
    try {
      resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      resolved = 'light';
    }
  }
  document.documentElement.setAttribute('data-theme', resolved);
}

if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').addEventListener) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((settings.theme || 'system') === 'system') applyTheme();
  });
}

// ---------------- 手机端桥接：凭证码导出 / 导入 ----------------

async function exportCode() {
  const ta = $('sync-code');
  try {
    const r = await fetch(`${BASE}/api/export`, { method: 'POST' });
    const res = await r.json();
    if (!res.ok) throw new Error(res.error || '导出失败');
    ta.value = res.code || '';
    ta.classList.remove('hidden');
    ta.select();
    try {
      await navigator.clipboard.writeText(ta.value);
      settingsHint('凭证码已生成并复制到剪贴板，发到手机端粘贴即可');
    } catch (_) {
      settingsHint('凭证码已生成，请手动复制并发送到手机端');
    }
  } catch (e) {
    settingsHint(`导出失败：${e.message}`, true);
  }
}

async function importCode() {
  const code = $('sync-code').value.trim();
  if (!code) {
    settingsHint('请先粘贴凭证码', true);
    return;
  }
  try {
    const r = await fetch(`${BASE}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const res = await r.json();
    if (!r.ok || !res.ok) throw new Error(res.error || '导入失败');
    settingsHint('凭证已导入（不影响其它设置）');
    await loadConfig();
    await loadSettings();
  } catch (e) {
    settingsHint(`导入失败：${e.message}`, true);
  }
}

// 生成 8 位配对码：手机端输入这 8 个字符就能取回凭证，避免粘几千字的长串被截断
async function createPairCode() {
  const box = $('pair-result');
  const label = $('pair-code-label');
  const tip = $('pair-tip');
  label.textContent = '······';
  box.classList.remove('hidden');
  tip.textContent = '正在生成…';
  try {
    const r = await fetch(`${BASE}/api/pair-create`, { method: 'POST' });
    const res = await r.json();
    if (!r.ok || !res.ok) throw new Error(res.error || '生成失败');
    label.textContent = res.code;
    const mins = Math.round((res.expiresIn || 600) / 60);
    tip.textContent = `在手机端「登录凭证 → 用配对码同步」输入这 8 位；${mins} 分钟内有效、只能领取一次`;
    try {
      await navigator.clipboard.writeText(res.code);
      settingsHint('配对码已生成并复制，去手机端输入即可');
    } catch (_) {
      settingsHint('配对码已生成，请手动输入到手机端');
    }
  } catch (e) {
    box.classList.add('hidden');
    settingsHint(`生成配对码失败：${e.message}`, true);
  }
}

// ---------------- 使用统计 ----------------
// 数据来自手机端服务：配对码被谁领走、领走的设备之后有没有真的签到。
// 桌面端只拿到"设备级"聚合数据，不含凭证内容。

const PLATFORM_TEXT = {
  android: '安卓',
  ios: 'iOS',
  windows: 'Windows',
  mac: 'Mac',
  linux: 'Linux',
  other: '其它',
};

const CODE_STATUS_TEXT = {
  active: { text: '有效', cls: 'ok' },
  used: { text: '已领满', cls: 'plain' },
  expired: { text: '已过期', cls: 'plain' },
};

function fmtClock(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '--';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtAgo(ts) {
  if (!ts) return '--';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return fmtClock(ts);
}

// 一台设备"现在的状态"：优先看是否今天签到成功，其次看最近一次请求的结果
function deviceTag(d) {
  const DAY = 24 * 60 * 60 * 1000;
  if (d.lastResult === 'token_expired') return { text: '凭证失效', cls: 'warn' };
  if (d.lastCheckinAt && Date.now() - d.lastCheckinAt < DAY) return { text: '今日已签', cls: 'ok' };
  if (d.lastResult === 'error') return { text: '签到失败', cls: 'err' };
  if (d.lastResult === 'idle') return { text: '待签到', cls: 'warn' };
  return { text: '仅同步', cls: 'plain' };
}

function renderUsageDevices(list) {
  const box = $('st-devices-list');
  if (!list.length) {
    box.innerHTML = '<p class="empty">还没有设备通过配对码同步过凭证</p>';
    return;
  }
  box.innerHTML = list
    .map((d) => {
      const t = deviceTag(d);
      const name = [PLATFORM_TEXT[d.platform] || '其它', d.browser].filter(Boolean).join(' · ');
      const tail = String(d.id || '').slice(-4).toUpperCase() || '----';
      const extra = [];
      if (d.streak != null) extra.push(`连续 ${d.streak} 天`);
      if (d.todayCredit != null) extra.push(`今日 +${d.todayCredit}`);
      return `<div class="usage-item">
        <span class="usage-badge">${escapeHtml(name)}</span>
        <div class="usage-main">
          <div class="usage-title">设备 ${escapeHtml(tail)}<span class="usage-ago">${fmtAgo(d.lastAt)}活跃</span></div>
          <div class="usage-meta">首次 ${fmtClock(d.firstAt)} · 领取 ${d.claims || 0} 次 · 成功签到 ${d.checkins || 0} 次${
        extra.length ? ' · ' + extra.join(' · ') : ''
      }</div>
        </div>
        <span class="usage-tag ${t.cls}">${t.text}</span>
      </div>`;
    })
    .join('');
}

function renderUsageCodes(list) {
  const box = $('st-codes-list');
  if (!list.length) {
    box.innerHTML = '<p class="empty">还没有生成过配对码</p>';
    return;
  }
  box.innerHTML = list
    .map((c) => {
      const s = CODE_STATUS_TEXT[c.status] || CODE_STATUS_TEXT.expired;
      const detail = [`生成 ${fmtClock(c.at)}`, `领取 ${c.claims || 0} 次`];
      if (c.lastClaimAt) detail.push(`最近 ${fmtClock(c.lastClaimAt)}`);
      return `<div class="usage-item">
        <span class="usage-badge mono">${escapeHtml(c.mask || '••••••••')}</span>
        <div class="usage-main">
          <div class="usage-title">配对码<span class="usage-ago">${s.text}</span></div>
          <div class="usage-meta">${detail.join(' · ')}</div>
        </div>
        <span class="usage-tag ${s.cls}">${(c.claims || 0) > 0 ? '已使用' : '未使用'}</span>
      </div>`;
    })
    .join('');
}

function renderUsageStats(j) {
  const local = (j && j.local) || {};
  const remote = j && j.remote;
  const totals = (remote && remote.totals) || {};
  const devices = (remote && remote.devices) || [];
  const codes = (remote && remote.codes) || [];

  $('st-devices').textContent = remote ? totals.devices || 0 : '--';
  $('st-claims').textContent = remote ? totals.claims || 0 : '--';
  $('st-codes').textContent = Math.max(totals.codes || 0, local.pairCreated || 0);
  $('st-active').textContent = remote ? totals.activeToday || 0 : '--';

  const note = $('st-note');
  const parts = [];
  if (!j || !j.ok) {
    note.className = 'stats-note err';
    parts.push((j && j.error) || '暂时读取不到手机端统计');
    if (local.pairCreated) parts.push('（本机生成记录仍可参考下方"最近配对码"）');
  } else {
    note.className = 'stats-note';
    if (!devices.length) {
      parts.push('还没有人用过你的配对码：到「设置 → 手机端同步 → 生成配对码」，让手机输入后才会被统计');
    } else {
      parts.push(
        `共 ${totals.devices} 台设备用过你的凭证，其中近 24 小时 ${totals.activeToday} 台活跃、${totals.signedToday} 台签到成功`
      );
    }
    if (remote && remote.persisted === false) {
      parts.push('注意：手机端服务当前不可写盘，统计只在服务运行期间累计');
    }
  }
  note.textContent = parts.join(' ');

  renderUsageDevices(devices);
  renderUsageCodes(codes);

  const bits = [];
  if (local.ownerIdShort) bits.push(`本机标识 …${local.ownerIdShort}`);
  bits.push(`本机生成配对码 ${local.pairCreated || 0} 次`);
  if (local.exportCount) bits.push(`导出凭证码 ${local.exportCount} 次`);
  if (remote && remote.updatedAt) bits.push(`更新于 ${fmtClock(remote.updatedAt)}`);
  $('st-updated').textContent = bits.join(' · ');
}

async function loadUsageStats(silent) {
  const note = $('st-note');
  if (!note) return;
  if (!silent) {
    note.className = 'stats-note';
    note.textContent = '正在读取统计…';
  }
  try {
    const r = await fetch(`${BASE}/api/usage-stats`);
    renderUsageStats(await r.json());
  } catch (e) {
    note.className = 'stats-note err';
    note.textContent = `统计读取失败：${e.message}`;
  }
}

let statsTimer = null;

async function openStatsPanel() {
  showPanel('stats-panel');
  await loadUsageStats(false);
  if (!statsTimer) {
    statsTimer = setInterval(() => {
      if (panelOpen('stats-panel')) loadUsageStats(true);
    }, 60 * 1000);
  }
}

// ---------------- 事件绑定 ----------------

$('checkin-btn').addEventListener('click', doCheckin);
$('retry-btn').addEventListener('click', onRetry);

// 「设置」按钮：第一次点打开，第二次点关闭并返回主界面（与其它入口按钮行为一致）
$('settings-btn').addEventListener('click', () => togglePanel('settings-panel', openSettingsPanel));
$('close-settings-panel').addEventListener('click', () => closePanel('settings-panel'));
$('save-settings-btn').addEventListener('click', saveSettings);

// 手机端桥接：配对码 / 导出 / 导入
const pairBtn = $('pair-btn');
if (pairBtn) pairBtn.addEventListener('click', createPairCode);
const pairAgainBtn = $('pair-again-btn');
if (pairAgainBtn) pairAgainBtn.addEventListener('click', createPairCode);
const pairCopyBtn = $('pair-copy-btn');
if (pairCopyBtn)
  pairCopyBtn.addEventListener('click', async () => {
    const code = ($('pair-code-label').textContent || '').trim();
    if (!code || code.indexOf('·') >= 0) return;
    try {
      await navigator.clipboard.writeText(code);
      settingsHint('配对码已复制');
    } catch (_) {
      settingsHint('复制失败，请手动抄下这 8 位', true);
    }
  });
const exportBtn = $('export-btn');
const importBtn = $('import-btn');
if (exportBtn) exportBtn.addEventListener('click', exportCode);
if (importBtn) importBtn.addEventListener('click', importCode);

$('auto-checkin-input').addEventListener('change', (e) => {
  $('checkin-time-input').disabled = !e.target.checked;
  $('catchup-input').disabled = !e.target.checked;
});

$('logs-btn').addEventListener('click', () => togglePanel('logs-panel', openLogsPanel));
$('close-logs-panel').addEventListener('click', () => closePanel('logs-panel'));
$('refresh-logs-btn').addEventListener('click', loadLogs);
$('clear-logs-btn').addEventListener('click', async () => {
  try {
    await fetch(`${BASE}/api/logs/clear`, { method: 'POST' });
    await loadLogs();
  } catch (e) {
    $('logs-list').innerHTML = `<p class="empty">清空失败：${escapeHtml(e.message)}</p>`;
  }
});
$('open-logs-btn').addEventListener('click', async () => {
  try {
    await fetch(`${BASE}/api/openLogFolder`, { method: 'POST' });
  } catch (_) {}
});

$('credential-btn').addEventListener('click', () => togglePanel('credential-panel', openCredentialPanel));
$('close-credential').addEventListener('click', () => closePanel('credential-panel'));
$('save-btn').addEventListener('click', saveCredential);

// 使用统计
if ($('stats-btn')) $('stats-btn').addEventListener('click', () => togglePanel('stats-panel', openStatsPanel));
if ($('close-stats-panel')) $('close-stats-panel').addEventListener('click', () => closePanel('stats-panel'));
if ($('st-refresh-btn')) $('st-refresh-btn').addEventListener('click', () => loadUsageStats(false));

// 关闭设置面板后，若改了时间/开关，重算倒计时
async function syncAfterSettings() {
  await loadSettings();
  renderSubLine();
}

// 托盘"立即签到"菜单触发时，自动点一次签到
if (window.api && typeof window.api.onTriggerCheckin === 'function') {
  window.api.onTriggerCheckin(() => {
    if (state === 'idle' || state === 'already' || state === 'success' || state === 'error') doCheckin();
  });
}

// 主进程完成一次后台自动签到后，刷新统计（不打断用户当前看到的状态）
if (window.api && typeof window.api.onCheckinDone === 'function') {
  window.api.onCheckinDone((res) => {
    if (!res) return;
    if (res.streak_days != null || res.total_credits != null) setStats(res);
    if (res.action === 'ok') {
      setState('success', { message: res.message || '后台自动签到成功', stats: res });
    } else if (res.action === 'already' && res.silent) {
      if (state !== 'error') setState('already', { message: '今日已签到（后台检查）', stats: res });
    } else if (res.action === 'error') {
      setState('error', { message: `后台自动签到失败：${res.message || '未知错误'}` });
    } else if (res.action === 'token_expired') {
      setState('need_token', { message: '登录态已过期，请点「登录凭证」重新粘贴一次' });
    }
    refreshSummary();
  });
}

// Esc 关闭当前打开的面板（与点「关闭」等价）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = PANELS.find((p) => panelOpen(p.id));
  if (open) closePanel(open.id);
});

// 定时刷新倒计时（每 30 秒）与统计（每 5 分钟）
setInterval(renderSubLine, 30 * 1000);
setInterval(refreshSummary, 5 * 60 * 1000);

// 启动
(async () => {
  syncPanelButtons(); // 初始化入口按钮的 aria-expanded / 提示文案
  await loadSettings();
  await loadConfig();
})();
