(() => {
  const DEFAULT_WEBUI_URL = 'http://localhost:48911/';
  const frame = document.getElementById('webui');
  const statusDot = document.getElementById('status');
  const offlineEl = document.getElementById('offline');
  const offlineMessage = document.getElementById('offline-message');
  const routesEl = document.getElementById('routes');
  const shell = document.querySelector('.shell');
  const preferredColorScheme = window.matchMedia?.('(prefers-color-scheme: dark)') || null;

  let currentWindowId = null;
  let webuiUrl = DEFAULT_WEBUI_URL;
  let isOwner = false;

  preferredColorScheme?.addEventListener('change', scheduleSidePanelTheme);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'NEKO_SIDEBAR_DEACTIVATE') {
      return false;
    }
    if (Number(message.windowId) !== currentWindowId) {
      return false;
    }
    const unloaded = deactivate();
    sendResponse({ ok: true, unloaded, windowId: currentWindowId });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }
    if (!changes.displayMode && !changes.activeSidePanelWindowId && !changes.webuiUrl) {
      return;
    }
    syncFromStorage().catch((error) => showFailure(error));
  });

  frame.addEventListener('load', () => {
    if (!isOwner || !frame.hasAttribute('src')) {
      return;
    }
    setOnline(true);
    scheduleSidePanelTheme();
    scheduleWebuiReflow();
    checkHealth();
  });

  document.addEventListener('click', (event) => {
    const actionButton = event.target.closest('[data-action]');
    const routeButton = event.target.closest('[data-route]');
    if (actionButton) {
      handleAction(actionButton.dataset.action);
      return;
    }
    if (routeButton) {
      openRoute(routeButton.dataset.route);
      setRoutesOpen(false);
      return;
    }
    if (!routesEl.hidden && !event.target.closest('.routes')) {
      setRoutesOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !routesEl.hidden) {
      setRoutesOpen(false);
    }
  });

  initialize().catch((error) => showFailure(error));

  async function initialize() {
    const currentWindow = await chrome.windows.getCurrent();
    currentWindowId = Number(currentWindow.id);
    if (!Number.isInteger(currentWindowId) || currentWindowId < 0) {
      throw new Error('无法识别当前浏览器窗口。');
    }

    const response = await chrome.runtime.sendMessage({
      type: 'NEKO_SIDEBAR_CLAIM',
      windowId: currentWindowId
    });
    if (!response?.ok || !response.owner) {
      throw new Error(response?.error || '无法取得侧栏实例所有权。');
    }

    applyState(response.state || {});
  }

  async function syncFromStorage() {
    if (currentWindowId === null) {
      return;
    }
    const state = await chrome.runtime.sendMessage({ type: 'NEKO_GET_STATE' });
    applyState(state || {});
  }

  function applyState(state) {
    const nextUrl = normalizeNekoUrl(state.webuiUrl) || DEFAULT_WEBUI_URL;
    const nextOwner = state.displayMode === 'sidebar'
      && state.activeSidePanelWindowId !== null
      && state.activeSidePanelWindowId !== undefined
      && Number(state.activeSidePanelWindowId) === currentWindowId;
    const urlChanged = nextUrl !== webuiUrl;
    webuiUrl = nextUrl;

    if (!nextOwner) {
      deactivate();
      return;
    }

    isOwner = true;
    if (urlChanged) {
      unloadFrame();
    }
    ensureFrameLoaded();
    checkHealth();
  }

  function deactivate() {
    isOwner = false;
    setRoutesOpen(false);
    const unloaded = unloadFrame();
    setOnline(null);
    return unloaded;
  }

  function handleAction(action) {
    if (action === 'reload' || action === 'retry') {
      if (!isOwner) {
        return;
      }
      offlineEl.hidden = true;
      setOnline(null);
      unloadFrame();
      ensureFrameLoaded();
      checkHealth();
      return;
    }

    if (action === 'routes') {
      setRoutesOpen(routesEl.hidden);
      return;
    }

    if (action === 'open') {
      openRoute('/');
    }
  }

  function setRoutesOpen(open) {
    routesEl.hidden = !open;
    shell.dataset.routesOpen = String(open);
    const menuButton = document.querySelector('[data-action="routes"][aria-controls="routes"]');
    if (menuButton) {
      menuButton.setAttribute('aria-expanded', String(open));
    }
  }

  function openRoute(path) {
    const routeUrl = new URL(path || '/', webuiUrl);
    chrome.runtime.sendMessage({
      type: 'NEKO_OPEN_TAB',
      url: routeUrl.toString()
    }).catch((error) => showFailure(error));
  }

  function ensureFrameLoaded() {
    if (!isOwner || frame.hasAttribute('src')) {
      return;
    }
    frame.src = webuiUrl;
  }

  function unloadFrame() {
    if (!frame.hasAttribute('src')) {
      return false;
    }
    try {
      frame.src = 'about:blank';
    } catch {}
    frame.removeAttribute('src');
    return true;
  }

  function scheduleSidePanelTheme() {
    if (!isOwner || !frame.contentWindow) {
      return;
    }
    const theme = preferredColorScheme?.matches ? 'dark' : 'light';
    [0, 80, 240, 600, 1200].forEach((delay) => {
      window.setTimeout(() => {
        if (!isOwner || !frame.contentWindow) {
          return;
        }
        try {
          frame.contentWindow.postMessage({
            type: 'NEKO_SIDEBAR_THEME',
            theme
          }, getWebuiOrigin());
        } catch {}
      }, delay);
    });
  }

  function scheduleWebuiReflow() {
    if (!isOwner || !frame.contentWindow) {
      return;
    }
    [0, 80, 240, 600, 1200].forEach((delay) => {
      window.setTimeout(() => {
        if (!isOwner) {
          return;
        }
        try {
          frame.contentWindow.postMessage({
            type: 'NEKO_FLOATING_WEBUI_REFLOW'
          }, getWebuiOrigin());
        } catch {}
      }, delay);
    });
  }

  async function checkHealth() {
    if (!isOwner) {
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
    if (online === true) {
      statusDot.dataset.state = 'online';
      offlineEl.hidden = true;
      return;
    }
    if (online === false) {
      statusDot.dataset.state = 'offline';
      offlineMessage.textContent = `确认前端服务可通过 ${webuiUrl} 访问`;
      offlineEl.hidden = false;
      return;
    }
    delete statusDot.dataset.state;
  }

  function showFailure(error) {
    isOwner = false;
    unloadFrame();
    statusDot.dataset.state = 'offline';
    offlineMessage.textContent = String(error?.message || error || '侧栏初始化失败。');
    offlineEl.hidden = false;
  }

  function getWebuiOrigin() {
    return new URL(webuiUrl).origin;
  }

  function normalizeNekoUrl(url) {
    try {
      const parsed = new URL(url || DEFAULT_WEBUI_URL);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (!parsed.hostname || parsed.username || parsed.password) return null;
      return parsed.toString();
    } catch {}
    return null;
  }
})();
