const DEFAULT_STATE = {
  enabled: false,
  minimized: true,
  wakeStateInitialized: true,
  activeTabId: null,
  activeSidePanelWindowId: null,
  displayMode: 'floating',
  panel: {
    width: 420,
    height: 680,
    right: 24,
    bottom: 24
  },
  webuiUrl: 'http://localhost:48911/'
};

const mediaRoutes = new Map();
const pendingOffscreenSignals = new Map();
let offscreenEnsurePromise = null;
const OFFSCREEN_PING_TIMEOUT_MS = 1000;
const OFFSCREEN_MESSAGE_TIMEOUT_MS = 3000;
const OFFSCREEN_READY_ATTEMPTS = 8;
const PANEL_HANDOFF_UNLOAD_DELAY_MS = 1200;
const PANEL_SWEEP_ALARM = 'neko-floating-ws-singleton-sweep';
const PANEL_SWEEP_INTERVAL_MINUTES = 0.5;
let panelSyncSeq = 0;
let sidePanelTransition = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(null);
  const hasWakeState = Object.prototype.hasOwnProperty.call(current, 'wakeStateInitialized');
  const minimized = hasWakeState && typeof current.minimized === 'boolean'
    ? current.minimized
    : DEFAULT_STATE.minimized;

  await chrome.storage.local.set({
    ...DEFAULT_STATE,
    ...current,
    enabled: false,
    minimized,
    wakeStateInitialized: true,
    activeTabId: null,
    activeSidePanelWindowId: null,
    displayMode: normalizeDisplayMode(current.displayMode),
    panel: {
      ...DEFAULT_STATE.panel,
      ...(current.panel || {})
    }
  });
  schedulePanelSweep();
});

chrome.runtime.onStartup.addListener(() => {
  schedulePanelSweep();
  queueSidePanelTransition(resetStartupSidePanelState).catch(() => {});
});

chrome.sidePanel.onOpened.addListener((info) => {
  if (!isNekoSidePanelPath(info.path)) {
    return;
  }
  queueSidePanelTransition(() => claimSidePanel(info.windowId)).catch(() => {});
});

chrome.sidePanel.onClosed.addListener((info) => {
  if (!isNekoSidePanelPath(info.path)) {
    return;
  }
  queueSidePanelTransition(() => releaseSidePanel(info.windowId, true)).catch(() => {});
});

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PANEL_SWEEP_ALARM) {
      sweepPanelSingleton().catch(() => {});
    }
  });
}

schedulePanelSweep();
setTimeout(() => {
  sweepPanelSingleton().catch(() => {});
}, 3000);
setTimeout(() => {
  syncLastFocusedPanel().catch(() => {});
}, 500);

async function handleActionClick(tab) {
  if (!tab || !tab.id || !isInjectableTab(tab.url)) {
    return;
  }
  panelSyncSeq += 1;

  const state = await getStoredState();
  if (state.displayMode === 'sidebar') {
    return;
  }
  const activeTabId = await getLiveActiveTabId(state);

  if (activeTabId && activeTabId !== tab.id) {
    await minimizeTabPanel(activeTabId);
  }

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    return;
  }

  if (activeTabId === tab.id) {
    const response = await sendTabMessage(tab.id, { type: 'NEKO_TOGGLE_SINGLETON' });
    await chrome.storage.local.set({
      activeTabId: response?.awake ? tab.id : null,
      enabled: Boolean(response?.visible || response?.awake),
      minimized: Boolean(response?.minimized)
    });
    return;
  }

  await activatePanelInTab(tab.id);
  const response = await sendTabMessage(tab.id, { type: 'NEKO_OPEN_SINGLETON' });
  await chrome.storage.local.set({
    activeTabId: response?.awake ? tab.id : null,
    enabled: Boolean(response?.visible || response?.awake),
    minimized: Boolean(response?.minimized)
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const syncSeq = ++panelSyncSeq;
  syncPanelToTab(tabId, syncSeq).catch(() => {});
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  const syncSeq = ++panelSyncSeq;
  syncFocusedWindowPanel(windowId, syncSeq).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getStoredState();
  if (state.activeTabId === tabId) {
    await chrome.storage.local.set({ activeTabId: null });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') {
    return;
  }

  const state = await getStoredState();
  if (state.activeTabId !== tabId) {
    return;
  }

  const tab = await getTab(tabId);
  if (!tab || !isInjectableTab(tab.url)) {
    await chrome.storage.local.set({ activeTabId: null, minimized: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  if (message.type === 'NEKO_GET_STATE') {
    getStoredState().then(sendResponse);
    return true;
  }

  if (message.type === 'NEKO_SET_STATE') {
    const payload = { ...(message.payload || {}) };
    if (typeof payload.minimized === 'boolean') {
      payload.wakeStateInitialized = true;
      if (typeof payload.enabled !== 'boolean') {
        payload.enabled = true;
      }
    }

    chrome.storage.local.set(payload).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'NEKO_OPEN_TAB') {
    const url = normalizeNekoUrl(message.url);
    if (url) {
      chrome.tabs.create({ url });
    }
    sendResponse({ ok: Boolean(url) });
    return false;
  }

  if (message.type === 'NEKO_TOGGLE_FROM_POPUP') {
    (async () => {
      const state = await getStoredState();
      if (state.displayMode === 'sidebar') {
        sendResponse({ ok: false, error: 'Use the native side panel toggle in popup.' });
        return;
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      if (tab && isInjectableTab(tab.url)) {
        await handleActionClick(tab);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'NEKO_SET_DISPLAY_MODE') {
    const mode = normalizeDisplayMode(message.mode);
    queueSidePanelTransition(() => setDisplayMode(mode))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === 'NEKO_SIDEBAR_CLAIM') {
    queueSidePanelTransition(() => claimSidePanel(message.windowId))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === 'NEKO_SIDEBAR_RELEASE') {
    queueSidePanelTransition(() => releaseSidePanel(message.windowId, false))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === 'NEKO_HEALTH_CHECK') {
    performHealthCheck().then(sendResponse);
    return true;
  }

  if (message.type === 'NEKO_AUTO_ATTACH' && sender.tab?.id) {
    autoAttachPanel(sender.tab.id).then(sendResponse);
    return true;
  }

  if (message.type === 'NEKO_WAKE_PANEL' && sender.tab?.id) {
    panelSyncSeq += 1;
    wakePanelInTab(sender.tab.id).then(sendResponse);
    return true;
  }

  if (message.type === 'NEKO_PANEL_STATE' && sender.tab?.id) {
    panelSyncSeq += 1;
    const payload = {};

    if (message.closed) {
      Object.assign(payload, { activeTabId: null, enabled: false });
    }

    if (typeof message.minimized === 'boolean') {
      payload.minimized = message.minimized;
      payload.wakeStateInitialized = true;
      payload.activeTabId = sender.tab.id;
      payload.enabled = true;
    }

    if (Object.keys(payload).length > 0) {
      chrome.storage.local.set(payload).catch(() => {});
    }

    if (payload.activeTabId) {
      enforceSingleActivePanel(payload.activeTabId).catch(() => {});
    }

    chrome.tabs.sendMessage(sender.tab.id, message).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'NEKO_MEDIA_REQUEST') {
    handleMediaRequest(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (message.type === 'NEKO_MEDIA_SIGNAL') {
    if (sender.tab) {
      forwardToOffscreen(message).catch(() => {});
    } else {
      routeSignalToContent(message);
    }
    return false;
  }

  if (message.type === 'NEKO_PCM_START') {
    handlePcmStart(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        const error = normalizeRuntimeError(e);
        routeSignalToContent({
          type: 'NEKO_PCM_SIGNAL',
          requestId: message.requestId,
          error
        });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'NEKO_FLOATING_PCM_START') {
    handlePcmStart({
      type: 'NEKO_PCM_START',
      requestId: message.requestId,
      constraints: message.constraints,
      sampleRate: message.sampleRate,
      fromFloating: true
    }, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        const error = normalizeRuntimeError(e);
        routeSignalToContent({
          type: 'NEKO_PCM_SIGNAL',
          requestId: message.requestId,
          error
        });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'NEKO_PCM_STOP') {
    handlePcmStop(message).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'NEKO_FLOATING_PCM_STOP') {
    handlePcmStop({
      type: 'NEKO_PCM_STOP',
      requestId: message.requestId
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'NEKO_PCM_SIGNAL' || message.type === 'NEKO_PCM_CHUNK') {
    routeSignalToContent(message);
    return false;
  }

  return false;
});

function queueSidePanelTransition(task) {
  const next = sidePanelTransition.then(task, task);
  sidePanelTransition = next.catch(() => {});
  return next;
}

async function resetStartupSidePanelState() {
  const state = await getStoredState();
  const payload = {
    activeSidePanelWindowId: null,
    activeTabId: null
  };
  if (state.displayMode === 'sidebar') {
    payload.enabled = false;
    payload.minimized = true;
    payload.wakeStateInitialized = true;
  }
  await chrome.storage.local.set(payload);
}

async function setDisplayMode(mode) {
  const previous = await getStoredState();
  panelSyncSeq += 1;

  if (mode === 'sidebar') {
    await deactivateAllTabPanels();
    const activeSidePanelWindowId = previous.displayMode === 'sidebar'
      ? normalizeWindowId(previous.activeSidePanelWindowId)
      : null;
    await chrome.storage.local.set({
      displayMode: 'sidebar',
      activeTabId: null,
      activeSidePanelWindowId,
      enabled: activeSidePanelWindowId !== null,
      minimized: activeSidePanelWindowId === null,
      wakeStateInitialized: true
    });
    return { ok: true, mode: 'sidebar' };
  }

  const previousSidePanelWindowId = normalizeWindowId(previous.activeSidePanelWindowId);
  const shouldTransferAwakePanel = previous.displayMode === 'sidebar'
    && previous.enabled === true
    && previousSidePanelWindowId !== null;

  if (previousSidePanelWindowId !== null) {
    await deactivateSidePanelWindow(previousSidePanelWindowId);
  }

  await chrome.storage.local.set({
    displayMode: mode,
    activeSidePanelWindowId: null,
    activeTabId: null
  });

  if (previousSidePanelWindowId !== null) {
    await chrome.sidePanel.close({ windowId: previousSidePanelWindowId });
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (!tab?.id || !isInjectableTab(tab.url)) {
    return { ok: true, mode, transferred: false };
  }

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    return { ok: true, mode, transferred: false };
  }

  await sendTabMessage(tab.id, { type: 'NEKO_APPLY_DISPLAY_MODE', mode });
  if (!shouldTransferAwakePanel) {
    return { ok: true, mode, transferred: false };
  }

  await activatePanelInTab(tab.id);
  const response = await sendTabMessage(tab.id, { type: 'NEKO_OPEN_SINGLETON' });
  await chrome.storage.local.set({
    activeTabId: response?.awake ? tab.id : null,
    enabled: Boolean(response?.visible || response?.awake),
    minimized: Boolean(response?.minimized)
  });
  return { ok: true, mode, transferred: Boolean(response?.awake) };
}

async function claimSidePanel(windowId) {
  const nextWindowId = normalizeWindowId(windowId);
  if (nextWindowId === null) {
    throw new Error('Invalid side panel window id.');
  }

  panelSyncSeq += 1;
  const state = await getStoredState();
  const previousWindowId = normalizeWindowId(state.activeSidePanelWindowId);

  if (previousWindowId !== null && previousWindowId !== nextWindowId) {
    await deactivateSidePanelWindow(previousWindowId);
    await chrome.sidePanel.close({ windowId: previousWindowId });
  }

  await deactivateAllTabPanels();
  await chrome.storage.local.set({
    displayMode: 'sidebar',
    activeSidePanelWindowId: nextWindowId,
    activeTabId: null,
    enabled: true,
    minimized: false,
    wakeStateInitialized: true
  });

  return {
    ok: true,
    owner: true,
    windowId: nextWindowId,
    state: await getStoredState()
  };
}

async function releaseSidePanel(windowId, alreadyClosed) {
  const closingWindowId = normalizeWindowId(windowId);
  if (closingWindowId === null) {
    return { ok: false, released: false };
  }

  const state = await getStoredState();
  if (normalizeWindowId(state.activeSidePanelWindowId) !== closingWindowId) {
    return { ok: true, released: false };
  }

  if (!alreadyClosed) {
    await deactivateSidePanelWindow(closingWindowId);
  }

  await chrome.storage.local.set({
    activeSidePanelWindowId: null,
    activeTabId: null,
    enabled: false,
    minimized: true,
    wakeStateInitialized: true
  });
  return { ok: true, released: true };
}

async function deactivateSidePanelWindow(windowId) {
  try {
    const response = await withTimeout(
      chrome.runtime.sendMessage({
        type: 'NEKO_SIDEBAR_DEACTIVATE',
        windowId
      }),
      1500,
      'side panel deactivation'
    );
    if (response?.unloaded === true) {
      await delay(PANEL_HANDOFF_UNLOAD_DELAY_MS);
    }
    return response;
  } catch {
    return null;
  }
}

async function deactivateAllTabPanels() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  let unloadedAny = false;
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) {
      return;
    }
    const response = await sendTabMessage(tab.id, { type: 'NEKO_FORCE_CLOSE' });
    unloadedAny = unloadedAny || response?.unloaded === true;
  }));
  if (unloadedAny) {
    await delay(PANEL_HANDOFF_UNLOAD_DELAY_MS);
  }
  return unloadedAny;
}

async function ensureContentScript(tabId) {
  const ping = await sendTabMessage(tabId, { type: 'NEKO_PING' });
  if (ping?.ok) {
    return true;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch {
    return false;
  }

  const secondPing = await sendTabMessage(tabId, { type: 'NEKO_PING' });
  return Boolean(secondPing?.ok);
}

async function closeTabPanel(tabId) {
  await sendTabMessage(tabId, { type: 'NEKO_FORCE_CLOSE' });
  await chrome.storage.local.set({ activeTabId: null, enabled: false });
}

async function minimizeTabPanel(tabId) {
  await sendTabMessage(tabId, { type: 'NEKO_FORCE_MINIMIZE' });
  await chrome.storage.local.set({ activeTabId: null });
}

async function autoAttachPanel(tabId) {
  const state = await getStoredState();
  const tab = await getTab(tabId);

  if (state.displayMode === 'sidebar') {
    await sendTabMessage(tabId, { type: 'NEKO_FORCE_CLOSE' });
    return {
      ok: true,
      minimized: true,
      awake: false
    };
  }

  if (state.minimized === false && tab?.active && isInjectableTab(tab.url)) {
    await activatePanelInTab(tabId);
    return {
      ok: true,
      minimized: false,
      awake: true
    };
  }

  return {
    ok: true,
    minimized: true,
    awake: false
  };
}

async function wakePanelInTab(tabId) {
  const state = await getStoredState();
  if (state.displayMode === 'sidebar') {
    await sendTabMessage(tabId, { type: 'NEKO_FORCE_CLOSE' });
    return {
      ok: false,
      minimized: true,
      awake: false
    };
  }
  await activatePanelInTab(tabId);

  return {
    ok: true,
    minimized: false,
    awake: true
  };
}

async function syncPanelToTab(tabId, syncSeq) {
  const state = await getStoredState();
  if (state.displayMode === 'sidebar') {
    await deactivateAllTabPanels();
    await chrome.storage.local.set({ activeTabId: null });
    return { ok: true, minimized: true, awake: false };
  }
  const tab = await getTab(tabId);
  if (!tab || !isInjectableTab(tab.url)) {
    await enforceSingleActivePanel(null);
    await chrome.storage.local.set({ activeTabId: null });
    return { ok: false, awake: false };
  }

  if (syncSeq !== panelSyncSeq) {
    return { ok: false, awake: false };
  }

  const ready = await ensureContentScript(tabId);
  if (!ready) {
    await enforceSingleActivePanel(null);
    await chrome.storage.local.set({ activeTabId: null });
    return { ok: false, awake: false };
  }

  if (syncSeq !== panelSyncSeq) {
    return { ok: false, awake: false };
  }

  if (!state.enabled) {
    await chrome.storage.local.set({
      activeTabId: null,
      minimized: true,
      wakeStateInitialized: true
    });
    const response = await sendTabMessage(tabId, { type: 'NEKO_SYNC_SINGLETON' });
    return response || { ok: true, visible: true, minimized: true, awake: false };
  }

  const minimized = Boolean(state.minimized);
  await chrome.storage.local.set({
    activeTabId: tabId,
    enabled: true,
    minimized,
    wakeStateInitialized: true
  });
  await enforceSingleActivePanel(tabId);

  if (syncSeq !== panelSyncSeq) {
    return { ok: false, awake: false };
  }

  const response = await sendTabMessage(tabId, { type: 'NEKO_SYNC_SINGLETON' });
  return response || { ok: true, visible: true, minimized, awake: !minimized };
}

async function activatePanelInTab(tabId) {
  const state = await getStoredState();
  if (state.displayMode === 'sidebar') {
    return false;
  }
  const activeTabId = await getLiveActiveTabId(state);

  if (activeTabId && activeTabId !== tabId) {
    await minimizeTabPanel(activeTabId);
  }

  await chrome.storage.local.set({
    activeTabId: tabId,
    enabled: true,
    minimized: false,
    wakeStateInitialized: true
  });

  await enforceSingleActivePanel(tabId);
  return true;
}

async function syncFocusedWindowPanel(windowId, syncSeq) {
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab?.id) {
    await syncPanelToTab(tab.id, syncSeq);
  }
}

async function syncLastFocusedPanel() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (tab?.id) {
    const syncSeq = ++panelSyncSeq;
    await syncPanelToTab(tab.id, syncSeq);
  }
}

async function enforceSingleActivePanel(activeTabId) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  let unloadedAny = false;
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || tab.id === activeTabId) {
      return;
    }
    const response = await sendTabMessage(tab.id, { type: 'NEKO_FORCE_MINIMIZE' });
    unloadedAny = unloadedAny || response?.unloaded === true;
  }));
  if (unloadedAny) {
    await delay(PANEL_HANDOFF_UNLOAD_DELAY_MS);
  }
  return unloadedAny;
}

function schedulePanelSweep() {
  if (!chrome.alarms) {
    return;
  }
  chrome.alarms.create(PANEL_SWEEP_ALARM, {
    delayInMinutes: PANEL_SWEEP_INTERVAL_MINUTES,
    periodInMinutes: PANEL_SWEEP_INTERVAL_MINUTES
  });
}

async function sweepPanelSingleton() {
  const state = await getStoredState();
  if (state.displayMode === 'sidebar' || !state.enabled || state.minimized !== false) {
    return;
  }

  let activeTabId = await getLiveActiveTabId(state);
  if (!activeTabId) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    if (tab?.id && isInjectableTab(tab.url)) {
      activeTabId = tab.id;
      await chrome.storage.local.set({ activeTabId: tab.id });
    } else {
      await enforceSingleActivePanel(null);
      return;
    }
  }

  const unloadedAny = await enforceSingleActivePanel(activeTabId);
  if (unloadedAny) {
    console.log('[N.E.K.O Floating] WS singleton sweep unloaded stale panels. activeTabId:', activeTabId);
  }
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function getStoredState() {
  const stored = await chrome.storage.local.get(DEFAULT_STATE);
  return {
    ...DEFAULT_STATE,
    ...stored,
    displayMode: normalizeDisplayMode(stored.displayMode),
    activeSidePanelWindowId: normalizeWindowId(stored.activeSidePanelWindowId),
    panel: {
      ...DEFAULT_STATE.panel,
      ...(stored.panel || {})
    }
  };
}

async function getLiveActiveTabId(state) {
  const activeTabId = Number.isInteger(state.activeTabId) ? state.activeTabId : null;
  if (!activeTabId) {
    return null;
  }

  try {
    await chrome.tabs.get(activeTabId);
    return activeTabId;
  } catch {
    await chrome.storage.local.set({ activeTabId: null });
    return null;
  }
}

function isInjectableTab(url) {
  if (!url) {
    return false;
  }

  return /^https?:\/\//i.test(url) && !/^https?:\/\/(?:localhost|127\.0\.0\.1):48911(?:\/|$)/i.test(url);
}

function normalizeDisplayMode(mode) {
  if (mode === 'fullscreen' || mode === 'sidebar') {
    return mode;
  }
  return 'floating';
}

function normalizeWindowId(windowId) {
  if (windowId === null || windowId === undefined || windowId === '') {
    return null;
  }
  const normalized = Number(windowId);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

function isNekoSidePanelPath(path) {
  return typeof path === 'string' && /(?:^|\/)sidepanel\.html(?:[?#].*)?$/.test(path);
}

function normalizeNekoUrl(url) {
  try {
    const parsed = new URL(url || DEFAULT_STATE.webuiUrl);
    const allowedHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (allowedHost && parsed.protocol === 'http:' && parsed.port === '48911') {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}

async function performHealthCheck() {
  const state = await getStoredState();
  const webuiUrl = state.webuiUrl || DEFAULT_STATE.webuiUrl;
  try {
    const healthUrl = new URL('/api/config/page_config', webuiUrl);
    const response = await fetch(healthUrl.toString(), {
      method: 'GET',
      cache: 'no-store'
    });
    return { online: response.ok };
  } catch {
    return { online: false };
  }
}

async function handleMediaRequest(message, sender) {
  if (!sender.tab?.id) {
    return;
  }
  mediaRoutes.set(message.requestId, { tabId: sender.tab.id, frameId: sender.frameId });
  await ensureOffscreen();
  await sendOffscreenMessage({
    type: 'NEKO_MEDIA_REQUEST',
    requestId: message.requestId,
    constraints: message.constraints,
    sdp: message.sdp
  });
  await flushPendingOffscreenSignals(message.requestId);
}

async function handlePcmStart(message, sender) {
  if (message.fromFloating) {
    mediaRoutes.set(message.requestId, { extensionPage: true, tabId: sender.tab?.id, frameId: sender.frameId });
    console.log('[NEKO-MIC background] PCM start:', message.requestId?.substring?.(0, 8), 'floating tab:', sender.tab?.id, 'frame:', sender.frameId);
  } else if (sender.tab?.id) {
    mediaRoutes.set(message.requestId, { tabId: sender.tab.id, frameId: sender.frameId });
    console.log('[NEKO-MIC background] PCM start:', message.requestId?.substring?.(0, 8), 'tab:', sender.tab.id, 'frame:', sender.frameId);
  } else {
    mediaRoutes.set(message.requestId, { extensionPage: true });
    console.log('[NEKO-MIC background] PCM start:', message.requestId?.substring?.(0, 8), 'extension-page');
  }
  await ensureOffscreen();
  const response = await sendOffscreenMessage({
    type: 'NEKO_PCM_START',
    requestId: message.requestId,
    constraints: message.constraints,
    sampleRate: message.sampleRate
  });
  if (response && response.ok === false) {
    throw new Error(response.error || 'Offscreen rejected PCM start');
  }
}

async function handlePcmStop(message) {
  if (!message.requestId) {
    return;
  }
  await ensureOffscreen();
  await sendOffscreenMessage({
    type: 'NEKO_PCM_STOP',
    requestId: message.requestId
  }).catch(() => {});
  mediaRoutes.delete(message.requestId);
}

async function forwardToOffscreen(message) {
  if (!message.requestId || !message.ice) {
    return;
  }
  const signal = {
    type: 'NEKO_MEDIA_SIGNAL',
    requestId: message.requestId,
    ice: message.ice
  };

  try {
    await ensureOffscreen();
    await sendOffscreenMessage(signal);
  } catch {
    queuePendingOffscreenSignal(signal);
  }
}

function routeSignalToContent(message) {
  const route = mediaRoutes.get(message.requestId);
  if (!route) {
    return;
  }
  if (route.extensionPage) {
    const payload = {
      type: 'NEKO_PCM_TO_FLOATING',
      payloadType: message.type,
      requestId: message.requestId,
      error: message.error,
      ready: message.ready,
      pcm16: message.pcm16,
      sampleRate: message.sampleRate,
      level: message.level
    };
    if (route.tabId !== undefined) {
      chrome.tabs.sendMessage(route.tabId, payload, { frameId: route.frameId }).catch(() => {});
    } else {
      chrome.runtime.sendMessage(payload).catch(() => {});
    }
    return;
  }
  chrome.tabs.sendMessage(route.tabId, {
    type: message.type,
    requestId: message.requestId,
    sdp: message.sdp,
    ice: message.ice,
    error: message.error,
    ready: message.ready,
    pcm16: message.pcm16,
    sampleRate: message.sampleRate,
    level: message.level
  }, { frameId: route.frameId }).catch(() => {});
}

function queuePendingOffscreenSignal(signal) {
  const existing = pendingOffscreenSignals.get(signal.requestId) || [];
  existing.push(signal);
  pendingOffscreenSignals.set(signal.requestId, existing);
}

async function flushPendingOffscreenSignals(requestId) {
  const signals = pendingOffscreenSignals.get(requestId) || [];
  pendingOffscreenSignals.delete(requestId);

  for (const signal of signals) {
    try {
      await sendOffscreenMessage(signal);
    } catch {
      queuePendingOffscreenSignal(signal);
    }
  }
}

async function ensureOffscreen() {
  if (!offscreenEnsurePromise) {
    offscreenEnsurePromise = ensureOffscreenReady().finally(() => {
      offscreenEnsurePromise = null;
    });
  }
  return offscreenEnsurePromise;
}

async function ensureOffscreenReady() {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    const has = await chrome.offscreen.hasDocument().catch(() => false);
    if (has && await waitForOffscreenReady()) {
      return;
    }
  }

  if (typeof chrome.offscreen.closeDocument === 'function') {
    await chrome.offscreen.closeDocument().catch(() => {});
  }

  await createOffscreenDocument();
  if (await waitForOffscreenReady()) {
    return;
  }

  if (typeof chrome.offscreen.closeDocument === 'function') {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  await createOffscreenDocument();
  if (await waitForOffscreenReady()) {
    return;
  }

  throw new Error('Offscreen document is not responding');
}

async function createOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'WEB_RTC'],
      justification: 'Hold microphone MediaStream once and relay to N.E.K.O WebUI via WebRTC.'
    });
  } catch (e) {
    if (!/single offscreen/i.test(String(e?.message || e))) {
      throw e;
    }
  }
}

async function waitForOffscreenReady() {
  for (let attempt = 0; attempt < OFFSCREEN_READY_ATTEMPTS; attempt += 1) {
    if (await pingOffscreen()) {
      return true;
    }
    await delay(100);
  }
  return false;
}

async function pingOffscreen() {
  try {
    const response = await withTimeout(
      chrome.runtime.sendMessage({ type: 'NEKO_OFFSCREEN_PING' }),
      OFFSCREEN_PING_TIMEOUT_MS,
      'offscreen ping'
    );
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function sendOffscreenMessage(message) {
  const response = await withTimeout(
    chrome.runtime.sendMessage(message),
    OFFSCREEN_MESSAGE_TIMEOUT_MS,
    'offscreen message ' + message.type
  );
  if (!response || response.ok === false) {
    throw new Error(response?.error || 'Offscreen did not acknowledge ' + message.type);
  }
  return response;
}

function normalizeRuntimeError(err) {
  if (err && typeof err === 'object') {
    return {
      name: err.name || 'UnknownError',
      message: err.message || String(err)
    };
  }
  return {
    name: 'UnknownError',
    message: String(err || 'Unknown runtime error')
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(label + ' timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
