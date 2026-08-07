(function () {
  const isEmbeddedSurface = new URLSearchParams(location.search).get('surface') === 'embed';
  const isNativeSidePanel = window.name === 'neko-native-sidepanel';
  const FLOATING_BRIDGE_ORIGIN = resolveFloatingBridgeOrigin();
  if (
    window.top === window
    || (!isEmbeddedSurface && !isNativeSidePanel)
    || !FLOATING_BRIDGE_ORIGIN
    || window.__nekoFloatingTransparentMainWorld
  ) {
    return;
  }

  window.__nekoFloatingTransparentMainWorld = true;
  document.documentElement.dataset.nekoFloatingTransparentMainWorld = 'enabled';
  if (isNativeSidePanel) {
    document.documentElement.dataset.nekoNativeSidePanel = 'enabled';
  }

  patchLive2DManager();
  patchAudioContextAutoResume();
  forceTransparentRenderers();

  window.addEventListener('load', forceTransparentRenderers);
  window.addEventListener('resize', forceTransparentRenderers);
  window.addEventListener('live2d-model-loaded', forceTransparentRenderers);
  window.addEventListener('live2d-floating-buttons-ready', forceTransparentRenderers);
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) {
      return;
    }

    if (event.data.type === 'NEKO_FLOATING_WEBUI_MAIN_WORLD_REFLOW') {
      forcePageReflow();
      return;
    }

    if (
      isNativeSidePanel
      && event.data.type === 'NEKO_SIDEBAR_THEME_APPLY'
      && event.data._sender === 'isolated'
    ) {
      applySidePanelTheme(event.data.theme);
    }
  });
  window.addEventListener('message', (event) => {
    if (!event.data || typeof event.data.type !== 'string') {
      return;
    }
    if (!event.data.type.startsWith('NEKO_PCM_')) {
      return;
    }
    if (event.data.type === 'NEKO_PCM_PORT') {
      if (
        FLOATING_BRIDGE_ORIGIN
        && event.source === window.parent
        && event.origin === FLOATING_BRIDGE_ORIGIN
        && event.ports
        && event.ports[0]
      ) {
        attachFloatingPcmPort(event.ports[0]);
      }
      return;
    }
    const fromIsolated = event.source === window && event.data._sender === 'isolated';
    const fromFloating = event.source === window.parent
      && event.origin === FLOATING_BRIDGE_ORIGIN
      && event.data._sender === 'floating';
    if (!fromIsolated && !fromFloating) {
      return;
    }
    handlePcmRelayMessage(event.data);
  });

  let ticks = 0;
  const intervalId = window.setInterval(() => {
    patchLive2DManager();
    resumeTrackedAudioContexts();
    forceTransparentRenderers();
    ticks += 1;
    if (ticks > 160) {
      window.clearInterval(intervalId);
    }
  }, 250);

  function applySidePanelTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') {
      return;
    }
    const isDark = theme === 'dark';
    if (window.nekoTheme && typeof window.nekoTheme.apply === 'function') {
      try {
        window.nekoTheme.apply(isDark, { persist: false });
        return;
      } catch {}
    }

    if (isDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    document.documentElement.classList.toggle('dark', isDark);
  }

  function patchLive2DManager() {
    const Live2DManager = window.Live2DManager;
    if (!Live2DManager || !Live2DManager.prototype || Live2DManager.prototype.__nekoFloatingTransparentPatched) {
      return;
    }

    const originalInitPIXI = Live2DManager.prototype.initPIXI;
    if (typeof originalInitPIXI !== 'function') {
      return;
    }

    Live2DManager.prototype.initPIXI = async function patchedInitPIXI(...args) {
      const result = await originalInitPIXI.apply(this, args);
      makePixiTransparent(this.pixi_app);
      return result;
    };

    Live2DManager.prototype.__nekoFloatingTransparentPatched = true;
  }

  const pcmRelayRequests = new Map();
  const trackedAudioContexts = new Set();
  let floatingPcmPort = null;

  function patchGetUserMedia() {
    if (!navigator.mediaDevices || navigator.mediaDevices.__nekoMicRelayPatched) {
      return false;
    }
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const c = constraints || {};
      if (c.audio && !c.video) {
        return relayAudioViaPcm(c).catch((err) => {
          console.warn('[NEKO-MIC main] PCM relay failed:', formatMediaError(err));
          throw err;
        });
      }
      return original(c);
    };
    navigator.mediaDevices.__nekoMicRelayPatched = true;
    return true;
  }

  if (!isNativeSidePanel && !patchGetUserMedia()) {
    const pollId = window.setInterval(() => {
      if (patchGetUserMedia()) {
        window.clearInterval(pollId);
      }
    }, 50);
    window.setTimeout(() => window.clearInterval(pollId), 10000);
  }

  function patchAudioContextAutoResume() {
    if (window.__nekoAudioContextAutoResumePatched) {
      return;
    }

    const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
    if (typeof OriginalAudioContext !== 'function') {
      return;
    }

    const PatchedAudioContext = new Proxy(OriginalAudioContext, {
      construct(target, args) {
        const context = Reflect.construct(target, args);
        trackAudioContext(context);
        return context;
      }
    });

    if (window.AudioContext) {
      window.AudioContext = PatchedAudioContext;
    }
    if (window.webkitAudioContext) {
      window.webkitAudioContext = PatchedAudioContext;
    }

    ['pointerdown', 'click', 'keydown', 'touchstart'].forEach((eventName) => {
      window.addEventListener(eventName, resumeTrackedAudioContexts, { capture: true, passive: true });
    });
    document.addEventListener('visibilitychange', resumeTrackedAudioContexts);
    window.addEventListener('focus', resumeTrackedAudioContexts);
    window.__nekoAudioContextAutoResumePatched = true;
  }

  function trackAudioContext(context) {
    if (!context || trackedAudioContexts.has(context)) {
      return;
    }

    trackedAudioContexts.add(context);
    const originalClose = typeof context.close === 'function' ? context.close.bind(context) : null;
    if (originalClose) {
      context.close = (...args) => {
        trackedAudioContexts.delete(context);
        return originalClose(...args);
      };
    }
    resumeAudioContext(context);
  }

  function resumeTrackedAudioContexts() {
    trackedAudioContexts.forEach(resumeAudioContext);
  }

  function resumeAudioContext(context) {
    if (!context || context.state !== 'suspended' || typeof context.resume !== 'function') {
      return;
    }
    context.resume().catch(() => {});
  }

  async function relayAudioViaPcm(constraints) {
    const requestId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextCtor !== 'function') {
      throw new DOMException('AudioContext is not available', 'NotSupportedError');
    }

    const audioContext = new AudioContextCtor({ sampleRate: 48000 });
    trackAudioContext(audioContext);
    await audioContext.resume().catch(() => {});

    const destination = audioContext.createMediaStreamDestination();
    const outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack) {
      try { audioContext.close(); } catch {}
      throw new DOMException('Could not create PCM relay audio track', 'NotFoundError');
    }

    let resolvePromise;
    let rejectPromise;
    const streamPromise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const entry = {
      audioContext,
      destination,
      stream: destination.stream,
      resolve: resolvePromise,
      reject: rejectPromise,
      nextStartTime: 0,
      resolved: false,
      closed: false,
      lastNonSilentAt: 0,
      idleTimer: null,
      bridgeTimer: window.setTimeout(() => {
        rejectPcmRelay(requestId, new DOMException('PCM bridge did not receive start request. Reload the host page after reloading the extension.', 'TimeoutError'));
      }, 3000),
      setupTimer: window.setTimeout(() => {
        rejectPcmRelay(requestId, new DOMException('PCM relay timeout', 'TimeoutError'));
      }, 15000)
    };
    pcmRelayRequests.set(requestId, entry);

    const originalStop = outputTrack.stop.bind(outputTrack);
    outputTrack.stop = () => {
      stopPcmRelay(requestId);
      originalStop();
    };
    outputTrack.onended = () => stopPcmRelay(requestId);

    console.log('[NEKO-MIC main] Starting PCM relay', requestId.substring(0, 8), 'ctxState:', audioContext.state);
    postToIsolated({ type: 'NEKO_PCM_START', requestId, constraints, sampleRate: audioContext.sampleRate });
    return streamPromise;
  }

  function handlePcmRelayMessage(data) {
    const entry = pcmRelayRequests.get(data.requestId);
    if (!entry || entry.closed) {
      return;
    }

    if (data.type === 'NEKO_PCM_SIGNAL') {
      if (data.error) {
        rejectPcmRelay(data.requestId, new DOMException(data.error.message || 'PCM relay error', data.error.name || 'UnknownError'));
      } else if (data.ready) {
        window.clearTimeout(entry.bridgeTimer);
        console.log('[NEKO-MIC main] PCM relay ready', data.requestId.substring(0, 8), 'sourceSampleRate:', data.sampleRate);
      }
      return;
    }

    if (data.type === 'NEKO_PCM_BRIDGE_ACK') {
      window.clearTimeout(entry.bridgeTimer);
      console.log('[NEKO-MIC main] PCM bridge ack', data.requestId.substring(0, 8));
      return;
    }

    if (data.type !== 'NEKO_PCM_CHUNK' || typeof data.pcm16 !== 'string') {
      return;
    }

    appendPcmChunk(data.requestId, entry, data);
  }

  function appendPcmChunk(requestId, entry, data) {
    try {
      resumeAudioContext(entry.audioContext);
      const samples = decodePcm16Base64(data.pcm16);
      if (samples.length === 0) {
        return;
      }

      const sampleRate = Number(data.sampleRate) || entry.audioContext.sampleRate || 48000;
      const buffer = entry.audioContext.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);

      const source = entry.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(entry.destination);

      const now = entry.audioContext.currentTime;
      if (!entry.nextStartTime || entry.nextStartTime < now + 0.04) {
        entry.nextStartTime = now + 0.08;
      }
      source.start(entry.nextStartTime);
      entry.nextStartTime += buffer.duration;
      if (!entry.resolved) {
        entry.resolved = true;
        window.clearTimeout(entry.setupTimer);
        console.log('[NEKO-MIC main] PCM relay stream resolved', requestId.substring(0, 8), 'ctxState:', entry.audioContext.state);
        armPcmIdleCleanup(requestId, entry);
        scheduleAudioContextResumes();
        entry.resolve(entry.stream);
      }

      if (Number(data.level) > 0.015) {
        entry.lastNonSilentAt = performance.now();
      }
    } catch (err) {
      rejectPcmRelay(requestId, err);
    }
  }

  function decodePcm16Base64(base64) {
    const binary = atob(base64);
    const length = Math.floor(binary.length / 2);
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const lo = binary.charCodeAt(i * 2);
      const hi = binary.charCodeAt(i * 2 + 1);
      let value = lo | (hi << 8);
      if (value >= 0x8000) {
        value -= 0x10000;
      }
      samples[i] = value / 32768;
    }
    return samples;
  }

  function rejectPcmRelay(requestId, err) {
    const entry = pcmRelayRequests.get(requestId);
    if (!entry) {
      return;
    }
    postToIsolated({ type: 'NEKO_PCM_STOP', requestId });
    cleanupPcmRelay(requestId);
    entry.reject(err);
  }

  function formatMediaError(err) {
    if (!err) {
      return 'unknown error';
    }
    const name = err.name || err.constructor?.name || 'Error';
    const message = err.message || String(err);
    return `${name}: ${message}`;
  }

  function stopPcmRelay(requestId) {
    postToIsolated({ type: 'NEKO_PCM_STOP', requestId });
    cleanupPcmRelay(requestId);
  }

  function cleanupPcmRelay(requestId) {
    const entry = pcmRelayRequests.get(requestId);
    if (!entry) {
      return;
    }
    entry.closed = true;
    window.clearTimeout(entry.setupTimer);
    window.clearTimeout(entry.bridgeTimer);
    window.clearTimeout(entry.idleTimer);
    try { entry.audioContext.close(); } catch {}
    pcmRelayRequests.delete(requestId);
  }

  function armPcmIdleCleanup(requestId, entry) {
    const startedAt = performance.now();
    const checkIdle = () => {
      if (entry.closed) {
        return;
      }
      const now = performance.now();
      const heardAudio = entry.lastNonSilentAt > 0;
      const age = now - startedAt;
      const silentFor = heardAudio ? now - entry.lastNonSilentAt : age;

      if ((!heardAudio && age > 3500) || (heardAudio && silentFor > 12000)) {
        console.log('[NEKO-MIC main] PCM relay idle cleanup', requestId.substring(0, 8), 'heardAudio:', heardAudio);
        stopPcmRelay(requestId);
        return;
      }

      entry.idleTimer = window.setTimeout(checkIdle, 1500);
    };

    entry.idleTimer = window.setTimeout(checkIdle, 3500);
  }

  function postToIsolated(data) {
    if (window.parent && window.parent !== window) {
      if (floatingPcmPort) {
        try {
          floatingPcmPort.postMessage({ ...data, _sender: 'main' });
          return;
        } catch {
          floatingPcmPort = null;
        }
      }
      if (FLOATING_BRIDGE_ORIGIN) {
        window.parent.postMessage({ ...data, _sender: 'main' }, FLOATING_BRIDGE_ORIGIN);
      }
      return;
    }
    window.postMessage({ ...data, _sender: 'main' }, window.location.origin);
  }

  function resolveFloatingBridgeOrigin() {
    const extensionOrigin = resolveCurrentScriptExtensionOrigin();
    if (!extensionOrigin) return '';
    const ancestorOrigin = window.location.ancestorOrigins?.[0];
    const candidates = [ancestorOrigin, document.referrer];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const referrer = new URL(candidate);
        if (`${referrer.protocol}//${referrer.host}` === extensionOrigin) {
          return extensionOrigin;
        }
      } catch {}
    }
    return '';
  }

  function resolveCurrentScriptExtensionOrigin() {
    const source = document.currentScript?.getAttribute('src');
    if (!source) return '';
    try {
      const scriptUrl = new URL(source);
      if (scriptUrl.protocol === 'chrome-extension:' && scriptUrl.host) {
        return `chrome-extension://${scriptUrl.host}`;
      }
    } catch {}
    return '';
  }

  function attachFloatingPcmPort(port) {
    if (floatingPcmPort) {
      try { floatingPcmPort.close(); } catch {}
    }
    floatingPcmPort = port;
    floatingPcmPort.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data.type !== 'string' || !data.type.startsWith('NEKO_PCM_')) {
        return;
      }
      handlePcmRelayMessage(data);
    };
    floatingPcmPort.onmessageerror = () => {
      floatingPcmPort = null;
    };
    try { floatingPcmPort.start(); } catch {}
    console.log('[NEKO-MIC main] PCM MessagePort attached');
  }

  function scheduleAudioContextResumes() {
    [0, 50, 150, 400, 1000].forEach((delay) => {
      window.setTimeout(resumeTrackedAudioContexts, delay);
    });
  }

  function forceTransparentRenderers() {
    makePixiTransparent(window.live2dManager && window.live2dManager.pixi_app);
    makeThreeTransparent(window.vrmManager && window.vrmManager.renderer);
    makeThreeTransparent(window.mmdManager && window.mmdManager.renderer);
    makeThreeTransparent(window.vrmManager && window.vrmManager.manager && window.vrmManager.manager.renderer);
    makeThreeTransparent(window.mmdManager && window.mmdManager.manager && window.mmdManager.manager.renderer);
  }

  function forcePageReflow() {
    window.dispatchEvent(new Event('resize'));

    forceTransparentRenderers();
  }

  function makePixiTransparent(app) {
    if (!app || !app.renderer) {
      return;
    }

    const renderer = app.renderer;
    setCanvasTransparent(renderer.view || app.view);

    trySet(renderer, 'backgroundAlpha', 0);
    trySet(renderer, 'transparent', true);

    if (renderer.options) {
      trySet(renderer.options, 'backgroundAlpha', 0);
      trySet(renderer.options, 'transparent', true);
    }

    if (renderer.background) {
      trySet(renderer.background, 'alpha', 0);
      trySet(renderer.background, 'color', 0x000000);
      if (typeof renderer.background.clearBeforeRender === 'boolean') {
        renderer.background.clearBeforeRender = true;
      }
    }

    if (Array.isArray(renderer._backgroundColorRgba) && renderer._backgroundColorRgba.length >= 4) {
      renderer._backgroundColorRgba[3] = 0;
    }

    if (typeof renderer.clear === 'function') {
      try {
        renderer.clear();
      } catch {}
    }

    if (typeof renderer.render === 'function' && app.stage) {
      try {
        renderer.render(app.stage);
      } catch {}
    }
  }

  function makeThreeTransparent(renderer) {
    if (!renderer) {
      return;
    }

    setCanvasTransparent(renderer.domElement);

    if (typeof renderer.setClearColor === 'function') {
      try {
        renderer.setClearColor(0x000000, 0);
      } catch {}
    }

    if (typeof renderer.setClearAlpha === 'function') {
      try {
        renderer.setClearAlpha(0);
      } catch {}
    }
  }

  function setCanvasTransparent(canvas) {
    if (!canvas || !canvas.style) {
      return;
    }

    canvas.style.setProperty('background', 'transparent', 'important');
    canvas.style.setProperty('background-color', 'transparent', 'important');
  }

  function trySet(target, key, value) {
    try {
      target[key] = value;
    } catch {}
  }
})();
