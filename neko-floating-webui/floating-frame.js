(() => {
  const BRIDGE_SENDER = 'neko-floating-frame-bridge';
  const DEFAULT_WEBUI_URL = 'http://localhost:48911/';
  const frame = document.getElementById('webui');

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

  postToParent('NEKO_FLOATING_FRAME_READY');

  function handleParentMessage(event) {
    const data = event.data;
    if (!data || typeof data.type !== 'string') {
      return;
    }
    if (parentOrigin && event.origin !== parentOrigin) {
      return;
    }

    if (data.type === 'NEKO_FLOATING_FRAME_LOAD') {
      parentOrigin = event.origin;
      setColorScheme(data.colorScheme);
      loadAllowedTarget(data.targetUrl);
      return;
    }

    if (!parentOrigin || event.origin !== parentOrigin) {
      return;
    }
    if (data.type === 'NEKO_FLOATING_FRAME_RELOAD') {
      reloadWebui();
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
      frame.contentWindow.postMessage(data, targetOrigin, Array.from(event.ports || []));
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

  async function loadAllowedTarget(value) {
    const sequence = ++loadSequence;
    try {
      const allowed = await resolveAllowedTarget(value);
      if (sequence !== loadSequence) {
        return;
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

  async function resolveAllowedTarget(value) {
    const candidate = normalizeWebuiUrl(value);
    if (!candidate) {
      throw new Error('Invalid WebUI target');
    }
    const state = await chrome.runtime.sendMessage({ type: 'NEKO_GET_STATE' }).catch(() => null);
    const configured = normalizeWebuiUrl(state?.webuiUrl) || new URL(DEFAULT_WEBUI_URL);
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
