(() => {
  const HOST_ID = 'neko-floating-webui-host';
  const PANEL_ID = 'neko-floating-webui-panel';
  const FRAME_ID = 'neko-floating-webui-frame';
  const WAKE_ID = 'neko-floating-webui-wake';
  const MENU_ID = 'neko-floating-webui-menu';

  const MINIMIZED_SIZE = { width: 96, height: 96 };
  const MIN_SIZE = { width: 320, height: 420 };
  const WAKE_DRAG_THRESHOLD = 4;
  const WAKE_IMAGE_URL = chrome.runtime.getURL('assets/cat-idle-cat1.gif');
  const FRAME_BRIDGE_URL = chrome.runtime.getURL('floating-frame.html');
  const FRAME_BRIDGE_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  const FRAME_BRIDGE_SENDER = 'neko-floating-frame-bridge';
  const EMBED_PROTOCOL_VERSION = 1;
  const EMBED_PROTOCOL_FALLBACK_MS = 1500;
  const EMBED_HIT_TEST_TIMEOUT_MS = 500;
  const EMBED_REGION_REFRESH_MS = 200;
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
  let fullscreenWakePosition = null;
  let suppressWakeClick = false;
  let suppressWakeClickTimer = 0;

  const activePcmRelays = new Set();
  let pcmWebuiPort = null;
  let frameBridgeToken = null;
  let frameBridgeTokenRequest = null;
  let frameBridgeReady = false;
  let frameWebuiReady = false;
  let healthCheckSequence = 0;
  let embedReady = false;
  let embedConnectSent = false;
  let embedRegions = [];
  let embedViewport = null;
  let embedPointerLock = null;
  let embedFallbackTimer = 0;
  let embedHitTestSequence = 0;
  let embedHitTestFrame = 0;
  let embedHitTestTimeout = 0;
  let pendingEmbedHitTest = null;
  let queuedEmbedHitTest = null;
  let lastHostPointer = null;
  let embedRegionRefreshTimer = 0;
  let lastEmbedRegionRefreshAt = 0;

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
      if (panel.dataset.fullscreenOffline === 'true' && fullscreenWakePosition) {
        const clampedPosition = clampMinimizedPanelPosition({
          ...currentPanel,
          ...fullscreenWakePosition
        });
        fullscreenWakePosition = {
          right: clampedPosition.right,
          bottom: clampedPosition.bottom
        };
        applyFullscreenWakePosition();
      }
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
    panel.dataset.fullscreenOffline = 'false';
    fullscreenWakePosition = null;
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
    if (mode !== 'fullscreen') {
      setFullscreenOfflineFallback(false);
    }
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
      if (previousMode !== mode && frameWebuiReady) {
        checkHealth();
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
        grid-template-rows: 46px minmax(0, 1fr);
        min-width: ${MIN_SIZE.width}px;
        min-height: ${MIN_SIZE.height}px;
        max-width: min(90vw, 860px);
        max-height: 90vh;
        border: 1px solid rgba(15, 23, 42, 0.18);
        border-radius: 12px;
        overflow: hidden;
        background: transparent;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.28);
        pointer-events: auto;
        color: #0f172a;
        font-family: Inter, "Segoe UI", Arial, sans-serif;
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
        position: relative;
        z-index: 8;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        height: 46px;
        padding: 0 7px 0 13px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.24);
        background:
          linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(241, 248, 255, 0.96));
        box-shadow:
          inset 0 1px rgba(255, 255, 255, 0.9),
          0 1px 0 rgba(15, 23, 42, 0.04);
        backdrop-filter: blur(16px) saturate(1.15);
        cursor: move;
        user-select: none;
      }

      .brand {
        display: inline-flex;
        align-items: center;
        min-width: 0;
        gap: 9px;
        white-space: nowrap;
      }

      .brand-title {
        color: #172033;
        font-size: 13px;
        font-weight: 760;
        letter-spacing: 0.045em;
      }

      .brand-state {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 22px;
        padding: 0 8px 0 7px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.7);
        color: #64748b;
        font-size: 10px;
        font-weight: 650;
        letter-spacing: 0.02em;
      }

      .status-dot {
        width: 7px;
        height: 7px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: #f59e0b;
        box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.12);
      }

      .status-dot[data-state="online"] {
        background: #22c55e;
        box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.12);
      }

      .status-dot[data-state="offline"] {
        background: #ef4444;
        box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.12);
      }

      .actions {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 3px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.58);
        cursor: pointer;
      }

      .actions button,
      .offline button {
        border: 1px solid rgba(15, 23, 42, 0.14);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.82);
        color: #0f172a;
        cursor: pointer;
        font: inherit;
      }

      .actions button {
        display: inline-grid;
        width: 27px;
        height: 27px;
        place-items: center;
        padding: 0;
        border-color: transparent;
        color: #475569;
        transition:
          color 140ms ease,
          background 140ms ease,
          border-color 140ms ease,
          transform 140ms ease;
      }

      .actions button svg {
        width: 15px;
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .actions button:hover,
      .offline button:hover {
        background: #f0f7ff;
        border-color: rgba(14, 165, 233, 0.28);
        color: #0284c7;
      }

      .actions button:hover {
        transform: translateY(-1px);
      }

      .actions button:active {
        transform: translateY(0);
      }

      .actions button[aria-expanded="true"] {
        border-color: rgba(14, 165, 233, 0.3);
        background: #e0f2fe;
        color: #0284c7;
      }

      .actions button[data-action="close"]:hover {
        border-color: rgba(239, 68, 68, 0.24);
        background: #fef2f2;
        color: #dc2626;
      }

      .routes {
        position: absolute;
        z-index: 10;
        top: 52px;
        right: 8px;
        box-sizing: border-box;
        width: min(232px, calc(100% - 16px));
        padding: 8px;
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 12px;
        background: #ffffff;
        box-shadow:
          0 18px 42px rgba(15, 23, 42, 0.2),
          0 3px 10px rgba(15, 23, 42, 0.08);
        color: #0f172a;
        animation: menu-pop 150ms ease-out;
      }

      .routes[hidden] {
        display: none;
      }

      @keyframes menu-pop {
        from {
          opacity: 0;
          transform: translateY(-5px) scale(0.98);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      .routes-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 28px;
        padding: 0 3px 5px 7px;
        color: #64748b;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
      }

      .routes-close {
        display: inline-grid;
        width: 24px;
        height: 24px;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: #94a3b8;
        cursor: pointer;
        font: 16px/1 "Segoe UI", sans-serif;
      }

      .routes-close:hover {
        background: #f1f5f9;
        color: #334155;
      }

      .routes-list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 5px;
      }

      .route-item {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        height: 38px;
        padding: 0 8px;
        border: 1px solid transparent;
        border-radius: 9px;
        background: #f8fafc;
        color: #334155;
        cursor: pointer;
        font: 600 11px/1 "Segoe UI", sans-serif;
        text-align: left;
        transition:
          color 140ms ease,
          background 140ms ease,
          border-color 140ms ease,
          transform 140ms ease;
      }

      .route-item:hover {
        border-color: rgba(14, 165, 233, 0.2);
        background: #f0f9ff;
        color: #0369a1;
        transform: translateY(-1px);
      }

      .route-mark {
        display: inline-grid;
        width: 22px;
        height: 22px;
        flex: 0 0 auto;
        place-items: center;
        border-radius: 7px;
        background: #e0f2fe;
        color: #0284c7;
      }

      .route-mark svg {
        width: 13px;
        height: 13px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .content {
        grid-row: 2;
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
        top: 46px;
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
        grid-template-rows: 0 minmax(0, 1fr) !important;
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

      #${PANEL_ID}[data-display-mode="fullscreen"][data-fullscreen-offline="true"] #${FRAME_ID} {
        visibility: hidden !important;
        pointer-events: none !important;
      }

      #${PANEL_ID}[data-display-mode="fullscreen"][data-fullscreen-offline="true"] #${WAKE_ID} {
        position: fixed;
        right: clamp(8px, var(--neko-wake-right, 24px), calc(100vw - ${MINIMIZED_SIZE.width}px));
        bottom: clamp(8px, var(--neko-wake-bottom, 24px), calc(100vh - ${MINIMIZED_SIZE.height}px));
        z-index: 2;
        display: flex !important;
        width: ${MINIMIZED_SIZE.width}px;
        height: ${MINIMIZED_SIZE.height}px;
        pointer-events: auto !important;
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

      @media (prefers-color-scheme: dark) {
        #${PANEL_ID} {
          border-color: rgba(148, 163, 184, 0.26);
          color: #e2e8f0;
        }

        .toolbar {
          border-bottom-color: rgba(148, 163, 184, 0.16);
          background:
            linear-gradient(135deg, rgba(15, 23, 42, 0.98), rgba(17, 36, 56, 0.97));
          box-shadow:
            inset 0 1px rgba(255, 255, 255, 0.05),
            0 1px 0 rgba(0, 0, 0, 0.28);
        }

        .brand-title {
          color: #f1f5f9;
        }

        .brand-state,
        .actions {
          border-color: rgba(148, 163, 184, 0.14);
          background: rgba(15, 23, 42, 0.46);
          color: #94a3b8;
        }

        .actions button {
          background: rgba(30, 41, 59, 0.76);
          color: #cbd5e1;
        }

        .actions button:hover,
        .actions button[aria-expanded="true"] {
          border-color: rgba(56, 189, 248, 0.25);
          background: rgba(14, 116, 144, 0.25);
          color: #7dd3fc;
        }

        .actions button[data-action="close"]:hover {
          border-color: rgba(248, 113, 113, 0.22);
          background: rgba(127, 29, 29, 0.28);
          color: #fca5a5;
        }

        .routes {
          border-color: rgba(148, 163, 184, 0.22);
          background: #111c2b;
          box-shadow:
            0 18px 42px rgba(0, 0, 0, 0.42),
            0 3px 10px rgba(0, 0, 0, 0.3);
          color: #e2e8f0;
        }

        .routes-head {
          color: #94a3b8;
        }

        .routes-close {
          color: #64748b;
        }

        .routes-close:hover {
          background: #1e293b;
          color: #e2e8f0;
        }

        .route-item {
          background: #172334;
          color: #cbd5e1;
        }

        .route-item:hover {
          border-color: rgba(56, 189, 248, 0.2);
          background: #172e43;
          color: #7dd3fc;
        }

        .route-mark {
          background: rgba(14, 116, 144, 0.3);
          color: #7dd3fc;
        }
      }
    `;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.dataset.minimized = 'true';
    panel.dataset.routesOpen = 'false';
    panel.dataset.componentsOpen = 'false';
    panel.dataset.displayMode = 'floating';
    panel.dataset.fullscreenOffline = 'false';
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
        <span class="brand-title">N.E.K.O</span>
        <span class="brand-state">
          <span class="status-dot" data-status></span>
          <span>WebUI</span>
        </span>
      </div>
      <nav class="actions" aria-label="浮窗操作">
        <button type="button" data-action="reload" title="刷新 WebUI" aria-label="刷新 WebUI">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5"/><path d="M18.2 15a7 7 0 1 1 .3-6.4L20 11"/></svg>
        </button>
        <button
          type="button"
          data-action="routes"
          title="菜单"
          aria-label="菜单"
          aria-haspopup="menu"
          aria-controls="${MENU_ID}"
          aria-expanded="false"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14"/></svg>
        </button>
        <button type="button" data-action="open" title="打开完整页面" aria-label="打开完整页面">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5"/><path d="M10 14 19 5"/><path d="M19 14v5H5V5h5"/></svg>
        </button>
        <button type="button" data-action="minimize" title="最小化" aria-label="最小化">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>
        </button>
        <button type="button" data-action="close" title="关闭" aria-label="关闭">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
        </button>
      </nav>
    `;
    toolbar = toolbarEl;

    const routesContainer = document.createElement('div');
    routesContainer.id = MENU_ID;
    routesContainer.className = 'routes';
    routesContainer.dataset.routes = '';
    routesContainer.setAttribute('role', 'menu');
    routesContainer.setAttribute('aria-label', '菜单');
    routesContainer.hidden = true;
    routesContainer.innerHTML = `
      <div class="routes-head">
        <span>菜单</span>
        <button type="button" class="routes-close" data-action="routes" aria-label="关闭菜单">×</button>
      </div>
      <div class="routes-list">
        <button type="button" class="route-item" role="menuitem" data-route="/">
          <span class="route-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="m4 11 8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/></svg>
          </span>
          <span>主界面</span>
        </button>
        <button type="button" class="route-item" role="menuitem" data-route="/chat_full">
          <span class="route-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M5 17.5 3.8 21l4.3-1.7A9 9 0 1 0 5 17.5Z"/><path d="M8 11h8M8 14h5"/></svg>
          </span>
          <span>完整聊天</span>
        </button>
        <button type="button" class="route-item" role="menuitem" data-route="/model_manager">
          <span class="route-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M5 21c.7-4.2 3-6.3 7-6.3s6.3 2.1 7 6.3"/><path d="M8.7 7.2c1.7.1 3.2-.7 4.2-2.2.7 1.2 1.5 1.9 2.6 2.2"/></svg>
          </span>
          <span>模型</span>
        </button>
        <button type="button" class="route-item" role="menuitem" data-route="/api_key">
          <span class="route-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2"/></svg>
          </span>
          <span>密钥</span>
        </button>
        <button type="button" class="route-item" role="menuitem" data-route="/memory_browser">
          <span class="route-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>
          </span>
          <span>记忆</span>
        </button>
      </div>
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
      if (routeButton) {
        openRoute(routeButton.dataset.route);
        return;
      }
      if (actionButton) {
        handleAction(actionButton.dataset.action);
        return;
      }
      if (routesEl && !routesEl.hidden && !routesEl.contains(event.target)) {
        setRoutesOpen(false);
      }
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !routesEl || routesEl.hidden) {
        return;
      }
      setRoutesOpen(false);
      toolbar?.querySelector('[data-action="routes"]')?.focus();
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
    toolbar
      ?.querySelector('[data-action="routes"]')
      ?.setAttribute('aria-expanded', String(open));
  }

  function openRoute(path) {
    setRoutesOpen(false);
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
    [0, 240, 1200].forEach((delay) => {
      window.setTimeout(() => {
        if (!isFrameReadyForWebui()) {
          return;
        }
        postFrameBridgeMessage({
          type: 'NEKO_FLOATING_WEBUI_REFLOW',
          force: true
        });
      }, delay);
    });
  }

  async function checkHealth() {
    if (!offlineEl) {
      return;
    }
    const sequence = ++healthCheckSequence;
    const checkedWebuiUrl = webuiUrl;
    let online = false;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'NEKO_HEALTH_CHECK' });
      online = response?.online === true;
    } catch {}
    if (sequence !== healthCheckSequence || checkedWebuiUrl !== webuiUrl) {
      return;
    }
    setOnline(online);
  }

  function setOnline(online) {
    updateOfflineMessage();
    if (online === true || online === false) {
      // A bridge load/error is more recent than any health request that is still pending.
      healthCheckSequence += 1;
    }
    if (online === true) {
      setFullscreenOfflineFallback(false);
    } else if (online === false) {
      setFullscreenOfflineFallback(true);
    }
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

  function setFullscreenOfflineFallback(active) {
    if (!panel) {
      return;
    }
    const shouldShow = active === true
      && displayMode === 'fullscreen'
      && panel.dataset.minimized === 'false';
    const wasShown = panel.dataset.fullscreenOffline === 'true';
    panel.dataset.fullscreenOffline = String(shouldShow);
    if (!shouldShow) {
      fullscreenWakePosition = null;
      return;
    }
    if (!wasShown || !fullscreenWakePosition) {
      const initialPosition = clampMinimizedPanelPosition(currentPanel);
      fullscreenWakePosition = {
        right: initialPosition.right,
        bottom: initialPosition.bottom
      };
    }
    applyFullscreenWakePosition();
    frameWebuiReady = false;
    resetEmbedPassthrough('fullscreen-offline');
    stopAllPcmRelays();
    postFrameBridgeMessage({ type: 'NEKO_FLOATING_FRAME_CLEAR' });
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
    const expandingFloatingPanel = minimized === false
      && displayMode === 'floating'
      && panel.dataset.minimized === 'true';
    let expandedPanelAdjusted = false;
    if (expandingFloatingPanel) {
      const expandedPanel = normalizePanel(currentPanel);
      expandedPanelAdjusted = expandedPanel.right !== currentPanel.right
        || expandedPanel.bottom !== currentPanel.bottom
        || expandedPanel.width !== currentPanel.width
        || expandedPanel.height !== currentPanel.height;
      currentPanel = expandedPanel;
    }
    if (minimized) {
      setFullscreenOfflineFallback(false);
      setAvatarForm('cat', false);
    }
    panel.dataset.minimized = String(minimized);

    if (expandingFloatingPanel) {
      applyPanelStyles(panel, currentPanel);
    }

    if (minimized) {
      setRoutesOpen(false);
      unloadFrame();
      stopAllPcmRelays();
    } else {
      ensureFrameLoaded();
    }

    if (persist) {
      saveState({ enabled: true, minimized, avatarForm, panel: currentPanel });
      chrome.runtime.sendMessage({
        type: 'NEKO_PANEL_STATE',
        minimized,
        avatarForm
      }).catch(() => {});
    } else if (expandedPanelAdjusted) {
      saveState({ panel: currentPanel });
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
      if (event.target.closest('.actions')) {
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
    // 全屏在线时直接使用 WebUI 自带的猫；后端离线时允许拖动扩展提供的临时唤醒入口。
    const fullscreenOfflineWake = displayMode === 'fullscreen'
      && panel.dataset.fullscreenOffline === 'true';
    if (!fullscreenOfflineWake && (displayMode === 'fullscreen' || panel.dataset.minimized !== 'true')) {
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
      startRight: fullscreenOfflineWake
        ? fullscreenWakePosition?.right ?? currentPanel.right
        : currentPanel.right,
      startBottom: fullscreenOfflineWake
        ? fullscreenWakePosition?.bottom ?? currentPanel.bottom
        : currentPanel.bottom,
      fullscreenOffline: fullscreenOfflineWake,
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

    const nextPosition = clampMinimizedPanelPosition({
      ...currentPanel,
      right: wakeDragSession.startRight - deltaX,
      bottom: wakeDragSession.startBottom - deltaY
    });
    if (wakeDragSession.fullscreenOffline) {
      fullscreenWakePosition = {
        right: nextPosition.right,
        bottom: nextPosition.bottom
      };
      applyFullscreenWakePosition();
    } else {
      currentPanel = nextPosition;
      applyPanelStyles(panel, currentPanel);
    }
  }

  function endWakeDrag(event) {
    if (!wakeDragSession || wakeDragSession.pointerId !== event.pointerId) {
      return;
    }
    const moved = wakeDragSession.moved;
    const fullscreenOffline = wakeDragSession.fullscreenOffline;
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
      if (!fullscreenOffline) {
        saveState({ panel: currentPanel });
      }
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
      displayMode === 'fullscreen'
      && panel?.dataset.fullscreenOffline === 'true'
    ) {
      event.preventDefault();
      event.stopPropagation();
      setOnline(null);
      retryFullscreenWebui();
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

  function retryFullscreenWebui() {
    if (frameBridgeReady && frameBridgeToken) {
      if (!loadWebuiThroughFrameBridge()) {
        reloadFrameBridge();
      }
      return;
    }
    ensureFrameBridgeToken()
      .then(() => {
        if (frameBridgeReady) {
          if (!loadWebuiThroughFrameBridge()) {
            reloadFrameBridge();
          }
          return;
        }
        reloadFrameBridge();
      })
      .catch(() => {
        reloadFrameBridge();
      });
  }

  function loadWebuiThroughFrameBridge() {
    if (!frameBridgeReady) {
      return false;
    }
    frameWebuiReady = false;
    return postFrameBridgeMessage({
      type: 'NEKO_FLOATING_FRAME_LOAD',
      targetUrl: getFrameTargetUrl(),
      requireOnline: displayMode === 'fullscreen',
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
    if (data.type === 'NEKO_FLOATING_FRAME_OFFLINE') {
      if (data.targetUrl !== getFrameTargetUrl()) {
        return;
      }
      frameWebuiReady = false;
      resetEmbedPassthrough('frame-offline');
      setOnline(false);
      return;
    }
    if (data.type === 'NEKO_FLOATING_FRAME_ERROR') {
      frameWebuiReady = false;
      resetEmbedPassthrough('frame-error');
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
    cancelEmbedHitTests();
    if (embedFallbackTimer) {
      window.clearTimeout(embedFallbackTimer);
      embedFallbackTimer = 0;
    }
    if (embedRegionRefreshTimer) {
      window.clearTimeout(embedRegionRefreshTimer);
      embedRegionRefreshTimer = 0;
    }
    lastEmbedRegionRefreshAt = 0;
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
      displayMode,
      components: surfaceComponents.slice(),
      chatMode: chatSurfaceMode,
      avatarForm,
      avatarFormRequestId,
      requestId: `connect-${Date.now()}`
    });
  }

  function postEmbedMessage(payload) {
    if (!isFrameReadyForWebui()) {
      return false;
    }
    return postFrameBridgeMessage(payload);
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
    scheduleEmbedRegionRefresh();
    if (wakeButton && event.composedPath?.().includes(wakeButton)) {
      setFrameInteractive(false, 'wake-button');
      return;
    }
    updateFrameInteractionFromLastPointer('host-pointer');
  }

  function scheduleEmbedRegionRefresh() {
    const now = performance.now();
    const elapsed = now - lastEmbedRegionRefreshAt;
    if (elapsed >= EMBED_REGION_REFRESH_MS) {
      const sent = postEmbedMessage({
        type: 'NEKO_EMBED_GET_REGIONS',
        requestId: `regions-${Date.now()}`
      });
      if (sent) {
        lastEmbedRegionRefreshAt = now;
      }
      return;
    }
    if (embedRegionRefreshTimer) {
      return;
    }
    embedRegionRefreshTimer = window.setTimeout(() => {
      embedRegionRefreshTimer = 0;
      const sent = postEmbedMessage({
        type: 'NEKO_EMBED_GET_REGIONS',
        requestId: `regions-${Date.now()}`
      });
      if (sent) {
        lastEmbedRegionRefreshAt = performance.now();
      }
    }, Math.max(0, EMBED_REGION_REFRESH_MS - elapsed));
  }

  function pointInConservativeEmbedModelBounds(x, y, region) {
    const rect = region?.rect;
    if (!rect) {
      return false;
    }
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    const halfWidth = (rect.right - rect.left) * 0.5 * 0.4;
    const halfHeight = (rect.bottom - rect.top) * 0.5 * 0.9;
    return halfWidth > 0
      && halfHeight > 0
      && Math.abs(x - centerX) <= halfWidth
      && Math.abs(y - centerY) <= halfHeight;
  }

  function updateFrameInteractionFromLastPointer(reason) {
    if (!isEmbedPassthroughActive() || embedPointerLock !== null || !lastHostPointer) {
      return;
    }
    const point = hostPointToEmbedPoint(lastHostPointer.x, lastHostPointer.y);
    const region = findEmbedRegionAtPoint(point.x, point.y);
    if (region?.kind === 'model-bounds' && (region.id === 'vrm-model' || region.id === 'mmd-model')) {
      // Use the same narrow model-centered inset as the embedded adapter so a
      // fast pointerdown does not have to wait for a cross-frame round trip.
      const conservativeHit = pointInConservativeEmbedModelBounds(point.x, point.y, region);
      setFrameInteractive(
        conservativeHit,
        conservativeHit ? 'model-conservative-hit' : 'model-conservative-miss'
      );
      if (!conservativeHit) {
        cancelEmbedHitTests();
        return;
      }
      // Confirm against the embedded adapter's fresher bounds while hover is
      // active. A pointerdown relay cancels this request and owns the drag.
      requestEmbedHitTest(point.x, point.y, lastHostPointer);
      return;
    }
    cancelEmbedHitTests();
    setFrameInteractive(Boolean(region), reason);
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
    queuedEmbedHitTest = {
      x,
      y,
      hostX: hostPoint.x,
      hostY: hostPoint.y
    };
    scheduleEmbedHitTest();
  }

  function scheduleEmbedHitTest() {
    if (embedHitTestFrame || pendingEmbedHitTest || !queuedEmbedHitTest) {
      return;
    }
    embedHitTestFrame = window.requestAnimationFrame(() => {
      embedHitTestFrame = 0;
      if (pendingEmbedHitTest || !queuedEmbedHitTest || embedPointerLock !== null) {
        return;
      }
      const request = queuedEmbedHitTest;
      queuedEmbedHitTest = null;
      const requestId = `hit-${++embedHitTestSequence}`;
      const sent = postEmbedMessage({
        type: 'NEKO_EMBED_HIT_TEST',
        requestId,
        x: request.x,
        y: request.y
      });
      if (!sent) {
        setFrameInteractive(false, 'model-hit-test-unavailable');
        return;
      }
      pendingEmbedHitTest = { requestId, hostX: request.hostX, hostY: request.hostY };
      embedHitTestTimeout = window.setTimeout(() => {
        embedHitTestTimeout = 0;
        if (!pendingEmbedHitTest || pendingEmbedHitTest.requestId !== requestId) {
          return;
        }
        pendingEmbedHitTest = null;
        setFrameInteractive(false, 'model-hit-test-timeout');
        scheduleEmbedHitTest();
      }, EMBED_HIT_TEST_TIMEOUT_MS);
    });
  }

  function cancelEmbedHitTests() {
    if (embedHitTestFrame) {
      window.cancelAnimationFrame(embedHitTestFrame);
      embedHitTestFrame = 0;
    }
    if (embedHitTestTimeout) {
      window.clearTimeout(embedHitTestTimeout);
      embedHitTestTimeout = 0;
    }
    pendingEmbedHitTest = null;
    queuedEmbedHitTest = null;
  }

  function handleEmbedHitTestResult(data) {
    if (!pendingEmbedHitTest || data.requestId !== pendingEmbedHitTest.requestId) {
      return;
    }
    const pending = pendingEmbedHitTest;
    pendingEmbedHitTest = null;
    if (embedHitTestTimeout) {
      window.clearTimeout(embedHitTestTimeout);
      embedHitTestTimeout = 0;
    }
    if (embedPointerLock !== null) {
      return;
    }
    if (!lastHostPointer
        || Math.abs(lastHostPointer.x - pending.hostX) > 1
        || Math.abs(lastHostPointer.y - pending.hostY) > 1) {
      if (lastHostPointer) {
        const point = hostPointToEmbedPoint(lastHostPointer.x, lastHostPointer.y);
        requestEmbedHitTest(point.x, point.y, lastHostPointer);
      }
      return;
    }
    setFrameInteractive(data.interactive === true, 'model-hit-test');
    scheduleEmbedHitTest();
  }

  function handleEmbeddedPointer(data) {
    const pointerId = Number.isFinite(Number(data.pointerId)) ? Number(data.pointerId) : 0;
    const phase = String(data.phase || 'move');
    const hostPoint = embedPointToHostPoint(Number(data.x) || 0, Number(data.y) || 0);
    lastHostPointer = hostPoint;
    // The embedded relay has already performed a hit test for this newer
    // pointer state. Retire any older host-requested model hit test so its
    // response or timeout cannot overwrite the authoritative relay result.
    cancelEmbedHitTests();

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
    const wakePanel = clampMinimizedPanelPosition(nextPanel);
    target.style.setProperty('--neko-wake-right', `${wakePanel.right}px`);
    target.style.setProperty('--neko-wake-bottom', `${wakePanel.bottom}px`);
    if (target.dataset.displayMode === 'fullscreen') {
      return;
    }
    target.style.width = `${nextPanel.width}px`;
    target.style.height = `${nextPanel.height}px`;
    target.style.right = `${nextPanel.right}px`;
    target.style.bottom = `${nextPanel.bottom}px`;
  }

  function applyFullscreenWakePosition() {
    if (!panel || !fullscreenWakePosition) {
      return;
    }
    panel.style.setProperty('--neko-wake-right', `${fullscreenWakePosition.right}px`);
    panel.style.setProperty('--neko-wake-bottom', `${fullscreenWakePosition.bottom}px`);
  }

  function normalizePanel(nextPanel) {
    const maxWidth = Math.max(MIN_SIZE.width, Math.floor(window.innerWidth * 0.9));
    const maxHeight = Math.max(MIN_SIZE.height, Math.floor(window.innerHeight * 0.9));
    const width = Math.min(maxWidth, Math.max(MIN_SIZE.width, Math.round(Number(nextPanel.width) || DEFAULT_STATE.panel.width)));
    const height = Math.min(maxHeight, Math.max(MIN_SIZE.height, Math.round(Number(nextPanel.height) || DEFAULT_STATE.panel.height)));
    const maxRight = Math.max(8, window.innerWidth - width - 8);
    const maxBottom = Math.max(8, window.innerHeight - height - 8);
    const rawRight = Number(nextPanel.right);
    const rawBottom = Number(nextPanel.bottom);
    const right = Math.max(8, Math.min(Math.round(Number.isFinite(rawRight) ? rawRight : DEFAULT_STATE.panel.right), maxRight));
    const bottom = Math.max(8, Math.min(Math.round(Number.isFinite(rawBottom) ? rawBottom : DEFAULT_STATE.panel.bottom), maxBottom));
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
