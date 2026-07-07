(function () {
  if (window.top === window) {
    return;
  }

  const TRANSPARENT_CLASS = 'neko-floating-webui-transparent';
  const STYLE_ID = 'neko-floating-webui-transparent-runtime-style';
  const MAIN_WORLD_SCRIPT_ID = 'neko-floating-webui-transparent-main-world';

  const apply = () => {
    document.documentElement.classList.add(TRANSPARENT_CLASS);
    document.documentElement.classList.remove('lanlan-pet-mode');
    document.documentElement.dataset.nekoFloatingTransparent = 'enabled';
    document.documentElement.style.setProperty('background', 'transparent', 'important');
    document.documentElement.style.setProperty('background-color', 'transparent', 'important');

    if (document.body) {
      document.body.classList.add(TRANSPARENT_CLASS);
      document.body.classList.remove('lanlan-pet-mode');
      document.body.dataset.nekoFloatingTransparent = 'enabled';
      document.body.style.setProperty('background', 'transparent', 'important');
      document.body.style.setProperty('background-color', 'transparent', 'important');
    }

    ensureRuntimeStyle();
    injectMainWorldScript();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }

  window.addEventListener('message', (event) => {
    if (!event.origin.startsWith('chrome-extension://') && !event.origin.startsWith('extension://')) {
      return;
    }

    if (!event.data || event.data.type !== 'NEKO_FLOATING_WEBUI_REFLOW') {
      return;
    }

    requestReflow();
  });

  apply();
  requestReflow();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    childList: true
  });

  let ticks = 0;
  const intervalId = window.setInterval(() => {
    apply();
    requestReflow();
    ticks += 1;
    if (ticks > 80) {
      window.clearInterval(intervalId);
    }
  }, 250);

  function ensureRuntimeStyle() {
    let style = document.getElementById(STYLE_ID);
    if (style) {
      const target = document.head || document.documentElement;
      if (style.parentElement !== target || target.lastElementChild !== style) {
        target.appendChild(style);
      }
      return;
    }

    style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.${TRANSPARENT_CLASS},
      html.${TRANSPARENT_CLASS} body,
      body.${TRANSPARENT_CLASS},
      html.${TRANSPARENT_CLASS}:not(.lanlan-pet-mode),
      body.${TRANSPARENT_CLASS}:not(.lanlan-pet-mode):not(.electron-chat-window) {
        background: transparent !important;
        background-color: transparent !important;
      }

      @media only screen and (max-width: 768px) {
        html.${TRANSPARENT_CLASS},
        html.${TRANSPARENT_CLASS}:not(.lanlan-pet-mode),
        html.${TRANSPARENT_CLASS}[data-theme="dark"]:not(.lanlan-pet-mode),
        html.${TRANSPARENT_CLASS} body,
        html.${TRANSPARENT_CLASS} body:not(.lanlan-pet-mode):not(.electron-chat-window),
        html.${TRANSPARENT_CLASS}[data-theme="dark"] body:not(.electron-chat-window),
        body.${TRANSPARENT_CLASS},
        body.${TRANSPARENT_CLASS}:not(.lanlan-pet-mode):not(.electron-chat-window) {
          background: transparent !important;
          background-color: transparent !important;
        }
      }

      html.${TRANSPARENT_CLASS} body::before,
      html.${TRANSPARENT_CLASS} body::after {
        background: transparent !important;
        background-color: transparent !important;
      }

      html.${TRANSPARENT_CLASS} #live2d-container,
      html.${TRANSPARENT_CLASS} #mmd-container,
      html.${TRANSPARENT_CLASS} #vrm-container,
      html.${TRANSPARENT_CLASS} #pngtuber-container,
      html.${TRANSPARENT_CLASS} #live2d-canvas,
      html.${TRANSPARENT_CLASS} #mmd-canvas,
      html.${TRANSPARENT_CLASS} #vrm-canvas,
      html.${TRANSPARENT_CLASS} canvas {
        background: transparent !important;
        background-color: transparent !important;
      }

      html.${TRANSPARENT_CLASS} #chat-container,
      html.${TRANSPARENT_CLASS} #chat-container::before,
      html.${TRANSPARENT_CLASS}[data-theme="dark"] #chat-container,
      html.${TRANSPARENT_CLASS}[data-theme="dark"] #chat-container::before {
        background: transparent !important;
        background-color: transparent !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }

      html.${TRANSPARENT_CLASS} #status-toast {
        background-image: none !important;
        background-color: rgba(15, 23, 42, 0.78) !important;
      }
    `;

    const target = document.head || document.documentElement;
    target.appendChild(style);
  }

  function injectMainWorldScript() {
    if (document.getElementById(MAIN_WORLD_SCRIPT_ID)) {
      return;
    }

    const script = document.createElement('script');
    script.id = MAIN_WORLD_SCRIPT_ID;
    script.src = chrome.runtime.getURL('transparent-main-world.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function requestReflow() {
    window.dispatchEvent(new Event('resize'));

    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      window.postMessage({
        type: 'NEKO_FLOATING_WEBUI_MAIN_WORLD_REFLOW'
      }, window.location.origin);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    if (event.origin !== window.location.origin) {
      return;
    }
    const data = event.data;
    if (!data || typeof data.type !== 'string') {
      return;
    }
    if (data._sender !== 'main') {
      return;
    }
    if (data.type === 'NEKO_MEDIA_REQUEST' || data.type === 'NEKO_MEDIA_SIGNAL' || data.type === 'NEKO_PCM_START' || data.type === 'NEKO_PCM_STOP') {
      if (data.type === 'NEKO_PCM_START') {
        window.postMessage({
          type: 'NEKO_PCM_BRIDGE_ACK',
          requestId: data.requestId,
          _sender: 'isolated'
        }, window.location.origin);
      }
      const payload = {
        type: data.type,
        requestId: data.requestId,
        constraints: data.constraints,
        sdp: data.sdp,
        ice: data.ice,
        sampleRate: data.sampleRate
      };
      chrome.runtime.sendMessage(payload)
        .then((response) => {
          if (response && response.ok === false) {
            postBridgeError(data, response.error || 'Runtime bridge rejected request');
          }
        })
        .catch((err) => {
          postBridgeError(data, err);
        });
    }
  });

  function postBridgeError(source, err) {
    if (!source || !source.requestId || source.type === 'NEKO_PCM_STOP') {
      return;
    }
    const isPcm = source.type.startsWith('NEKO_PCM_');
    window.postMessage({
      type: isPcm ? 'NEKO_PCM_SIGNAL' : 'NEKO_MEDIA_SIGNAL',
      requestId: source.requestId,
      error: normalizeBridgeError(err),
      _sender: 'isolated'
    }, window.location.origin);
  }

  function normalizeBridgeError(err) {
    if (err && typeof err === 'object') {
      return {
        name: err.name || 'UnknownError',
        message: err.message || String(err)
      };
    }
    return {
      name: 'UnknownError',
      message: String(err || 'Unknown bridge error')
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return false;
    }
    if (message.type === 'NEKO_MEDIA_SIGNAL') {
      window.postMessage({
        type: 'NEKO_MEDIA_SIGNAL',
        requestId: message.requestId,
        sdp: message.sdp,
        ice: message.ice,
        error: message.error,
        _sender: 'isolated'
      }, window.location.origin);
    }
    if (message.type === 'NEKO_PCM_SIGNAL' || message.type === 'NEKO_PCM_CHUNK') {
      window.postMessage({
        type: message.type,
        requestId: message.requestId,
        ready: message.ready,
        error: message.error,
        pcm16: message.pcm16,
        sampleRate: message.sampleRate,
        level: message.level,
        _sender: 'isolated'
      }, window.location.origin);
    }
    return false;
  });
})();
