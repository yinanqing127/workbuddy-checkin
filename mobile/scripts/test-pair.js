'use strict';
// 端到端验证配对码链路：Node(AES-GCM) 加密 → 服务端暂存 → 手机(WebCrypto) 解密
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3799;
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function post(path, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
      }
    );
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function genCode() {
  let o = '';
  const b = crypto.randomBytes(16);
  for (let i = 0; i < b.length && o.length < 8; i++) if (b[i] < 248) o += ALPHA[b[i] % ALPHA.length];
  return o;
}

(async () => {
  const code = genCode();
  const secret = { domain: 'www.workbuddy.cn', accessToken: 'session=' + 'x'.repeat(4000) + '; session_2=abc', uid: 'uid-test', userAgent: 'UA-TEST' };
  const plaintext = JSON.stringify(secret);

  // 桌面端加密
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(code, salt, 100000, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const blob = {
    code,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: Buffer.concat([enc, c.getAuthTag()]).toString('base64'),
  };

  const pub = await post('/api/pair/publish', blob);
  console.log('1) publish ->', pub.status, JSON.stringify(pub.body));

  const claim = await post('/api/pair/claim', { code });
  console.log('2) claim   ->', claim.status, claim.body.ok ? 'ok(拿到密文)' : JSON.stringify(claim.body));

  // 手机端解密（用 WebCrypto，和浏览器完全一致）
  const subtle = crypto.webcrypto.subtle;
  const km = await subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  const k2 = await subtle.deriveKey(
    { name: 'PBKDF2', salt: Uint8Array.from(Buffer.from(claim.body.salt, 'base64')), iterations: 100000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: Uint8Array.from(Buffer.from(claim.body.iv, 'base64')) },
    k2, Uint8Array.from(Buffer.from(claim.body.data, 'base64'))
  );
  const got = JSON.parse(new TextDecoder().decode(plain));
  console.log('3) 解密 ->', got.accessToken === secret.accessToken && got.uid === secret.uid ? 'PASS 内容完全一致' : 'FAIL 内容不一致');

  // 允许有限次重复领取（容忍手机端解密/网络偶发失败），超过上限后销毁
  const c2 = await post('/api/pair/claim', { code });
  const c3 = await post('/api/pair/claim', { code });
  const c4 = await post('/api/pair/claim', { code });
  console.log('4) 重复领取 ->', c2.body && c2.body.ok && c3.body && c3.body.ok && !(c4.body && c4.body.ok) ? 'PASS 共可领3次，之后销毁' : 'FAIL ' + JSON.stringify([c2.status, c3.status, c4.status]));

  // 错误配对码
  const bad = await post('/api/pair/claim', { code: 'ZZZZZZZZ' });
  console.log('5) 错误配对码 ->', bad.status, bad.body.ok ? 'FAIL' : 'PASS 被拒绝');

  // 格式非法
  const badfmt = await post('/api/pair/publish', { code: 'abc', salt: 'a', iv: 'b', data: 'c' });
  console.log('6) 非法配对码 ->', badfmt.status, badfmt.body.ok ? 'FAIL' : 'PASS 被拒绝');
})();
