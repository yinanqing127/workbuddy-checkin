'use strict';

// 共享签到逻辑：主进程与 headless 测试 harness 共同使用，不依赖 Electron。

const http = require('http');
const https = require('https');
const { URL } = require('url');

const STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';

/**
 * 底层 HTTP 请求（自动适配 http / https）。
 * @returns {Promise<{status:number, data:any, raw:string}>}
 */
function request(rawUrl, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return reject(new Error('非法 URL: ' + rawUrl));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(chunks);
          } catch (_) {
            /* 非 JSON 响应也允许 */
          }
          resolve({ status: res.statusCode, data: json, raw: chunks });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 判断用户粘贴的"凭证"是 Bearer token 还是 Cookie 串。
 * - JWT（eyJ 开头）或单个无空格的 token → Authorization: Bearer
 * - 含 "=" 且可能是 "k=v; k2=v2" 形式 → 直接作为 Cookie 头发送
 */
function isCookieString(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  if (/^eyJ/.test(s)) return false; // JWT 优先当 token
  return /[=]/.test(s) && (/;/.test(s) || s.split('=').length === 2);
}

// 服务端把会话与 User-Agent 绑定了：UA 与登录时不一致会直接 401。
// 因此优先使用用户从 cURL 里带过来的真实 UA，缺失时才退回一个常见的 Edge UA。
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';

function buildAuthHeaders(credential, uid, userAgent, origin) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': userAgent || DEFAULT_UA,
  };
  if (origin) {
    headers.Origin = origin;
    headers.Referer = `${origin}/app`;
  }
  if (isCookieString(credential)) {
    headers.Cookie = credential;
  } else {
    headers.Authorization = `Bearer ${credential}`;
  }
  if (uid) headers['X-User-Id'] = uid;
  return headers;
}

async function callApi(apiBase, path, token, uid, userAgent) {
  return request(`${apiBase}${path}`, {
    headers: buildAuthHeaders(token, uid, userAgent, apiBase),
    body: {},
  });
}

function isTokenExpired(res) {
  if (res.status === 401) return true;
  const code = res.data && res.data.code;
  return code === 10002;
}

/**
 * 执行一次签到流程：查状态 → 未签则签到 → 再查确认。
 * @param {object} opts
 * @param {string} opts.accessToken
 * @param {string} opts.uid
 * @param {string} [opts.userAgent] 与登录浏览器一致的 UA（服务端会校验）
 * @param {string} [opts.domain='www.codebuddy.cn']
 * @param {string} [opts.apiBase] 完整 origin，测试时传 http://127.0.0.1:PORT
 * @returns {Promise<{action:string, message:string, streak_days:?number, today_credit:?number, total_credits:?number}>}
 *  action: ok | already | need_token | token_expired | error
 */
async function runCheckin(opts = {}) {
  const { accessToken, uid, userAgent, domain = 'www.codebuddy.cn', apiBase } = opts;
  const base = apiBase || `https://${domain}`;

  if (!accessToken) {
    return {
      action: 'need_token',
      message: '尚未配置登录凭证，请先粘贴 accessToken 或 Cookie',
      streak_days: null,
      today_credit: null,
      total_credits: null,
    };
  }

  // 1) 查询当前状态
  let statusRes;
  try {
    statusRes = await callApi(base, STATUS_PATH, accessToken, uid, userAgent);
  } catch (e) {
    return { action: 'error', message: `网络请求失败：${e.message}`, streak_days: null, today_credit: null, total_credits: null };
  }
  if (isTokenExpired(statusRes)) {
    return { action: 'token_expired', message: '登录态已过期，请重新配置 token', streak_days: null, today_credit: null, total_credits: null };
  }
  const st = statusRes.data && statusRes.data.data ? statusRes.data.data : null;
  if (!st) {
    return { action: 'error', message: '响应格式异常，无法解析签到状态', streak_days: null, today_credit: null, total_credits: null };
  }
  if (st.today_checked_in) {
    return {
      action: 'already',
      message: '今天已经签到啦',
      streak_days: st.streak_days,
      today_credit: st.today_credit,
      total_credits: st.total_credits,
    };
  }

  // 2) 执行签到
  let ckRes;
  try {
    ckRes = await callApi(base, CHECKIN_PATH, accessToken, uid, userAgent);
  } catch (e) {
    return { action: 'error', message: `签到请求失败：${e.message}`, streak_days: null, today_credit: null, total_credits: null };
  }
  if (isTokenExpired(ckRes)) {
    return { action: 'token_expired', message: '登录态已过期，请重新配置 token', streak_days: null, today_credit: null, total_credits: null };
  }
  if (ckRes.data && ckRes.data.code === 10001) {
    return {
      action: 'already',
      message: '今天已签到',
      streak_days: ckRes.data.data && ckRes.data.data.streak_days,
      today_credit: ckRes.data.data && ckRes.data.data.today_credit,
      total_credits: ckRes.data.data && ckRes.data.data.total_credits,
    };
  }
  // 其它业务错误码
  if (ckRes.data && ckRes.data.code != null && ckRes.data.code !== 0 && ckRes.data.code !== 200 && ckRes.data.code !== '0') {
    return { action: 'error', message: (ckRes.data && ckRes.data.msg) || `签到失败（code=${ckRes.data.code}）`, streak_days: null, today_credit: null, total_credits: null };
  }
  if (ckRes.status >= 400) {
    return { action: 'error', message: `签到失败（HTTP ${ckRes.status}）`, streak_days: null, today_credit: null, total_credits: null };
  }

  // 3) 再查一次确认并取最新数据
  let finalSt = st;
  try {
    const finalRes = await callApi(base, STATUS_PATH, accessToken, uid, userAgent);
    if (finalRes.data && finalRes.data.data) finalSt = finalRes.data.data;
  } catch (_) {
    /* 忽略确认失败，沿用签到返回 */
  }

  return {
    action: 'ok',
    message: '签到成功',
    streak_days: finalSt.streak_days,
    today_credit: finalSt.today_credit,
    total_credits: finalSt.total_credits,
  };
}

/**
 * 只查询当前签到状态，不做任何写操作（启动时刷新界面用）。
 * @returns {Promise<{action:'idle'|'already'|'need_token'|'token_expired'|'error', message?:string,
 *   today_checked_in?:boolean, streak_days?:?number, today_credit?:?number, total_credits?:?number}>}
 */
async function fetchStatus(opts = {}) {
  const { accessToken, uid, userAgent, domain = 'www.codebuddy.cn', apiBase } = opts;
  const base = apiBase || `https://${domain}`;

  if (!accessToken) return { action: 'need_token', message: '尚未配置登录凭证' };

  let res;
  try {
    res = await callApi(base, STATUS_PATH, accessToken, uid, userAgent);
  } catch (e) {
    return { action: 'error', message: `网络请求失败：${e.message}` };
  }
  if (isTokenExpired(res)) {
    return { action: 'token_expired', message: '登录态已过期，请重新配置凭证' };
  }
  const st = res.data && res.data.data;
  if (!st) return { action: 'error', message: '响应格式异常，无法获取签到状态' };

  return {
    action: st.today_checked_in ? 'already' : 'idle',
    today_checked_in: !!st.today_checked_in,
    streak_days: st.streak_days != null ? st.streak_days : null,
    today_credit: st.today_credit != null ? st.today_credit : null,
    total_credits: st.total_credits != null ? st.total_credits : null,
  };
}

module.exports = { request, callApi, runCheckin, fetchStatus, STATUS_PATH, CHECKIN_PATH };
