'use strict';

// 手机端 PWA 与签到服务之间的"同源代理核心"。
// 为什么需要它：workbuddy 的签到接口不返回 CORS 头，手机浏览器里的网页无法直接 fetch。
// 因此由部署在服务器上的本进程代为请求（服务端之间不存在浏览器跨域限制），
// 再把结果原样回传。本模块不保存任何凭证——token 只存在于用户手机浏览器的 localStorage。

const https = require('https');
const http = require('http');

const STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';

// 仅允许转发到这两个官方域名，杜绝被当成任意网站的 SSRF 跳板。
const ALLOWED_HOSTS = ['www.codebuddy.cn', 'www.workbuddy.cn'];

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

function isCookieString(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  if (/^eyJ/.test(s)) return false; // JWT 优先当 token
  return /=/.test(s) && (/;/.test(s) || s.split('=').length === 2);
}

function buildAuthHeaders(credential, uid, userAgent) {
  // 清掉换行/回车等非法头字符（手机会把复制的凭证带进换行，Node 会直接抛
  // "Invalid character in header content"），避免把可修复的输入问题变成"请求失败"
  const cred = String(credential || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': String(userAgent || '').replace(/[\r\n]+/g, ' ').trim() || DEFAULT_UA,
  };
  if (isCookieString(cred)) {
    headers.Cookie = cred;
  } else {
    headers.Authorization = `Bearer ${cred}`;
  }
  if (uid) headers['X-User-Id'] = String(uid).replace(/[\r\n\t]+/g, '').trim();
  return headers;
}

function doRequest(hostname, apiPath, credential, uid, userAgent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const req = https.request(
      {
        hostname,
        path: apiPath,
        method: 'POST',
        headers: { ...buildAuthHeaders(credential, uid, userAgent), 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(chunks);
          } catch (_) {}
          resolve({ status: res.statusCode, data: json, raw: chunks });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    req.write(body);
    req.end();
  });
}

function isTokenExpired(res) {
  if (res.status === 401) return true;
  const code = res.data && res.data.code;
  return code === 10002;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 带重试的请求：网关偶发 401（会话校验抖动、节点未同步等）不应被当成"凭证过期"直接判死。
// 只有连续多次都是 401 才认定为真的过期，避免用户被迫手动点两三次。
async function requestWithRetry(host, apiPath, credential, uid, userAgent, attempts = 3) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    const res = await doRequest(host, apiPath, credential, uid, userAgent);
    last = res;
    if (res.status !== 401) return res;
    if (i < attempts) await sleep(350 * i);
  }
  return last;
}

// 统一把一次签到流程跑完：查状态 → 未签则签到 → 再查确认。
async function runCheckin({ accessToken, uid, userAgent, domain }) {
  const host = ALLOWED_HOSTS.includes(domain) ? domain : ALLOWED_HOSTS[0];
  if (!accessToken) {
    return { action: 'need_token', message: '尚未配置登录凭证' };
  }
  let statusRes;
  try {
    statusRes = await requestWithRetry(host, STATUS_PATH, accessToken, uid, userAgent);
  } catch (e) {
    return { action: 'error', message: `网络请求失败：${e.message}` };
  }
  if (isTokenExpired(statusRes)) return { action: 'token_expired', message: '登录态已过期，请重新配置凭证' };
  const st = statusRes.data && statusRes.data.data;
  if (!st) return { action: 'error', message: '响应格式异常，无法解析签到状态' };
  if (st.today_checked_in) {
    return { action: 'already', message: '今天已经签到啦', streak_days: st.streak_days, today_credit: st.today_credit, total_credits: st.total_credits };
  }
  let ckRes;
  try {
    ckRes = await requestWithRetry(host, CHECKIN_PATH, accessToken, uid, userAgent);
  } catch (e) {
    return { action: 'error', message: `签到请求失败：${e.message}` };
  }
  if (isTokenExpired(ckRes)) return { action: 'token_expired', message: '登录态已过期，请重新配置凭证' };
  if (ckRes.data && ckRes.data.code === 10001) {
    return { action: 'already', message: '今天已签到', streak_days: ckRes.data.data && ckRes.data.data.streak_days, today_credit: ckRes.data.data && ckRes.data.data.today_credit, total_credits: ckRes.data.data && ckRes.data.data.total_credits };
  }
  if (ckRes.data && ckRes.data.code != null && ckRes.data.code !== 0 && ckRes.data.code !== 200 && ckRes.data.code !== '0') {
    return { action: 'error', message: (ckRes.data && ckRes.data.msg) || `签到失败（code=${ckRes.data.code}）` };
  }
  if (ckRes.status >= 400) {
    return { action: 'error', message: `签到失败（HTTP ${ckRes.status}）` };
  }
  let finalSt = st;
  try {
    const finalRes = await requestWithRetry(host, STATUS_PATH, accessToken, uid, userAgent, 2);
    if (finalRes.data && finalRes.data.data) finalSt = finalRes.data.data;
  } catch (_) {}
  return { action: 'ok', message: '签到成功', streak_days: finalSt.streak_days, today_credit: finalSt.today_credit, total_credits: finalSt.total_credits };
}

async function fetchStatus({ accessToken, uid, userAgent, domain }) {
  const host = ALLOWED_HOSTS.includes(domain) ? domain : ALLOWED_HOSTS[0];
  if (!accessToken) return { action: 'need_token', message: '尚未配置登录凭证' };
  let res;
  try {
    res = await requestWithRetry(host, STATUS_PATH, accessToken, uid, userAgent);
  } catch (e) {
    return { action: 'error', message: `网络请求失败：${e.message}` };
  }
  if (isTokenExpired(res)) return { action: 'token_expired', message: '登录态已过期，请重新配置凭证' };
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

module.exports = { runCheckin, fetchStatus, ALLOWED_HOSTS, STATUS_PATH, CHECKIN_PATH };
