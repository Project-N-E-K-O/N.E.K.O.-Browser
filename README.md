# N.E.K.O Browser

N.E.K.O Browser 是一个统一构建的 Chrome/Edge MV3 扩展。它可以用浮窗、全屏叠加层或原生侧栏显示 N.E.K.O WebUI，并在同一个扩展中集成 Tencent BrowserSkill。

- N.E.K.O 默认地址：`http://localhost:48911/`
- BrowserSkill daemon：`ws://127.0.0.1:52800`
- 扩展加载目录：`neko-floating-webui/dist/chrome-mv3`

## 快速开始

### 环境要求

- Chrome 142 或更高版本，或支持完整 `chrome.sidePanel` API 的 Microsoft Edge。
- Node.js、`pnpm 10.17.0`。
- 可正常访问的 N.E.K.O WebUI。
- BrowserSkill `bsk 0.1.9` daemon。

### 构建扩展

在仓库根目录执行：

```powershell
git submodule update --init --recursive
Set-Location neko-floating-webui
pnpm install --frozen-lockfile
pnpm build
```

然后打开 `chrome://extensions` 或 `edge://extensions`：

1. 启用开发人员模式。
2. 选择“加载解压缩的扩展”。
3. 加载 `neko-floating-webui/dist/chrome-mv3`。

源码修改后需要重新运行 `pnpm build`，再到扩展管理页点击“重新加载”。若修改了 content script，还需要刷新已经打开的网页。

### 启动服务

先启动 N.E.K.O，并确认 `http://localhost:48911/` 可以访问。

N.E.K.O 的 Windows 安装包含 BrowserSkill CLI。当前目录布局下，可从仓库根目录启动 daemon：

```powershell
$Bsk = (Resolve-Path '..\N.E.K.O\plugin\plugins\browser_skill\bin\bsk.exe').Path
& $Bsk daemon start
& $Bsk status
```

当前开发环境中的完整路径为：

```text
H:\AI\neko-music\N.E.K.O\plugin\plugins\browser_skill\bin\bsk.exe
```

如果 N.E.K.O 安装在其他位置，只需修改 `$Bsk`。

## 使用扩展

点击扩展图标，可以选择 N.E.K.O 的显示模式并查看 BrowserSkill 状态。

| 模式 | 行为 |
| --- | --- |
| 浮窗 | 在当前网页显示可拖动、可缩放的面板；最小化后保留唤醒胶囊。 |
| 全屏 | 透明覆盖网页；猫、聊天框等组件保持交互，空白区域事件透传给网页。 |
| 侧栏 | 使用浏览器原生 Side Panel；侧栏位于左侧还是右侧由浏览器决定。 |

popup 中还可以：

- 修改 N.E.K.O 前端地址，并即时重载当前界面。
- 开关模型、聊天框、字幕、任务 HUD 等组件。
- 设置聊天框模式。
- 查看 BrowserSkill 连接状态、实例 ID、扩展/daemon/协议版本和错误信息。
- 根据录制目的与起始 URL 生成并复制录制命令。

自定义 WebUI 必须允许 iframe 嵌入，不能被 `X-Frame-Options` 或页面 CSP 阻止。HTTPS 网页嵌入 HTTP WebUI 时，也可能被浏览器的混合内容策略限制。

## 使用 BrowserSkill

常用会话命令：

```powershell
& $Bsk status
& $Bsk session start
& $Bsk snapshot
& $Bsk screenshot
& $Bsk session stop
```

录制示例：

```powershell
& $Bsk record start `
  --purpose '验证登录流程' `
  --url 'https://example.com/' `
  --output '.\trace.json'
```

`record start` 会打开 Agent Window，并等待浏览器中的录制完成。需要从另一个终端停止时，可以运行：

```powershell
& $Bsk record stop
```

## 页面层级与自动化

Agent Window 是 BrowserSkill 管理的外层 Chrome 窗口。N.E.K.O 只能置顶于标签页内容视口，不能覆盖地址栏或标签栏。

```text
N.E.K.O              z-index: 2147483647
BrowserSkill overlay z-index: 2147483646
网页内容             页面原始层级
```

自动化时，扩展会临时调整 N.E.K.O 的交互状态：

| BrowserSkill 操作 | N.E.K.O 行为 |
| --- | --- |
| 坐标点击 | 瞬时穿透，操作结束后恢复。 |
| 截图 | 瞬时隐藏，截图结束后恢复。 |
| 快照 / VOM | 保持可见，但从观察结果中排除。 |
| 录制 | 保持可见，但在整个录制期间不接收指针事件。 |

这些状态由带唯一 `leaseId` 的内部租约管理，支持并发，并在完成、异常、取消、页面重载或 session 结束时清理。

## 开发

扩展本体位于 `neko-floating-webui`；仓库根目录不应直接加载到浏览器。

```text
neko-floating-webui/
├─ src/
│  ├─ entrypoints/          WXT background/content 入口
│  ├─ browser-skill/        本仓库的集成 adapter
│  └─ manifest-base.json    Manifest 基础配置
├─ vendor/browser-skill/    Tencent/BrowserSkill 子模块
├─ background.js            N.E.K.O 后台模块
├─ content.js               N.E.K.O 页面运行时
├─ popup.* / sidepanel.*    popup 与原生侧栏
├─ offscreen.*              浮窗/全屏麦克风桥接
├─ wxt.config.ts            统一构建配置
└─ dist/chrome-mv3/         构建产物，不提交
```

WXT background 会依次安装集成 adapter、初始化 N.E.K.O 后台，再启动 BrowserSkill background。BrowserSkill 源码通过别名参与统一构建，不需要另外加载 BrowserSkill 扩展。popup 使用 `bsk-popup` runtime port 连接 BrowserSkill 后台。

开发命令均在 `neko-floating-webui` 中执行：

```powershell
pnpm dev       # WXT 开发模式
pnpm test      # N.E.K.O CJS + integration Vitest
pnpm compile   # WXT prepare + TypeScript 检查
pnpm build     # 生产构建
```

提交前应运行：

```powershell
pnpm test
pnpm compile
pnpm build
```

## BrowserSkill 上游策略

BrowserSkill 以 Git 子模块固定在提交：

```text
93df62a3569203bb8a1880bb3d42e7a8b0914abe
```

集成的上游扩展源码版本为 `0.1.5`，协议版本为 `1.0`。本仓库不直接修改子模块源码：

- N.E.K.O 兼容逻辑放在 `neko-floating-webui/src/browser-skill`。
- BrowserSkill 自身缺陷由上游修复。
- 升级时显式更新子模块提交，并重新运行完整测试、类型检查和生产构建。
- 更新提交号时同步修改第三方声明。

许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 权限与媒体

- `sidePanel` 是必需权限，不会在运行时再次申请。
- BrowserSkill 需要 `debugger`、`idle`、`notifications`、`tabs`、`webNavigation` 和 `windows` 等权限。
- 侧栏直接向 WebUI 委托麦克风、摄像头、屏幕捕获、剪贴板和本地网络权限。
- 浮窗和全屏使用 offscreen/PCM 麦克风桥接。首次使用前，可在 popup 中点击“授权麦克风”。

扩展在整个浏览器中只维持一个活动的 N.E.K.O WebUI/WebSocket。浮窗和全屏跟随当前活动标签页；多个窗口同时打开侧栏时，最后打开的窗口取得所有权。

## 常见问题

### N.E.K.O 页面出现黑色背景

在嵌入的 WebUI iframe 中检查：

```js
document.documentElement.dataset.nekoFloatingTransparent
document.documentElement.dataset.nekoFloatingTransparentMainWorld
```

两项都应为 `enabled`。原生侧栏还应满足：

```js
window.name === 'neko-native-sidepanel'
document.documentElement.dataset.nekoNativeSidePanel === 'enabled'
```

### BrowserSkill 没有连接

依次确认：

1. `& $Bsk status` 显示 daemon 正常运行。
2. popup 中的 BrowserSkill 开关已启用。
3. 扩展管理页中加载的是最新的 `dist/chrome-mv3`。
4. 重新构建后已经重新加载扩展，并刷新目标网页。
