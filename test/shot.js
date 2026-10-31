'use strict';

// 仅用于开发期截图核对界面布局（不参与打包、不影响正式代码）。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 用于截图核对「使用统计」面板排版（在渲染进程里 stub 掉两个请求，不依赖线上数据）
const mockStats = {
  ok: true,
  updatedAt: Date.now(),
  totals: { devices: 2, claims: 3, codes: 3, checkins: 6, activeToday: 1, signedToday: 1 },
  devices: [
    {
      id: 'a1b2c3d4e5f60718',
      platform: 'android',
      browser: 'Chrome',
      firstAt: Date.now() - 2 * 86400000,
      lastAt: Date.now() - 4 * 60000,
      claims: 2,
      checkins: 4,
      lastResult: 'ok',
      lastCheckinAt: Date.now() - 4 * 60000,
      streak: 6,
      todayCredit: 100,
    },
    {
      id: 'ffff000011112222',
      platform: 'ios',
      browser: 'Safari',
      firstAt: Date.now() - 5 * 3600000,
      lastAt: Date.now() - 26 * 3600000,
      claims: 1,
      checkins: 2,
      lastResult: 'idle',
      lastCheckinAt: 0,
      streak: 2,
      todayCredit: 0,
    },
  ],
  codes: [
    { mask: 'K7••••4X', at: Date.now() - 5 * 60000, claims: 3, lastClaimAt: Date.now() - 3 * 60000, status: 'used' },
    { mask: 'M2••••9Q', at: Date.now() - 3600000, claims: 0, lastClaimAt: 0, status: 'expired' },
  ],
  persisted: true,
};

const OUT = os.tmpdir();
const STATUS = path.join(OUT, 'wb-shot-status.txt');
const log = (m) => {
  try {
    fs.appendFileSync(STATUS, `[${new Date().toISOString()}] ${m}\n`);
  } catch (_) {}
};

fs.writeFileSync(STATUS, 'start\n');

const tmp = fs.mkdtempSync(path.join(OUT, 'wb-shot-'));
try {
  app.setPath('userData', tmp);
  log('userData set ' + tmp);
} catch (e) {
  log('setPath failed ' + e.message);
}

process.env.WB_MOBILE_SHARE = 'SHOTSHARE';
const { createApiServer } = require('../src/config');


process.on('uncaughtException', (e) => log('UNCAUGHT ' + (e.stack || e)));
process.on('unhandledRejection', (e) => log('UNHANDLED ' + (e && e.stack ? e.stack : e)));

app.whenReady().then(async () => {
  log('whenReady');
  const configPath = path.join(tmp, 'config.json');
  const now = Date.now();
  const lines = [
    { ts: new Date(now - 3600 * 1000).toISOString(), action: 'ok', message: '签到成功', streak_days: 3, today_credit: 100, trigger: 'schedule' },
    { ts: new Date(now - 1800 * 1000).toISOString(), action: 'already', message: '今天已经签到啦', streak_days: 3, today_credit: 100 },
    { ts: new Date(now - 600 * 1000).toISOString(), action: 'error', message: '网络不可达', trigger: 'catchup', attempt: 2 },
  ];
  fs.writeFileSync(path.join(tmp, 'checkin-log.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      domain: 'www.workbuddy.cn',
      accessToken: 'FAKE_COOKIE_FOR_SHOT=0123456789abcdef',
      uid: 'shot-uid',
      userAgent: 'UA-SHOT',
      checkinTime: '09:00',
      autoCheckin: true,
      autoLaunch: false,
      autoRetry: true,
      closeToTray: true,
      catchUp: true,
      desktopNotify: true,
      maxRetries: 3,
      theme: 'system',
    }),
    'utf8'
  );

  const server = createApiServer({ port: 3000, configPath });
  await new Promise((resolve) => {
    server.on('error', (e) => {
      log('server error ' + e.message);
      resolve();
    });
    server.listen(3000, '127.0.0.1', () => {
      log('server listening');
      resolve();
    });
  });

  const win = new BrowserWindow({
    width: 480,
    height: 760,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  log('window created');

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    log('loaded');
  } catch (e) {
    log('load error ' + e.message);
  }

  await new Promise((r) => setTimeout(r, 2000));
  log('waited');

  // 在页面里 stub 两个请求，保证截图内容稳定（不依赖线上服务或本机 3000 端口是否被占用）
  try {
    await win.webContents.executeJavaScript(`(() => {
      const mockStats = ${JSON.stringify(mockStats)};
      const local = { ownerIdShort: 'a1b2c3', pairCreated: 3, exportCount: 1, importCount: 0, hasToken: true };
      const orig = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = String(input);
        if (url.indexOf('/api/usage-stats') >= 0) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true, local, remote: mockStats }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (url.indexOf('/api/pair-create') >= 0) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true, code: 'K7M2QP4X', expiresIn: 600 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return orig(input, init);
      };
    })()`);
    log('stubbed fetch');
  } catch (e) {
    log('stub error ' + e.message);
  }

  const shot = async (name) => {
    try {
      const img = await win.capturePage();
      const p = path.join(OUT, name);
      fs.writeFileSync(p, img.toPNG());
      log('SHOT ' + p + ' bytes=' + img.toPNG().length);
    } catch (e) {
      log('shot ' + name + ' error ' + e.message);
    }
  };

  await shot('wb-main.png');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const isOpen = async (id) => js(`!document.getElementById('${id}').classList.contains('hidden')`);

  try {
    // 1) 点「设置」打开
    await js("document.getElementById('settings-btn').click()");
    await sleep(700);
    await shot('wb-settings.png');
    log('ASSERT 首次点「设置」 -> ' + ((await isOpen('settings-panel')) ? 'open(OK)' : 'closed(FAIL)'));

    await js("document.getElementById('pair-btn').click()");
    await sleep(1200);
    await shot('wb-settings-pair.png');

    // 2) 关键回归：再点一次「设置」应关闭并返回主界面
    await js("document.getElementById('settings-btn').click()");
    await sleep(350);
    log('ASSERT 再点「设置」 -> ' + ((await isOpen('settings-panel')) ? 'open(FAIL)' : 'closed(OK)'));

    // 3) 其它入口按钮行为一致：点开 → 再点关闭
    await js("document.getElementById('logs-btn').click()");
    await sleep(500);
    await shot('wb-logs.png');
    await js("document.getElementById('logs-btn').click()");
    await sleep(300);
    log('ASSERT 再点「运行日志」 -> ' + ((await isOpen('logs-panel')) ? 'open(FAIL)' : 'closed(OK)'));

    await js("document.getElementById('credential-btn').click()");
    await sleep(500);
    await shot('wb-credential.png');
    await js("document.getElementById('credential-btn').click()");
    await sleep(300);
    log('ASSERT 再点「登录凭证」 -> ' + ((await isOpen('credential-panel')) ? 'open(FAIL)' : 'closed(OK)'));

    // 4) 使用统计面板
    win.setContentSize(480, 1180);
    await js("document.getElementById('stats-btn').click()");
    await sleep(900);
    await js("document.getElementById('stats-panel').scrollIntoView({block:'start'})");
    await sleep(250);
    await shot('wb-stats.png');
    await js("document.getElementById('stats-btn').click()");
    await sleep(300);
    log('ASSERT 再点「使用统计」 -> ' + ((await isOpen('stats-panel')) ? 'open(FAIL)' : 'closed(OK)'));

    const m = await js(
      'JSON.stringify({scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight})'
    );
    log('METRICS ' + m);
  } catch (e) {
    log('panel flow error ' + e.message);
  }

  log('done');
  setTimeout(() => app.exit(0), 200);
});
