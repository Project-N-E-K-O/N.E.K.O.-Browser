(function () {
  const isEmbeddedSurface = new URLSearchParams(location.search).get('surface') === 'embed';
  const isNativeSidePanel = window.name === 'neko-native-sidepanel';
  const extensionParentOrigin = resolveExtensionParentOrigin();
  if (
    window.top === window
    || (!isEmbeddedSurface && !isNativeSidePanel)
    || !extensionParentOrigin
  ) {
    return;
  }

  const TRANSPARENT_CLASS = 'neko-floating-webui-transparent';
  const STYLE_ID = 'neko-floating-webui-transparent-runtime-style';
  const REFLOW_RETRY_INTERVAL_MS = 250;
  const REFLOW_RETRY_MAX_WAIT_MS = 10000;
  const SIDEPANEL_THEME_MESSAGE = 'NEKO_SIDEBAR_THEME';
  let lastReflowWidth = -1;
  let lastReflowHeight = -1;
  let reflowFrame = 0;
  let forcedReflowPending = false;
  let forcedReflowStartedAt = 0;
  let reflowRetryTimer = 0;

  function resolveExtensionParentOrigin() {
    const extensionUrl = new URL(chrome.runtime.getURL('/'));
    const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;
    const candidates = [window.location.ancestorOrigins?.[0], document.referrer];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parent = new URL(candidate);
        if (`${parent.protocol}//${parent.host}` === extensionOrigin) {
          return extensionOrigin;
        }
      } catch {}
    }
    return '';
  }

  const apply = () => {
    document.documentElement.classList.add(TRANSPARENT_CLASS);
    document.documentElement.classList.remove('lanlan-pet-mode');
    document.documentElement.dataset.nekoFloatingTransparent = 'enabled';
    document.documentElement.style.setProperty('background', 'transparent', 'important');
    document.documentElement.style.setProperty('background-color', 'transparent', 'important');
    document.documentElement.style.setProperty('color-scheme', 'light dark', 'important');

    if (document.body) {
      document.body.classList.add(TRANSPARENT_CLASS);
      document.body.classList.remove('lanlan-pet-mode');
      document.body.dataset.nekoFloatingTransparent = 'enabled';
      document.body.style.setProperty('background', 'transparent', 'important');
      document.body.style.setProperty('background-color', 'transparent', 'important');
    }

    ensureRuntimeStyle();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== extensionParentOrigin) {
      return;
    }

    if (!event.data) {
      return;
    }

    if (event.data.type === 'NEKO_FLOATING_WEBUI_REFLOW') {
      requestReflow(event.data.force === true);
      return;
    }

    if (
      isNativeSidePanel
      && event.data.type === SIDEPANEL_THEME_MESSAGE
      && (event.data.theme === 'dark' || event.data.theme === 'light')
    ) {
      window.postMessage({
        type: 'NEKO_SIDEBAR_THEME_APPLY',
        theme: event.data.theme,
        _sender: 'isolated'
      }, window.location.origin);
    }
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

  function isReflowInteractionActive() {
    const body = document.body;
    if (body && (
      body.classList.contains('react-chat-window-dragging')
      || body.classList.contains('react-chat-window-resizing')
      || body.classList.contains('neko-model-dragging')
      || body.classList.contains('neko-agent-hud-dragging')
      || body.classList.contains('jukebox-dragging')
    )) {
      return true;
    }
    return Boolean(document.querySelector([
      '#subtitle-display.dragging',
      '#subtitle-display.resizing',
      '#chat-container.dragging',
      '#chat-container.is-resizing',
      '.card-companion-dragging',
      '[data-dragging="true"]',
      '[data-neko-cat1-playground-dragging]'
    ].join(',')));
  }

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

      html.${TRANSPARENT_CLASS} {
        color-scheme: light dark !important;
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

      html.${TRANSPARENT_CLASS}::before,
      html.${TRANSPARENT_CLASS}::after,
      html.${TRANSPARENT_CLASS} body::before,
      html.${TRANSPARENT_CLASS} body::after,
      html.${TRANSPARENT_CLASS} #react-chat-window-overlay {
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

  function requestReflow(force = false) {
    if (force) {
      forcedReflowPending = true;
      forcedReflowStartedAt = Date.now();
    }
    if (isReflowInteractionActive()) {
      if (forcedReflowPending) scheduleReflowRetry();
      return;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (!forcedReflowPending
        && width === lastReflowWidth
        && height === lastReflowHeight) {
      return;
    }
    if (reflowFrame) {
      return;
    }
    reflowFrame = window.requestAnimationFrame(() => {
      reflowFrame = 0;
      if (isReflowInteractionActive()) {
        if (forcedReflowPending) scheduleReflowRetry();
        return;
      }
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (!forcedReflowPending
          && width === lastReflowWidth
          && height === lastReflowHeight) {
        return;
      }
      clearForcedReflowState();
      lastReflowWidth = width;
      lastReflowHeight = height;
      window.postMessage({
        type: 'NEKO_FLOATING_WEBUI_MAIN_WORLD_REFLOW'
      }, window.location.origin);
    });
  }

  function scheduleReflowRetry() {
    if (reflowRetryTimer || !forcedReflowPending) {
      return;
    }
    const remainingWait = REFLOW_RETRY_MAX_WAIT_MS - (Date.now() - forcedReflowStartedAt);
    if (remainingWait <= 0) {
      clearForcedReflowState();
      return;
    }
    reflowRetryTimer = window.setTimeout(() => {
      reflowRetryTimer = 0;
      if (!forcedReflowPending) {
        return;
      }
      if ((Date.now() - forcedReflowStartedAt) >= REFLOW_RETRY_MAX_WAIT_MS) {
        clearForcedReflowState();
        return;
      }
      requestReflow();
    }, Math.min(REFLOW_RETRY_INTERVAL_MS, remainingWait));
  }

  function clearForcedReflowState() {
    forcedReflowPending = false;
    forcedReflowStartedAt = 0;
    if (reflowRetryTimer) {
      window.clearTimeout(reflowRetryTimer);
      reflowRetryTimer = 0;
    }
  }

})();
