'use strict';

// 使用统计链路测试：publish(带 owner) → claim(带 did) → GET /api/pair/stats
// 覆盖：配对码生成数、领取次数、按设备去重的人数、非法 owner 拒绝、统计文件落盘。
// 运行： node scripts/test-stats.js   （会自己起一个临时端口的服务）

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 3811;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-stats-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.PORT = String(PORT);

const server = require('../server');

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile' }
          : { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' },
      },
      (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(s);
          } catch (_) {}
          resolve({ status: res.statusCode, body: j });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`);
}

function publishBody(code, owner, mask) {
  const secret = JSON.stringify({ accessToken: 'TOKEN-x', uid: 'u', userAgent: 'ua', domain: 'www.codebuddy.cn' });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(code, salt, 100000, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return {
    code,
    owner,
    mask,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: Buffer.concat([enc, c.getAuthTag()]).toString('base64'),
  };
}

(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  console.log(`== 使用统计测试（端口 ${PORT}）==`);

  const owner = crypto.randomBytes(16).toString('hex');
  const code = 'K7M2QP4X';

  const pub = await req('POST', '/api/pair/publish', publishBody(code, owner, 'K7••••4X'));
  check('1) 带 owner 发布配对码成功', pub.status === 200 && pub.body && pub.body.ok, JSON.stringify(pub.body));

  const empty = await req('GET', `/api/pair/stats?owner=${owner}`);
  check(
    '2) 未领取时：1 个码、0 领取、0 人',
    empty.status === 200 && empty.body.totals.codes === 1 && empty.body.totals.claims === 0 && empty.body.totals.devices === 0,
    JSON.stringify(empty.body && empty.body.totals)
  );

  const claim1 = await req('POST', '/api/pair/claim', { code, did: 'a1b2c3d4e5f60718' });
  const claim2 = await req('POST', '/api/pair/claim', { code, did: 'ffff000011112222' });
  check('3) 两台设备各领取一次', claim1.body.ok && claim2.body.ok);

  const s1 = await req('GET', `/api/pair/stats?owner=${owner}`);
  const t1 = s1.body.totals;
  check(
    '4) 统计：2 人 / 2 次领取 / 1 个码',
    t1.devices === 2 && t1.claims === 2 && t1.codes === 1,
    JSON.stringify(t1)
  );
  check(
    '5) 设备信息含平台与领取次数',
    s1.body.devices.every((d) => d.claims === 1 && ['android', 'ios'].includes(d.platform)),
    JSON.stringify(s1.body.devices)
  );
  check('6) 配对码以掩码形式返回，不含原文', s1.body.codes[0].mask === 'K7••••4X' && !JSON.stringify(s1.body).includes(code));

  // 同一设备再次领取：人数不变、领取次数 +1
  const claim3 = await req('POST', '/api/pair/claim', { code, did: 'a1b2c3d4e5f60718' });
  const s2 = await req('GET', `/api/pair/stats?owner=${owner}`);
  check(
    '7) 同一设备重复领取：人数不变、次数 +1、码变为已领满',
    claim3.body.ok && s2.body.totals.devices === 2 && s2.body.totals.claims === 3 && s2.body.codes[0].status === 'used',
    JSON.stringify({ totals: s2.body.totals, code: s2.body.codes[0] })
  );

  const bad = await req('GET', '/api/pair/stats?owner=abc');
  check('8) 非法统计标识被拒绝', bad.status === 400 && bad.body.ok === false);

  const other = await req('GET', `/api/pair/stats?owner=${crypto.randomBytes(16).toString('hex')}`);
  check('9) 别人的标识看不到数据', other.status === 200 && other.body.totals.devices === 0);

  // 统计落盘（防抖 1.5s）
  await new Promise((r) => setTimeout(r, 1800));
  const file = path.join(DATA_DIR, 'usage-stats.json');
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  check('10) 统计已写入 usage-stats.json', !!saved && !!saved.owners[owner]);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`结果: ${results.length - failed.length} 通过 / ${failed.length} 失败`);
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
  process.exit(failed.length ? 1 : 0);
})();
