# N.E.K.O. 猫娘浏览器伴侣 隐私政策 / Privacy Policy

**最后更新 / Last updated: 2026-09-28**

[中文](#中文) | [English](#english)

---

## 中文

本政策适用于浏览器扩展“N.E.K.O. 猫娘浏览器伴侣”（下称“扩展”），由 Project N.E.K.O. 开发。扩展是本地运行的 N.E.K.O. 应用和 BrowserSkill 工具的浏览器端组件。

### 1. 概述

- 扩展**没有自己的服务器**，不包含任何统计、广告或遥测代码。
- 扩展**不会向开发者或任何第三方发送你的数据**，也不会出售或转让数据。
- 扩展只和**你自己运行或配置的服务**通信：N.E.K.O. WebUI（默认 `http://localhost:48911/`）和本机 BrowserSkill 守护进程（`ws://127.0.0.1:52800`）。

### 2. 扩展处理的数据

| 数据 | 何时处理 | 去向 |
| --- | --- | --- |
| 扩展设置（WebUI 地址、显示模式、面板位置与大小、组件开关、聊天框模式等） | 你修改设置时 | 仅保存在浏览器本地（`chrome.storage.local`） |
| N.E.K.O. 界面内容与对话 | 你打开浮窗、全屏或侧栏时 | 扩展以 iframe 加载你配置的 WebUI 地址；对话内容由 N.E.K.O. 应用处理，扩展不读取或保存 |
| 麦克风音频 | 仅在你授权麦克风并使用语音对话时 | 实时转发给你配置的 N.E.K.O. WebUI，扩展不录音、不保存 |
| 当前网站 Cookies | **仅在你在弹窗中主动点击“获取当前网站 Cookies”时**，只读取当前标签页网址对应的 Cookies | 只在该弹窗内显示；只有你点击复制时才写入剪贴板。不保存、不发送给任何服务器，关闭弹窗即丢弃 |
| 网页内容（页面结构/文本快照、截图、网址与标题、控制台与网络请求记录、你在录制中执行的操作） | 仅在你本机的 AI Agent 通过 BrowserSkill 发起任务时，且只针对 BrowserSkill 的独立“Agent Window”中的标签页，或你在确认通知中明确同意借用的标签页 | 发送给本机 BrowserSkill 守护进程（`127.0.0.1`），由你运行的 Agent 使用 |

### 3. 你的 AI 服务商

N.E.K.O. 应用和你使用的 AI Agent 可能会把对话、语音或网页内容发送给**你自己在 N.E.K.O. 中选择并配置的** AI 模型服务商。这部分数据流由 N.E.K.O. 应用和对应服务商的隐私政策约束，不经过扩展开发者。N.E.K.O. 应用的说明见 [Project N.E.K.O. 文档](https://project-neko.online)。

### 4. 权限用途

扩展申请的权限只用于上述功能：显示 N.E.K.O. 界面（`<all_urls>`、`scripting`、`tabs`、`sidePanel`、`offscreen`、`storage`、`alarms`），用户主动读取 Cookies（`cookies`），以及 BrowserSkill 浏览器自动化（`debugger`、`tabs`、`windows`、`webNavigation`、`idle`、`notifications`）。

### 5. 数据保留与删除

扩展只在本地保存设置。卸载扩展，或在 `chrome://extensions` 中清除扩展数据，即可删除全部设置。

### 6. 儿童

扩展不面向 13 岁以下儿童，也不会有意收集儿童的个人信息。

### 7. 变更

政策如有更新，会发布在本页面并修改上方日期。

### 8. 联系我们

请通过 [GitHub Issues](https://github.com/Project-N-E-K-O/N.E.K.O.-Browser/issues) 联系我们。请不要在公开 issue 中发布 Cookies 等敏感信息。

---

## English

This policy covers the browser extension "N.E.K.O. Browser Companion" (the "Extension") developed by Project N.E.K.O. The Extension is the browser-side component of the locally running N.E.K.O. application and the BrowserSkill tool.

### 1. Summary

- The Extension has **no servers of its own** and contains no analytics, advertising, or telemetry code.
- The Extension **does not send your data to the developer or to any third party**, and never sells or transfers it.
- The Extension only talks to **services you run or configure yourself**: the N.E.K.O. WebUI (default `http://localhost:48911/`) and the BrowserSkill daemon on your computer (`ws://127.0.0.1:52800`).

### 2. Data the Extension handles

| Data | When | Where it goes |
| --- | --- | --- |
| Extension settings (WebUI address, display mode, panel position/size, component toggles, chat mode) | When you change settings | Stored locally in your browser only (`chrome.storage.local`) |
| N.E.K.O. interface and conversations | When you open the floating window, fullscreen overlay, or side panel | The Extension loads your configured WebUI address in an iframe; conversations are handled by the N.E.K.O. app, and the Extension does not read or store them |
| Microphone audio | Only after you grant microphone access and use voice chat | Streamed to your configured N.E.K.O. WebUI; never recorded or stored by the Extension |
| Cookies of the current site | **Only when you click the "获取当前网站 Cookies" (Get cookies for this site) button in the popup**, and only for the active tab's URL | Shown inside that popup only; copied to the clipboard only when you click copy. Never stored or sent to any server; discarded when the popup closes |
| Web page content (page structure/text snapshots, screenshots, URLs and titles, console and network logs, actions you perform during a recording) | Only when an AI agent on your computer starts a task through BrowserSkill, and only for tabs in BrowserSkill's separate "Agent Window" or tabs you explicitly agree to lend through a confirmation notification | Sent to the BrowserSkill daemon on your computer (`127.0.0.1`) for use by the agent you run |

### 3. Your AI providers

The N.E.K.O. app and the AI agent you use may send conversations, audio, or page content to the AI model providers **you choose and configure in N.E.K.O.** That data flow is governed by the N.E.K.O. app and those providers' privacy policies, and does not pass through the Extension developer. See the [Project N.E.K.O. documentation](https://project-neko.online).

### 4. Permissions

Permissions are used only for the features above: showing the N.E.K.O. interface (`<all_urls>`, `scripting`, `tabs`, `sidePanel`, `offscreen`, `storage`, `alarms`), reading cookies on your explicit request (`cookies`), and BrowserSkill browser automation (`debugger`, `tabs`, `windows`, `webNavigation`, `idle`, `notifications`).

### 5. Retention and deletion

The Extension stores only settings, locally. Uninstalling the Extension or clearing its data in `chrome://extensions` deletes all of them.

### 6. Children

The Extension is not directed at children under 13 and does not knowingly collect their personal information.

### 7. Changes

Updates to this policy will be published on this page with a new date above.

### 8. Contact

Contact us through [GitHub Issues](https://github.com/Project-N-E-K-O/N.E.K.O.-Browser/issues). Please do not post cookies or other sensitive information in public issues.
