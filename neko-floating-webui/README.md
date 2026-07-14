# N.E.K.O 浏览器 WebUI

这是一个 Chrome/Edge MV3 扩展，用于以浮窗、全屏叠加层或浏览器原生侧栏显示 `http://localhost:48911/`。

## 浏览器要求

- Chrome 142 或更高版本。
- 使用相同 Chromium 能力、支持完整 `chrome.sidePanel` 生命周期 API 的 Microsoft Edge。
- 扩展会在安装时请求必需的 `sidePanel` 权限；该权限不是可选权限，也不会在运行时再次申请。

## 使用方法

1. 启动 N.E.K.O，并确认主 WebUI 可通过 `http://localhost:48911/` 访问。
2. 打开 `chrome://extensions` 或 `edge://extensions`。
3. 启用开发人员模式并选择**加载解压缩的扩展**。
4. 选择本目录 `browser-extensions/neko-floating-webui`。
5. 点击扩展图标，在“浮窗 / 全屏 / 侧栏”之间切换。

浏览器决定原生侧栏显示在窗口左侧还是右侧。侧栏模式可以在普通网页、浏览器受限页面以及直接打开的 N.E.K.O 页面旁使用。

## 三种显示模式

- **浮窗**：在普通网页上显示可拖动、可缩放的面板；最小化后只保留唤醒胶囊。
- **全屏**：透明覆盖整个网页；Live2D、聊天框等可直接交互，未被组件覆盖的区域会把点击、悬停和滚轮透传给原网页。右上角胶囊仍可整体隐藏 N.E.K.O。
- **侧栏**：使用浏览器原生 Side Panel，顶部提供状态、刷新、入口和打开完整页面操作。

切换到侧栏时，扩展会先移除所有网页内面板，再加载侧栏 iframe。离开侧栏时会先卸载侧栏 iframe，再启动浮窗或全屏实例。

## 权限与麦克风

侧栏 iframe 直接委托麦克风、摄像头、屏幕捕获、剪贴板和本地网络权限。N.E.K.O WebUI 会直接触发浏览器的权限提示，不经过扩展的 offscreen、PCM 或 MessagePort 中继。

浮窗和全屏仍沿用原有的 offscreen/PCM 麦克风桥接，以保持已有嵌入行为不变。关闭或切换模式会卸载对应 iframe，并释放媒体会话。

## 单例行为

扩展在整个浏览器中只允许一个活动 WebUI/WebSocket：

- 浮窗或全屏实例会跟随当前活动标签页，其他标签页只保留最小化状态。
- 多窗口同时打开原生侧栏时，最后打开的窗口取得所有权，旧窗口会先卸载 WebUI。
- 浏览器重启后会记住所选模式，但原生侧栏仍需由用户操作打开。

## 透明模式与调试

嵌入 iframe 时，扩展会向本地 WebUI 注入透明样式。直接在普通标签页打开 `localhost:48911` 时保留原始页面背景。

全屏模式会加载宿主原有的 `/?surface=embed` 根页面。这里的查询参数只作为扩展注入适配器的启动标记，宿主无需新增 endpoint、模板变量或静态资源。适配器在页面主世界中提供 `NEKO_EMBED_*` 协议并计算组件区域；iframe 默认不接收指针事件，仅在模型或 UI 区域内启用。模型开始拖拽后会保持交互锁定，直到 `pointerup` 或 `pointercancel`，避免拖拽经过透明区域时中断。若适配器未能初始化，扩展会自动回退为整层交互模式。

扩展弹出面板中的“界面组件”可以分别开关模型、聊天框、字幕、模型按钮、任务 HUD 和状态提示。设置会保存到扩展本地存储，并实时同步到当前浮窗或全屏页面；侧栏仍使用自己的独立页面。

弹出面板中的“聊天框模式”可以选择跟随页面、固定小聊天框或固定大聊天框。固定模式会调用宿主已有的聊天界面 API，并在页面尝试切换模式时自动恢复；该设置同样只应用于浮窗和全屏页面。

浮窗工具栏中的“组件开关”按钮也提供同一组开关，修改结果与扩展弹出面板共用并实时同步。

弹幕字幕启用宿主自带的交互穿透时，扩展仍会保留字幕面板边界、控制按钮和设置面板的命中区域，确保可以重新打开设置或关闭弹幕模式。

嵌入适配由扩展内的 `embedded-surface-main-world.js` 和 `embedded-surface.css` 实现。宿主仍运行原始 `/` 页面并持有唯一会话；宿主升级后若组件 DOM 结构发生变化，只需更新扩展中的选择器。

修改扩展文件后，请在扩展管理页点击**重新加载**。`content.js` 发生变化时，还需要刷新已经打开的普通网页。

如果嵌入页面仍然是黑色，请在 `localhost:48911` iframe 中检查：

```js
document.documentElement.dataset.nekoFloatingTransparent
document.documentElement.dataset.nekoFloatingTransparentMainWorld
```

两项都应为 `enabled`。原生侧栏 iframe 还应满足：

```js
window.name
document.documentElement.dataset.nekoNativeSidePanel
```

对应值应为 `neko-native-sidepanel` 和 `enabled`。
