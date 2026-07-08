(() => {
  const HOST_ID = 'neko-floating-webui-host';
  const PANEL_ID = 'neko-floating-webui-panel';
  const FRAME_ID = 'neko-floating-webui-frame';
  const WAKE_ID = 'neko-floating-webui-wake';

  const MINIMIZED_SIZE = { width: 210, height: 48 };
  const MIN_SIZE = { width: 320, height: 420 };
  const WAKE_DRAG_THRESHOLD = 4;

  const DEFAULT_STATE = {
    enabled: false,
    minimized: true,
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
  let host = null;
  let shadow = null;
  let panel = null;
  let frame = null;
  let wakeButton = null;
  let toolbar = null;
  let routesEl = null;
  let offlineEl = null;
  let statusDot = null;

  let dragSession = null;
  let resizeSession = null;
  let wakeDragSession = null;

  const activePcmRelays = new Set();
  let pcmWebuiPort = null;

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
      closePanel();
      sendResponse({ visible: false });
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

    return false;
  });

  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow) {
      return;
    }
    if (event.origin !== getWebuiOrigin()) {
      return;
    }
    const data = event.data;
    if (!data || data._sender !== 'main' || typeof data.type !== 'string') {
      return;
    }
    if (data.type === 'NEKO_PCM_START' || data.type === 'NEKO_PCM_STOP') {
      handlePcmControlMessage(data);
    }
  });

  autoOpenPanel().catch(() => {});

  window.addEventListener('resize', () => {
    if (!panel) {
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

  window.addEventListener('pagehide', stopAllPcmRelays);
  window.addEventListener('beforeunload', stopAllPcmRelays);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopAllPcmRelays();
    }
  });

  async function openPanel(forceAwake = false) {
    const state = await getState();
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
    panel.hidden = false;
    applyPanelStyles(panel, currentPanel);
  }

  function ensurePanel() {
    host = document.getElementById(HOST_ID) || createHost();
    shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    panel = shadow.getElementById(PANEL_ID);
    frame = shadow.getElementById(FRAME_ID);
    wakeButton = shadow.getElementById(WAKE_ID);

    if (panel && frame && wakeButton) {
      return;
    }

    shadow.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
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
        border-radius: 999px;
      }

      #${WAKE_ID} {
        display: none;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        height: 100%;
        border: 1px solid rgba(15, 23, 42, 0.18);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.92);
        color: #0f172a;
        box-sizing: border-box;
        cursor: grab;
        font: 650 13px "Segoe UI", Arial, sans-serif;
        letter-spacing: 0;
        backdrop-filter: blur(14px);
        touch-action: none;
        user-select: none;
      }

      #${WAKE_ID}::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #16a34a;
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

    wakeButton = document.createElement('button');
    wakeButton.id = WAKE_ID;
    wakeButton.type = 'button';
    wakeButton.title = '唤醒 N.E.K.O 面板';
    wakeButton.textContent = 'N.E.K.O';
    wakeButton.addEventListener('pointerdown', startWakeDrag);
    wakeButton.addEventListener('pointermove', moveWakeDrag);
    wakeButton.addEventListener('pointerup', endWakeDrag);
    wakeButton.addEventListener('pointercancel', endWakeDrag);
    wakeButton.addEventListener('lostpointercapture', endWakeDrag);

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
        allow="autoplay; microphone; camera; display-capture; clipboard-read; clipboard-write"
        referrerpolicy="no-referrer-when-downgrade"
      ></iframe>
      <div class="offline" data-offline hidden>
        <strong>N.E.K.O WebUI 未连接</strong>
        <span>确认本地服务已运行在 http://localhost:48911/</span>
        <button type="button" data-action="retry">重试</button>
      </div>
    `;
    frame = contentEl.querySelector('#' + FRAME_ID);
    offlineEl = contentEl.querySelector('[data-offline]');
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
        const target = webuiUrl || DEFAULT_STATE.webuiUrl;
        try { frame.src = 'about:blank'; } catch {}
        frame.src = target;
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

  function onWebuiLoad() {
    setOnline(true);
    scheduleWebuiReflow();
    setupPcmMessagePort();
    checkHealth();
  }

  function scheduleWebuiReflow() {
    if (!frame) {
      return;
    }
    [0, 80, 240, 600, 1200].forEach((delay) => {
      window.setTimeout(() => {
        try {
          frame.contentWindow?.postMessage({
            type: 'NEKO_FLOATING_WEBUI_REFLOW'
          }, getWebuiOrigin());
        } catch {}
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
    const target = webuiUrl || DEFAULT_STATE.webuiUrl;
    try {
      const current = frame.src;
      if (current && new URL(current).toString() === new URL(target).toString()) {
        return;
      }
    } catch {}
    frame.src = target;
  }

  function unloadFrame() {
    if (!frame) {
      return;
    }
    try { frame.src = 'about:blank'; } catch {}
    frame.removeAttribute('src');
  }

  function setMinimized(minimized, persist) {
    if (!panel) {
      return;
    }
    panel.dataset.minimized = String(minimized);

    if (minimized) {
      unloadFrame();
      stopAllPcmRelays();
    } else {
      ensureFrameLoaded();
    }

    if (persist) {
      saveState({ enabled: true, minimized });
      chrome.runtime.sendMessage({
        type: 'NEKO_PANEL_STATE',
        minimized
      }).catch(() => {});
    }
  }

  async function wakePanel() {
    const response = await chrome.runtime.sendMessage({ type: 'NEKO_WAKE_PANEL' }).catch(() => null);
    if (response?.ok) {
      setMinimized(false, true);
      return;
    }
    setMinimized(false, true);
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
    if (event.button !== 0 || !panel || !wakeButton || panel.dataset.minimized !== 'true') {
      return;
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
    } else if (event.type === 'pointerup') {
      wakePanel();
    }
  }

  function closePanel() {
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
    statusDot = null;
    dragSession = null;
    resizeSession = null;
    wakeDragSession = null;
  }

  function createHost() {
    const nextHost = document.createElement('div');
    nextHost.id = HOST_ID;
    nextHost.style.all = 'initial';
    nextHost.style.position = 'fixed';
    nextHost.style.inset = '0';
    nextHost.style.zIndex = '2147483647';
    nextHost.style.pointerEvents = 'none';
    document.documentElement.append(nextHost);
    return nextHost;
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
      awake: isPanelVisible() && !minimized
    };
  }

  function canInjectHere() {
    const url = location.href;
    if (!/^https?:\/\//i.test(url)) {
      return false;
    }
    return !/^https?:\/\/(?:localhost|127\.0\.0\.1):48911(?:\/|$)/i.test(url);
  }

  function getState() {
    return chrome.runtime.sendMessage({ type: 'NEKO_GET_STATE' }).then((stored) => ({
      ...DEFAULT_STATE,
      ...stored,
      panel: {
        ...DEFAULT_STATE.panel,
        ...(stored?.panel || {})
      }
    })).catch(() => DEFAULT_STATE);
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
    try {
      frame.contentWindow.postMessage({
        type: 'NEKO_PCM_PORT',
        _sender: 'floating'
      }, getWebuiOrigin(), [channel.port2]);
      console.log('[NEKO-MIC content] PCM MessagePort sent');
    } catch {
      try { pcmWebuiPort.close(); } catch {}
      pcmWebuiPort = null;
    }
  }

  function isWebuiFrameReadyForMessaging() {
    if (!frame?.contentWindow) {
      return false;
    }
    const expectedOrigin = getWebuiOrigin();
    try {
      if (new URL(frame.src).origin !== expectedOrigin) {
        return false;
      }
    } catch {
      return false;
    }
    try {
      const currentHref = frame.contentWindow.location.href;
      if (!currentHref || currentHref === 'about:blank') {
        return false;
      }
      return new URL(currentHref).origin === expectedOrigin;
    } catch {
      return true;
    }
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
    try {
      frame?.contentWindow?.postMessage({ ...payload, _sender: 'floating' }, getWebuiOrigin());
    } catch {}
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

  function getWebuiOrigin() {
    try {
      return new URL(webuiUrl || DEFAULT_STATE.webuiUrl).origin;
    } catch {
      return 'http://localhost:48911';
    }
  }

  function normalizeNekoUrl(url) {
    try {
      const parsed = new URL(url);
      const allowedHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (allowedHost && parsed.protocol === 'http:' && parsed.port === '48911') {
        return parsed.toString();
      }
    } catch {
      return null;
    }
    return null;
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
