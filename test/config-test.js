'use strict';

// 配置与日志层单测（纯 Node，无需 Electron / GUI）
// 重点守护：保存设置绝不能清空已保存的 token；旧版 config.json 能平滑升级。

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const cfgMod = require('../src/config');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cfg-test-'));
const cfgPath = path.join(tmpDir, 'config.json');

function writeCfg(obj) {
  fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2));
}
function readCfg() {
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

console.log('== 配置 / 日志层测试 ==');

test('缺失文件时返回默认配置（含新增字段）', () => {
  fs.rmSync(cfgPath, { force: true });
  const c = cfgMod.loadConfig(cfgPath);
  assert.strictEqual(c.domain, 'www.codebuddy.cn');
  assert.strictEqual(c.accessToken, '');
  assert.strictEqual(c.autoCheckin, true);
  assert.strictEqual(c.checkinTime, '09:00');
  assert.strictEqual(c.autoRetry, true);
  assert.strictEqual(c.closeToTray, true);
  assert.strictEqual(c.catchUp, true);
});

test('旧版 config.json（无新增字段）可平滑升级', () => {
  writeCfg({ domain: 'www.workbuddy.cn', accessToken: 'COOKIE_ABC', uid: 'u1', userAgent: 'UA-X', autoLaunch: true });
  const c = cfgMod.loadConfig(cfgPath);
  assert.strictEqual(c.accessToken, 'COOKIE_ABC');
  assert.strictEqual(c.userAgent, 'UA-X');
  assert.strictEqual(c.autoLaunch, true);
  assert.strictEqual(c.autoCheckin, true, '新字段应取默认值');
  assert.strictEqual(c.checkinTime, '09:00');
});

test('保存设置不会清空 accessToken / uid / userAgent', () => {
  writeCfg({ domain: 'www.workbuddy.cn', accessToken: 'COOKIE_ABC', uid: 'u1', userAgent: 'UA-X' });
  cfgMod.saveConfig({ autoCheckin: false, checkinTime: '07:30', autoLaunch: true }, cfgPath);
  const c = readCfg();
  assert.strictEqual(c.accessToken, 'COOKIE_ABC', 'token 必须保留');
  assert.strictEqual(c.uid, 'u1', 'uid 必须保留');
  assert.strictEqual(c.userAgent, 'UA-X', 'UA 必须保留（会话与其绑定）');
  assert.strictEqual(c.domain, 'www.workbuddy.cn', '域名必须保留');
  assert.strictEqual(c.autoCheckin, false);
  assert.strictEqual(c.checkinTime, '07:30');
  assert.strictEqual(c.autoLaunch, true);
});

test('保存凭证不会覆盖已保存的设置', () => {
  cfgMod.saveConfig({ autoCheckin: false, checkinTime: '07:30' }, cfgPath);
  cfgMod.saveConfig({ accessToken: 'NEW_COOKIE', uid: 'u2' }, cfgPath);
  const c = readCfg();
  assert.strictEqual(c.accessToken, 'NEW_COOKIE');
  assert.strictEqual(c.checkinTime, '07:30', '设置必须保留');
  assert.strictEqual(c.autoCheckin, false);
});

test('时间规范化：H:MM / 非法值', () => {
  assert.strictEqual(cfgMod.normalizeTime('7:5'), '07:05');
  assert.strictEqual(cfgMod.normalizeTime('9:30'), '09:30');
  assert.strictEqual(cfgMod.normalizeTime('23:59'), '23:59');
  assert.strictEqual(cfgMod.normalizeTime('24:00'), '09:00', '越界回落默认');
  assert.strictEqual(cfgMod.normalizeTime('abc'), '09:00');
  assert.strictEqual(cfgMod.normalizeTime(''), '09:00');
  assert.strictEqual(cfgMod.normalizeTime(null), '09:00');
});

test('坏配置不会把程序带崩（类型错乱自动纠正）', () => {
  writeCfg({ autoCheckin: 'yes', checkinTime: 123, accessToken: null, uid: 5 });
  const c = cfgMod.loadConfig(cfgPath);
  assert.strictEqual(c.autoCheckin, true, '真值字符串转 bool');
  assert.strictEqual(c.checkinTime, '09:00', '非法时间回落');
  assert.strictEqual(c.accessToken, '', 'null token 归一为空串');
  assert.strictEqual(c.uid, '', '数字 uid 归一为空串');
});

test('computeNextRun：关闭自动签到时为 null，开启时晚于当前时间', () => {
  assert.strictEqual(cfgMod.computeNextRun({ autoCheckin: false, checkinTime: '09:00' }), null);
  const now = new Date(2026, 0, 1, 10, 0, 0);
  const next = cfgMod.computeNextRun({ autoCheckin: true, checkinTime: '09:00' }, now);
  assert.ok(next instanceof Date);
  assert.ok(next.getTime() > now.getTime(), '已过点应顺延到明天');
  assert.strictEqual(next.getDate(), 2);
  const sameDay = cfgMod.computeNextRun({ autoCheckin: true, checkinTime: '18:30' }, now);
  assert.strictEqual(sameDay.getDate(), 1);
  assert.strictEqual(sameDay.getHours(), 18);
});

test('readLogs：解析 jsonl、倒序、limit 生效、坏行容错', () => {
  const logFile = cfgMod.logFilePath(cfgPath);
  const lines = [
    { ts: '2026-01-01T01:00:00.000Z', action: 'ok', message: '签到成功', streak_days: 1 },
    'NOT JSON',
    { ts: '2026-01-02T01:00:00.000Z', action: 'already', message: '今天已经签到了' },
    { ts: '2026-01-03T01:00:00.000Z', action: 'error', message: '网络错误' },
  ];
  fs.writeFileSync(logFile, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const all = cfgMod.readLogs(cfgPath, 0);
  assert.strictEqual(all.total, 3, '坏行被跳过');
  assert.strictEqual(all.items[0].action, 'error', '最新的在最前');
  assert.strictEqual(all.items[0].label, '失败', '带中文标签');
  const limited = cfgMod.readLogs(cfgPath, 2);
  assert.strictEqual(limited.items.length, 2);
  assert.strictEqual(limited.items[1].action, 'already');
});

test('stats：本月签到天数与上次签到时间', () => {
  const now = new Date();
  const mk = (d) => new Date(now.getFullYear(), now.getMonth(), d, 9, 0, 0).toISOString();
  const logFile = cfgMod.logFilePath(cfgPath);
  fs.writeFileSync(
    logFile,
    [
      { ts: mk(1), action: 'ok', streak_days: 1 },
      { ts: mk(2), action: 'already', streak_days: 2 },
      { ts: '2020-01-01T00:00:00.000Z', action: 'ok', streak_days: 9 }, // 上个月/往年，不计入本月
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n'
  );
  const s = cfgMod.computeStats(cfgPath, { autoCheckin: true, checkinTime: '09:00' });
  assert.strictEqual(s.monthDays, 2, '本月应有 2 天');
  assert.ok(s.lastCheckin, '应有上次签到时间');
  assert.ok(s.nextRunAt, '应给出下次执行时间');
});

test('统计标识与用量计数：默认值、只生成一次、不碰凭证', () => {
  writeCfg({ accessToken: 'COOKIE_ABC', uid: 'u1', userAgent: 'UA-X' });
  const c0 = cfgMod.loadConfig(cfgPath);
  assert.strictEqual(c0.ownerId, '', '旧配置没有统计标识');
  assert.deepStrictEqual(c0.usage, { pairCreated: 0, exportCount: 0, importCount: 0 });

  const id = cfgMod.ensureOwnerId(cfgPath);
  assert.ok(/^[a-f0-9]{32}$/.test(id), '应生成 32 位 hex');
  assert.strictEqual(cfgMod.ensureOwnerId(cfgPath), id, '多次调用复用同一个标识');

  cfgMod.bumpUsage(cfgPath, 'pairCreated');
  cfgMod.bumpUsage(cfgPath, 'pairCreated');
  cfgMod.bumpUsage(cfgPath, 'notAKey'); // 未知键忽略
  const c1 = readCfg();
  assert.strictEqual(c1.usage.pairCreated, 2);
  assert.strictEqual(c1.usage.exportCount, 0);
  assert.strictEqual(c1.accessToken, 'COOKIE_ABC', '写统计不能清空 token');
  assert.strictEqual(c1.userAgent, 'UA-X');

  cfgMod.saveConfig({ ownerId: 'not-a-valid-id' }, cfgPath);
  assert.strictEqual(readCfg().ownerId, '', '非法标识归一为空，坏值不落盘');
});

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`结果: ${results.length - failed.length} 通过 / ${failed.length} 失败`);

// 清理临时目录
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (_) {}

process.exit(failed.length ? 1 : 0);
