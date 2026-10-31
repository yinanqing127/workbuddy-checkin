# WorkBuddy 每日签到 · 桌面端（不依赖微信环境）

一个 **Electron 桌面程序**，内置「每日签到」按钮：点击即触发真实签到请求，带成功 / 失败 / 已签 / 凭证过期状态反馈与重试机制，并支持 **自定义时间的自动签到**。

完全本地运行，**无需微信账号、无需 AppID、无需云开发**。

- **独立设置面板**：主界面右上角有显眼的「设置」按钮，自动签到开关 / 时间 / 开机自启等偏好都在这里；**设置与登录凭证完全分离**，改设置不会跳转凭证页、也不会要求重新输入 token。
- **自定义自动签到时间**：任意 `HH:MM`，可随时开关；修改后立即按新时间重新调度，并持久保存到本地配置。
- **开机自启**：登录系统后在**托盘静默运行**（不弹窗），保证自动签到不因忘记打开程序而失效。
- **托盘常驻**：关闭窗口默认最小化到托盘而非退出，后台定时器继续跑；右键可「打开窗口 / 立即签到 / 打开日志文件夹 / 退出」。
- **运行日志**：内置日志面板，可按时间倒序查看每次签到结果（成功 / 已签 / 失败 / 过期 / 定时或补签 / 第几次重试），支持刷新、清空、打开日志文件夹。
- **失败自动重试**：自动签到失败时最多重试 3 次（指数退避）；手动签到失败也有「重试」按钮。
- **错过时间补签**：若到点时电脑关机/睡眠，开机后会补签当天一次（可关闭）。

---

## 一、运行步骤

> 前置：已安装 Node.js 22+（本项目在 Node v22.x 验证）。

**最省事的方式：直接双击 `start-app.bat`。** 它会自动检测并修复 Electron 引擎，然后启动窗口。

手动命令方式：

```bash
cd workbuddy-checkin-electron
npm install --ignore-scripts   # 只装 JS 包，跳过被 npm 拦截的安装脚本
node scripts/setup-electron.js # 直连国内 CDN 下载 Electron 引擎并解压
npm start                      # 打开签到窗口
```

首次打开时按钮为禁用状态，提示「请先配置 Token」——这是正常的，下一步配置一次即可。

---

## 二、获取并配置 Token（只需一次）

由于 WorkBuddy 桌面客户端的本地登录态已加密，无法自动读取 token，因此需要**手动从网页版复制一次**：

1. 浏览器打开 WorkBuddy 网页版并登录。
2. 按 `F12` → `Network`（网络）面板。
3. 随便点一下触发一个请求，在请求头里找到：
   - `Authorization: Bearer eyJ...`（复制 `Bearer ` 后面的整串）
   - `X-User-Id: 123456`（复制数值）
4. 在小程序主界面点「设置 Token」，把上面两项分别粘贴到 `accessToken` 和 `uid`，保存。
5. 回到主界面点「立即签到」验证。

以后 token 失效（返回"登录态已过期"）时，重复上述步骤重填一次即可。

---

## 三、自动签到

- **时间可自定义**：默认 `09:00`，在「设置」里改成任意 `HH:MM`；关闭「自动签到」开关即完全不自动执行。
- 调度逻辑：主进程每 30 秒检查一次，一旦到达当天设定时间且今天还没执行过，就触发一次；修改时间后按新时间重新计算，不需要重启程序。
- **执行前先查状态**：到点后先调状态接口，若今天已签则直接返回，不会重复发签到请求、也不污染日志。
- **错过时间会补签**：若到点时电脑关机/睡眠，下次启动（含开机自启）会补签当天一次；关掉「错过时间自动补签」则只在到点后 5 分钟内执行，避免很晚才开程序时突然签到。
- **失败自动重试**：网络抖动等原因失败时，最多重试 3 次（1.5s / 3s 退避），可在设置里关闭。
- 每次自动 / 手动签到结果都会写入日志：
  `<用户数据目录>/checkin-log.jsonl`（每行一条 JSON，超过 1 MB 自动轮转为 `.1`）。

### 界面结构（设置 / 日志 / 凭证 / 统计四个面板互不影响）

| 入口 | 位置 | 作用 |
| --- | --- | --- |
| **设置** | 主界面右上角独立按钮（齿轮图标） | 自动签到开关、每天签到时间、错过补签、失败自动重试、开机自启、关闭窗口是否最小化到托盘、桌面通知、重试次数、主题、手机端同步。**不含任何凭证输入框**，保存时也不会动 token |
| **运行日志** | 主界面「立即签到」下方文字链接 | 倒序查看最近 100 条记录，支持刷新 / 清空 / 打开日志文件夹 |
| **登录凭证** | 主界面文字链接（仅此一处） | 粘贴 cURL / token / Cookie 更新凭证。设置按钮**永远不会**把你带到这里 |
| **使用统计** | 主界面「立即签到」下方文字链接 | 有多少台手机用你的配对码同步过凭证、之后有没有签到成功（见第十四节） |

> 四个入口的行为完全一致：**点一次打开，再点同一个入口即可关闭并返回主界面**（面板右上角的「关闭」、Esc 等价）。
> 入口在面板打开时保持高亮，便于看出"再点一次就收起"。
>
> 设置页底部只显示一行只读状态「登录凭证：已配置（无需重新输入）」，不会索取或清空任何凭证。

### 托盘与窗口

- 程序启动后会在系统托盘常驻一个绿色图标：
  - **右键** →「打开窗口 / 立即签到 / 打开日志文件夹 / 退出」。
  - **左键单击** → 打开（或聚焦）窗口。
- 托盘提示实时反映状态：`今日已签（连续 N 天）`、`今日未签`、`凭证已过期`，并附「下次 今天/明天 HH:MM」；关闭自动签到时显示 `自动签到已关闭`。
- 关闭窗口默认**最小化到托盘**（可在设置里改成「关闭即退出」）；真正退出请通过托盘菜单的「退出」。

### 关于"token 过期"与保活

- **客户端无法生成永不过期的 token**：登录态（`session` Cookie）的有效期由 WorkBuddy 服务器控制，本地程序不能自己造长期凭证。任何"永久 token"都得是 WorkBuddy 官方下发的（如账号设置里的 API / 个人令牌）。
- 本程序已做两套"延长有效期"的机制，尽量让你少粘：
  1. **每天 09:00 自动签到**本身就在"碰"服务器，对**滑动过期**（有活动就顺延）的会话可一直保持有效——前提是那会儿电脑开机。
  2. **保活探测**：启动约 1 分钟后、之后每 12 小时再探一次状态接口，覆盖"09:00 没开机"的空档。
- 若 WorkBuddy 用的是**固定到期日**（写死某天失效，与活动无关），以上都不管用，届时只能重粘一次（现在支持整段 cURL 一键解析，已比手填省事很多）。建议去 WorkBuddy 账号设置里看看有没有可长期使用的 API 令牌。

---

## 四、自测（无需安装 Electron / 无 GUI）

```bash
npm run test:all      # 一次跑完下面三组
```

| 测试 | 命令 | 覆盖内容 |
| --- | --- | --- |
| 签到逻辑 | `npm run test:logic` | 6 分支：need_token / ok / already / expired / error / 网络不可达（内置 mock 服务器） |
| 配置与日志 | `npm run test:config` | 默认值、旧配置平滑升级、**保存设置不清空 token**、时间规范化、坏配置容错、下次执行时间、日志解析、月度统计 |
| 本地 API | `npm run test:api` | 11 项：设置读写 / 局部更新 / 非法时间 400 / 日志读取清空 / 汇总统计 / saveConfig 保留设置 / token 不外泄 / 404 |

若要验证真实接口连通性，设置环境变量后运行（**不会改动签到状态，接口幂等**）：

```bash
ACCESS_TOKEN="eyJ..." UID="123456" npm run test:logic
```

界面截图核对（开发用，输出到系统临时目录）：

```bash
npm run shot   # 生成 wb-main / wb-settings / wb-logs / wb-credential 四张截图
```

---

## 五、项目结构

```
workbuddy-checkin-electron/
├── start-app.bat        # 一键启动开发环境（自动修复 Electron 引擎）
├── run-tests.bat        # 一键跑逻辑测试
├── build-setup.bat      # 一键打包：生成 dist\WorkBuddyCheckin-Setup-<版本>.exe
├── main.js              # 主进程：窗口 + 本地 API 服务 + 09:00 调度 + 托盘 + 开机自启
├── preload.js          # 安全桥（暴露本地 API 地址 + 托盘"立即签到"事件）
├── package.json        # 依赖、脚本、electron-builder 打包配置（build 字段）
├── build/
│   └── installer.nsh   # 自定义 NSIS 逻辑：卸载/重装时清理残留的开机自启注册表项
├── scripts/
│   ├── setup-electron.js  # 直连国内 CDN 下载并解压 Electron 引擎
│   ├── make-icon.js       # 生成托盘图标 assets/tray-icon.png（纯 Node，无外部依赖）
│   └── make-winicon.js    # 生成 Windows 应用图标 assets/icon.ico（16~256 多尺寸）
├── assets/
│   ├── tray-icon.png   # 托盘图标
│   └── icon.ico        # 安装包 / exe / 快捷方式图标
├── src/
│   ├── checkin.js      # 共享签到逻辑（HTTPS 请求 + 状态机判定），可被测试复用
│   └── config.js       # 配置读写 + 本地 API 服务器 + 开机自启注册
├── renderer/
│   ├── index.html      # UI 结构 + CSP（含开机自启开关）
│   ├── renderer.js     # 状态机 + 退避重试 + 配置保存 + 自启开关
│   └── styles.css      # WorkBuddy 绿 (#07c160) 样式
└── test/
    ├── mock-server.js  # 模拟 WorkBuddy API（ok/already/expired/error）
    ├── harness.js      # 无 GUI headless 签到逻辑测试
    ├── config-test.js  # 配置/日志层单测（含"保存设置不清 token"红线）
    ├── api-test.js     # 本地 API 层测试（设置/日志/汇总）
    └── shot.js         # 开发期界面截图（不参与打包）
```

---

## 六、安全说明

- 采用 `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，渲染进程（页面）**接触不到** token 与任何 Node API。
- token 以明文保存在本机 `<用户数据目录>/config.json`（个人单机使用，风险可控）。后续如需可改用 `electron.safeStorage` 加密存储。
- 所有对外请求均由主进程发出，绕开浏览器 CORS 限制。

---

## 七、已知限制

- **自动签到依赖程序运行**：09:00 若已退出则当天不补签。已提供「开机自动启动」开关（注册系统登录项 + 托盘常驻），勾选后基本可保证每天自动签到生效；极端情况（如系统休眠到 09:00 整点）仍可能错过。
- **token 有效期**：WorkBuddy 的 `session` Cookie 由服务器控制过期（客户端无法造假）。已用"每日 09:00 签到 + 每 12 小时保活探测"尽量延长滑动过期会话的寿命；若为固定到期日则仍需重粘（支持整段 cURL 一键解析）。真正的长期免维护需 WorkBuddy 官方提供 API 令牌。
- 本仓库既交付源码（`npm install && npm start` 可看 GUI），也提供免依赖的 Windows 安装包（见第九节）。

---

## 八、常见问题（均已在本项目内置修复）

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `Electron failed to install correctly, please delete node_modules/electron...` | npm 新版本默认**禁止依赖执行安装脚本**（`npm warn install-scripts`），Electron 的下载脚本被拦，只装了空壳 | 运行 `node scripts/setup-electron.js`，或直接双击 `start-app.bat`（会自动修复） |
| 安装时 `RequestError: getaddrinfo ENOTFOUND github.com` | Electron 默认从 GitHub 拉二进制，国内网络不通 | 已配 `.npmrc` 指向 `cdn.npmmirror.com`；`setup-electron.js` 也优先走该 CDN |
| `TypeError: Cannot read properties of undefined (reading 'whenReady')` | 环境变量 `ELECTRON_RUN_AS_NODE=1` 让 Electron 退化成普通 Node，`require('electron')` 只返回路径字符串 | `start-app.bat` 已自动 `set "ELECTRON_RUN_AS_NODE="` 清空该变量；手动启动时请先清掉 |
| 下载 Electron 极慢（几十 KB/s） | `npmmirror.com/mirrors` 有 302 跳转且限速 | 改用 `cdn.npmmirror.com/binaries/electron/...`，实测 2–5 MB/s |
| `EADDRINUSE` / 端口 3000 被占用 | 开了多个实例 | 已加单实例锁，重复双击会聚焦已有窗口而非崩溃 |
| 配置了正确 Cookie 仍报「登录态已过期」 | **服务端把会话与 User-Agent 绑定**，UA 与登录浏览器不一致直接返回 401（裸 `curl/8`、`Chrome/138` 均被拒） | 程序会从粘贴的 cURL 里自动提取 `user-agent` 并沿用；只粘 Cookie 时请手动确保 UA 与浏览器一致 |

### 关于鉴权方式的结论（实测）

WorkBuddy 网页版（`www.workbuddy.cn`）的接口**不使用 Bearer token，而是 HttpOnly Cookie**（`session` / `session_2`），且：

- `Authorization` 请求头不存在；
- `document.cookie` 只能读到 `_gcl_au`、`qcloud_visitId` 等统计 Cookie；
- 唯一可行方式：DevTools → 网络 → 右键请求 → **复制为 cURL**，整段粘进程序，由程序抽出 `-b '...'` 里的 Cookie 与 `-H 'user-agent: ...'` 里的 UA。

---

## 九、打包发布：Windows 安装包（Setup.exe）

### 9.1 产物

| 项目 | 内容 |
| --- | --- |
| 安装包路径 | `dist/WorkBuddyCheckin-Setup-1.1.0.exe` |
| 安装包体积 | 约 **81 MB**（84,092,128 字节） |
| 安装后体积 | 约 **259 MB**（含 Chromium 运行时，Electron 固有开销） |
| 应用代码 | `app.asar` 仅 45 KB（已开启 asar 完整性校验） |
| 目标平台 | Windows 10 / 11，64 位（win32 x64） |
| 安装范围 | 当前用户（无需管理员权限，`allowElevation: false`） |

> 运行时全部内置于安装包。**用户端不需要预装 Node.js / Electron / 任何依赖**——这是 Electron 打包的本质：Chromium + Node 运行时被一起压缩进安装目录。

### 9.2 一条命令构建

```bash
# 在项目根目录执行
build-setup.bat          # 双击即可；内部已配好国内镜像
```

等价的手工命令：

```bash
set "ELECTRON_RUN_AS_NODE="
set ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
set ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/

npm install --ignore-scripts        # 首次：装 electron + electron-builder（跳过被 npm 拦截的安装脚本）
node scripts/setup-electron.js      # 首次：补下载 Electron 引擎二进制
node scripts/make-icon.js           # 生成 assets/tray-icon.png
node scripts/make-winicon.js        # 生成 assets/icon.ico

npx electron-builder --win --x64    # 产出 dist\WorkBuddyCheckin-Setup-1.1.0.exe
```

### 9.3 为打包新增 / 修改的文件

| 文件 | 作用 | 备注 |
| --- | --- | --- |
| `package.json`（改） | 新增 `build` 字段：appId、productName、asar、`files`白名单、win/nsis 配置 | 见下方配置要点 |
| `scripts/make-winicon.js`（新增） | 用纯 Node+zlib 生成多尺寸 `assets/icon.ico`（16/24/32/48/64/128/256） | 无外部依赖 |
| `build/installer.nsh`（新增） | 自定义 NSIS：卸载 / 覆盖安装时删除残留的开机自启注册表项 | 关键修复，见 9.5 |
| `build-setup.bat`（改） | 构建入口：修正了错误的镜像变量名 | `ELECTRON_BUILDER_BINARIES_MIRROR` 才是正确的旧名误写（`..._DOWNLOAD_MIRROR` 无效） |
| `main.js`（改） | 把 `userData` 固定到 `%APPDATA%\workbuddy-checkin-electron`；显式设置窗口标题 | 保证安装后仍读得到原有凭证 |
| `src/config.js`（改） | `applyAutoLaunch()` 按 `app.isPackaged` 决定是否传 app 目录参数 | 开发态需传目录，安装态不能传 |

`package.json` 的打包要点：

```json
"build": {
  "appId": "com.workbuddy.checkin",
  "productName": "WorkBuddy 每日签到",
  "compression": "maximum",       // 最大压缩，控体积
  "asar": true,                   // 打包成单一 asar + 完整性校验
  "npmRebuild": false,            // 无原生模块，跳过 rebuild，显著提速
  "publish": null,                // 不尝试发布到任何远端
  "win": { "target": "nsis", "icon": "assets/icon.ico" },
  "nsis": {
    "oneClick": false,            // 走常规向导（可选安装目录）
    "perMachine": false,          // 免管理员安装
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true,
    "deleteAppDataOnUninstall": false,   // 卸载保留凭证配置
    "language": "2052",                  // 简体中文向导
    "include": "build/installer.nsh"
  }
}
```

### 9.4 安装后的行为约定

| 项目 | 说明 |
| --- | --- |
| 应用图标 | `assets/icon.ico`（多尺寸），用于 exe、桌面 / 开始菜单快捷方式、任务栏 |
| 窗口标题 | `WorkBuddy 每日签到` |
| 托盘图标 | 绿色圆形 `tray-icon.png`，右键可「打开窗口 / 立即签到 / 退出」 |
| 默认安装目录 | `%LOCALAPPDATA%\Programs\workbuddy-checkin-electron`（向导中可自选） |
| 配置文件（含凭证） | `%APPDATA%\workbuddy-checkin-electron\config.json` |
| 签到日志 | `%APPDATA%\workbuddy-checkin-electron\checkin-log.jsonl`（每行一条 JSON） |
| 本地接口 | `http://127.0.0.1:3000`（仅供本机渲染进程调用） |
| 卸载入口 | 系统「设置 → 应用 → 已安装的应用」；或安装目录下的 `Uninstall WorkBuddy 每日签到.exe` |
| 卸载保留项 | `config.json` 凭证不会被删除；同时清除开机自启注册表项 |

**凭证不会丢**：`userData` 被显式钉死在 `%APPDATA%\workbuddy-checkin-electron`，与开发态同目录。所以从源码版升级到安装版后，**无需再次粘贴 cURL**。

### 9.5 两个真实的坑（已修复，供参考）

1. **卸载后残留开机自启项**：Electron 的 `setLoginItemSettings` 把登录项写在 `HKCU\...\Run` 下（`electron.app.<产品名>`），NSIS 卸载器不会清它，卸载后会留下指向已删除 exe 的僵尸启动项。修法：`build/installer.nsh` 里用 `EnumRegValue` 遍历并删除该前缀的键值（用纯 ASCII 前缀匹配，避免 .nsh 里的中文编码问题）。
2. **`ELECTRON_RUN_AS_NODE=1` 会让程序秒退且退出码为 0**：Electron 会退化成普通 Node，`main.js` 一行都不会执行，表现为"打包版双击没反应"。正常环境下不会出现；若在某些终端里手动启动异常，先在命令行 `set "ELECTRON_RUN_AS_NODE="` 清掉即可。

### 9.6 在干净 Windows 上验证全流程

建议在一台**从没装过**的 Windows 10/11 x64 机器上按序执行：

```bat
:: 1) 安装 —— 双击 Setup.exe，或静默安装到自定义目录
WorkBuddyCheckin-Setup-1.1.0.exe /S
WorkBuddyCheckin-Setup-1.1.0.exe /S /D=D:\WorkBuddyCheckin

:: 2) 检查安装产物
dir "%LOCALAPPDATA%\Programs\workbuddy-checkin-electron"
::    桌面与开始菜单应出现「WorkBuddy 每日签到」
::    设置 → 应用 → 已安装的应用 应出现该项（名称/版本/发布者齐全）

:: 3) 启动：双击桌面快捷方式
::    预期：绿色窗口标题「WorkBuddy 每日签到」，托盘出现绿色图标

:: 4) 验证本地服务已就绪（PowerShell）
Invoke-RestMethod http://127.0.0.1:3000/api/config
::    预期返回 {"domain":"www.workbuddy.cn","hasToken":true}（首次为 false，需先配置凭证）

:: 5) 触发一次真实签到（PowerShell）
Invoke-RestMethod http://127.0.0.1:3000/api/status -Method Post
::    预期 action = already 或 ok，并返回 streak_days / today_credit / total_credits

:: 6) 检查开机自启（设置里勾选后）
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "electron.app.WorkBuddy 每日签到"

:: 7) 卸载：设置 → 应用 → 卸载，或运行
"%LOCALAPPDATA%\Programs\workbuddy-checkin-electron\Uninstall WorkBuddy 每日签到.exe" /S
::    预期：安装目录、桌面快捷方式、开始菜单、卸载入口、开机自启项全部清除
::          %APPDATA%\workbuddy-checkin-electron\config.json 保留
```

### 9.7 关于体积与杀软误报

- **体积**：259 MB 主要是 Chromium。已通过 `compression: maximum` + `asar` + 空白依赖（无第三方运行库）压到安装包 81 MB，这是在"不做分层 / 不含 WebView2 依赖"前提下的常规量级。进一步瘦身需要换 Tauri / WebView2 方案，属重构级别改动。
- **误报**：本包**未做代码签名**（无证书）。未签名的 Electron NSIS 安装包被部分杀软（如 360、火绒）启发式拦报属常见现象，属误报而非病毒。缓解方式：从「应用和功能」卸载时保持正常、运行时只在本地 127.0.0.1 通信。若需在团队内分发，建议购买代码签名证书后在 `build.win.certificateFile` 配置签名。

---

## 十、v1.2.0 功能清单与改动说明

### 10.1 功能清单

| # | 功能 | 入口 | 说明 |
| --- | --- | --- | --- |
| 1 | 手动立即签到 | 主界面大按钮 | 一键触发真实签到；成功后按钮变「签到成功 ✓」并禁用，已签显示「今日已签 ✓」 |
| 2 | 独立设置按钮 | 右上角齿轮按钮 | 显眼、常驻主界面；**只开设置面板**，不触碰凭证 |
| 3 | 自定义自动签到时间 | 设置 → 每天签到时间 | 任意 `HH:MM`，保存后立即生效，无需重启 |
| 4 | 自动签到开关 | 设置 → 自动签到 | 关闭后完全不再自动执行，倒计时显示「已关闭」 |
| 5 | 错过时间补签 | 设置 → 错过时间自动补签 | 关机/睡眠错过到点后，下次启动补签当天一次 |
| 6 | 失败自动重试 | 设置 → 失败自动重试 | 自动签到失败重试最多 3 次（1.5s / 3s 退避） |
| 7 | 开机自启动 | 设置 → 开机自动启动 | 写入系统登录项，登录后托盘静默运行 |
| 8 | 关闭窗口行为 | 设置 → 关闭窗口时最小化到托盘 | 默认最小化到托盘以保留后台调度 |
| 9 | 运行日志查看 | 主界面 → 运行日志 | 最近 100 条，倒序，带彩色标签与统计（条数/体积） |
| 10 | 清空日志 / 打开日志文件夹 | 日志面板工具条 | 一键清空；或在资源管理器中定位文件 |
| 11 | 签到结果提示 | 主界面消息行 + 托盘提示 | 成功/已签/失败/凭证过期四态；托盘 tooltip 同步状态与下一次时间 |
| 12 | 失败重试按钮 | 主界面「重试」 | 手动签到失败后出现，带退避 |
| 13 | 倒计时 | 标题下方 | 「下次自动签到 今天/明天 HH:MM · N 小时 M 分后」，每 30 秒刷新 |
| 14 | 统计汇总 | 状态卡下方 | 上次签到时间 + 本月已签天数（从日志汇总） |
| 15 | 配置持久化 | 自动 | 全部偏好写入 `config.json`；新字段对旧配置自动补默认值 |
| 16 | 后台结果回传 | 自动 | 后台自动签到完成后主动推送结果到界面并刷新统计 |
| 17 | 日志轮转 | 自动 | 超过 1 MB 归档为 `.1`，避免无限增长 |

### 10.2 改动的文件

| 文件 | 改动 |
| --- | --- |
| `src/config.js` | **重写配置层**：新增 `autoCheckin / checkinTime / autoRetry / closeToTray / catchUp` 字段与默认值、`normalizeTime / parseTime / computeNextRun / computeStats / readLogs`；`saveConfig` 改为**局部合并**语义（只覆盖传入字段，绝不整份重写，从根上杜绝"保存设置清空 token"）；新增 `/api/settings`（GET/POST）、`/api/logs`、`/api/logs/clear`、`/api/openLogFolder`、`/api/summary`；`createApiServer` 增加 `onSettingsChanged` 回调 |
| `main.js` | 调度器由"固定 09:00"改为**读配置的任意时间**，每 30 秒检查、含补签判定；`runAutoCheckin()` 统一处理"先查状态→再签到→失败重试"；`syncStatus()` 同步托盘提示；`updateTrayTip()` 显示今日状态与下次时间；托盘菜单新增「打开日志文件夹」；窗口改为 480×760 可缩放、`autoHideMenuBar`；关闭窗口行为读 `closeToTray`；日志写入增加 1 MB 轮转；新增 `notifyRenderer()` 向界面推送后台签到结果 |
| `preload.js` | 新增 `onCheckinDone` 事件桥（后台签到完成 → 界面刷新） |
| `renderer/index.html` | 新增右上角**独立「设置」按钮**；拆成三个互斥面板（设置 / 运行日志 / 登录凭证）；设置面板用「标题+说明+开关」布局，含时间选择器；凭证输入表单整体移入独立的 `credential-panel` |
| `renderer/renderer.js` | 面板管理器 `showPanel/hidePanels`；设置读写与倒计时（`renderNextRun`）；日志渲染（`loadLogs/renderLogs`，含 HTML 转义）；统计汇总；后台结果回传处理；`Esc` 关闭面板；`setState('need_token')` **不再**自动跳设置页 |
| `renderer/styles.css` | 新增设置按钮、开关滑块、设置项行、日志列表、标签、面板动画等样式；窗口可滚动 |
| `test/config-test.js` | 新增 9 项配置/日志单测 |
| `test/api-test.js` | 新增 11 项本地 API 测试 |
| `test/shot.js` | 新增开发期截图脚本（不打包） |
| `package.json` | 版本 1.1.0 → **1.2.0**；新增 `test:config / test:api / test:all / shot` 脚本 |

### 10.3 兼容性与安全性

- **token 零改动**：凭证读取、cURL 解析、UA 提取、`/api/saveConfig` 全部保持原逻辑；`saveConfig` 的合并语义让"存设置"和"存凭证"互不干扰（由 `test:config` 与 `test:api` 双重点守护）。
- **旧配置自动升级**：老的 `config.json` 没有新字段时按默认值补齐并正常读写，不需要手动迁移。
- **实测结论**：1.1.0 覆盖升级到 1.2.0 后，`config.json` 中的 token（6061 字符）、uid、UA 完全一致；改自动签到时间后 token 字节数不变；真实签到接口仍返回 `already / streak 2 / total 200`。

---

### 11. v1.3.0 新增与优化（桌面端）

在 1.2.0 基础上补充了 4 项实用优化，**全部不触碰已保存的 token / uid / UA**：

| 编号 | 优化 | 位置 | 说明 |
| --- | --- | --- | --- |
| 18 | 桌面系统通知 | `main.js` `notify()` + `renderer` 开关 | 定时/补签**成功**、凭证**过期**时弹 Windows Toast；可在设置里关闭 |
| 19 | 可配置重试次数 | `config.js` `maxRetries`(1~5) + `renderer` 数字框 | 替代原先写死的 3 次；关闭"失败自动重试"时不再重试 |
| 20 | 深色模式 | `styles.css` 变量 + `renderer` 主题选择 | 跟随系统 / 浅色 / 深色三档，立即生效 |
| 21 | 配置导出 / 导入（手机桥接） | `config.js` `/api/export`、`/api/import` + `renderer` 同步区 | 桌面一键生成 base64 凭证码，手机端粘贴即用，无需重新抓包；也支持把手机/其它电脑的凭证导入回桌面 |

> 红线依旧有效：导出/导入与保存设置都是**局部合并**，绝不会清空或覆盖已保存的登录凭证（由 `test:api` 的 export/import 用例守护）。

**改动的文件**

| 文件 | 改动 |
| --- | --- |
| `src/config.js` | 新增 `desktopNotify / maxRetries / theme` 字段与默认/规范化；`/api/export`、`/api/import` 路由（base64 编码传输），`saveConfig` 继续局部合并 |
| `main.js` | 新增 `notify()`（Windows 原生通知，受 `desktopNotify` 开关与令牌过期触发）；自动签到重试次数改用 `maxRetries` |
| `renderer/index.html` | 设置面板新增「桌面通知 / 重试次数 / 主题」三项，及「手机端同步」导出/导入区 |
| `renderer/renderer.js` | 读取并保存新增偏好；`applyTheme()` 应用深浅色并监听系统变化；`exportCode/importCode()` 桥接手机端 |
| `renderer/styles.css` | 引入 `[data-theme='dark']` 配色变量，写死颜色改为变量，新增同步区样式 |
| `test/api-test.js` | 新增 2 项：导出码可解码且响应不明文泄露 token、导入能恢复凭证且保留其它设置 |
| `package.json` | 版本 1.2.0 → **1.3.0** |

---

### 12. 手机端 PWA（mobile/）

让你**在手机浏览器里也能签到**，无需装 App、数据只存本机。

#### 12.1 为什么需要"代理"

WorkBuddy 的签到接口（`www.codebuddy.cn`）**不返回 CORS 头**，手机浏览器里的网页无法直接 `fetch` 调用它。因此手机端做成一个「网页 + 轻量同源代理」：

- `mobile/server.js` 部署在服务器上，同时托管网页**和**提供 `/api/status`、`/api/checkin` 两个接口；
- 网页（运行在手机浏览器）与这两个接口**同源**，不存在跨域问题；
- 代理只把请求**转发**到官方域名（白名单 `www.codebuddy.cn` / `www.workbuddy.cn`），**不在服务端保存任何 token**；你的凭证只存在手机浏览器的 `localStorage`。

#### 12.2 使用步骤

1. **桌面端导出**：打开桌面端 → 右上角「设置」→ 拉到「手机端同步」→ 点「导出凭证码」（已自动复制剪贴板）；
2. **手机打开链接**：在手机浏览器访问部署后的地址（见下方"运行/部署"）；
3. **粘贴导入**：点「登录凭证」→ 把那串凭证码粘进去 → 「保存并使用」；
   - 没有桌面端也行：直接粘 `eyJ...` 的 token、或 `k=v; k2=v2` 的 Cookie、或整段 cURL，会被自动解析；
4. **签到**：回主界面点「立即签到」；
5. **当 App 用**：浏览器菜单「添加到主屏幕 / 安装」，之后像原生 App 一样从桌面打开，且可离线启动。

#### 12.3 运行 / 部署

- **本地运行（同一台电脑，手机连同一 WiFi）**：
  ```bash
  cd mobile
  node server.js          # 默认 3000 端口，可用 PORT=8080 指定
  ```
  手机浏览器访问 `http://<电脑局域网IP>:3000`（需放行防火墙）。
- **发布为可访问链接（推荐，手机随时可用）**：把 `mobile/` 目录作为"单端口 HTTP 服务"发布/部署，得到一个公网 HTTPS 地址，手机直接打开即可。

#### 12.4 安全说明

- 代理**仅转发**到白名单域名，不能被当成任意网站的 SSRF 跳板；
- 凭证**不上传**到任何服务器，只存在你手机的浏览器存储里；
- 服务端对请求体大小、来源 IP 做限速，避免接口被滥用；
- 同样地，登录态有有效期，过期后在手机端重新粘贴一次凭证码即可（桌面端重新导出最新码最省事）。

| 文件 | 作用 |
| --- | --- |
| `mobile/server.js` | 静态托管 + 同源代理 + 限速/白名单/防穿越 |
| `mobile/src/proxy-core.js` | 复用桌面端鉴权头构造与签到流程，转发官方接口 |
| `mobile/public/index.html` / `app.js` / `styles.css` | 手机端界面与逻辑（凭证本地存取、主题、SW） |
| `mobile/public/manifest.json` / `sw.js` | PWA 安装与离线壳 |
| `mobile/scripts/gen-icons.js` | 纯 Node 生成 192/512/maskable 图标 |



---

## 十一、手机端原生 Android APK（v1.0.0）

除了“手机网页(PWA)”方案，本项目也已编译出**可安装的 Android 安装包**：

- 产物：`apk-build/WorkBuddyCheckin-1.0.0.apk`（约 17KB，自包含）
- 构建方式：用本仓 `apk-build/` 下的免安装工具链（JDK + Android build-tools + platform，均通过代理分块下载）手动 `aapt2`/`d8`/`apksigner` 组装，**不依赖 Android Studio**，也不依赖本机全局 Java 环境。
- 本质：一个原生 Android 壳，内部用 WebView 加载已发布的手机端 PWA 地址（含同源代理，自动解决签到接口 CORS 问题）。
- 签名：自带自签名密钥（`apk-build/upload-key.jks`），可直接侧载安装。

### 关于“管理入口：设置—数据管理—应用”
这句话指的是**已发布的手机网页应用（PWA 链接）**在 WorkBuddy 平台里的管理位置，不是这个 APK 文件本身：
- 进入 WorkBuddy 客户端/网页的「设置 → 数据管理 → 应用」，可以看到你通过“发布为应用”部署的手机端链接（即 `your-app.example.com`），在那里能查看、配置或下架该发布应用。
- APK 是你本地的安装文件，不受这个管理入口控制；要分发/重装直接用这个 .apk 文件即可。

### 手机上如何运行（APK 侧载）
1. 把 `WorkBuddyCheckin-1.0.0.apk` 传到手机（本预览直接下载 / U 盘 / 微信文件传输 / 邮件附件均可）。
2. 手机允许“安装未知应用”：设置 → 应用 → 特殊应用权限/安装未知应用 → 允许你用来打开 APK 的那个 App（或直接开启“未知来源”）。
3. 点 APK 安装，桌面出现「WorkBuddy 签到」图标。
4. 打开 App → 加载登录页 → 粘贴手机端凭证（桌面端“设置→手机端同步→导出凭证码”最方便，也可直接粘 token/Cookie/cURL）→ 立即签到。
> 该 App 需要联网（它加载的是线上 PWA 页面）；凭证只存在你手机本地，服务端不保存。

---

## 十二、v1.4.0：修复"第二部手机显示登录态过期、要重试两三次"

### 现象
在第二部手机（网页版与 APK 表现一致）输入凭证后提示「登录态已过期」，反复重试两三次才成功。

### 根因（实测定位，不是凭证真的过期）
1. 本账号的 Cookie 总长 **6061 字符**（其中 `session` 一项 4001、`session_2` 1204），导出成 base64 凭证码后为 **8400 字符**。
2. 这么长的字符串在手机上长按粘贴、或经微信/QQ 转发时**极易被截断**。
3. 原代码在凭证码解析失败时会「降级」把它当成 token 去请求 → 上游返回 **401** → 被 `isTokenExpired()` 判定为「登录态已过期」。于是「传歪了」被误报成「过期了」，用户重试几次把完整内容粘进去后才成功。
4. 实测排除项：同一凭证串行 8 次全部正常、5 并发全部正常、两域名（workbuddy.cn / codebuddy.cn）互通 → **不是凭证过期，也不是多设备冲突**。

### 修复内容
| 项 | 说明 |
|---|---|
| 凭证码截断识别 | 形态像凭证码却解不开时，直接提示"凭证码不完整（可能被截断）"，不再降级成 token 猜测，避免误报过期 |
| 空白容错 | 容忍转发带入的换行/空格（含 base64 内部空白），不再抛 `Invalid character in header content` |
| 401 自动重试 | 代理内部对 401 重试最多 3 次（350/700ms 退避），网关抖动不再直接判死；只有连续 401 才算过期 |
| 保存即验证 | 保存凭证后先在原地验证，失败则**保留凭证面板**并给出具体原因，不必反复开关面板 |
| **8 位配对码同步（新增，推荐）** | 桌面「设置 → 手机端同步 → 生成配对码」→ 手机「登录凭证 → 用配对码同步」输入 8 位码即可。**彻底绕开超长粘贴** |
| 提示语更准确 | 「过期」改为「登录态无效或已过期，若刚粘贴过凭证码请确认内容完整」 |

### 配对码的安全设计
- 桌面端用配对码派生密钥（PBKDF2-SHA256，100000 次，16 字节盐）做 **AES-256-GCM** 加密后上传；
- 服务端只存**密文**（表键为配对码的 SHA-256），有效期 10 分钟、**领取一次即销毁**；
- 同 IP 领取失败超过 5 次即锁定，防暴力猜码；
- 配对码用 8 位、字符集排除 `0/O/1/I/L`，约 8.5e11 组合；
- 手机端在本地用 WebCrypto 派生同一密钥解密，**服务端全程无法解密，也拿不到配对码原文**。

### 验证
- 本地：`node mobile/scripts/test-pair.js` → 6 项全过（加密互通、一次性销毁、错误码拒绝、非法格式拒绝）
- 线上：`publish → claim → WebCrypto 解密` 三端一致；重复领取返回 404
- 桌面端 `/api/pair-create` → 线上 claim → 解密结果与桌面 `config.json` 完全一致
- 桌面端原有 28 项测试仍全绿

---

## 十三、v1.4.1：修复"手机端取不回凭证"等三个问题

### 1) 手机端无法取回凭证（根因）
线上部署要求**每个请求都必须带 `sharecode`**，否则网关直接返回 403 的 HTML 页面。
而手机端所有请求用的都是相对路径 `fetch('/api/pair/claim')`，**相对路径不会继承地址栏的查询参数**，于是：

- `fetch` 拿到的是 403 HTML → `r.json()` 抛 `Unexpected token '<'` → 界面显示"取回失败"
- 同一问题也潜伏在 `/api/status`、`/api/checkin` 上，只是平时偶尔命中"放行窗口"才没暴露

**修复**：新增 `SHARE` 常量（先从 `location.search` 取，取不到则回退到首次访问时存入 localStorage 的值），
所有请求统一经 `apiUrl(path)` 追加 `sharecode`；并对非 JSON 响应给出准确提示（403 时提示"链接不完整"）。
Service Worker 注册也改为带参数，避免离线壳注册失败。

### 2) 电脑端缺少重新生成按钮
配对码结果区新增 **「重新生成」** 与 **「复制配对码」** 两个按钮，过期或填错可一键换新码。

### 3) 配对码输入框样式不统一
原先是一个字体 17px、居中、等宽、带大字距的自定义输入框，与页面上"凭证码 / UID"输入框风格割裂。
现改为与其它输入框**完全一致**的标准结构（`label > span + input`），沿用同一套边框、圆角、内边距、
字号与聚焦高亮，仅保留轻微字距与大写转换以便阅读。

### 附带的健壮性改进
- 配对码**允许领取 3 次**（原先一次即销毁）：手机端若解密失败或网络中断，不必回电脑端重新生成
- 领取失败上限从 5 次放宽到 10 次，避免误输几次就被锁 10 分钟
- 领取次数用尽时返回明确文案

### 验证
- 本地配对测试 6 项全过（含"共可领 3 次后销毁"）
- 线上 `publish → claim（带 sharecode）→ WebCrypto 解密` 与桌面端配置逐字节一致
- 桌面端 28 项回归测试全绿

---

## 十四、v1.5.0：按钮交互统一 + 手机端使用统计

两个改动：一个是纯交互（谁打开、谁能关闭），一个是新功能（有多少人在用我的配对码/凭证）。

### 14.1 交互：入口按钮 = 开关

**问题**：设置面板打开后，只有面板右上角的「关闭」能退出；很多人习惯再点一次「设置」，
结果没反应，看起来像"卡住了"。

**规则**（四个入口全部统一，不再有例外）：

| 入口元素 | 打开的面板 | 第二次点同一个入口 | 等价关闭方式 |
| --- | --- | --- | --- |
| 右上角「设置」按钮 | 设置面板 | 关闭并返回主界面 | 面板内「关闭」/ `Esc` |
| 「运行日志」文字链接 | 运行日志 | 关闭并返回主界面 | 面板内「关闭」/ `Esc` |
| 「登录凭证」文字链接 | 凭证面板 | 关闭并返回主界面 | 面板内「关闭」/ `Esc` |
| 「使用统计」文字链接 | 统计面板 | 关闭并返回主界面 | 面板内「关闭」/ `Esc` |

实现要点（`renderer/renderer.js`）：

- 面板清单集中在一处：`PANELS = [{ id, entry, afterClose }]`，`togglePanel()` 统一处理"开着就关、关着就开"；
  新增面板只要往数组里加一行，行为自动与其它面板一致。
- **状态可见**：面板打开时入口保持高亮（`is-active`：设置按钮描边变绿、文字链接变绿），
  同时写入 `aria-expanded="true"` 与 `title="再点一次「设置」即可关闭"`，鼠标悬停即可确认"再点一次是关闭"。
- **收尾逻辑不丢**：设置面板关闭时仍会重新拉一次设置并重算"下次自动签到"倒计时（`afterClose`），
  所以"点设置关闭"和"点关闭按钮"两条路径的效果完全相同。
- **面板互斥**：设置面板开着时点「使用统计」，会先关掉设置、再打开统计，不会两块叠在一起；
  同一时刻只有一个面板可见。
- 键盘可达：`Esc` 关闭当前打开的面板（不再固定只关设置）。

### 14.2 统计：数据是从哪来的

统计不是本地猜的，而是手机端服务在"领凭证 / 签到"时顺手记的事件。完整链路：

```
桌面端「生成配对码」
   → POST /api/pair-create  { code(加密后), owner, mask }
   → 手机端服务：pairs 表暂存密文(10 分钟) + usage 表记下"这台电脑生成了 1 个码"

手机端输入配对码 → 「取回凭证」
   → POST /api/pair/claim { code, did }
   → 服务端：领取次数 +1；登记这台设备（did、平台、浏览器、首次时间）

手机端每次「刷新状态 / 立即签到」
   → POST /api/status | /api/checkin { 凭证, did }
   → 服务端：更新该设备的最近活跃、最近结果、连续天数、今日积分、成功签到次数

桌面端打开「使用统计」
   → GET  /api/usage-stats（本地）
   → 代理到 手机端 /api/pair/stats?owner=<本机随机标识>
   → 返回按设备聚合的结果
```

- `owner` 是桌面端首次生成配对码时创建的 **32 位随机 hex**（存在 `config.json`），不含任何个人信息；
  它同时充当读取统计的凭据，只有本机能查到自己的数据。
- 服务端**只存密文**：配对码原文不落库（表键是它的 SHA-256），凭证也不落库（只在手机浏览器里）。
- 配对码在统计列表里只显示掩码（如 `K7••••4X`），首尾各 2 位，够你认出是哪一次。

### 14.3 界面怎么展示

统计面板（主界面「使用统计」）自上而下三块：

**① 四个数字**

| 指标 | 含义 | 口径 |
| --- | --- | --- |
| 使用人数 | 有多少台设备成功同步过你的凭证 | 按设备去重（同一台手机换浏览器算两台） |
| 领取次数 | 配对码被成功领取的总次数 | 事件数，同一台设备重复领取会累加（每码最多 3 次） |
| 已生成配对码 | 一共发过多少个码 | 服务端记录数与本机计数取较大值，避免服务重启后看着像没发过 |
| 近 24h 活跃 | 最近一天内还在查状态/签到的设备数 | 以最后一次请求时间计 |

**② 设备使用情况**（一行一台设备）

- 左侧胶囊：`安卓 · Chrome` / `iOS · Safari` / `Windows · Edge` 等（由 UA 粗分类，不存完整 UA）
- 中间两行：`设备 0718 · 4 分钟前活跃` + `首次 10/29 12:09 · 领取 2 次 · 成功签到 4 次 · 连续 6 天 · 今日 +100`
- 右侧状态标签，优先级从高到低：
  - `凭证失效`（最近一次请求返回 401，需要重新生成配对码）
  - `今日已签`（24 小时内签到成功过）
  - `签到失败` / `待签到`（最近一次是失败或未签）
  - `仅同步`（只取走了凭证，还没签过到）

**③ 最近配对码**（最近 12 个，倒序）

- 掩码 + `有效 / 已过期 / 已领满`，以及 `生成时间 · 领取 N 次 · 最近领取时间`；
  右侧 `已使用 / 未使用` 让你一眼看出哪些码被真的用了。

底部还有一行「本机标识 …a1b2c3 · 本机生成配对码 3 次 · 导出凭证码 1 次 · 更新于 10/31 12:09」，
用来区分"我发了几次"和"别人用了几次"。面板打开时每 60 秒自动刷新一次，也可手动点「刷新」。

### 14.4 隐私与限制（重要）

- 不记录：凭证内容、配对码原文、完整 IP、完整 User-Agent、手机号等任何身份信息。
- 设备标识 `did` 由手机端 `localStorage` 随机生成（16 位 hex），**换浏览器 / 清缓存会被算成新设备**，
  所以"使用人数"是"设备数"的近似值。
- 统计需要**手机端服务是新版本**：旧版部署没有 `/api/pair/stats`，
  面板会明确提示"手机端服务还是旧版本，重新发布一次 mobile/ 目录即可"，不会假装 0 人。
- 统计落盘在 `mobile/.data/usage-stats.json`（可用 `DATA_DIR` 环境变量改位置）。
  若部署环境磁盘只读，会自动降级成"仅本次服务运行期间累计"，并在面板里提示这一点。

### 14.5 验证

- 手机端统计链路 `mobile/scripts/test-stats.js`：10 项全过
  （含"两台设备=2 人""同设备重复领取不重复计人""别人的 owner 看不到数据""统计已落盘"）
- 桌面端统计接口 `test/usage-test.js`：6 项全过
  （含"自动创建统计标识""请求带 owner/sharecode""服务不可用时优雅降级""统计请求不改动凭证"）
- 原有回归：配置层 10 项、API 层 13 项、签到逻辑 9 项全绿
- 交互断言（Electron 真实渲染）：四个入口"点开 → 再点关闭"全部 `closed(OK)`
