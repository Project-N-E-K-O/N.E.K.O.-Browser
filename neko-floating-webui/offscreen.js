(() => {
  const cachedStreams = new Map();
  const pcmSessions = new Map();
  const STREAM_KEY = 'audio';
  const PCM_WORKLET_MODULE = 'pcm-audio-worklet.js';
  const PCM_WORKLET_PROCESSOR = 'neko-pcm-capture';
  const PCM_WORKLET_LOAD_TIMEOUT_MS = 1200;
  const PCM_CONTEXT_RESUME_TIMEOUT_MS = 1200;
  const MIC_RELEASE_DELAY_MS = 500;
  let micReleaseTimer = null;

  console.log('[NEKO-MIC offscreen] ready');

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'NEKO_OFFSCREEN_PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'NEKO_PCM_START') {
      handlePcmStart(message.requestId, message.constraints, message.sampleRate)
        .catch((err) => {
          if (err?.name === 'AbortError') {
            return;
          }
          sendPcmSignal(message.requestId, {
            error: { name: err?.name || 'UnknownError', message: String(err?.message || err) }
          });
        });
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'NEKO_PCM_STOP') {
      cleanupPcmSession(message.requestId);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  async function handlePcmStart(requestId, constraints, requestedSampleRate) {
    if (!requestId) {
      return;
    }
    cleanupPcmSession(requestId);
    console.log('[NEKO-MIC offscreen] PCM start requested:', requestId.substring(0, 8));

    const stream = await ensureMicStream(constraints);
    const sampleRate = Number(requestedSampleRate) || 48000;
    const audioContext = new AudioContext({ sampleRate });
    const source = audioContext.createMediaStreamSource(stream);
    const silence = audioContext.createGain();
    silence.gain.value = 0;

    const session = {
      requestId,
      audioContext,
      source,
      processor: null,
      silence,
      closed: false,
      captureMode: 'unknown'
    };
    pcmSessions.set(requestId, session);

    let processor;
    try {
      processor = await createPcmProcessor(audioContext, session);
    } catch (err) {
      cleanupPcmSession(requestId);
      throw err;
    }
    if (session.closed) {
      try { processor.disconnect(); } catch {}
      return;
    }
    session.processor = processor;

    source.connect(processor);
    processor.connect(silence);
    silence.connect(audioContext.destination);

    if (audioContext.state === 'suspended') {
      await withTimeout(audioContext.resume(), PCM_CONTEXT_RESUME_TIMEOUT_MS, 'AudioContext resume').catch((err) => {
        console.warn('[NEKO-MIC offscreen] PCM AudioContext resume did not complete:', formatError(err), 'state:', audioContext.state);
      });
    }

    console.log('[NEKO-MIC offscreen] PCM relay started:', requestId.substring(0, 8), 'mode:', session.captureMode, 'sampleRate:', audioContext.sampleRate, 'ctxState:', audioContext.state);
    sendPcmSignal(requestId, {
      ready: true,
      sampleRate: audioContext.sampleRate
    });
  }

  async function createPcmProcessor(audioContext, session) {
    if (audioContext.audioWorklet && typeof AudioWorkletNode === 'function') {
      const absoluteModuleUrl = chrome.runtime.getURL(PCM_WORKLET_MODULE);
      const moduleUrls = absoluteModuleUrl === PCM_WORKLET_MODULE
        ? [PCM_WORKLET_MODULE]
        : [PCM_WORKLET_MODULE, absoluteModuleUrl];
      let lastError = null;

      for (const moduleUrl of moduleUrls) {
        try {
          assertPcmSessionOpen(audioContext, session);
          await withTimeout(
            audioContext.audioWorklet.addModule(moduleUrl),
            PCM_WORKLET_LOAD_TIMEOUT_MS,
            'AudioWorklet addModule ' + moduleUrl
          );
          assertPcmSessionOpen(audioContext, session);
          const node = new AudioWorkletNode(audioContext, PCM_WORKLET_PROCESSOR, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1]
          });
          node.port.onmessage = (event) => handlePcmWorkletMessage(session, event.data);
          node.port.onmessageerror = (event) => {
            console.warn('[NEKO-MIC offscreen] PCM worklet message error:', event);
          };
          session.captureMode = 'audioWorklet';
          return node;
        } catch (err) {
          lastError = err;
          assertPcmSessionOpen(audioContext, session);
        }
      }

      console.warn('[NEKO-MIC offscreen] AudioWorklet unavailable, falling back to ScriptProcessor:', formatError(lastError));
    }

    assertPcmSessionOpen(audioContext, session);
    return createScriptPcmProcessor(audioContext, session);
  }

  function assertPcmSessionOpen(audioContext, session) {
    if (session.closed || audioContext.state === 'closed') {
      throw new DOMException('PCM relay session closed', 'AbortError');
    }
  }

  function formatError(err) {
    if (!err) {
      return 'unknown error';
    }
    const name = err.name || err.constructor?.name || 'Error';
    const message = err.message || String(err);
    return `${name}: ${message}`;
  }

  function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new DOMException(label + ' timed out after ' + timeoutMs + 'ms', 'TimeoutError'));
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function handlePcmWorkletMessage(session, data) {
    if (session.closed || !data || !data.pcm16Buffer) {
      return;
    }

    const level = Number(data.level) || 0;
    const pcm16 = encodePcm16BytesBase64(data.pcm16Buffer);
    sendPcmChunk(session.requestId, {
      pcm16,
      sampleRate: data.sampleRate || session.audioContext.sampleRate,
      level
    });
  }

  function createScriptPcmProcessor(audioContext, session) {
    assertPcmSessionOpen(audioContext, session);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    session.captureMode = 'scriptProcessor';

    processor.onaudioprocess = (event) => {
      if (session.closed) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);

      let sumSquares = 0;
      for (let i = 0; i < input.length; i++) {
        sumSquares += input[i] * input[i];
      }
      const level = Math.sqrt(sumSquares / input.length);
      const pcm16 = encodePcm16Base64(input);
      sendPcmChunk(session.requestId, {
        pcm16,
        sampleRate: audioContext.sampleRate,
        level
      });
    };

    return processor;
  }

  function encodePcm16Base64(input) {
    let binary = '';
    for (let i = 0; i < input.length; i++) {
      const clamped = Math.max(-1, Math.min(1, input[i]));
      const value = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      const unsigned = value < 0 ? value + 0x10000 : value;
      binary += String.fromCharCode(unsigned & 0xff, (unsigned >> 8) & 0xff);
    }
    return btoa(binary);
  }

  function encodePcm16BytesBase64(buffer) {
    const bytes = buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function sendPcmSignal(requestId, payload) {
    chrome.runtime.sendMessage({
      type: 'NEKO_PCM_SIGNAL',
      requestId,
      ...payload
    }).catch(() => {});
  }

  function sendPcmChunk(requestId, payload) {
    chrome.runtime.sendMessage({
      type: 'NEKO_PCM_CHUNK',
      requestId,
      ...payload
    }).catch(() => {});
  }

  function cleanupPcmSession(requestId) {
    const session = pcmSessions.get(requestId);
    if (!session) {
      return;
    }
    session.closed = true;
    try { session.source.disconnect(); } catch {}
    try { session.processor.port.onmessage = null; } catch {}
    try { session.processor.port.close(); } catch {}
    try { session.processor.disconnect(); } catch {}
    try { session.silence.disconnect(); } catch {}
    try { session.audioContext.close(); } catch {}
    pcmSessions.delete(requestId);
    scheduleMicReleaseIfIdle();
  }

  async function ensureMicStream(constraints) {
    clearTimeout(micReleaseTimer);
    micReleaseTimer = null;
    const existing = cachedStreams.get(STREAM_KEY);
    if (existing && existing.getAudioTracks().some((t) => t.readyState === 'live')) {
      console.log('[NEKO-MIC offscreen] Reusing cached mic stream');
      return existing;
    }

    if (existing) {
      existing.getTracks().forEach((t) => {
        try { t.stop(); } catch {}
      });
      cachedStreams.delete(STREAM_KEY);
    }

    const audioConstraints = resolveAudioConstraints(constraints);
    console.log('[NEKO-MIC offscreen] getUserMedia with constraints:', JSON.stringify(audioConstraints));
    const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
    cachedStreams.set(STREAM_KEY, stream);
    return stream;
  }

  function resolveAudioConstraints(constraints) {
    if (constraints && typeof constraints === 'object') {
      if (constraints.audio !== undefined) {
        return { audio: constraints.audio, video: false };
      }
    }
    return { audio: true, video: false };
  }

  function scheduleMicReleaseIfIdle() {
    clearTimeout(micReleaseTimer);
    micReleaseTimer = setTimeout(() => {
      micReleaseTimer = null;
      releaseMicStreamIfIdle();
    }, MIC_RELEASE_DELAY_MS);
  }

  function releaseMicStreamIfIdle() {
    if (pcmSessions.size > 0) {
      return;
    }

    const stream = cachedStreams.get(STREAM_KEY);
    if (!stream) {
      return;
    }

    stream.getTracks().forEach((track) => {
      try { track.stop(); } catch {}
    });
    cachedStreams.delete(STREAM_KEY);
    console.log('[NEKO-MIC offscreen] Released cached mic stream');
  }
})();
