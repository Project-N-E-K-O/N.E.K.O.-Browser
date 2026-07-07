(() => {
  const HOST_ID = 'neko-floating-webui-host';
  const PANEL_ID = 'neko-floating-webui-panel';
  const FRAME_ID = 'neko-floating-webui-frame';
  const WAKE_ID = 'neko-floating-webui-wake';
  const MINIMIZED_SIZE = {
    width: 210,
    height: 48
  };
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
  let host = null;
  let shadow = null;
  let panel = null;
  let frame = null;
  let wakeButton = null;
  let wakeDragSession = null;

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

    return false;
  });

  window.addEventListener('message', (event) => {
    const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;
    if (event.origin !== extensionOrigin) {
      return;
    }

    if (!event.data || event.data.type !== 'NEKO_FLOATING_PANEL') {
      return;
    }

    applyPanelMessage(event.data);
  });

  autoOpenPanel().catch(() => {});

  window.addEventListener('resize', () => {
    if (panel) {
      clampPanel(panel);
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
        min-width: 320px;
        min-height: 420px;
        max-width: min(90vw, 860px);
        max-height: 90vh;
        border: 1px solid rgba(15, 23, 42, 0.18);
        border-radius: 8px;
        overflow: hidden;
        background: transparent;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.28);
        pointer-events: auto;
      }

      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
      }

      #${PANEL_ID}[data-minimized="true"] {
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

      #${PANEL_ID}[data-minimized="true"] #${FRAME_ID} {
        display: none;
      }
    `;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.dataset.minimized = 'true';

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

    frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.title = 'N.E.K.O Floating WebUI';
    frame.allow = 'autoplay; microphone; camera; display-capture; clipboard-read; clipboard-write';
    frame.allowTransparency = 'true';
    panel.append(wakeButton, frame);
    shadow.append(style, panel);
  }

  function ensureFrameLoaded() {
    if (!frame) {
      return;
    }

    const extensionUrl = chrome.runtime.getURL('floating.html');
    if (frame.src !== extensionUrl) {
      frame.src = extensionUrl;
    }
  }

  function unloadFrame() {
    if (!frame) {
      return;
    }

    frame.src = 'about:blank';
    frame.removeAttribute('src');
  }

  function setMinimized(minimized, persist) {
    if (!panel) {
      return;
    }

    panel.dataset.minimized = String(minimized);

    if (minimized) {
      unloadFrame();
    } else {
      ensureFrameLoaded();
    }

    if (persist) {
      saveState({ enabled: true, minimized });
    }
  }

  async function wakePanel() {
    const response = await chrome.runtime.sendMessage({ type: 'NEKO_WAKE_PANEL' }).catch(() => null);
    if (response?.ok) {
      setMinimized(false, false);
      return;
    }

    setMinimized(false, true);
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

    try {
      wakeButton.setPointerCapture(event.pointerId);
    } catch {}
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

    if (host) {
      host.remove();
    }

    host = null;
    shadow = null;
    panel = null;
    frame = null;
    wakeButton = null;
    wakeDragSession = null;
    saveState({ enabled: false });
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
    const maxWidth = Math.max(320, Math.floor(window.innerWidth * 0.9));
    const maxHeight = Math.max(420, Math.floor(window.innerHeight * 0.9));
    const width = Math.min(maxWidth, Math.max(320, Math.round(Number(nextPanel.width) || DEFAULT_STATE.panel.width)));
    const height = Math.min(maxHeight, Math.max(420, Math.round(Number(nextPanel.height) || DEFAULT_STATE.panel.height)));
    const right = Math.max(8, Math.min(Math.round(Number(nextPanel.right) || DEFAULT_STATE.panel.right), window.innerWidth - 80));
    const bottom = Math.max(8, Math.min(Math.round(Number(nextPanel.bottom) || DEFAULT_STATE.panel.bottom), window.innerHeight - 48));

    return {
      width,
      height,
      right,
      bottom
    };
  }

  function clampMinimizedPanelPosition(nextPanel) {
    const rawRight = Number(nextPanel.right);
    const rawBottom = Number(nextPanel.bottom);
    const maxRight = Math.max(8, window.innerWidth - MINIMIZED_SIZE.width);
    const maxBottom = Math.max(8, window.innerHeight - MINIMIZED_SIZE.height);
    const right = Math.max(8, Math.min(Math.round(Number.isFinite(rawRight) ? rawRight : DEFAULT_STATE.panel.right), maxRight));
    const bottom = Math.max(8, Math.min(Math.round(Number.isFinite(rawBottom) ? rawBottom : DEFAULT_STATE.panel.bottom), maxBottom));

    return {
      ...nextPanel,
      right,
      bottom
    };
  }

  function clampPanel(target) {
    const rect = target.getBoundingClientRect();
    currentPanel = normalizePanel({
      ...currentPanel,
      right: window.innerWidth - rect.left - rect.width,
      bottom: window.innerHeight - rect.top - rect.height
    });
    applyPanelStyles(target, currentPanel);
    saveState({ panel: currentPanel });
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

  function getPointerScreenX(event) {
    return Number.isFinite(event.screenX) ? event.screenX : event.clientX;
  }

  function getPointerScreenY(event) {
    return Number.isFinite(event.screenY) ? event.screenY : event.clientY;
  }
})();
