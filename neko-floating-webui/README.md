# N.E.K.O 悬浮 WebUI

这是一个 Edge/Chrome MV3 扩展，用于在普通网页上以悬浮面板形式显示 `http://localhost:48911/`。

## 使用方法

1. 启动 N.E.K.O，并确认主 WebUI 可通过 `http://localhost:48911/` 访问。
2. 打开 `edge://extensions`。
3. 启用开发人员模式。
4. 选择**加载解压缩的扩展**。
5. 选择此目录：`browser-extensions/neko-floating-webui`。
6. 打开任意普通的 `http` 或 `https` 页面。最小化的 `N.E.K.O` 唤醒按钮会自动出现。

该扩展会刻意避免注入到 `localhost:48911` 或 `127.0.0.1:48911` 页面中。

## 唤醒模式

该扩展会自动在普通页面上附加一个小型、最小化的 `N.E.K.O` 唤醒按钮。点击它即可加载并显示完整的悬浮 WebUI。

最小化完整面板后，它会恢复为唤醒按钮，并卸载嵌入的 WebUI iframe，同时断开 WebSocket 连接。扩展会把上一次的唤醒/最小化状态存储在 `chrome.storage.local` 中；当该状态被唤醒时，完整面板会跟随当前活动标签页，其他标签页保持最小化。

## 单例行为

该扩展在整个浏览器中只保留一个活动的悬浮 WebUI 实例。在其他标签页唤醒面板、切换到其他普通页面，或加载新的活动页面时，扩展会先卸载上一个标签页中的 iframe，因此本地 WebUI 不会创建多个 WebSocket 连接。

内容脚本始终会加载轻量级唤醒按钮，但在面板被唤醒之前不会加载 `http://localhost:48911/`。关闭面板会移除 iframe，从而关闭 WebUI 连接。

## 透明模式

当 N.E.K.O WebUI 被嵌入到悬浮面板中时，扩展会向 `localhost:48911` iframe 注入一段小范围生效的样式表，使页面背景变为透明。直接在普通标签页中打开 `http://localhost:48911/` 时，会保留原始页面背景。

修改扩展文件后，请打开 `edge://extensions`，并在再次测试前点击该扩展的**重新加载**。
当 `content.js` 发生变化时，还需要刷新注入了悬浮面板的网页，以便替换旧的内容脚本实例。

如果嵌入页面仍然是黑色，请在开发者工具中检查 `localhost:48911` iframe，并查看：

```js
document.documentElement.dataset.nekoFloatingTransparent
document.documentElement.dataset.nekoFloatingTransparentMainWorld
```

当扩展脚本已注入时，这两项都应为 `enabled`。
