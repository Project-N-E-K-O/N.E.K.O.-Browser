const DEFAULT_STATE = {
  enabled: true,
  minimized: false,
  panel: {
    width: 420,
    height: 680,
    right: 24,
    bottom: 24
  },
  webuiUrl: 'http://localhost:48911/'
};

const MIN_SIZE = {
  width: 320,
  height: 420
};

const panel = document.querySelector('.panel');
const webui = document.getElementById('neko-webui');
const offline = document.querySelector('[data-offline]');
const statusDot = document.querySelector('[data-status]');
const routes = document.querySelector('[data-routes]');
const toolbar = document.querySelector('[data-drag-handle]');

let state = { ...DEFAULT_STATE };
let dragSession = null;
let resizeSession = null;
const activePcmRelays = new Set();
let pcmWebuiPort = null;

init();

async function init() {
  state = await getState();
  state.panel = {
    ...DEFAULT_STATE.panel,
    ...(state.panel || {})
  };

  applyMinimized(Boolean(state.minimized));
  setRoutesOpen(false);
  syncParentPanel(state.panel, false);
  setWebuiUrl(state.webuiUrl || DEFAULT_STATE.webuiUrl);
  bindControls();
  bindPcmRelay();
  bindDrag();
  bindResize();
  checkHealth();
  ensureMicPermission();
}

async function ensureMicPermission() {
  try {
    let needPrompt = true;
    try {
      const status = await navigator.permissions.query({ name: 'microphone' });
      needPrompt = (status.state === 'prompt');
    } catch {}
    if (!needPrompt) {
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {}
}

function bindControls() {
  document.addEventListener('click', (event) => {
    const actionButton = event.target.closest('[data-action]');
    const routeButton = event.target.closest('[data-route]');

    if (actionButton) {
      handleAction(actionButton.dataset.action);
    }

    if (routeButton) {
      openRoute(routeButton.dataset.route);
    }
  });

  webui.addEventListener('load', () => {
    setOnline(true);
    scheduleWebuiReflow();
    setupPcmMessagePort();
  });
}

function bindPcmRelay() {
  window.addEventListener('message', (event) => {
    if (event.source !== webui.contentWindow || event.origin !== getWebuiOrigin()) {
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

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'NEKO_PCM_TO_FLOATING') {
      return false;
    }
    if (!activePcmRelays.has(message.requestId)) {
      return false;
    }
    if (message.ready) {
      console.log('[NEKO-MIC floating] PCM relay ready:', message.requestId?.substring?.(0, 8));
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
  });

  window.addEventListener('pagehide', stopAllPcmRelays);
  window.addEventListener('beforeunload', stopAllPcmRelays);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopAllPcmRelays();
    }
  });
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
    webui.contentWindow.postMessage({
      type: 'NEKO_PCM_PORT',
      _sender: 'floating'
    }, getWebuiOrigin(), [channel.port2]);
    console.log('[NEKO-MIC floating] PCM MessagePort sent');
  } catch {
    try { pcmWebuiPort.close(); } catch {}
    pcmWebuiPort = null;
  }
}

function isWebuiFrameReadyForMessaging() {
  if (!webui.contentWindow) {
    return false;
  }

  const expectedOrigin = getWebuiOrigin();
  try {
    if (new URL(webui.src).origin !== expectedOrigin) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const currentHref = webui.contentWindow.location.href;
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
    console.log('[NEKO-MIC floating] PCM start:', data.requestId?.substring?.(0, 8));
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
        postPcmError(data.requestId, response.error || 'Floating PCM relay rejected request');
        return;
      }
      console.log('[NEKO-MIC floating] PCM start acknowledged:', data.requestId?.substring?.(0, 8));
    }).catch((err) => {
      postPcmError(data.requestId, err);
    });
    return;
  }

  if (data.type === 'NEKO_PCM_STOP') {
    activePcmRelays.delete(data.requestId);
    console.log('[NEKO-MIC floating] PCM stop:', data.requestId?.substring?.(0, 8));
    chrome.runtime.sendMessage({
      type: 'NEKO_FLOATING_PCM_STOP',
      requestId: data.requestId
    }).catch(() => {});
  }
}

function postPcmToWebui(payload) {
  if (pcmWebuiPort) {
    try {
      pcmWebuiPort.postMessage({
        ...payload,
        _sender: 'floating'
      });
      return;
    } catch {
      pcmWebuiPort = null;
    }
  }
  try {
    webui.contentWindow?.postMessage({
      ...payload,
      _sender: 'floating'
    }, getWebuiOrigin());
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
    console.log('[NEKO-MIC floating] PCM stop all:', requestId?.substring?.(0, 8));
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
    message: String(err || 'Unknown floating relay error')
  };
}

function handleAction(action) {
  if (action === 'reload' || action === 'retry') {
    offline.hidden = true;
    setOnline(null);
    webui.src = webui.src;
    checkHealth();
  }

  if (action === 'routes') {
    setRoutesOpen(routes.hidden);
    scheduleWebuiReflow();
  }

  if (action === 'open') {
    openRoute('/');
  }

  if (action === 'minimize') {
    applyMinimized(panel.dataset.minimized !== 'true');
  }

  if (action === 'close') {
    chrome.runtime.sendMessage({
      type: 'NEKO_PANEL_STATE',
      closed: true
    }).catch(() => {});

    window.parent.postMessage({
      type: 'NEKO_FLOATING_PANEL',
      closed: true
    }, '*');

    chrome.runtime.sendMessage({
      type: 'NEKO_SET_STATE',
      payload: { enabled: false }
    }).catch(() => {});
  }
}

function bindDrag() {
  toolbar.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) {
      return;
    }

    event.preventDefault();
    toolbar.setPointerCapture(event.pointerId);
    dragSession = {
      pointerId: event.pointerId,
      startX: getPointerScreenX(event),
      startY: getPointerScreenY(event),
      startRight: state.panel.right,
      startBottom: state.panel.bottom
    };
  });

  toolbar.addEventListener('pointermove', (event) => {
    if (!dragSession || dragSession.pointerId !== event.pointerId) {
      return;
    }

    const nextPanel = clampPanel({
      ...state.panel,
      right: dragSession.startRight - (getPointerScreenX(event) - dragSession.startX),
      bottom: dragSession.startBottom - (getPointerScreenY(event) - dragSession.startY)
    });

    persistPanel(nextPanel, false);
  });

  toolbar.addEventListener('pointerup', endDrag);
  toolbar.addEventListener('pointercancel', endDrag);
}

function bindResize() {
  document.querySelectorAll('[data-resize]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      document.documentElement.dataset.resizeDirection = handle.dataset.resize;
      resizeSession = {
        pointerId: event.pointerId,
        direction: handle.dataset.resize,
        startX: getPointerScreenX(event),
        startY: getPointerScreenY(event),
        panel: { ...state.panel }
      };
    });

    handle.addEventListener('pointermove', (event) => {
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      persistPanel(resizePanelFromPointer(resizeSession, event), false);
    });

    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
  });
}

function endDrag(event) {
  if (!dragSession || dragSession.pointerId !== event.pointerId) {
    return;
  }

  toolbar.releasePointerCapture(event.pointerId);
  dragSession = null;
  saveState({ panel: state.panel });
}

function endResize(event) {
  if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
    return;
  }

  event.target.releasePointerCapture(event.pointerId);
  delete document.documentElement.dataset.resizeDirection;
  resizeSession = null;
  saveState({ panel: state.panel });
}

function persistPanel(nextPanel, persist) {
  state.panel = nextPanel;
  syncParentPanel(nextPanel, persist);

  if (persist) {
    saveState({ panel: nextPanel });
  }
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

function applyMinimized(minimized) {
  panel.dataset.minimized = String(minimized);
  state.minimized = minimized;

  chrome.runtime.sendMessage({
    type: 'NEKO_PANEL_STATE',
    minimized
  }).catch(() => {});

  window.parent.postMessage({
    type: 'NEKO_FLOATING_PANEL',
    minimized,
    persist: true
  }, '*');

  saveState({ enabled: true, minimized });
}

function setWebuiUrl(url) {
  const normalized = normalizeNekoUrl(url) || DEFAULT_STATE.webuiUrl;
  state.webuiUrl = normalized;
  webui.src = normalized;
}

function setRoutesOpen(open) {
  routes.hidden = !open;
  panel.dataset.routesOpen = String(open);
}

function scheduleWebuiReflow() {
  [0, 80, 240, 600, 1200].forEach((delay) => {
    window.setTimeout(() => {
      try {
        webui.contentWindow?.postMessage({
          type: 'NEKO_FLOATING_WEBUI_REFLOW'
        }, getWebuiOrigin());
      } catch {}
    }, delay);
  });
}

function openRoute(path) {
  const routeUrl = new URL(path || '/', state.webuiUrl || DEFAULT_STATE.webuiUrl);
  chrome.runtime.sendMessage({
    type: 'NEKO_OPEN_TAB',
    url: routeUrl.toString()
  }).catch(() => {});
}

async function checkHealth() {
  try {
    const healthUrl = new URL('/api/config/page_config', state.webuiUrl || DEFAULT_STATE.webuiUrl);
    const response = await fetch(healthUrl.toString(), {
      method: 'GET',
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    offline.hidden = true;
    setOnline(true);
  } catch {
    offline.hidden = false;
    setOnline(false);
  }
}

function setOnline(online) {
  if (online === true) {
    statusDot.dataset.state = 'online';
  } else if (online === false) {
    statusDot.dataset.state = 'offline';
  } else {
    delete statusDot.dataset.state;
  }
}

function clampPanel(nextPanel) {
  const maxWidth = 860;
  const maxHeight = 900;
  const width = Math.round(clampNumber(nextPanel.width, MIN_SIZE.width, maxWidth));
  const height = Math.round(clampNumber(nextPanel.height, MIN_SIZE.height, maxHeight));
  const right = Math.max(8, Math.round(nextPanel.right));
  const bottom = Math.max(8, Math.round(nextPanel.bottom));

  return {
    width,
    height,
    right,
    bottom
  };
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(max, Math.max(min, number));
}

function syncParentPanel(nextPanel, persist) {
  window.parent.postMessage({
    type: 'NEKO_FLOATING_PANEL',
    panel: nextPanel,
    persist
  }, '*');
}

function getPointerScreenX(event) {
  return Number.isFinite(event.screenX) ? event.screenX : event.clientX;
}

function getPointerScreenY(event) {
  return Number.isFinite(event.screenY) ? event.screenY : event.clientY;
}

function getWebuiOrigin() {
  try {
    return new URL(state.webuiUrl || DEFAULT_STATE.webuiUrl).origin;
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
