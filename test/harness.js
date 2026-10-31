'use strict';

// 无 GUI headless 测试：用 mock 服务器覆盖 ok / already / expired / error / network-error / need_token
// 六个分支；若提供环境变量 ACCESS_TOKEN + UID 则再直连真实接口验证一次。
//
// 运行： node test/harness.js
// 真实： ACCESS_TOKEN=xxx UID=yyy node test/harness.js

const { runCheckin } = require('../src/checkin');
const { createMockServer } = require('./mock-server');

let passed = 0;
let failed = 0;

async function runCase(name, fn) {
  try {
    const ok = await fn();
    if (ok) {
      passed++;
      console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    } else {
      failed++;
      console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
    }
  } catch (e) {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (异常: ${e.message})`);
  }
}

async function withMock(mode, fn) {
  const server = createMockServer(mode);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const apiBase = `http://127.0.0.1:${port}`;
  try {
    return await fn(apiBase);
  } finally {
    server.close();
  }
}

function assertAction(name, expect, result) {
  const ok = result.action === expect;
  if (!ok) console.log(`       期望 action=${expect}, 实际=${result.action} (msg: ${result.message})`);
  return ok;
}

async function main() {
  console.log('== WorkBuddy 签到逻辑 headless 测试 ==');

  await runCase('空凭证 → need_token', async () => {
    const r = await runCheckin({ accessToken: '', uid: '' });
    return assertAction('空凭证', 'need_token', r);
  });

  await runCase('正常未签 → 签到成功 ok', async () => {
    return withMock('ok', async (base) => {
      const r = await runCheckin({ accessToken: 't', uid: 'u', apiBase: base });
      const ok = assertAction('正常未签', 'ok', r);
      return ok && r.streak_days === 5 && r.today_credit === 10 && r.total_credits === 120;
    });
  });

  await runCase('已签到 → already', async () => {
    return withMock('already', async (base) => {
      const r = await runCheckin({ accessToken: 't', uid: 'u', apiBase: base });
      return assertAction('已签到', 'already', r);
    });
  });

  await runCase('token 过期 → token_expired', async () => {
    return withMock('expired', async (base) => {
      const r = await runCheckin({ accessToken: 't', uid: 'u', apiBase: base });
      return assertAction('token过期', 'token_expired', r);
    });
  });

  await runCase('服务端 500 → error', async () => {
    return withMock('error', async (base) => {
      const r = await runCheckin({ accessToken: 't', uid: 'u', apiBase: base });
      return assertAction('服务端错误', 'error', r);
    });
  });

  await runCase('网络不可达 → error', async () => {
    const r = await runCheckin({ accessToken: 't', uid: 'u', apiBase: 'http://127.0.0.1:1' });
    return assertAction('网络错误', 'error', r);
  });

  // 真实链路（可选）
  if (process.env.ACCESS_TOKEN && process.env.UID) {
    await runCase('真实接口直连', async () => {
      const r = await runCheckin({ accessToken: process.env.ACCESS_TOKEN, uid: process.env.UID });
      console.log('       真实返回:', JSON.stringify(r));
      return ['ok', 'already', 'token_expired', 'error'].includes(r.action);
    });
  }

  console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
