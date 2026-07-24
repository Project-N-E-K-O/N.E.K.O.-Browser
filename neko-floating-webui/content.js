(() => {
  const HOST_ID = 'neko-floating-webui-host';
  const PANEL_ID = 'neko-floating-webui-panel';
  const FRAME_ID = 'neko-floating-webui-frame';
  const WAKE_ID = 'neko-floating-webui-wake';

  const MINIMIZED_SIZE = { width: 96, height: 96 };
  const MIN_SIZE = { width: 320, height: 420 };
  const WAKE_DRAG_THRESHOLD = 4;
  const WAKE_IMAGE_URL = chrome.runtime.getURL('assets/cat-idle-cat1.gif');
  const FRAME_BRIDGE_URL = chrome.runtime.getURL('floating-frame.html');
  const FRAME_BRIDGE_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  const FRAME_BRIDGE_SENDER = 'neko-floating-frame-bridge';
  const EMBED_PROTOCOL_VERSION = 1;
  const EMBED_PROTOCOL_FALLBACK_MS = 1500;
  const CONTENT_RUNTIME_ID = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const EMBED_SURFACE_COMPONENT_ORDER = Object.freeze([
    'avatar',
    'chat',
    'subtitle',
    'controls',
    'agent-hud',
    'status'
  ]);

  const DEFAULT_STATE = {
    enabled: false,
    minimized: true,
    avatarForm: 'cat',
    displayMode: 'floating',
    surfaceComponents: EMBED_SURFACE_COMPONENT_ORDER.slice(),
    chatSurfaceMode: 'auto',
    panel: {
      width: 420,
      height: 680,
      right: 24,
      bottom: 24
    },
    webuiUrl: 'http://localhost:48911/'
  };

  if (!canInjectHere()) {
    return;
  }

  if (window.__nekoFloatingWebuiLoaded) {
    return;
  }
  window.__nekoFloatingWebuiLoaded = true;

  let currentPanel = { ...DEFAULT_STATE.panel };
  let webuiUrl = DEFAULT_STATE.webuiUrl;
  let displayMode = DEFAULT_STATE.displayMode;
  let avatarForm = DEFAULT_STATE.avatarForm;
  let avatarFormRequestId = null;
  let surfaceComponents = DEFAULT_STATE.surfaceComponents.slice();
  let chatSurfaceMode = DEFAULT_STATE.chatSurfaceMode;
  let host = null;
  let shadow = null;
  let panel = null;
  let frame = null;
  let wakeButton = null;
  let toolbar = null;
  let routesEl = null;
  let offlineEl = null;
  let offlineMessageEl = null;
  let statusDot = null;

  let dragSession = null;
  let resizeSession = null;
  let wakeDragSession = null;
  let suppressWakeClick = false;
  let suppressWakeClickTimer = 0;

  const activePcmRelays = new Set();
  let pcmWebuiPort = null;
  let frameBridgeToken = null;
  let frameBridgeTokenRequest = null;
  let frameBridgeReady = false;
  let frameWebuiReady = false;
  let embedReady = false;
  let embedConnectSent = false;
  let embedRegions = [];
  let embedViewport = null;
  let embedPointerLock = null;
  let embedFallbackTimer = 0;
  let embedHitTestSequence = 0;
  let pendingEmbedHitTest = null;
  let lastHostPointer = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'NEKO_PING') {
      sendResponse({ ok: true, visible: isPanelVisible() });
      return false;
    }

    if (message.type === 'NEKO_OPEN_SINGLETON') {
      openPanel(true).then(sendResponse);
      return true;
    }

    if (message.type === 'NEKO_SYNC_SINGLETON') {
      openPanel(false).then(sendResponse);
      return true;
    }

    if (message.type === 'NEKO_TOGGLE_SINGLETON' || message.type === 'NEKO_TOGGLE') {
      togglePanel().then(sendResponse);
      return true;
    }

    if (message.type === 'NEKO_FORCE_CLOSE') {
      const unloaded = Boolean(frame?.hasAttribute('src'));
      const removed = Boolean(panel || frame || host);
      closePanel();
      sendResponse({ visible: false, unloaded, removed });
      return false;
    }

    if (message.type === 'NEKO_FORCE_MINIMIZE') {
      setMinimized(true, false);
      sendResponse({ ...getPanelStatus(), unloaded: true });
      return false;
    }

    if (message.type === 'NEKO_PANEL_STATE') {
      applyPanelMessage(message);
      sendResponse(getPanelStatus());
      return false;
    }

    if (message.type === 'NEKO_PCM_TO_FLOATING') {
      if (!activePcmRelays.has(message.requestId)) {
        return false;
      }
      if (message.ready) {
        console.log('[NEKO-MIC content] PCM relay ready:', message.requestId?.substring?.(0, 8));
      }
      postPcmToWebui({
        type: message.payloadType,
        requestId: message.requestId,
        ready: message.ready,
        error: message.error,
        pcm16: message.pcm16,
        sampleRate: message.sampleRate,
        level: message.level
      });
      if (message.error) {
        activePcmRelays.delete(message.requestId);
      }
      return false;
    }

    if (message.type === 'NEKO_APPLY_DISPLAY_MODE') {
      applyDisplayMode(normalizeDisplayMode(message.mode), {
        minimized: message.minimized,
        avatarForm: message.avatarForm
      });
      sendResponse({ ok: true, ...getPanelStatus() });
      return false;
    }

    if (message.type === 'NEKO_APPLY_SURFACE_COMPONENTS') {
      const applied = applySurfaceComponents(message.surfaceComponents);
      sendResponse({ ok: true, surfaceComponents: applied });
      return false;
    }

    if (message.type === 'NEKO_APPLY_CHAT_SURFACE_MODE') {
      const applied = applyChatSurfaceMode(message.chatSurfaceMode);
      sendResponse({ ok: true, chatSurfaceMode: applied });
      return false;
    }

    if (message.type === 'NEKO_APPLY_WEBUI_URL') {
      const applied = applyWebuiUrl(message.webuiUrl);
      if (!applied) {
        sendResponse({ ok: false, error: '前端地址必须是有效的 HTTP 或 HTTPS 地址。' });
        return false;
      }
      sendResponse({ ok: true, webuiUrl: applied });
      return false;
    }

    return false;
  });

  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow) {
      return;
    }
    if (event.origin !== FRAME_BRIDGE_ORIGIN) {
      return;
    }
    const data = event.data;
    if (!data || typeof data.type !== 'string') {
      return;
    }
    if (data._sender === FRAME_BRIDGE_SENDER) {
      handleFrameBridgeMessage(data);
      return;
    }
    if (data._sender === 'neko-embedded-surface') {
      handleEmbedMessage(data);
      return;
    }
    if (data._sender !== 'main') {
      return;
    }
    if (data.type === 'NEKO_PCM_START' || data.type === 'NEKO_PCM_STOP') {
      handlePcmControlMessage(data);
    }
  });

  const embeddingColorSchemeMedia = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
  const embeddingColorSchemeObserver = new MutationObserver(syncFrameColorScheme);
  embeddingColorSchemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-darkreader-scheme']
  });
  if (document.body) {
    embeddingColorSchemeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-darkreader-scheme']
    });
  }
  embeddingColorSchemeMedia?.addEventListener('change', syncFrameColorScheme);
  window.addEventListener('pageshow', syncFrameColorScheme);

  ensureFrameBridgeToken().catch(() => {});
  autoOpenPanel().catch(() => {});

  window.addEventListener('resize', () => {
    if (!panel) {
      return;
    }
    if (displayMode === 'fullscreen') {
      return;
    }
    const rect = panel.getBoundingClientRect();
    currentPanel = normalizePanel({
      ...currentPanel,
      right: window.innerWidth - rect.left - rect.width,
      bottom: window.innerHeight - rect.top - rect.height
    });
    applyPanelStyles(panel, currentPanel);
    saveState({ panel: currentPanel });
  });

  window.addEventListener('pointermove', handleHostPointerMove, true);
  window.addEventListener('blur', () => {
    if (embedPointerLock !== null) {
      embedPointerLock = null;
      updateFrameInteractionFromLastPointer('window-blur');
    }
  });

  window.addEventListener('pagehide', stopAllPcmRelays);
  window.addEventListener('beforeunload', stopAllPcmRelays);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopAllPcmRelays();
    }
  });

  async function openPanel(forceAwake = false) {
    const state = await getState();
    if (isConfiguredFrontendPage(location.href, state.webuiUrl)) {
      closePanel();
      return getPanelStatus();
    }
    if (normalizeDisplayMode(state.displayMode) === 'sidebar') {
      displayMode = 'sidebar';
      closePanel();
      return getPanelStatus();
    }
    const minimized = forceAwake ? false : !state.enabled || Boolean(state.minimized);
    showPanelShell(state);
    setMinimized(minimized, false);
    if (forceAwake || state.enabled) {
      saveState({ enabled: true, minimized });
    }
    return getPanelStatus();
  }

  async function autoOpenPanel() {
    const state = await getState();
    if (isConfiguredFrontendPage(location.href, state.webuiUrl)) {
      closePanel();
      return;
    }
    if (normalizeDisplayMode(state.displayMode) === 'sidebar') {
      displayMode = 'sidebar';
      closePanel();
      return;
    }
    showPanelShell(state);

    if (!state.enabled) {
      setMinimized(true, false);
      return;
    }

    if (state.minimized) {
      setMinimized(true, false);
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: 'NEKO_AUTO_ATTACH' }).catch(() => null);
    setMinimized(response?.awake === true ? false : true, false);
  }

  async function togglePanel() {
    if (isPanelVisible()) {
      if (panel?.dataset.minimized === 'true') {
        await wakePanel();
        return getPanelStatus();
      }
      setMinimized(true, true);
      return getPanelStatus();
    }
    await openPanel();
    return getPanelStatus();
  }

  function showPanelShell(state) {
    ensurePanel();
    currentPanel = normalizePanel({
      ...DEFAULT_STATE.panel,
      ...(state.panel || {})
    });
    webuiUrl = normalizeNekoUrl(state.webuiUrl) || DEFAULT_STATE.webuiUrl;
    updateOfflineMessage();
    displayMode = normalizeDisplayMode(state.displayMode);
    setAvatarForm(state.avatarForm, false);
    surfaceComponents = normalizeSurfaceComponents(state.surfaceComponents);
    chatSurfaceMode = normalizeChatSurfaceMode(state.chatSurfaceMode);
    panel.dataset.displayMode = displayMode;
    panel.hidden = false;
    applyPanelStyles(panel, currentPanel);
  }

  function applyDisplayMode(mode, options = {}) {
    const previousMode = displayMode;
    setAvatarForm(options.avatarForm, false);
    displayMode = mode;
    if (mode === 'sidebar') {
      closePanel();
      return;
    }
    if (!panel) {
      ensurePanel();
    }
    panel.dataset.displayMode = mode;
    if (typeof options.minimized === 'boolean') {
      setMinimized(options.minimized, false);
    }
    if (previousMode !== mode) {
      resetEmbedPassthrough('display-mode-change');
    }
    if (mode === 'fullscreen') {
      if (panel.dataset.minimized !== 'true') {
        ensureFrameLoaded();
      }
    } else {
      applyPanelStyles(panel, currentPanel);
      if (panel.dataset.minimized !== 'true') {
        ensureFrameLoaded();
      }
    }
    if (previousMode !== mode && panel.dataset.minimized !== 'true') {
      window.requestAnimationFrame(() => {
        if (displayMode === mode && panel?.dataset.minimized !== 'true') {
          scheduleWebuiReflow();
        }
      });
    }
    saveState({ displayMode: mode });
  }

  function ensurePanel() {
    const existingHost = document.getElementById(HOST_ID);
    if (
      existingHost
      && existingHost.dataset.nekoContentRuntimeId !== CONTENT_RUNTIME_ID
    ) {
      existingHost.remove();
    }
    host = document.getElementById(HOST_ID) || createHost();
    shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    panel = shadow.getElementById(PANEL_ID);
    frame = shadow.getElementById(FRAME_ID);
    wakeButton = shadow.getElementById(WAKE_ID);

    if (panel && frame && wakeButton) {
      syncFrameColorScheme();
      return;
    }

    shadow.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        /* Chromium paints a white canvas behind a transparent cross-origin
           iframe when its used color scheme differs from the embedding page.
           Keep the shadow host in the page's scheme so floating/fullscreen
           surfaces remain genuinely transparent on dark pages. */
        color-scheme: inherit;
      }

      #${PANEL_ID} {
        position: fixed;
        z-index: 2147483647;
        box-sizing: border-box;
        display: grid;
        grid-template-rows: 42px 0 minmax(0, 1fr);
        min-width: ${MIN_SIZE.width}px;
        min-height: ${MIN_SIZE.height}px;
        max-width: min(90vw, 860px);
        max-height: 90vh;
        border: 1px solid rgba(15, 23, 42, 0.18);
        border-radius: 8px;
        overflow: hidden;
        background: transparent;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.28);
        pointer-events: auto;
        color: #0f172a;
        font-family: Inter, "Segoe UI", Arial, sans-serif;
      }

      #${PANEL_ID}[data-routes-open="true"] {
        grid-template-rows: 42px auto minmax(0, 1fr);
      }

      #${PANEL_ID}[data-minimized="true"] {
        grid-template-rows: ${MINIMIZED_SIZE.height}px;
        width: ${MINIMIZED_SIZE.width}px !important;
        height: ${MINIMIZED_SIZE.height}px !important;
        min-width: ${MINIMIZED_SIZE.width}px;
        min-height: ${MINIMIZED_SIZE.height}px;
        border: 0;
        border-radius: 0;
        overflow: visible;
        box-shadow: none;
      }

      #${WAKE_ID} {
        display: none;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #0f172a;
        box-sizing: border-box;
        cursor: grab;
        padding: 0;
        touch-action: none;
        user-select: none;
      }

      #${WAKE_ID} .wake-art {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: contain;
        pointer-events: none;
      }

      #${PANEL_ID}[data-minimized="true"] #${WAKE_ID} {
        display: flex;
      }

      #${PANEL_ID}[data-wake-dragging="true"] #${WAKE_ID} {
        cursor: grabbing;
      }

      #${PANEL_ID}[data-minimized="true"] .toolbar,
      #${PANEL_ID}[data-minimized="true"] .routes,
      #${PANEL_ID}[data-minimized="true"] .content,
      #${PANEL_ID}[data-minimized="true"] .resize {
        display: none;
      }

      .toolbar {
        grid-row: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        height: 42px;
        padding: 0 8px 0 12px;
        border-bottom: 1px solid rgba(15, 23, 42, 0.1);
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(14px);
        cursor: move;
        user-select: none;
      }

      .brand {
        display: inline-flex;
        align-items: center;
        min-width: 0;
        gap: 8px;
        font-size: 13px;
        font-weight: 650;
        white-space: nowrap;
      }

      .status-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: #f59e0b;
      }

      .status-dot[data-state="online"] { background: #16a34a; }
      .status-dot[data-state="offline"] { background: #dc2626; }

      .actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .actions button,
      .routes button,
      .offline button {
        border: 1px solid rgba(15, 23, 42, 0.14);
        border-radius: 6px;
        background: #ffffff;
        color: #0f172a;
        cursor: pointer;
        font: inherit;
      }

      .actions button {
        display: inline-grid;
        width: 28px;
        height: 28px;
        place-items: center;
        padding: 0;
        font-size: 12px;
        font-weight: 700;
      }

      .actions button:hover,
      .routes button:hover,
      .offline button:hover {
        background: #eef2ff;
        border-color: rgba(79, 70, 229, 0.32);
      }

      .routes {
        grid-row: 2;
        display: flex;
        gap: 6px;
        padding: 8px;
        border-bottom: 1px solid rgba(15, 23, 42, 0.1);
        background: rgba(248, 250, 252, 0.9);
        backdrop-filter: blur(14px);
        overflow-x: auto;
      }

      .routes[hidden] {
        display: flex;
        height: 0;
        padding-top: 0;
        padding-bottom: 0;
        border-bottom: 0;
        visibility: hidden;
        overflow: hidden;
      }

      .routes button {
        height: 28px;
        flex: 0 0 auto;
        padding: 0 10px;
        font-size: 12px;
      }

      .content {
        grid-row: 3;
        position: relative;
        min-height: 0;
        background: transparent;
      }

      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
        color-scheme: inherit;
      }

      .offline {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        gap: 10px;
        padding: 24px;
        text-align: center;
        background: #f8fafc;
      }

      .offline[hidden] { display: none; }
      .offline strong { font-size: 15px; }
      .offline span {
        max-width: 280px;
        color: #475569;
        font-size: 12px;
        line-height: 1.5;
      }
      .offline button {
        justify-self: center;
        height: 32px;
        padding: 0 14px;
      }

      .resize {
        position: absolute;
        z-index: 4;
      }

      .resize-e {
        top: 42px;
        right: 0;
        width: 8px;
        bottom: 8px;
        cursor: ew-resize;
      }

      .resize-s {
        right: 8px;
        bottom: 0;
        left: 0;
        height: 8px;
        cursor: ns-resize;
      }

      .resize-se {
        right: 0;
        bottom: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
      }

      #${PANEL_ID}[data-display-mode="fullscreen"] {
        position: fixed !important;
        inset: 0 !important;
        top: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        min-width: 0 !important;
        min-height: 0 !important;
        max-width: none !important;
        max-height: none !important;
        border: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        background: transparent !important;
        pointer-events: none !important;
        grid-template-rows: 0 0 minmax(0, 1fr) !important;
      }

      #${PANEL_ID}[data-display-mode="fullscreen"] .toolbar,
      #${PANEL_ID}[data-display-mode="fullscreen"] .routes,
      #${PANEL_ID}[data-display-mode="fullscreen"] .resize,
      #${PANEL_ID}[data-display-mode="fullscreen"] .offline {
        display: none !important;
      }

      #${PANEL_ID}[data-display-mode="fullscreen"] .content {
        background: transparent !important;
      }

      #${PANEL_ID}[data-display-mode="fullscreen"] #${FRAME_ID} {
        width: 100% !important;
        height: 100% !important;
        background: transparent !important;
        pointer-events: none !important;
      }

      #${PANEL_ID}[data-display-mode="fullscreen"][data-embed-interactive="true"] #${FRAME_ID} {
        pointer-events: auto !important;
      }

      #${PANEL_ID}[data-display-mode="fullscreen"] #${WAKE_ID} {
        display: none !important;
      }

      #${PANEL_ID}[data-resize-direction="e"],
      #${PANEL_ID}[data-resize-direction="e"] * {
        cursor: ew-resize !important;
        user-select: none;
      }

      #${PANEL_ID}[data-resize-direction="s"],
      #${PANEL_ID}[data-resize-direction="s"] * {
        cursor: ns-resize !important;
        user-select: none;
      }

      #${PANEL_ID}[data-resize-direction="se"],
      #${PANEL_ID}[data-resize-direction="se"] * {
        cursor: nwse-resize !important;
        user-select: none;
      }
    `;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.dataset.minimized = 'true';
    panel.dataset.routesOpen = 'false';
    panel.dataset.componentsOpen = 'false';
    panel.dataset.displayMode = 'floating';
    panel.dataset.embedInteractive = 'false';
    panel.dataset.embedProtocol = 'idle';

    wakeButton = document.createElement('button');
    wakeButton.id = WAKE_ID;
    wakeButton.type = 'button';
    wakeButton.title = '唤醒 N.E.K.O 面板';
    wakeButton.draggable = false;
    const wakeImage = document.createElement('img');
    wakeImage.src = WAKE_IMAGE_URL;
    wakeImage.alt = '';
    wakeImage.draggable = false;
    wakeImage.className = 'wake-art';
    wakeButton.append(wakeImage);
    // 阻止 <img> 的 native drag 干扰 pointer capture（导致浮窗模式拖动失效）
    wakeButton.addEventListener('dragstart', (event) => event.preventDefault());
    wakeButton.addEventListener('pointerdown', startWakeDrag);
    wakeButton.addEventListener('pointermove', moveWakeDrag);
    wakeButton.addEventListener('pointerup', endWakeDrag);
    wakeButton.addEventListener('pointercancel', endWakeDrag);
    wakeButton.addEventListener('lostpointercapture', endWakeDrag);
    wakeButton.addEventListener('click', handleWakeClick);
    const toolbarEl = document.createElement('header');
    toolbarEl.className = 'toolbar';
    toolbarEl.dataset.dragHandle = '';
    toolbarEl.innerHTML = `
      <div class="brand">
        <span class="status-dot" data-status></span>
        <span>N.E.K.O</span>
      </div>
      <nav class="actions" aria-label="浮窗操作">
        <button type="button" data-action="reload" title="刷新 WebUI" aria-label="刷新 WebUI">↻</button>
        <button type="button" data-action="routes" title="入口" aria-label="入口">☰</button>
        <button type="button" data-action="open" title="打开完整页面" aria-label="打开完整页面">↗</button>
        <button type="button" data-action="minimize" title="最小化" aria-label="最小化">−</button>
        <button type="button" data-action="close" title="关闭" aria-label="关闭">×</button>
      </nav>
    `;
    toolbar = toolbarEl;

    const routesContainer = document.createElement('div');
    routesContainer.className = 'routes';
    routesContainer.dataset.routes = '';
    routesContainer.hidden = true;
    routesContainer.innerHTML = `
      <button type="button" data-route="/">主界面</button>
      <button type="button" data-route="/chat_full">完整聊天</button>
      <button type="button" data-route="/model_manager">模型</button>
      <button type="button" data-route="/api_key">密钥</button>
      <button type="button" data-route="/memory_browser">记忆</button>
    `;
    routesEl = routesContainer;

    const contentEl = document.createElement('main');
    contentEl.className = 'content';
    contentEl.innerHTML = `
      <iframe
        id="${FRAME_ID}"
        title="N.E.K.O WebUI"
        allowtransparency="true"
        allow="autoplay; microphone; camera; display-capture; clipboard-read; clipboard-write; local-network-access"
        referrerpolicy="no-referrer-when-downgrade"
      ></iframe>
      <div class="offline" data-offline hidden>
        <strong>N.E.K.O WebUI 未连接</strong>
        <span data-offline-message></span>
        <button type="button" data-action="retry">重试</button>
      </div>
    `;
    frame = contentEl.querySelector('#' + FRAME_ID);
    offlineEl = contentEl.querySelector('[data-offline]');
    offlineMessageEl = contentEl.querySelector('[data-offline-message]');
    updateOfflineMessage();
    statusDot = toolbarEl.querySelector('[data-status]');

    const resizeE = document.createElement('div');
    resizeE.className = 'resize resize-e';
    resizeE.dataset.resize = 'e';
    const resizeS = document.createElement('div');
    resizeS.className = 'resize resize-s';
    resizeS.dataset.resize = 's';
    const resizeSE = document.createElement('div');
    resizeSE.className = 'resize resize-se';
    resizeSE.dataset.resize = 'se';

    panel.append(wakeButton, toolbar, routesContainer, contentEl, resizeE, resizeS, resizeSE);
    shadow.append(style, panel);

    bindToolbarDrag(toolbar);
    bindResize([resizeE, resizeS, resizeSE]);
    bindActions();
    frame.addEventListener('load', onWebuiLoad);
    syncFrameColorScheme();
  }

  function bindActions() {
    shadow.addEventListener('click', (event) => {
      const actionButton = event.target.closest('[data-action]');
      const routeButton = event.target.closest('[data-route]');
      if (actionButton) {
        handleAction(actionButton.dataset.action);
      }
      if (routeButton) {
        openRoute(routeButton.dataset.route);
      }
    });
  }

  function handleAction(action) {
    if (action === 'reload' || action === 'retry') {
      if (offlineEl) offlineEl.hidden = true;
      setOnline(null);
      if (frame) {
        resetEmbedPassthrough('manual-reload');
        frameWebuiReady = false;
        if (!postFrameBridgeMessage({ type: 'NEKO_FLOATING_FRAME_RELOAD' })) {
          reloadFrameBridge();
        }
      }
      checkHealth();
      return;
    }

    if (action === 'routes') {
      setRoutesOpen(routesEl?.hidden === true);
      scheduleWebuiReflow();
      return;
    }

    if (action === 'open') {
      openRoute('/');
      return;
    }

    if (action === 'minimize') {
      setMinimized(true, true);
      return;
    }

    if (action === 'close') {
      closePanel();
      saveState({ enabled: false });
      chrome.runtime.sendMessage({
        type: 'NEKO_PANEL_STATE',
        closed: true
      }).catch(() => {});
      return;
    }
  }

  function setRoutesOpen(open) {
    if (!routesEl || !panel) {
      return;
    }
    routesEl.hidden = !open;
    panel.dataset.routesOpen = String(open);
  }

  function openRoute(path) {
    const routeUrl = new URL(path || '/', webuiUrl || DEFAULT_STATE.webuiUrl);
    chrome.runtime.sendMessage({
      type: 'NEKO_OPEN_TAB',
      url: routeUrl.toString()
    }).catch(() => {});
  }

  function isFrameReadyForWebui() {
    return Boolean(frame?.contentWindow && frameBridgeReady && frameWebuiReady);
  }

  function onWebuiLoad() {
    if (!isFrameReadyForWebui()) {
      return;
    }
    setOnline(true);
    scheduleWebuiReflow();
    setupPcmMessagePort();
    startEmbeddedSurfaceHandshake();
    checkHealth();
  }

  function scheduleWebuiReflow() {
    if (!frame) {
      return;
    }
    [0, 80, 240, 600, 1200].forEach((delay) => {
      window.setTimeout(() => {
        if (!isFrameReadyForWebui()) {
          return;
        }
        postFrameBridgeMessage({ type: 'NEKO_FLOATING_WEBUI_REFLOW' });
      }, delay);
    });
  }

  async function checkHealth() {
    if (!offlineEl) {
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: 'NEKO_HEALTH_CHECK' });
      setOnline(response?.online === true);
    } catch {
      setOnline(false);
    }
  }

  function setOnline(online) {
    updateOfflineMessage();
    if (!statusDot) {
      return;
    }
    if (online === true) {
      statusDot.dataset.state = 'online';
      if (offlineEl) offlineEl.hidden = true;
    } else if (online === false) {
      statusDot.dataset.state = 'offline';
      if (offlineEl) offlineEl.hidden = false;
    } else {
      delete statusDot.dataset.state;
    }
  }

  function ensureFrameLoaded() {
    if (!frame) {
      return;
    }
    syncFrameColorScheme();
    try {
      const current = frame.src;
      if (current && new URL(current).toString() === new URL(FRAME_BRIDGE_URL).toString()) {
        if (frameBridgeReady && !frameWebuiReady) {
          loadWebuiThroughFrameBridge();
        } else if (!embedReady && isEmbeddedSurfaceActive() && frameWebuiReady) {
          startEmbeddedSurfaceHandshake();
        }
        return;
      }
    } catch {}
    resetEmbedPassthrough('frame-navigation');
    resetFrameBridgeState();
    frame.src = FRAME_BRIDGE_URL;
  }

  function unloadFrame() {
    if (!frame) {
      return;
    }
    resetEmbedPassthrough('frame-unload');
    resetFrameBridgeState();
    try { frame.src = 'about:blank'; } catch {}
    frame.removeAttribute('src');
  }

  function setMinimized(minimized, persist) {
    if (!panel) {
      return;
    }
    if (minimized) {
      setAvatarForm('cat', false);
    }
    panel.dataset.minimized = String(minimized);

    if (minimized) {
      unloadFrame();
      stopAllPcmRelays();
    } else {
      ensureFrameLoaded();
    }

    if (persist) {
      saveState({ enabled: true, minimized, avatarForm });
      chrome.runtime.sendMessage({
        type: 'NEKO_PANEL_STATE',
        minimized,
        avatarForm
      }).catch(() => {});
    }
  }

  async function wakePanel() {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: 'NEKO_WAKE_PANEL' }).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000))
    ]);
    setAvatarForm(response?.avatarForm, false);
    setMinimized(false, response?.ok ? false : true);
  }

  function bindToolbarDrag(handle) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) {
        return;
      }
      if (panel?.dataset.minimized === 'true') {
        return;
      }
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      dragSession = {
        pointerId: event.pointerId,
        startX: getPointerScreenX(event),
        startY: getPointerScreenY(event),
        startRight: currentPanel.right,
        startBottom: currentPanel.bottom
      };
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }
      const nextPanel = clampPanel({
        ...currentPanel,
        right: dragSession.startRight - (getPointerScreenX(event) - dragSession.startX),
        bottom: dragSession.startBottom - (getPointerScreenY(event) - dragSession.startY)
      });
      currentPanel = nextPanel;
      applyPanelStyles(panel, nextPanel);
    });

    handle.addEventListener('pointerup', endToolbarDrag);
    handle.addEventListener('pointercancel', endToolbarDrag);
  }

  function endToolbarDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) {
      return;
    }
    if (toolbar?.hasPointerCapture?.(event.pointerId)) {
      toolbar.releasePointerCapture(event.pointerId);
    }
    dragSession = null;
    saveState({ panel: currentPanel });
  }

  function bindResize(handles) {
    handles.forEach((handle) => {
      handle.addEventListener('pointerdown', (event) => {
        if (panel?.dataset.minimized === 'true') {
          return;
        }
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        panel.dataset.resizeDirection = handle.dataset.resize;
        resizeSession = {
          pointerId: event.pointerId,
          direction: handle.dataset.resize,
          startX: getPointerScreenX(event),
          startY: getPointerScreenY(event),
          panel: { ...currentPanel }
        };
      });

      handle.addEventListener('pointermove', (event) => {
        if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
          return;
        }
        currentPanel = resizePanelFromPointer(resizeSession, event);
        applyPanelStyles(panel, currentPanel);
      });

      handle.addEventListener('pointerup', endResize);
      handle.addEventListener('pointercancel', endResize);
    });
  }

  function endResize(event) {
    if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
      return;
    }
    const handle = event.target;
    if (handle?.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    delete panel.dataset.resizeDirection;
    resizeSession = null;
    saveState({ panel: currentPanel });
  }

  function resizePanelFromPointer(session, event) {
    const nextPanel = { ...session.panel };
    const deltaX = getPointerScreenX(event) - session.startX;
    const deltaY = getPointerScreenY(event) - session.startY;

    if (session.direction.includes('e')) {
      const width = clampNumber(session.panel.width + deltaX, MIN_SIZE.width, 860);
      nextPanel.width = width;
      nextPanel.right = session.panel.right - (width - session.panel.width);
    }

    if (session.direction.includes('s')) {
      const height = clampNumber(session.panel.height + deltaY, MIN_SIZE.height, 900);
      nextPanel.height = height;
      nextPanel.bottom = session.panel.bottom - (height - session.panel.height);
    }

    return clampPanel(nextPanel);
  }

  function startWakeDrag(event) {
    if (event.button !== 0 || !panel || !wakeButton) {
      return;
    }
    // 全屏模式直接使用 WebUI 自带的猫；插件唤醒胶囊只属于最小化浮窗。
    if (displayMode === 'fullscreen' || panel.dataset.minimized !== 'true') {
      return;
    }
    suppressWakeClick = false;
    if (suppressWakeClickTimer) {
      window.clearTimeout(suppressWakeClickTimer);
      suppressWakeClickTimer = 0;
    }
    event.stopPropagation();
    wakeDragSession = {
      pointerId: event.pointerId,
      startX: getPointerScreenX(event),
      startY: getPointerScreenY(event),
      startRight: currentPanel.right,
      startBottom: currentPanel.bottom,
      moved: false
    };
    panel.dataset.wakeDragging = 'true';
    try { wakeButton.setPointerCapture(event.pointerId); } catch {}
  }

  function moveWakeDrag(event) {
    if (!wakeDragSession || wakeDragSession.pointerId !== event.pointerId || !panel) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const deltaX = getPointerScreenX(event) - wakeDragSession.startX;
    const deltaY = getPointerScreenY(event) - wakeDragSession.startY;

    if (!wakeDragSession.moved && Math.hypot(deltaX, deltaY) < WAKE_DRAG_THRESHOLD) {
      return;
    }
    wakeDragSession.moved = true;

    currentPanel = clampMinimizedPanelPosition({
      ...currentPanel,
      right: wakeDragSession.startRight - deltaX,
      bottom: wakeDragSession.startBottom - deltaY
    });
    applyPanelStyles(panel, currentPanel);
  }

  function endWakeDrag(event) {
    if (!wakeDragSession || wakeDragSession.pointerId !== event.pointerId) {
      return;
    }
    const moved = wakeDragSession.moved;
    wakeDragSession = null;
    if (panel) {
      delete panel.dataset.wakeDragging;
    }
    if (wakeButton?.hasPointerCapture?.(event.pointerId)) {
      wakeButton.releasePointerCapture(event.pointerId);
    }
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
      saveState({ panel: currentPanel });
      suppressWakeClick = true;
      suppressWakeClickTimer = window.setTimeout(() => {
        suppressWakeClick = false;
        suppressWakeClickTimer = 0;
      }, 500);
    }
  }

  function handleWakeClick(event) {
    if (suppressWakeClick) {
      suppressWakeClick = false;
      if (suppressWakeClickTimer) {
        window.clearTimeout(suppressWakeClickTimer);
        suppressWakeClickTimer = 0;
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      displayMode !== 'fullscreen'
      && panel?.dataset.minimized === 'true'
    ) {
      wakePanel();
    }
  }

  function closePanel() {
    resetEmbedPassthrough('panel-close');
    unloadFrame();
    stopAllPcmRelays();
    if (host) {
      host.remove();
    }
    host = null;
    shadow = null;
    panel = null;
    frame = null;
    wakeButton = null;
    toolbar = null;
    routesEl = null;
    offlineEl = null;
    offlineMessageEl = null;
    statusDot = null;
    dragSession = null;
    resizeSession = null;
    wakeDragSession = null;
    suppressWakeClick = false;
    if (suppressWakeClickTimer) {
      window.clearTimeout(suppressWakeClickTimer);
      suppressWakeClickTimer = 0;
    }
  }

  function getFrameTargetUrl() {
    const target = new URL(webuiUrl || DEFAULT_STATE.webuiUrl);
    if (isEmbeddedDisplayMode(displayMode)) {
      target.searchParams.set('surface', 'embed');
      target.searchParams.set('components', surfaceComponents.length ? surfaceComponents.join(',') : 'none');
      target.searchParams.set('chat_mode', chatSurfaceMode);
      if (avatarForm === 'cat') {
        target.searchParams.set('avatar_form', 'cat');
        if (avatarFormRequestId) {
          target.searchParams.set('avatar_request_id', avatarFormRequestId);
        }
      }
    }
    return target.toString();
  }

  function resetFrameBridgeState() {
    frameBridgeReady = false;
    frameWebuiReady = false;
  }

  function reloadFrameBridge() {
    if (!frame) {
      return;
    }
    resetFrameBridgeState();
    try { frame.src = 'about:blank'; } catch {}
    frame.src = FRAME_BRIDGE_URL;
  }

  function loadWebuiThroughFrameBridge() {
    if (!frameBridgeReady) {
      return false;
    }
    frameWebuiReady = false;
    return postFrameBridgeMessage({
      type: 'NEKO_FLOATING_FRAME_LOAD',
      targetUrl: getFrameTargetUrl(),
      colorScheme: syncFrameColorScheme()
    });
  }

  function postFrameBridgeMessage(payload, transfer = []) {
    if (!frame?.contentWindow || !frameBridgeReady || !frameBridgeToken) {
      return false;
    }
    try {
      frame.contentWindow.postMessage({
        ...payload,
        bridgeToken: frameBridgeToken
      }, FRAME_BRIDGE_ORIGIN, transfer);
      return true;
    } catch {
      return false;
    }
  }

  function handleFrameBridgeMessage(data) {
    if (data.type === 'NEKO_FLOATING_FRAME_READY') {
      frameBridgeReady = true;
      frameWebuiReady = false;
      ensureFrameBridgeToken()
        .then(() => {
          if (frameBridgeReady) {
            loadWebuiThroughFrameBridge();
          }
        })
        .catch(() => setOnline(false));
      return;
    }
    if (data.type === 'NEKO_FLOATING_FRAME_WEBUI_LOADED') {
      if (data.targetUrl !== getFrameTargetUrl()) {
        loadWebuiThroughFrameBridge();
        return;
      }
      frameWebuiReady = true;
      onWebuiLoad();
      return;
    }
    if (data.type === 'NEKO_FLOATING_FRAME_ERROR') {
      frameWebuiReady = false;
      setOnline(false);
    }
  }

  function ensureFrameBridgeToken() {
    if (frameBridgeToken) {
      return Promise.resolve(frameBridgeToken);
    }
    if (!frameBridgeTokenRequest) {
      frameBridgeTokenRequest = chrome.runtime.sendMessage({
        type: 'NEKO_GET_FRAME_BRIDGE_TOKEN'
      }).then((response) => {
        if (!response?.ok || typeof response.token !== 'string' || response.token.length < 32) {
          throw new Error(response?.error || 'Floating frame bridge token is unavailable');
        }
        frameBridgeToken = response.token;
        return frameBridgeToken;
      }).finally(() => {
        frameBridgeTokenRequest = null;
      });
    }
    return frameBridgeTokenRequest;
  }

  function isEmbeddedSurfaceActive() {
    return Boolean(
      isEmbeddedDisplayMode(displayMode)
      && panel
      && frame
      && panel.hidden !== true
      && panel.dataset.minimized === 'false'
    );
  }

  function isEmbedPassthroughActive() {
    return Boolean(
      displayMode === 'fullscreen'
      && isEmbeddedSurfaceActive()
    );
  }

  function resetEmbedPassthrough(reason) {
    embedReady = false;
    embedConnectSent = false;
    embedRegions = [];
    embedViewport = null;
    embedPointerLock = null;
    pendingEmbedHitTest = null;
    if (embedFallbackTimer) {
      window.clearTimeout(embedFallbackTimer);
      embedFallbackTimer = 0;
    }
    if (panel) {
      panel.dataset.embedInteractive = 'false';
      panel.dataset.embedProtocol = reason || 'idle';
    }
  }

  function startEmbeddedSurfaceHandshake() {
    if (!isEmbeddedSurfaceActive()) {
      return;
    }
    resetEmbedPassthrough('connecting');
    sendEmbedConnect();
    embedFallbackTimer = window.setTimeout(() => {
      embedFallbackTimer = 0;
      if (!isEmbeddedSurfaceActive() || embedReady) {
        return;
      }
      panel.dataset.embedProtocol = 'legacy';
      setFrameInteractive(true, 'legacy-fallback');
    }, EMBED_PROTOCOL_FALLBACK_MS);
  }

  function sendEmbedConnect() {
    if (!isEmbeddedSurfaceActive() || embedConnectSent) {
      return;
    }
    embedConnectSent = true;
    postEmbedMessage({
      type: 'NEKO_EMBED_CONNECT',
      protocolVersion: EMBED_PROTOCOL_VERSION,
      components: surfaceComponents.slice(),
      chatMode: chatSurfaceMode,
      avatarForm,
      avatarFormRequestId,
      requestId: `connect-${Date.now()}`
    });
  }

  function postEmbedMessage(payload) {
    if (!isFrameReadyForWebui()) {
      return;
    }
    postFrameBridgeMessage(payload);
  }

  function handleEmbedMessage(data) {
    if (!isEmbeddedSurfaceActive() || !data.type.startsWith('NEKO_EMBED_')) {
      return;
    }

    if (data.type === 'NEKO_EMBED_READY') {
      embedReady = true;
      if (embedFallbackTimer) {
        window.clearTimeout(embedFallbackTimer);
        embedFallbackTimer = 0;
      }
      panel.dataset.embedProtocol = 'ready';
      sendEmbedConnect();
      postEmbedMessage({ type: 'NEKO_EMBED_GET_REGIONS', requestId: `regions-${Date.now()}` });
      return;
    }

    if (data.type === 'NEKO_EMBED_INTERACTIVE_REGIONS') {
      embedRegions = normalizeEmbedRegions(data.regions);
      embedViewport = normalizeEmbedViewport(data.viewport);
      updateFrameInteractionFromLastPointer('regions');
      return;
    }

    if (data.type === 'NEKO_EMBED_COMPONENTS_CHANGED') {
      postEmbedMessage({ type: 'NEKO_EMBED_GET_REGIONS', requestId: `regions-${Date.now()}` });
      return;
    }

    if (data.type === 'NEKO_EMBED_AVATAR_FORM_STATE') {
      const nextAvatarForm = normalizeAvatarForm(data.avatarForm);
      if (data.status === 'applied') {
        setAvatarForm(nextAvatarForm, false);
        chrome.runtime.sendMessage({
          type: 'NEKO_AVATAR_FORM_STATE',
          avatarForm: nextAvatarForm,
          visible: data.visible === true,
          requestId: data.avatarFormRequestId || null
        }).catch(() => {});
      }
      return;
    }

    if (data.type === 'NEKO_EMBED_POINTER') {
      handleEmbeddedPointer(data);
      return;
    }

    if (data.type === 'NEKO_EMBED_HIT_TEST_RESULT') {
      handleEmbedHitTestResult(data);
    }
  }

  function normalizeEmbedRegions(regions) {
    if (!Array.isArray(regions)) {
      return [];
    }
    return regions.filter((region) => {
      const rect = region?.rect;
      return rect
        && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
        && rect.right > rect.left
        && rect.bottom > rect.top;
    }).map((region) => ({
      component: String(region.component || ''),
      kind: String(region.kind || 'ui'),
      id: String(region.id || ''),
      rect: {
        left: Number(region.rect.left),
        top: Number(region.rect.top),
        right: Number(region.rect.right),
        bottom: Number(region.rect.bottom)
      }
    }));
  }

  function normalizeEmbedViewport(viewport) {
    const width = Number(viewport?.width);
    const height = Number(viewport?.height);
    if (!(width > 0) || !(height > 0)) {
      return null;
    }
    return { width, height };
  }

  function handleHostPointerMove(event) {
    lastHostPointer = { x: event.clientX, y: event.clientY };
    if (!isEmbedPassthroughActive() || embedPointerLock !== null) {
      return;
    }
    if (wakeButton && event.composedPath?.().includes(wakeButton)) {
      setFrameInteractive(false, 'wake-button');
      return;
    }
    updateFrameInteractionFromLastPointer('host-pointer');
  }

  function updateFrameInteractionFromLastPointer(reason) {
    if (!isEmbedPassthroughActive() || embedPointerLock !== null || !lastHostPointer) {
      return;
    }
    const point = hostPointToEmbedPoint(lastHostPointer.x, lastHostPointer.y);
    const region = findEmbedRegionAtPoint(point.x, point.y);
    setFrameInteractive(Boolean(region), reason);
    if (region?.kind === 'model-bounds' && (region.id === 'vrm-model' || region.id === 'mmd-model')) {
      requestEmbedHitTest(point.x, point.y, lastHostPointer);
    } else {
      pendingEmbedHitTest = null;
    }
  }

  function setFrameInteractive(interactive, reason) {
    if (!panel || displayMode !== 'fullscreen') {
      return;
    }
    panel.dataset.embedInteractive = interactive ? 'true' : 'false';
    if (reason) {
      panel.dataset.embedInteractionReason = reason;
    }
  }

  function hostPointToEmbedPoint(x, y) {
    const rect = frame?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { x, y };
    }
    const viewportWidth = embedViewport?.width || rect.width;
    const viewportHeight = embedViewport?.height || rect.height;
    return {
      x: (x - rect.left) * viewportWidth / rect.width,
      y: (y - rect.top) * viewportHeight / rect.height
    };
  }

  function embedPointToHostPoint(x, y) {
    const rect = frame?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { x, y };
    }
    const viewportWidth = embedViewport?.width || rect.width;
    const viewportHeight = embedViewport?.height || rect.height;
    return {
      x: rect.left + x * rect.width / viewportWidth,
      y: rect.top + y * rect.height / viewportHeight
    };
  }

  function findEmbedRegionAtPoint(x, y) {
    return embedRegions.find((region) => (
      x >= region.rect.left
      && x <= region.rect.right
      && y >= region.rect.top
      && y <= region.rect.bottom
    )) || null;
  }

  function requestEmbedHitTest(x, y, hostPoint) {
    const requestId = `hit-${++embedHitTestSequence}`;
    pendingEmbedHitTest = {
      requestId,
      hostX: hostPoint.x,
      hostY: hostPoint.y
    };
    postEmbedMessage({ type: 'NEKO_EMBED_HIT_TEST', requestId, x, y });
  }

  function handleEmbedHitTestResult(data) {
    if (!pendingEmbedHitTest || data.requestId !== pendingEmbedHitTest.requestId || embedPointerLock !== null) {
      return;
    }
    const pending = pendingEmbedHitTest;
    pendingEmbedHitTest = null;
    if (!lastHostPointer
        || Math.abs(lastHostPointer.x - pending.hostX) > 1
        || Math.abs(lastHostPointer.y - pending.hostY) > 1) {
      return;
    }
    setFrameInteractive(data.interactive === true, 'model-hit-test');
  }

  function handleEmbeddedPointer(data) {
    const pointerId = Number.isFinite(Number(data.pointerId)) ? Number(data.pointerId) : 0;
    const phase = String(data.phase || 'move');
    const hostPoint = embedPointToHostPoint(Number(data.x) || 0, Number(data.y) || 0);
    lastHostPointer = hostPoint;

    if (phase === 'down') {
      embedPointerLock = pointerId;
      setFrameInteractive(true, 'pointer-drag');
      return;
    }

    if (phase === 'up' || phase === 'cancel' || phase === 'leave') {
      embedPointerLock = null;
      setFrameInteractive(data.interactive === true, 'embedded-pointer-release');
      return;
    }

    if (embedPointerLock !== null && Number(data.buttons) > 0) {
      setFrameInteractive(true, 'pointer-drag');
      return;
    }

    if (embedPointerLock !== null && Number(data.buttons) === 0) {
      embedPointerLock = null;
    }

    if (embedPointerLock === null) {
      setFrameInteractive(data.interactive === true, 'embedded-pointer');
    }
  }

  function createHost() {
    const nextHost = document.createElement('div');
    nextHost.id = HOST_ID;
    nextHost.dataset.nekoContentRuntimeId = CONTENT_RUNTIME_ID;
    nextHost.style.all = 'initial';
    nextHost.style.position = 'fixed';
    nextHost.style.inset = '0';
    nextHost.style.zIndex = '2147483647';
    nextHost.style.pointerEvents = 'none';
    document.documentElement.append(nextHost);
    return nextHost;
  }

  function resolveEmbeddingColorScheme() {
    const candidates = [document.documentElement, document.body]
      .filter(Boolean)
      .map((element) => {
        try {
          return String(getComputedStyle(element).colorScheme || '').trim().toLowerCase();
        } catch {
          return '';
        }
      });
    const declared = candidates.find((value) => value && value !== 'normal') || 'normal';
    const supportsLight = /(?:^|\s)light(?:\s|$)/.test(declared);
    const supportsDark = /(?:^|\s)dark(?:\s|$)/.test(declared);

    if (supportsDark && !supportsLight) {
      return 'dark';
    }
    if (supportsLight && !supportsDark) {
      return 'light';
    }
    if (supportsLight && supportsDark) {
      return embeddingColorSchemeMedia?.matches === true ? 'dark' : 'light';
    }

    // `normal` means the page did not opt in to dark browser surfaces. Even
    // under a dark OS preference its document canvas is therefore light.
    return 'light';
  }

  function syncFrameColorScheme() {
    const scheme = resolveEmbeddingColorScheme();
    host?.style.setProperty('color-scheme', scheme);
    panel?.style.setProperty('color-scheme', scheme);
    if (frame) {
      frame.style.setProperty('color-scheme', scheme);
      frame.dataset.nekoEmbeddingColorScheme = scheme;
    }
    if (frameBridgeReady) {
      postFrameBridgeMessage({
        type: 'NEKO_FLOATING_FRAME_COLOR_SCHEME',
        colorScheme: scheme
      });
    }
    return scheme;
  }

  function applyPanelMessage(message) {
    if (message.closed) {
      closePanel();
      return;
    }
    if (!panel) {
      return;
    }
    if (message.panel) {
      currentPanel = normalizePanel(message.panel);
      applyPanelStyles(panel, currentPanel);
      if (message.persist) {
        saveState({ panel: currentPanel });
      }
    }
    if (typeof message.minimized === 'boolean') {
      setMinimized(message.minimized, Boolean(message.persist));
    }
  }

  function applyPanelStyles(target, nextPanel) {
    if (target.dataset.displayMode === 'fullscreen') {
      return;
    }
    target.style.width = `${nextPanel.width}px`;
    target.style.height = `${nextPanel.height}px`;
    target.style.right = `${nextPanel.right}px`;
    target.style.bottom = `${nextPanel.bottom}px`;
  }

  function normalizePanel(nextPanel) {
    const maxWidth = Math.max(MIN_SIZE.width, Math.floor(window.innerWidth * 0.9));
    const maxHeight = Math.max(MIN_SIZE.height, Math.floor(window.innerHeight * 0.9));
    const width = Math.min(maxWidth, Math.max(MIN_SIZE.width, Math.round(Number(nextPanel.width) || DEFAULT_STATE.panel.width)));
    const height = Math.min(maxHeight, Math.max(MIN_SIZE.height, Math.round(Number(nextPanel.height) || DEFAULT_STATE.panel.height)));
    const right = Math.max(8, Math.min(Math.round(Number(nextPanel.right) || DEFAULT_STATE.panel.right), window.innerWidth - 80));
    const bottom = Math.max(8, Math.min(Math.round(Number(nextPanel.bottom) || DEFAULT_STATE.panel.bottom), window.innerHeight - 48));
    return { width, height, right, bottom };
  }

  function clampMinimizedPanelPosition(nextPanel) {
    const rawRight = Number(nextPanel.right);
    const rawBottom = Number(nextPanel.bottom);
    const maxRight = Math.max(8, window.innerWidth - MINIMIZED_SIZE.width);
    const maxBottom = Math.max(8, window.innerHeight - MINIMIZED_SIZE.height);
    const right = Math.max(8, Math.min(Math.round(Number.isFinite(rawRight) ? rawRight : DEFAULT_STATE.panel.right), maxRight));
    const bottom = Math.max(8, Math.min(Math.round(Number.isFinite(rawBottom) ? rawBottom : DEFAULT_STATE.panel.bottom), maxBottom));
    return { ...nextPanel, right, bottom };
  }

  function clampPanel(nextPanel) {
    return normalizePanel(nextPanel);
  }

  function isPanelVisible() {
    return Boolean(panel && !panel.hidden);
  }

  function getPanelStatus() {
    const minimized = panel?.dataset.minimized !== 'false';
    return {
      visible: isPanelVisible(),
      minimized,
      awake: isPanelVisible() && !minimized,
      avatarForm
    };
  }

  function normalizeDisplayMode(mode) {
    if (mode === 'fullscreen' || mode === 'sidebar') {
      return mode;
    }
    return 'floating';
  }

  function normalizeAvatarForm(value) {
    return value === 'cat' ? 'cat' : 'model';
  }

  function setAvatarForm(value, persist) {
    const nextAvatarForm = normalizeAvatarForm(value);
    if (nextAvatarForm === 'cat') {
      if (avatarForm !== 'cat' || !avatarFormRequestId) {
        avatarFormRequestId = `avatar-form-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
    } else {
      avatarFormRequestId = null;
    }
    avatarForm = nextAvatarForm;
    if (persist) {
      saveState({ avatarForm });
    }
    return avatarForm;
  }

  function isEmbeddedDisplayMode(mode) {
    return mode === 'floating' || mode === 'fullscreen';
  }

  function normalizeSurfaceComponents(value) {
    if (!Array.isArray(value)) {
      return EMBED_SURFACE_COMPONENT_ORDER.slice();
    }
    const selected = new Set(value.map((item) => String(item || '').trim().toLowerCase()));
    return EMBED_SURFACE_COMPONENT_ORDER.filter((component) => selected.has(component));
  }

  function normalizeChatSurfaceMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'compact' || normalized === 'full' ? normalized : 'auto';
  }

  function applySurfaceComponents(value) {
    const next = normalizeSurfaceComponents(value);
    surfaceComponents = next;
    if (isEmbeddedSurfaceActive() && embedReady) {
      postEmbedMessage({
        type: 'NEKO_EMBED_SET_COMPONENTS',
        requestId: `components-${Date.now()}`,
        components: surfaceComponents.slice()
      });
    }
    return surfaceComponents.slice();
  }

  function applyChatSurfaceMode(value) {
    chatSurfaceMode = normalizeChatSurfaceMode(value);
    if (isEmbeddedSurfaceActive() && embedReady) {
      postEmbedMessage({
        type: 'NEKO_EMBED_SET_CHAT_MODE',
        requestId: `chat-mode-${Date.now()}`,
        chatMode: chatSurfaceMode
      });
    }
    return chatSurfaceMode;
  }

  function applyWebuiUrl(value) {
    const nextUrl = normalizeNekoUrl(value);
    if (!nextUrl) {
      return null;
    }
    if (nextUrl === webuiUrl) {
      return webuiUrl;
    }
    webuiUrl = nextUrl;
    stopAllPcmRelays();
    updateOfflineMessage();
    setOnline(null);
    if (isConfiguredFrontendPage(location.href, webuiUrl)) {
      closePanel();
      return webuiUrl;
    }
    if (panel && !panel.hidden && panel.dataset.minimized !== 'true') {
      unloadFrame();
      ensureFrameLoaded();
      checkHealth();
    }
    return webuiUrl;
  }

  function updateOfflineMessage() {
    if (offlineMessageEl) {
      offlineMessageEl.textContent = `确认前端服务可通过 ${webuiUrl} 访问`;
    }
  }

  function canInjectHere() {
    return /^https?:\/\//i.test(location.href);
  }

  function getState() {
    return chrome.runtime.sendMessage({ type: 'NEKO_GET_STATE' }).then((stored) => ({
      ...DEFAULT_STATE,
      ...stored,
      webuiUrl: normalizeNekoUrl(stored?.webuiUrl) || DEFAULT_STATE.webuiUrl,
      surfaceComponents: normalizeSurfaceComponents(stored?.surfaceComponents),
      chatSurfaceMode: normalizeChatSurfaceMode(stored?.chatSurfaceMode),
      panel: {
        ...DEFAULT_STATE.panel,
        ...(stored?.panel || {})
      }
    })).catch(() => ({
      ...DEFAULT_STATE,
      surfaceComponents: DEFAULT_STATE.surfaceComponents.slice()
    }));
  }

  function saveState(payload) {
    chrome.runtime.sendMessage({
      type: 'NEKO_SET_STATE',
      payload
    }).catch(() => {});
  }

  function setupPcmMessagePort() {
    if (!isWebuiFrameReadyForMessaging()) {
      return;
    }
    try { pcmWebuiPort?.close(); } catch {}
    const channel = new MessageChannel();
    pcmWebuiPort = channel.port1;
    pcmWebuiPort.onmessage = (event) => {
      const data = event.data;
      if (!data || data._sender !== 'main' || typeof data.type !== 'string') {
        return;
      }
      if (data.type === 'NEKO_PCM_START' || data.type === 'NEKO_PCM_STOP') {
        handlePcmControlMessage(data);
      }
    };
    pcmWebuiPort.onmessageerror = () => {
      pcmWebuiPort = null;
    };
    try { pcmWebuiPort.start(); } catch {}
    if (!isFrameReadyForWebui()) {
      try { pcmWebuiPort.close(); } catch {}
      pcmWebuiPort = null;
      return;
    }
    try {
      const sent = postFrameBridgeMessage({
        type: 'NEKO_PCM_PORT',
        _sender: 'floating'
      }, [channel.port2]);
      if (!sent) {
        throw new Error('Floating frame bridge is not ready');
      }
      console.log('[NEKO-MIC content] PCM MessagePort sent');
    } catch {
      try { pcmWebuiPort.close(); } catch {}
      pcmWebuiPort = null;
    }
  }

  function isWebuiFrameReadyForMessaging() {
    return isFrameReadyForWebui();
  }

  function handlePcmControlMessage(data) {
    if (data.type === 'NEKO_PCM_START') {
      activePcmRelays.add(data.requestId);
      console.log('[NEKO-MIC content] PCM start:', data.requestId?.substring?.(0, 8));
      postPcmToWebui({
        type: 'NEKO_PCM_BRIDGE_ACK',
        requestId: data.requestId
      });
      chrome.runtime.sendMessage({
        type: 'NEKO_FLOATING_PCM_START',
        requestId: data.requestId,
        constraints: data.constraints,
        sampleRate: data.sampleRate
      }).then((response) => {
        if (response && response.ok === false) {
          postPcmError(data.requestId, response.error || 'Content PCM relay rejected request');
          return;
        }
        console.log('[NEKO-MIC content] PCM start acknowledged:', data.requestId?.substring?.(0, 8));
      }).catch((err) => {
        postPcmError(data.requestId, err);
      });
      return;
    }

    if (data.type === 'NEKO_PCM_STOP') {
      activePcmRelays.delete(data.requestId);
      console.log('[NEKO-MIC content] PCM stop:', data.requestId?.substring?.(0, 8));
      chrome.runtime.sendMessage({
        type: 'NEKO_FLOATING_PCM_STOP',
        requestId: data.requestId
      }).catch(() => {});
    }
  }

  function postPcmToWebui(payload) {
    if (pcmWebuiPort) {
      try {
        pcmWebuiPort.postMessage({ ...payload, _sender: 'floating' });
        return;
      } catch {
        pcmWebuiPort = null;
      }
    }
    if (!isFrameReadyForWebui()) {
      return;
    }
    postFrameBridgeMessage({ ...payload, _sender: 'floating' });
  }

  function postPcmError(requestId, err) {
    activePcmRelays.delete(requestId);
    postPcmToWebui({
      type: 'NEKO_PCM_SIGNAL',
      requestId,
      error: normalizeRelayError(err)
    });
  }

  function stopAllPcmRelays() {
    if (activePcmRelays.size === 0) {
      return;
    }
    const requestIds = Array.from(activePcmRelays);
    activePcmRelays.clear();
    requestIds.forEach((requestId) => {
      console.log('[NEKO-MIC content] PCM stop all:', requestId?.substring?.(0, 8));
      chrome.runtime.sendMessage({
        type: 'NEKO_FLOATING_PCM_STOP',
        requestId
      }).catch(() => {});
    });
  }

  function normalizeRelayError(err) {
    if (err && typeof err === 'object') {
      return {
        name: err.name || 'UnknownError',
        message: err.message || String(err)
      };
    }
    return {
      name: 'UnknownError',
      message: String(err || 'Unknown relay error')
    };
  }

  function normalizeNekoUrl(url) {
    try {
      const parsed = new URL(url || DEFAULT_STATE.webuiUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (!parsed.hostname || parsed.username || parsed.password) return null;
      return parsed.toString();
    } catch {}
    return null;
  }

  function isConfiguredFrontendPage(pageUrl, frontendUrl) {
    try {
      return new URL(pageUrl).origin === new URL(
        normalizeNekoUrl(frontendUrl) || DEFAULT_STATE.webuiUrl
      ).origin;
    } catch {
      return false;
    }
  }

  function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(max, Math.max(min, number));
  }

  function getPointerScreenX(event) {
    return Number.isFinite(event.screenX) ? event.screenX : event.clientX;
  }

  function getPointerScreenY(event) {
    return Number.isFinite(event.screenY) ? event.screenY : event.clientY;
  }
})();
