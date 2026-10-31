'use strict';

// 本地 API 层测试（纯 Node，起在随机端口，配置写到临时目录，不碰真实用户数据）
// 覆盖：设置读写、时间校验、日志读取/清空、汇总统计，以及"保存设置不动 token"的红线。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createApiServer, loadConfig } = require('../src/config');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

function req(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(b);
          } catch (_) {}
          resolve({ status: res.statusCode, body: json, raw: b });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-api-test-'));
  const configPath = path.join(tmpDir, 'config.json');
  // 预置一份"已有凭证"的真实形态配置
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        domain: 'www.workbuddy.cn',
        accessToken: 'session=SECRET_COOKIE_VALUE_1234567890; session_2=xyz',
        uid: '8e233246-1deb-4926-a6c1-b1ab42f66b96',
        userAgent: 'UA-FROM-EDGE',
        autoLaunch: true,
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(tmpDir, 'checkin-log.jsonl'),
    [
      { ts: new Date().toISOString(), action: 'ok', message: '签到成功', streak_days: 4, today_credit: 100 },
      { ts: new Date().toISOString(), action: 'already', message: '今天已经签到啦', streak_days: 4 },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n'
  );

  const server = createApiServer({ port: 0, configPath });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`== 本地 API 测试（端口 ${port}）==`);

  await test('GET /api/config 只暴露 hasToken，不泄露明文', async () => {
    const r = await req(port, 'GET', '/api/config');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.hasToken, true);
    assert.ok(!r.raw.includes('SECRET_COOKIE'), '响应里不能出现 token 明文');
  });

  await test('GET /api/settings 返回全部设置项与 hasToken', async () => {
    const r = await req(port, 'GET', '/api/settings');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.autoCheckin, true);
    assert.strictEqual(r.body.checkinTime, '09:00');
    assert.strictEqual(r.body.autoLaunch, true);
    assert.strictEqual(r.body.autoRetry, true);
    assert.strictEqual(r.body.closeToTray, true);
    assert.strictEqual(r.body.catchUp, true);
    assert.strictEqual(r.body.hasToken, true);
    assert.ok(r.body.nextRunAt, '应返回下次执行时间');
  });

  await test('POST /api/settings 保存自定义时间与开关，且不清空 token', async () => {
    const r = await req(port, 'POST', '/api/settings', {
      autoCheckin: true,
      checkinTime: '07:30',
      autoRetry: false,
      closeToTray: false,
      catchUp: false,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.settings.checkinTime, '07:30');
    assert.strictEqual(r.body.settings.autoRetry, false);

    const cfg = loadConfig(configPath);
    assert.strictEqual(cfg.accessToken, 'session=SECRET_COOKIE_VALUE_1234567890; session_2=xyz');
    assert.strictEqual(cfg.uid, '8e233246-1deb-4926-a6c1-b1ab42f66b96');
    assert.strictEqual(cfg.userAgent, 'UA-FROM-EDGE');
    assert.strictEqual(cfg.domain, 'www.workbuddy.cn');
    assert.strictEqual(cfg.checkinTime, '07:30');
    assert.strictEqual(cfg.autoLaunch, true, '未提交的 autoLaunch 不应被改动');
  });

  await test('POST /api/settings 支持只改一个字段（局部更新）', async () => {
    const r = await req(port, 'POST', '/api/settings', { checkinTime: '21:05' });
    assert.strictEqual(r.status, 200);
    const cfg = loadConfig(configPath);
    assert.strictEqual(cfg.checkinTime, '21:05');
    assert.strictEqual(cfg.autoRetry, false, '之前关闭的重试开关要保持');
    assert.ok(cfg.accessToken, 'token 仍在');
  });

  await test('POST /api/settings 非法时间返回 400 且不写坏配置', async () => {
    const before = loadConfig(configPath).checkinTime;
    const r = await req(port, 'POST', '/api/settings', { checkinTime: 'abc' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(loadConfig(configPath).checkinTime, before, '非法值不应落盘');
  });

  await test('GET /api/logs 返回倒序记录与标签', async () => {
    const r = await req(port, 'GET', '/api/logs?limit=10');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items.length, 2);
    assert.strictEqual(r.body.items[0].action, 'already');
    assert.strictEqual(r.body.items[0].label, '今日已签');
    assert.ok(r.body.path.endsWith('checkin-log.jsonl'));
  });

  await test('GET /api/summary 汇总本月天数与上次签到', async () => {
    const r = await req(port, 'GET', '/api/summary');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.monthDays, 1, '同一天只算 1 天');
    assert.ok(r.body.lastCheckin);
  });

  await test('POST /api/logs/clear 清空日志', async () => {
    const r = await req(port, 'POST', '/api/logs/clear');
    assert.strictEqual(r.status, 200);
    const after = await req(port, 'GET', '/api/logs');
    assert.strictEqual(after.body.total, 0);
  });

  await test('POST /api/saveConfig 保存新凭证时保留已有设置', async () => {
    const r = await req(port, 'POST', '/api/saveConfig', {
      accessToken: 'NEW_COOKIE_ABCDEFGHIJKLMNOP',
      uid: 'new-uid',
      domain: 'www.codebuddy.cn',
      userAgent: 'NEW-UA',
    });
    assert.strictEqual(r.status, 200);
    const cfg = loadConfig(configPath);
    assert.strictEqual(cfg.accessToken, 'NEW_COOKIE_ABCDEFGHIJKLMNOP');
    assert.strictEqual(cfg.checkinTime, '21:05', '设置必须保留');
    assert.strictEqual(cfg.autoRetry, false, '设置必须保留');
  });

  await test('POST /api/export 返回可解码的凭证码（手机端可直接用）', async () => {
    const cur = loadConfig(configPath);
    const r = await req(port, 'POST', '/api/export');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.code, '应返回 base64 凭证码');
    // 响应体本身不得明文泄露 token（应是编码后的字符串）
    assert.ok(!r.raw.includes(cur.accessToken), '导出响应不得明文包含 token');
    // 解码后应能还原出当前凭证
    const payload = JSON.parse(Buffer.from(r.body.code, 'base64').toString('utf8'));
    assert.strictEqual(payload.accessToken, cur.accessToken);
    assert.strictEqual(payload.uid, cur.uid);
    assert.strictEqual(payload.userAgent, cur.userAgent);
    assert.strictEqual(payload.domain || 'www.codebuddy.cn', cur.domain);
  });

  await test('POST /api/import 能从凭证码恢复凭证且保留其它设置', async () => {
    const code = Buffer.from(
      JSON.stringify({
        v: 1,
        domain: 'www.codebuddy.cn',
        accessToken: 'IMPORTED_TOKEN_FOR_PHONE_ABCDEF',
        uid: 'phone-uid-001',
        userAgent: 'PHONE-UA',
      })
    ).toString('base64');
    const r = await req(port, 'POST', '/api/import', { code });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    const cfg = loadConfig(configPath);
    assert.strictEqual(cfg.accessToken, 'IMPORTED_TOKEN_FOR_PHONE_ABCDEF');
    assert.strictEqual(cfg.uid, 'phone-uid-001');
    assert.strictEqual(cfg.checkinTime, '21:05', '导入凭证不应改动已有的偏好设置');
    // 无效码应被拒绝
    const bad = await req(port, 'POST', '/api/import', { code: 'not-a-valid-code' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.ok, false);
  });

  await test('关闭自动签到后 nextRunAt 为 null', async () => {
    await req(port, 'POST', '/api/settings', { autoCheckin: false });
    const r = await req(port, 'GET', '/api/settings');
    assert.strictEqual(r.body.autoCheckin, false);
    assert.strictEqual(r.body.nextRunAt, null);
  });

  await test('未知路由返回 404', async () => {
    const r = await req(port, 'GET', '/api/nope');
    assert.strictEqual(r.status, 404);
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
