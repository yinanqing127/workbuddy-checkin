'use strict';

// 桌面端「使用统计」接口测试（纯 Node）：
// 用本地 mock 冒充手机端服务，验证 /api/usage-stats 的聚合、错误降级，以及"不碰凭证"的红线。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-usage-test-'));
const configPath = path.join(tmpDir, 'config.json');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

function req(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(b);
        } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  // 先起 mock 手机端服务，再加载 config（MOBILE_BASE 在模块加载时读取环境变量）
  const remote = {
    ok: true,
    updatedAt: Date.now(),
    totals: { devices: 2, claims: 3, codes: 2, checkins: 5, activeToday: 1, signedToday: 1 },
    devices: [
      { id: 'a1b2c3d4e5f60718', platform: 'android', browser: 'Chrome', firstAt: Date.now() - 86400000, lastAt: Date.now() - 60000, claims: 2, checkins: 3, lastResult: 'ok', lastCheckinAt: Date.now(), streak: 4, todayCredit: 100 },
      { id: 'ffff000011112222', platform: 'ios', browser: 'Safari', firstAt: Date.now() - 3600000, lastAt: Date.now() - 7200000, claims: 1, checkins: 0, lastResult: 'token_expired', lastCheckinAt: 0, streak: null, todayCredit: null },
    ],
    codes: [{ mask: 'K7••••4X', at: Date.now(), claims: 3, lastClaimAt: Date.now(), status: 'used' }],
    persisted: true,
  };
  let lastQuery = null;
  const mock = http.createServer((rq, rs) => {
    lastQuery = rq.url;
    rs.setHeader('Content-Type', 'application/json');
    rs.end(JSON.stringify(remote));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  process.env.WB_MOBILE_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.WB_MOBILE_SHARE = 'TESTSHARE';
  const { createApiServer, loadConfig } = require('../src/config');

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        domain: 'www.workbuddy.cn',
        accessToken: 'COOKIE_ABC_SECRET_1234567890',
        uid: 'uid-1',
        userAgent: 'UA-1',
        checkinTime: '08:15',
      },
      null,
      2
    )
  );

  const server = createApiServer({ port: 0, configPath });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`== 使用统计接口测试（本地 API ${port} / mock 手机端 ${mockPort}）==`);

  let ownerId = '';

  await test('GET /api/usage-stats 首次调用自动创建统计标识并拉回数据', async () => {
    const r = await req(port, 'GET', '/api/usage-stats');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.remote && r.body.remote.totals.devices === 2);
    ownerId = loadConfig(configPath).ownerId;
    assert.ok(/^[a-f0-9]{32}$/.test(ownerId), '应生成 32 位 hex 统计标识');
    assert.strictEqual(r.body.local.ownerIdShort, ownerId.slice(-6));
  });

  await test('请求手机端时带上 owner 与 sharecode', async () => {
    await req(port, 'GET', '/api/usage-stats');
    assert.ok(lastQuery.includes(`owner=${ownerId}`), lastQuery);
    assert.ok(lastQuery.includes('sharecode=TESTSHARE'), lastQuery);
  });

  await test('统计请求不会改动已保存的凭证与设置', async () => {
    const cfg = loadConfig(configPath);
    assert.strictEqual(cfg.accessToken, 'COOKIE_ABC_SECRET_1234567890');
    assert.strictEqual(cfg.uid, 'uid-1');
    assert.strictEqual(cfg.userAgent, 'UA-1');
    assert.strictEqual(cfg.checkinTime, '08:15');
  });

  await test('响应里不包含凭证明文', async () => {
    const r = await req(port, 'GET', '/api/usage-stats');
    assert.ok(!r.raw.includes('COOKIE_ABC_SECRET'), '统计响应不得泄露 token');
  });

  await test('手机端服务不可用时优雅降级（ok:false + 本地计数）', async () => {
    await new Promise((r) => mock.close(r));
    const r = await req(port, 'GET', '/api/usage-stats');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, false);
    assert.ok(r.body.error, '应给出可读原因');
    assert.ok(r.body.local, '仍应返回本地计数');
    assert.strictEqual(r.body.local.pairCreated, 0);
  });

  await test('导出 / 导入计数只累加，且不动凭证', async () => {
    await req(port, 'POST', '/api/export');
    await req(port, 'POST', '/api/export');
    const cfg = loadConfig(configPath);
    assert.strictEqual(cfg.usage.exportCount, 2);
    assert.strictEqual(cfg.accessToken, 'COOKIE_ABC_SECRET_1234567890');
    assert.strictEqual(cfg.usage.pairCreated, 0);
  });

  server.close();
  const failed = results.filter((x) => !x.ok);
  console.log('');
  console.log(`结果: ${results.length - failed.length} 通过 / ${failed.length} 失败`);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
  process.exit(failed.length ? 1 : 0);
})();
