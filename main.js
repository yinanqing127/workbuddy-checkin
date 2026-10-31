'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const electronApi = require('electron');

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification } = electronApi;

// 如果 ELECTRON_RUN_AS_NODE=1，Electron 会退化为普通 Node，
// require('electron') 只返回一个路径字符串，app 为 undefined。
if (!app) {
  console.error(
    '\n[启动失败] 当前环境变量 ELECTRON_RUN_AS_NODE 被设置，Electron 退化成了普通 Node。\n' +
      '请先在终端执行以下命令再启动：\n' +
      '    set ELECTRON_RUN_AS_NODE=\n' +
      '然后重新运行 start-app.bat（该脚本已自动处理此问题）。\n'
  );
  process.exit(1);
}

// 固定用户数据目录。
// 原因：Electron 的 userData 路径取自应用名；打包后因 productName 变更（可能含中文与空格）
// 会让路径改变，导致之前保存的登录凭证"丢失"。这里显式钉成固定目录，
// 既保持开发与安装后一致，也让已有的凭证/UA 配置直接沿用。
const STABLE_DATA_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'workbuddy-checkin-electron')
  : path.join(os.homedir(), '.workbuddy-checkin-electron');
app.setPath('userData', STABLE_DATA_DIR);

const {
  createApiServer,
  loadConfig,
  applyAutoLaunch,
  parseTime,
  computeNextRun,
  logFilePath,
} = require('./src/config');
const { runCheckin, fetchStatus } = require('./src/checkin');

const PORT = 3000;

let mainWindow = null;
let tray = null;
let lastAutoDay = ''; // 已触发自动签到的日期 YYYY-MM-DD
let logPath = null;
let isQuiting = false;
let credsExpired = false; // 凭证过期标记，用于托盘提示
let todaySigned = null; // 今日是否已签（null = 未知）
let lastStats = null; // 最近一次统计（连续天数等）
let autoRunning = false; // 防止自动签到并发

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayKey(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function updateTrayTip() {
  if (!tray) return;
  let tip = 'WorkBuddy 每日签到';
  if (credsExpired) {
    tip += ' — 凭证已过期，请重新粘贴';
  } else if (todaySigned === true) {
    const s = lastStats && lastStats.streak_days != null ? lastStats.streak_days : '-';
    tip += ` — 今日已签（连续 ${s} 天）`;
  } else if (todaySigned === false) {
    tip += ' — 今日未签';
  }
  try {
    const cfg = loadConfig();
    if (cfg.autoCheckin) {
      const next = computeNextRun(cfg);
      if (next) {
        const hh = String(next.getHours()).padStart(2, '0');
        const mm = String(next.getMinutes()).padStart(2, '0');
        const dayDiff = todayKey(next) === todayKey() ? '今天' : '明天';
        tip += ` · 下次 ${dayDiff} ${hh}:${mm}`;
      }
    } else {
      tip += ' · 自动签到已关闭';
    }
  } catch (_) {}
  tray.setToolTip(tip);
}

function markCredsExpired(expired) {
  credsExpired = expired;
  updateTrayTip();
}

// Windows 原生通知（Toast）。失败静默降级，绝不影响签到流程。
function notify(title, body) {
  try {
    if (typeof Notification === 'undefined' || !Notification.isSupported || !Notification.isSupported()) return;
    if (!loadConfig().desktopNotify) return;
    const n = new Notification({ title, body });
    n.show();
  } catch (_) {
    /* 通知失败不应打断主流程 */
  }
}

// 自启时的"静默启动"（只留托盘、不弹窗）判定：
// ① 快捷方式/登录项带 --hidden 开关；② Windows/macOS 登录项启动时 Electron 自带的官方标记。
function detectStartHidden() {
  if (process.argv.includes('--hidden')) return true;
  try {
    const s = typeof app.getLoginItemSettings === 'function' ? app.getLoginItemSettings() : null;
    if (s && s.wasOpenedAtLogin) return true;
  } catch (_) {}
  return false;
}

const startHidden = detectStartHidden();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 420,
    minHeight: 620,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setTitle('WorkBuddy 每日签到'); // 明确窗口标题（安装前后一致）
  // 关闭窗口的行为跟随设置：最小化到托盘（默认）或直接退出
  mainWindow.on('close', (e) => {
    if (isQuiting) return;
    let toTray = true;
    try {
      toTray = loadConfig().closeToTray;
    } catch (_) {}
    if (toTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  else if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 打包后资源在 app.asar 里，而 nativeImage.createFromPath 走的是原生 IO，读不到 asar 内的文件，
// 会得到空图片并让 new Tray() 抛错、应用静默退出。所以先把图标复制到真实磁盘再加载。
function resolveTrayIcon() {
  try {
    const src = path.join(__dirname, 'assets', 'tray-icon.png');
    const dst = path.join(app.getPath('userData'), 'tray-icon.png');
    fs.copyFileSync(src, dst); // 读取 asar 内的文件由 Electron 打过补丁的 fs 处理
    return dst;
  } catch (_) {
    try {
      return path.join(__dirname, 'assets', 'tray-icon.png');
    } catch (_e) {
      return '';
    }
  }
}

function createTray() {
  if (tray) return;
  try {
    let img = nativeImage.createFromPath(resolveTrayIcon());
    if (!img || img.isEmpty()) {
      img = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC'
      );
    }
    tray = new Tray(img);
    const ctxMenu = Menu.buildFromTemplate([
      { label: '打开窗口', click: () => showWindow() },
      {
        label: '立即签到',
        click: () => {
          showWindow();
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('trigger-checkin');
          }
        },
      },
      { type: 'separator' },
      {
        label: '打开日志文件夹',
        click: () => {
          try {
            if (logPath && fs.existsSync(logPath)) shell.showItemInFolder(logPath);
            else shell.openPath(app.getPath('userData'));
          } catch (_) {}
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => { isQuiting = true; app.quit(); } },
    ]);
    tray.setContextMenu(ctxMenu);
    tray.on('click', () => showWindow());
    updateTrayTip();
  } catch (e) {
    // 托盘创建失败不应该让整个程序退出（否则自动签到也就没了）
    console.error('[workbuddy-checkin] 托盘创建失败:', e && e.message);
    tray = null;
  }
}

function appendLog(result) {
  if (!logPath) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...result }) + '\n';
  try {
    // 简单轮转：超过 1MB 就把旧文件挪成 .1（只保留一份历史），避免日志无穷增长
    try {
      const st = fs.statSync(logPath);
      if (st.size > 1024 * 1024) fs.renameSync(logPath, logPath + '.1');
    } catch (_) {}
    fs.appendFileSync(logPath, line);
  } catch (_) {}
}

function notifyRenderer(payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('checkin-done', payload);
  }
}

/** 查询一次真实状态并同步到托盘/界面；返回 status 结果 */
async function syncStatus() {
  const cfg = loadConfig();
  if (!cfg.accessToken) {
    todaySigned = false;
    updateTrayTip();
    return { action: 'need_token' };
  }
  try {
    const r = await fetchStatus({
      accessToken: cfg.accessToken,
      uid: cfg.uid,
      domain: cfg.domain,
      userAgent: cfg.userAgent,
    });
    if (r && r.action === 'already') {
      todaySigned = true;
      lastStats = r;
      markCredsExpired(false);
    } else if (r && r.action === 'token_expired') {
      markCredsExpired(true);
    } else if (r && r.action !== 'error') {
      todaySigned = false;
      lastStats = r;
      markCredsExpired(false);
    }
    updateTrayTip();
    return r || { action: 'error' };
  } catch (e) {
    return { action: 'error', message: e.message };
  }
}

/**
 * 执行一次"自动签到"：
 * 先查状态（已签就不重复请求，避免日志噪音），未签则签到，失败按设置自动重试。
 * @param {string} trigger 'schedule'(到点) | 'catchup'(补签)
 */
async function runAutoCheckin(trigger) {
  if (autoRunning) return null;
  autoRunning = true;
  try {
    const cfg = loadConfig();
    if (!cfg.accessToken) {
      appendLog({ action: 'need_token', message: '未配置凭证，跳过自动签到', trigger });
      return { action: 'need_token' };
    }
    const st = await syncStatus();
    if (st.action === 'already') {
      // 今天已经签过，直接返回，不再产生签到请求
      notifyRenderer({ action: 'already', trigger, silent: true, ...st });
      return st;
    }
    if (st.action === 'token_expired') {
      appendLog({ action: 'token_expired', message: '登录态已过期，未能自动签到', trigger });
      return st;
    }

    const maxAttempts = cfg.autoRetry ? (Math.max(1, Math.min(5, Number(cfg.maxRetries) || 3))) : 1;
    let last = null;
    for (let i = 1; i <= maxAttempts; i++) {
      const res = await runCheckin({
        accessToken: cfg.accessToken,
        uid: cfg.uid,
        domain: cfg.domain,
        userAgent: cfg.userAgent,
      }).catch((e) => ({ action: 'error', message: e.message }));
      last = res;
      appendLog({ ...res, trigger, attempt: i });
      if (res.action !== 'error') {
        todaySigned = true;
        if (res.streak_days != null) lastStats = res;
        markCredsExpired(res.action === 'token_expired');
        updateTrayTip();
        notifyRenderer({ ...res, trigger });
        // 仅"自动触发"（定时/补签）才弹系统通知，手动点击不打扰
        if (trigger === 'schedule' || trigger === 'catchup') {
          if (res.action === 'ok') {
            notify('WorkBuddy 每日签到', `自动签到成功${res.streak_days != null ? `，连续 ${res.streak_days} 天` : ''}`);
          } else if (res.action === 'token_expired') {
            notify('WorkBuddy 签到提醒', '登录态已过期，请在桌面端重新粘贴一次凭证');
          }
        }
        return res;
      }
      if (i < maxAttempts) await sleep(1500 * i);
    }
    notifyRenderer({ ...(last || { action: 'error' }), trigger });
    if (trigger === 'schedule' || trigger === 'catchup') {
      notify('WorkBuddy 签到失败', (last && last.message) || '自动签到失败，可在程序内手动重试');
    }
    return last;
  } finally {
    autoRunning = false;
  }
}

function startAutoScheduler() {
  const tick = async () => {
    const now = new Date();
    const day = todayKey(now);
    const cfg = loadConfig();
    if (!cfg.autoCheckin) return; // 自动签到已关闭
    if (lastAutoDay === day) return; // 今天已执行过
    const { hour, minute } = parseTime(cfg.checkinTime);
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    const diff = now.getTime() - target.getTime();
    if (diff < 0) return; // 还没到点
    // 关闭"补签"时只在到点后 5 分钟内执行，避免很晚才开程序时突然签到
    if (!cfg.catchUp && diff > 5 * 60 * 1000) {
      lastAutoDay = day;
      return;
    }
    lastAutoDay = day;
    await runAutoCheckin(diff > 5 * 60 * 1000 ? 'catchup' : 'schedule');
  };
  // 启动 5 秒后先判定一次（覆盖"到点时电脑关机"的情况），之后每 30 秒检查
  setTimeout(tick, 5 * 1000);
  setInterval(tick, 30 * 1000);
}

// 保活探测：覆盖"错过时间点"的空档。仅读取状态接口，无副作用。
// 对"滑动过期"的会话可显著延长有效期；对"固定到期日"无效（那需要官方长期令牌）。
function startKeepAlive() {
  const tick = async () => {
    await syncStatus();
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 12 * 60 * 60 * 1000);
}

// 单实例锁：避免重复双击导致 3000 端口被占用而崩溃
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  logPath = logFilePath(path.join(userData, 'config.json'));
  const configPath = path.join(userData, 'config.json');

  // 让系统登录项与已保存的偏好保持一致（以防外部改动）
  try {
    const cfg = loadConfig(configPath);
    applyAutoLaunch(!!cfg.autoLaunch);
  } catch (_) {}

  const server = createApiServer({
    port: PORT,
    configPath,
    onCheckinResult: appendLog,
    onSettingsChanged: () => {
      // 设置变更后立即刷新托盘提示（下次签到时间 / 自动签到开关）
      updateTrayTip();
    },
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(
        `[workbuddy-checkin] 端口 ${PORT} 已被占用（可能有另一个实例在运行），本地接口未启动。\n` +
          `请关闭已运行的程序后重试，或重启电脑后再打开。`
      );
    } else {
      console.error('[workbuddy-checkin] 本地接口启动失败:', err);
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[workbuddy-checkin] 本地接口已启动: http://127.0.0.1:${PORT}`);
  });

  createTray();
  // 自启（--hidden）时只留在托盘；正常双击才弹窗
  if (!startHidden) createWindow();
  startAutoScheduler();
  startKeepAlive();
  // 启动后异步探一次状态，让托盘提示与界面尽快准确
  setTimeout(() => {
    syncStatus();
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 有托盘 / 自启隐藏实例时不自动退出，保留后台自动签到；仅 macOS 按系统惯例退出
  if (process.platform !== 'darwin' && !startHidden) {
    let toTray = true;
    try {
      toTray = loadConfig().closeToTray;
    } catch (_) {}
    if (!toTray) app.quit();
  }
});
