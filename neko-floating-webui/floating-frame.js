(() => {
  const BRIDGE_SENDER = 'neko-floating-frame-bridge';
  const DEFAULT_WEBUI_URL = 'http://localhost:48911/';
  const HEALTH_GATE_TIMEOUT_MS = 4000;
  const frame = document.getElementById('webui');

  let bridgeToken = null;
  let parentOrigin = null;
  let targetUrl = null;
  let targetOrigin = null;
  let loadSequence = 0;

  window.addEventListener('message', (event) => {
    if (event.source === window.parent) {
      handleParentMessage(event);
      return;
    }
    if (event.source === frame.contentWindow) {
      handleWebuiMessage(event);
    }
  });

  frame.addEventListener('load', () => {
    if (!targetUrl || frame.src === 'about:blank') {
      return;
    }
    postToParent('NEKO_FLOATING_FRAME_WEBUI_LOADED', { targetUrl });
  });

  initialize();

  function handleParentMessage(event) {
    const data = event.data;
    if (!data || typeof data.type !== 'string') {
      return;
    }
    if (!bridgeToken || data.bridgeToken !== bridgeToken) {
      return;
    }
    if (parentOrigin && event.origin !== parentOrigin) {
      return;
    }

    if (data.type === 'NEKO_FLOATING_FRAME_LOAD') {
      parentOrigin = event.origin;
      setColorScheme(data.colorScheme);
      loadAllowedTarget(data.targetUrl, data.requireOnline === true);
      return;
    }

    if (!parentOrigin || event.origin !== parentOrigin) {
      return;
    }
    if (data.type === 'NEKO_FLOATING_FRAME_RELOAD') {
      reloadWebui();
      return;
    }
    if (data.type === 'NEKO_FLOATING_FRAME_CLEAR') {
      clearWebui();
      return;
    }
    if (data.type === 'NEKO_FLOATING_FRAME_VERIFY') {
      verifyLoadedTarget(data.targetUrl);
      return;
    }
    if (data.type === 'NEKO_FLOATING_FRAME_COLOR_SCHEME') {
      setColorScheme(data.colorScheme);
      return;
    }
    if (!targetOrigin || !isParentRelayMessage(data)) {
      return;
    }
    try {
      const payload = { ...data };
      delete payload.bridgeToken;
      frame.contentWindow.postMessage(payload, targetOrigin, Array.from(event.ports || []));
    } catch {}
  }

  function handleWebuiMessage(event) {
    if (!targetOrigin || event.origin !== targetOrigin) {
      return;
    }
    const data = event.data;
    if (!isWebuiRelayMessage(data)) {
      return;
    }
    try {
      window.parent.postMessage(data, parentOrigin || '*');
    } catch {}
  }

  async function loadAllowedTarget(value, requireOnline) {
    const sequence = ++loadSequence;
    try {
      const allowed = await resolveAllowedTarget(value);
      if (sequence !== loadSequence) {
        return;
      }
      if (requireOnline) {
        const health = await checkHealthWithTimeout();
        if (sequence !== loadSequence) {
          return;
        }
        if (health?.online !== true) {
          targetUrl = null;
          targetOrigin = null;
          frame.src = 'about:blank';
          postToParent('NEKO_FLOATING_FRAME_OFFLINE', {
            targetUrl: allowed.toString()
          });
          return;
        }
      }
      targetUrl = allowed.toString();
      targetOrigin = allowed.origin;
      frame.src = targetUrl;
    } catch (error) {
      if (sequence !== loadSequence) {
        return;
      }
      targetUrl = null;
      targetOrigin = null;
      frame.removeAttribute('src');
      postToParent('NEKO_FLOATING_FRAME_ERROR', {
        error: String(error?.message || error || 'Invalid WebUI target')
      });
    }
  }

  async function verifyLoadedTarget(value) {
    const sequence = ++loadSequence;
    try {
      const allowed = await resolveAllowedTarget(value);
      if (sequence !== loadSequence) {
        return;
      }
      const allowedTarget = allowed.toString();
      if (targetUrl !== allowedTarget) {
        loadAllowedTarget(allowedTarget, true);
        return;
      }
      const health = await checkHealthWithTimeout();
      if (sequence !== loadSequence) {
        return;
      }
      if (health?.online !== true) {
        targetUrl = null;
        targetOrigin = null;
        frame.src = 'about:blank';
        postToParent('NEKO_FLOATING_FRAME_OFFLINE', {
          targetUrl: allowedTarget
        });
        return;
      }
      postToParent('NEKO_FLOATING_FRAME_VERIFIED', {
        targetUrl: allowedTarget
      });
    } catch (error) {
      if (sequence !== loadSequence) {
        return;
      }
      targetUrl = null;
      targetOrigin = null;
      frame.src = 'about:blank';
      postToParent('NEKO_FLOATING_FRAME_ERROR', {
        error: String(error?.message || error || 'Invalid WebUI target')
      });
    }
  }

  async function initialize() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'NEKO_GET_FRAME_BRIDGE_TOKEN'
      });
      if (!response?.ok || typeof response.token !== 'string' || response.token.length < 32) {
        throw new Error(response?.error || 'Floating frame bridge token is unavailable');
      }
      bridgeToken = response.token;
      postToParent('NEKO_FLOATING_FRAME_READY');
    } catch (error) {
      postToParent('NEKO_FLOATING_FRAME_ERROR', {
        error: String(error?.message || error || 'Floating frame bridge initialization failed')
      });
    }
  }

  async function resolveAllowedTarget(value) {
    const candidate = normalizeWebuiUrl(value);
    if (!candidate) {
      throw new Error('Invalid WebUI target');
    }
    const prepared = await chrome.runtime.sendMessage({
      type: 'NEKO_PREPARE_WEBUI_INJECTION'
    }).catch(() => null);
    if (!prepared?.ok) {
      throw new Error(prepared?.error || 'WebUI adapters are unavailable');
    }
    const configured = normalizeWebuiUrl(prepared.webuiUrl) || new URL(DEFAULT_WEBUI_URL);
    if (candidate.origin !== configured.origin || candidate.pathname !== configured.pathname) {
      throw new Error('WebUI target does not match the configured frontend');
    }
    return candidate;
  }

  function reloadWebui() {
    if (!targetUrl) {
      return;
    }
    const sequence = ++loadSequence;
    frame.src = 'about:blank';
    window.setTimeout(() => {
      if (sequence === loadSequence && targetUrl) {
        frame.src = targetUrl;
      }
    }, 0);
  }

  async function checkHealthWithTimeout() {
    let timeoutId = 0;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage({ type: 'NEKO_HEALTH_CHECK' }).catch(() => null),
        new Promise((resolve) => {
          timeoutId = window.setTimeout(() => resolve(null), HEALTH_GATE_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  function clearWebui() {
    loadSequence += 1;
    targetUrl = null;
    targetOrigin = null;
    frame.src = 'about:blank';
  }

  function setColorScheme(value) {
    const scheme = value === 'dark' ? 'dark' : 'light';
    document.documentElement.style.colorScheme = scheme;
    frame.style.colorScheme = scheme;
  }

  function postToParent(type, payload = {}) {
    try {
      window.parent.postMessage({
        ...payload,
        type,
        _sender: BRIDGE_SENDER
      }, parentOrigin || '*');
    } catch {}
  }

  function isParentRelayMessage(data) {
    if (data.type === 'NEKO_FLOATING_WEBUI_REFLOW') {
      return true;
    }
    if (data.type.startsWith('NEKO_EMBED_')) {
      return true;
    }
    return data.type.startsWith('NEKO_PCM_') && data._sender === 'floating';
  }

  function isWebuiRelayMessage(data) {
    if (!data || typeof data.type !== 'string') {
      return false;
    }
    if (data.type.startsWith('NEKO_EMBED_')) {
      return data._sender === 'neko-embedded-surface';
    }
    return (data.type === 'NEKO_PCM_START' || data.type === 'NEKO_PCM_STOP')
      && data._sender === 'main';
  }

  function normalizeWebuiUrl(value) {
    try {
      const parsed = new URL(value || DEFAULT_WEBUI_URL);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      if (!parsed.hostname || parsed.username || parsed.password) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
})();
