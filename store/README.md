# Chrome Web Store 上架资料

本目录保存 Chrome Web Store 开发者控制台需要填写的全部内容。文字可以直接复制粘贴，图片在 [assets/](assets/)。

- 控制台：<https://chrome.google.com/webstore/devconsole>
- 隐私政策：<https://github.com/Project-N-E-K-O/N.E.K.O.-Browser/blob/main/PRIVACY.md>

## 上架步骤

1. **注册开发者账号（需本人操作）**：登录控制台，支付 5 美元注册费，开启两步验证，验证联系邮箱。发布者名称建议填 `Project N.E.K.O.`。
2. **合并包含 `PRIVACY.md` 的改动**，确保上面的隐私政策链接可以公开访问。
3. **第一次上传，只为拿到商店 ID**：
   ```bash
   cd neko-floating-webui
   pnpm zip:store
   ```
   在控制台点击“新建内容”，上传 `dist/neko-floating-webui-extension-<版本>-chrome.zip`。**先不要提交审核。**
4. **把开发公钥换成商店公钥**：进入该条目的“软件包”页面，点击“查看公钥”，复制整段内容，然后运行：
   ```bash
   pnpm set-extension-key "-----BEGIN PUBLIC KEY-----..."
   ```
   `transparent-main-world.js` 和 `embedded-surface-main-world.js` 用写死的扩展 ID 校验父页面来源，所以必须替换。替换后，本地解压加载的构建和商店版使用同一个扩展 ID。运行 `pnpm test`，提交改动。
5. **上传正式包**：再次运行 `pnpm zip:store`，在“软件包”页面上传新包。如果控制台提示版本号必须更高，把 `package.json` 和 `src/manifest-base.json` 的 `version` 都改成 `0.3.1` 再打包。
6. 按下面各节填写“商品详情”“隐私权”“分发”和“测试说明”。
7. 提交审核。本扩展使用 `debugger` 和 `<all_urls>`，会进入人工深度审核，通常需要几天到几周。
8. 以后每次更新：提高 `version`，然后运行 `pnpm zip:store` 并上传。

---

## 商品详情（Store listing）

### 名称与简短描述

从 manifest 自动读取（`neko-floating-webui/_locales/*/messages.json`）：

| 语言 | 名称 | 简短描述 |
| --- | --- | --- |
| 中文（简体） | N.E.K.O. 猫娘浏览器伴侣 | 把本地运行的 N.E.K.O. 猫娘带进每个网页：浮窗、全屏或侧栏显示，并可通过 BrowserSkill 让本地 AI Agent 协助操作浏览器。 |
| English | N.E.K.O. Browser Companion | Bring your local N.E.K.O. companion to any web page as a floating window, fullscreen overlay or side panel, with BrowserSkill. |

### 详细描述（中文）

```text
N.E.K.O. 猫娘浏览器伴侣是 N.E.K.O.（猫娘计划）的官方浏览器扩展。它把你电脑上运行的 N.E.K.O. 带进浏览器，让她在你浏览网页时一直陪在身边。

【三种显示方式】
• 浮窗：在任意网页上显示可拖动、可缩放的 N.E.K.O. 面板，最小化后变成小胶囊。
• 全屏：透明叠加在网页上，模型和聊天框可以交互，空白区域的点击会直接传给网页。
• 侧栏：使用浏览器原生侧边栏，不遮挡网页内容。

【主要功能】
• 文字与语音聊天，支持麦克风语音对话。
• 自由开关模型、聊天框、字幕、任务 HUD 等界面组件。
• 集成 BrowserSkill：让你本机的 AI Agent 在独立的 Agent Window 中打开网页、点击、输入和截图，不打扰你正在使用的窗口。借用你自己的标签页前，会先弹出通知请你确认。
• 需要时可在弹窗中一键读取当前网站的 Cookies，方便开发调试（只在你点击时读取，不保存、不上传）。

【使用前准备】
本扩展需要配合 N.E.K.O. 本体使用：
• Steam（免费）：https://store.steampowered.com/app/4099310/
• GitHub Releases：https://github.com/Project-N-E-K-O/N.E.K.O/releases
启动 N.E.K.O. 后，扩展默认连接 http://localhost:48911/，也可以在弹窗中改成你自己的地址。BrowserSkill 功能需要运行 bsk 守护进程（N.E.K.O. Windows 版已内置）。

【隐私】
扩展没有自己的服务器，没有统计或广告代码，只和你自己运行的 N.E.K.O. 以及本机 BrowserSkill 通信。
隐私政策：https://github.com/Project-N-E-K-O/N.E.K.O.-Browser/blob/main/PRIVACY.md

【开源】
https://github.com/Project-N-E-K-O/N.E.K.O.-Browser
```

### 详细描述（English）

```text
N.E.K.O. Browser Companion is the official browser extension for Project N.E.K.O. It brings the N.E.K.O. companion running on your computer into your browser, so she can stay with you while you browse.

THREE WAYS TO SHOW N.E.K.O.
• Floating window: a draggable, resizable N.E.K.O. panel on any page that collapses into a small capsule.
• Fullscreen: a transparent overlay where the model and chat box stay interactive, and clicks on empty areas pass straight through to the page.
• Side panel: the browser's native side panel, keeping the page uncovered.

FEATURES
• Text and voice chat, including microphone conversations.
• Toggle the model, chat box, subtitles, task HUD and other components.
• BrowserSkill built in: let an AI agent on your computer open pages, click, type and take screenshots inside a separate Agent Window, without touching the windows you are using. Borrowing one of your own tabs always asks for your confirmation first.
• Read the current site's cookies from the popup with one click for development and debugging (only when you click; never stored or uploaded).

REQUIREMENTS
This extension works together with the N.E.K.O. app:
• Steam (free): https://store.steampowered.com/app/4099310/
• GitHub Releases: https://github.com/Project-N-E-K-O/N.E.K.O/releases
Once N.E.K.O. is running, the extension connects to http://localhost:48911/ by default; you can change the address in the popup. BrowserSkill features require the bsk daemon (bundled with N.E.K.O. for Windows).

PRIVACY
The extension has no servers of its own and no analytics or ads. It only talks to the N.E.K.O. app you run and the BrowserSkill daemon on your computer.
Privacy policy: https://github.com/Project-N-E-K-O/N.E.K.O.-Browser/blob/main/PRIVACY.md

OPEN SOURCE
https://github.com/Project-N-E-K-O/N.E.K.O.-Browser
```

### 类别与其他

| 字段 | 填写 |
| --- | --- |
| 类别 | 生活时尚 › 娱乐（Lifestyle › Entertainment）；如果更想强调 Agent 功能，可改为 效率 › 工具（Productivity › Tools） |
| 语言 | 中文（简体），并添加 English 商品详情 |
| 官方网址 / 主页 | https://project-neko.online |
| 支持网址 | https://github.com/Project-N-E-K-O/N.E.K.O.-Browser/issues |
| 成人内容 | 否 |

### 图片

| 控制台字段 | 文件 | 尺寸 |
| --- | --- | --- |
| 商店图标 | [store-icon-128.png](assets/store-icon-128.png) | 128×128，图形 96×96，四周留透明边 |
| 屏幕截图 1 | [screenshot-1-floating.png](assets/screenshot-1-floating.png) | 1280×800 |
| 屏幕截图 2 | [screenshot-2-fullscreen.png](assets/screenshot-2-fullscreen.png) | 1280×800 |
| 屏幕截图 3 | [screenshot-3-sidepanel.png](assets/screenshot-3-sidepanel.png) | 1280×800 |
| 屏幕截图 4 | [screenshot-4-popup.png](assets/screenshot-4-popup.png) | 1280×800 |
| 小型宣传图块（必填） | [promo-small-440x280.png](assets/promo-small-440x280.png) | 440×280 |
| 顶部宣传图块（可选） | [promo-marquee-1400x560.png](assets/promo-marquee-1400x560.png) | 1400×560 |

截图来自真实运行的扩展（本地 N.E.K.O. + Chromium）。截图 3 的侧栏和截图 4 的弹窗是分别截取后拼到网页旁边的，因为浏览器自带的界面无法直接截进网页截图。

---

## 隐私权（Privacy practices）

### 单一用途（Single purpose）

```text
Display the user's locally running N.E.K.O. AI companion inside the browser (floating window, fullscreen overlay or side panel) and let that companion's local agent assist the user on web pages through BrowserSkill.
```

### 权限理由（Permission justification）

| 权限 | 理由 |
| --- | --- |
| activeTab | Used when the user clicks the toolbar icon or popup to show, hide, or read cookies for the tab they are currently viewing. |
| alarms | Periodically checks for stale N.E.K.O. panels in closed or discarded tabs so only one panel stays active, and keeps the BrowserSkill connection alive in the MV3 service worker. |
| cookies | Only when the user clicks "Get cookies for this site" in the popup, the extension reads cookies for the active tab's URL and shows them in that popup so the user can copy them for development and debugging. Cookies are never stored, never sent to any server, and are discarded when the popup closes. |
| debugger | Used by the built-in BrowserSkill module to automate pages for the user's local AI agent through the Chrome DevTools Protocol: accurate clicks and typing, screenshots, and page/console/network inspection. It is attached only to tabs in BrowserSkill's dedicated Agent Window, or to a tab the user explicitly agrees to lend through a confirmation notification, and only while a task runs. |
| idle | Detects when the user returns from an idle or locked state (for example after the computer wakes up) so BrowserSkill can promptly reconnect to the local daemon. |
| notifications | Asks the user for confirmation before the local agent borrows one of the user's own tabs, and notifies when the agent needs human help. |
| offscreen | Hosts an offscreen document that relays microphone audio to the N.E.K.O. WebUI for voice chat in floating and fullscreen modes, because content scripts cannot keep a stable audio pipeline. |
| scripting | Injects the N.E.K.O. panel into the page the user chooses, and registers adapters that run only inside the user's own N.E.K.O. WebUI iframe to make its background transparent. |
| sidePanel | Provides the side panel display mode, which shows N.E.K.O. in the browser's native side panel. |
| storage | Saves the user's settings locally: WebUI address, display mode, panel position and size, and component toggles. |
| tabs | Tracks which tab currently shows the N.E.K.O. panel so it follows the active tab, and lets BrowserSkill open, switch and close tabs in its Agent Window. |
| webNavigation | Lets BrowserSkill detect when a page in the Agent Window finishes loading, so agent actions and user-recorded steps run on the right page. |
| windows | Creates and manages BrowserSkill's separate Agent Window so the agent never works in the user's own windows. |
| Host permission `<all_urls>` | The user can open N.E.K.O. as a floating window or fullscreen overlay on any website they visit, which requires a content script on all pages. BrowserSkill also needs to work on whatever sites the user asks the local agent to visit. The extension does not collect browsing data in the background. |

### 远程代码（Remote code）

选择 **“不，我没有使用远程代码”（No）**。扩展的全部 JavaScript 都打包在安装包里，扩展页面的 CSP 为 `script-src 'self'`。N.E.K.O. WebUI 是在 iframe 中显示的网页，不算远程代码。

如果审核员追问 BrowserSkill 的 `evaluate` 工具，可以这样回复：

```text
BrowserSkill's evaluate tool runs a JavaScript expression requested by the user's own local agent inside the page being automated, via the Chrome DevTools Protocol (Runtime.evaluate). It never runs in the extension's own context, is limited to tabs in the dedicated Agent Window, and is equivalent to what a developer does in DevTools. No code is downloaded from a remote server.
```

### 数据使用（Data usage）

建议如实勾选以下类别。扩展会把这些数据交给用户自己运行的本地服务，勾选可以避免被判定为披露不完整：

- [x] 身份验证信息（Authentication information）：仅在用户主动读取 Cookies 时
- [x] 个人通讯（Personal communications）：聊天和语音会转发给用户自己的 N.E.K.O.
- [x] 网络记录（Web history）：Agent Window 中的网址与标题
- [x] 用户活动（User activity）：BrowserSkill 录制时的点击和输入
- [x] 网站内容（Website content）：Agent 任务中的页面快照和截图
- [ ] 个人身份信息、健康信息、财务和付款信息、位置信息：不勾选

三项声明全部勾选：

- [x] 我不会出于已获批准的用途之外的用途向第三方出售或传输用户数据
- [x] 我不会为实现与我的产品的单一用途无关的目的而使用或转移用户数据
- [x] 我不会为确定信用度或实现贷款而使用或转移用户数据

隐私权政策网址：`https://github.com/Project-N-E-K-O/N.E.K.O.-Browser/blob/main/PRIVACY.md`

---

## 测试说明（Test instructions）

控制台的“测试说明”栏，不需要账号密码：

```text
This extension is the browser companion for the N.E.K.O. desktop app and needs it running locally.

1. Install N.E.K.O. (free):
   - GitHub Releases: https://github.com/Project-N-E-K-O/N.E.K.O/releases
   - or Steam: https://store.steampowered.com/app/4099310/
2. Launch N.E.K.O. and wait until http://localhost:48911/ opens in a browser. A free model is available out of the box; no API key is needed to see the character.
3. Open any website, click the extension icon, and press "显示 / 隐藏面板" (Show / hide panel). N.E.K.O. appears as a floating window.
4. In the popup, switch "显示模式" (Display mode) between 浮窗 (Floating), 全屏 (Fullscreen) and 侧栏 (Side panel).
5. Cookies: on any website, open the popup and click "获取当前网站 Cookies" (Get cookies for this site). The cookies are shown only in the popup.
6. BrowserSkill (optional): with the bsk daemon bundled in N.E.K.O. for Windows running (`bsk daemon start`), the BrowserSkill card in the popup shows the connection status. Automation sessions started with `bsk session start` run in a separate Agent Window.

Without N.E.K.O. running, the panel has nothing to display; this is expected.
Source code: https://github.com/Project-N-E-K-O/N.E.K.O.-Browser
```

---

## 分发（Distribution）

| 字段 | 建议 |
| --- | --- |
| 公开范围 | 第一次可以先选“不公开”（Unlisted），用链接小范围测试，确认没问题后再改为“公开” |
| 地区 | 所有地区 |
| 发布方式 | 审核通过后自动发布，或选“延迟发布”后手动发布 |
