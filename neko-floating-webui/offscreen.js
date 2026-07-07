(() => {
  const cachedStreams = new Map();
  const peerConnections = new Map();
  const earlyIceCandidates = new Map();
  const pcmSessions = new Map();
  const STREAM_KEY = 'audio';
  const PCM_WORKLET_MODULE = 'pcm-audio-worklet.js';
  const PCM_WORKLET_PROCESSOR = 'neko-pcm-capture';
  const PCM_WORKLET_LOAD_TIMEOUT_MS = 1200;
  const PCM_CONTEXT_RESUME_TIMEOUT_MS = 1200;
  const MIC_RELEASE_DELAY_MS = 500;
  let micReleaseTimer = null;

  window.setInterval(() => {}, 20000);
  console.log('[NEKO-MIC offscreen] ready');

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'NEKO_OFFSCREEN_PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'NEKO_MEDIA_REQUEST') {
      handleOfferMedia(message.requestId, message.constraints, message.sdp)
        .then(() => {})
        .catch((err) => sendSignal(message.requestId, {
          error: { name: err?.name || 'UnknownError', message: String(err?.message || err) }
        }));
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'NEKO_MEDIA_SIGNAL' && message.ice) {
      const entry = peerConnections.get(message.requestId);
      if (entry) {
        addIceCandidateSafe(entry, message.ice);
      } else {
        queueEarlyIce(message.requestId, message.ice);
        console.warn('[NEKO-MIC offscreen] ICE arrived before PC exists, queued:', message.requestId);
      }
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

  async function handleOfferMedia(requestId, constraints, offerSdp) {
    const pc = new RTCPeerConnection();
    const entry = { pc, pendingIce: [], remoteDescSet: false, closed: false };
    peerConnections.set(requestId, entry);
    takeEarlyIce(requestId).forEach((ice) => addIceCandidateSafe(entry, ice));

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(requestId, { ice: event.candidate.toJSON() });
      } else {
        console.log('[NEKO-MIC offscreen] ICE gathering complete:', requestId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[NEKO-MIC offscreen] ICE state:', pc.iceConnectionState, requestId);
    };

    pc.onicegatheringstatechange = () => {
      console.log('[NEKO-MIC offscreen] ICE gathering state:', pc.iceGatheringState, requestId);
    };

    pc.onconnectionstatechange = () => {
      console.log('[NEKO-MIC offscreen] PC state:', pc.connectionState, requestId);
      if (['closed', 'failed', 'disconnected'].includes(pc.connectionState)) {
        cleanupPc(requestId);
      }
    };

    pc.ontrack = (event) => {
      console.log('[NEKO-MIC offscreen] ontrack (sender side):', event.track.kind, 'readyState:', event.track.readyState);
    };

    let stream;
    try {
      stream = await ensureMicStream(constraints);
      const tracksInfo = stream.getAudioTracks().map((t) => ({
        readyState: t.readyState,
        muted: t.muted,
        enabled: t.enabled,
        label: t.label
      }));
      console.log('[NEKO-MIC offscreen] Got mic stream:', tracksInfo);
      const track = stream.getAudioTracks()[0];
      if (track) {
        console.log('[NEKO-MIC offscreen] Track settings:', track.getSettings());
      }
      monitorAudioLevel(stream, requestId);
    } catch (err) {
      console.error('[NEKO-MIC offscreen] getUserMedia failed:', err);
      sendSignal(requestId, {
        error: { name: err?.name || 'NotAllowedError', message: String(err?.message || err) }
      });
      cleanupPc(requestId);
      return;
    }

    if (entry.closed) {
      cleanupPc(requestId);
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
      entry.remoteDescSet = true;
      console.log('[NEKO-MIC offscreen] Set remote offer');

      for (const ice of entry.pendingIce) {
        addIceCandidateSafe(entry, ice);
      }
      entry.pendingIce.length = 0;

      await attachMicTrack(entry, stream, requestId);
      logTransceivers(pc, 'after attachTrack');

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc, 1500);
      console.log('[NEKO-MIC offscreen] Sent answer');
      logTransceivers(pc, 'after answer');

      monitorRtpStats(pc, requestId);

      sendSignal(requestId, { sdp: pc.localDescription.toJSON() });
    } catch (err) {
      console.error('[NEKO-MIC offscreen] Signaling failed:', err);
      sendSignal(requestId, {
        error: { name: err?.name || 'UnknownError', message: String(err?.message || err) }
      });
      cleanupPc(requestId);
    }
  }

  async function attachMicTrack(entry, stream, requestId) {
    const pc = entry.pc;
    const audioTracks = stream.getAudioTracks();
    const [sourceTrack] = audioTracks;
    if (!sourceTrack) {
      throw new DOMException('No audio track available from microphone', 'NotFoundError');
    }

    sourceTrack.enabled = true;
    sourceTrack.onmute = () => console.log('[NEKO-MIC offscreen] Source track muted', requestId.substring(0, 8));
    sourceTrack.onunmute = () => console.log('[NEKO-MIC offscreen] Source track unmuted', requestId.substring(0, 8));
    sourceTrack.onended = () => cleanupPc(requestId);

    const relayContext = new AudioContext({ sampleRate: 48000 });
    const source = relayContext.createMediaStreamSource(stream);
    const gain = relayContext.createGain();
    gain.gain.value = 1;
    const destination = relayContext.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(destination);

    if (relayContext.state === 'suspended') {
      await relayContext.resume().catch(() => {});
    }

    const [relayTrack] = destination.stream.getAudioTracks();
    if (!relayTrack) {
      try { relayContext.close(); } catch {}
      throw new DOMException('No relay audio track available', 'NotFoundError');
    }

    relayTrack.enabled = true;
    relayTrack.onmute = () => console.log('[NEKO-MIC offscreen] Relay track muted', requestId.substring(0, 8));
    relayTrack.onunmute = () => console.log('[NEKO-MIC offscreen] Relay track unmuted', requestId.substring(0, 8));
    relayTrack.onended = () => cleanupPc(requestId);
    entry.audioContext = relayContext;
    entry.audioNodes = { source, gain, destination };

    console.log('[NEKO-MIC offscreen] Re-materialized mic through AudioContext:', {
      contextState: relayContext.state,
      contextSampleRate: relayContext.sampleRate,
      sourceReadyState: sourceTrack.readyState,
      sourceMuted: sourceTrack.muted,
      relayReadyState: relayTrack.readyState,
      relayMuted: relayTrack.muted,
      sourceLabel: sourceTrack.label
    });
    monitorAudioLevel(destination.stream, requestId + '-relay');

    const transceiver = pc.getTransceivers().find((candidate) => (
      candidate.receiver?.track?.kind === 'audio' || candidate.sender?.track?.kind === 'audio'
    ));

    if (transceiver?.sender) {
      try {
        transceiver.direction = 'sendonly';
      } catch (err) {
        console.warn('[NEKO-MIC offscreen] Could not set transceiver direction:', err);
      }
      await transceiver.sender.replaceTrack(relayTrack);
      console.log('[NEKO-MIC offscreen] Attached relay track to offered transceiver:', {
        mid: transceiver.mid,
        direction: transceiver.direction,
        readyState: relayTrack.readyState,
        muted: relayTrack.muted,
        enabled: relayTrack.enabled,
        label: sourceTrack.label
      });
      return;
    }

    pc.addTrack(relayTrack, destination.stream);
    console.log('[NEKO-MIC offscreen] Added relay track directly:', {
      readyState: relayTrack.readyState,
      muted: relayTrack.muted,
      enabled: relayTrack.enabled,
      label: sourceTrack.label
    });
  }

  function logTransceivers(pc, label) {
    console.log('[NEKO-MIC offscreen] Transceivers ' + label + ':', pc.getTransceivers().map((t, i) => ({
      index: i,
      mid: t.mid,
      direction: t.direction,
      currentDirection: t.currentDirection,
      receiverTrack: t.receiver?.track ? t.receiver.track.kind + ':' + t.receiver.track.readyState : 'null',
      senderTrack: t.sender?.track ? t.sender.track.kind + ':' + t.sender.track.readyState : 'null'
    })));
  }

  function monitorRtpStats(pc, requestId) {
    const shortId = String(requestId).substring(0, 8);
    const intervalId = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        stats.forEach((report) => {
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            console.log('[NEKO-MIC offscreen] Outbound RTP packetsSent:', report.packetsSent, 'bytesSent:', report.bytesSent, 'mid:', report.mid, 'ssrc:', report.ssrc, 'mediaSourceId:', report.mediaSourceId, shortId);
          }
          if (report.type === 'media-source' && report.kind === 'audio') {
            console.log('[NEKO-MIC offscreen] Media source:', report.id, report.audioLevel, report.totalAudioEnergy, shortId);
          }
        });
      } catch {}
    }, 1000);
    setTimeout(() => clearInterval(intervalId), 15000);
  }

  function waitForIceGatheringComplete(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onStateChange);
        resolve();
      };
      const onStateChange = () => {
        if (pc.iceGatheringState === 'complete') {
          finish();
        }
      };
      const timer = setTimeout(finish, timeoutMs);
      pc.addEventListener('icegatheringstatechange', onStateChange);
    });
  }

  let audioMonitorContext = null;

  function monitorAudioLevel(stream, requestId) {
    try {
      if (audioMonitorContext) {
        try { audioMonitorContext.close(); } catch {}
      }
      audioMonitorContext = new AudioContext();
      const source = audioMonitorContext.createMediaStreamSource(stream);
      const analyser = audioMonitorContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let tick = 0;
      const intervalId = setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const max = Math.max.apply(null, Array.from(dataArray));
        console.log('[NEKO-MIC offscreen] Audio level avg:', avg.toFixed(2), 'max:', max, 'tick:', tick, requestId.substring(0, 8));
        tick++;
        if (tick > 20) {
          clearInterval(intervalId);
          try { audioMonitorContext.close(); } catch {}
          audioMonitorContext = null;
        }
      }, 500);
    } catch (e) {
      console.warn('[NEKO-MIC offscreen] Audio monitor failed:', e);
    }
  }

  function addIceCandidateSafe(entry, ice) {
    if (!entry || entry.closed) {
      return;
    }
    if (!entry.remoteDescSet) {
      entry.pendingIce.push(ice);
      return;
    }
    entry.pc.addIceCandidate(new RTCIceCandidate(ice)).catch((err) => {
      console.warn('[NEKO-MIC offscreen] addIceCandidate failed:', err);
    });
  }

  function queueEarlyIce(requestId, ice) {
    if (!requestId || !ice) {
      return;
    }
    const existing = earlyIceCandidates.get(requestId) || [];
    existing.push(ice);
    earlyIceCandidates.set(requestId, existing);
  }

  function takeEarlyIce(requestId) {
    const existing = earlyIceCandidates.get(requestId) || [];
    earlyIceCandidates.delete(requestId);
    return existing;
  }

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
      chunksSent: 0,
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
    session.chunksSent += 1;

    if (level > 0.015 && session.chunksSent % 20 === 1) {
      console.log('[NEKO-MIC offscreen] PCM chunk:', session.requestId.substring(0, 8), 'mode:', session.captureMode, 'level:', level.toFixed(5), 'sampleRate:', data.sampleRate || session.audioContext.sampleRate, 'ctxState:', session.audioContext.state);
    }

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
      session.chunksSent += 1;

      if (level > 0.015 && session.chunksSent % 20 === 1) {
        console.log('[NEKO-MIC offscreen] PCM chunk:', session.requestId.substring(0, 8), 'mode:', session.captureMode, 'level:', level.toFixed(5), 'sampleRate:', audioContext.sampleRate, 'ctxState:', audioContext.state);
      }

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

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');
      console.log('[NEKO-MIC offscreen] Available audio inputs:', audioInputs.map((d) => ({
        label: d.label || '(no label)',
        deviceId: (d.deviceId || '').substring(0, 12) + '...'
      })));
    } catch (e) {
      console.warn('[NEKO-MIC offscreen] enumerateDevices failed:', e);
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

  function sendSignal(requestId, payload) {
    chrome.runtime.sendMessage({
      type: 'NEKO_MEDIA_SIGNAL',
      requestId,
      ...payload
    }).catch(() => {});
  }

  function cleanupPc(requestId) {
    const entry = peerConnections.get(requestId);
    if (!entry) {
      return;
    }
    entry.closed = true;
    try { entry.pc.close(); } catch {}
    if (entry.audioNodes) {
      try { entry.audioNodes.source.disconnect(); } catch {}
      try { entry.audioNodes.gain.disconnect(); } catch {}
    }
    try { entry.audioContext?.close(); } catch {}
    peerConnections.delete(requestId);
    earlyIceCandidates.delete(requestId);
    scheduleMicReleaseIfIdle();
  }

  function scheduleMicReleaseIfIdle() {
    clearTimeout(micReleaseTimer);
    micReleaseTimer = setTimeout(() => {
      micReleaseTimer = null;
      releaseMicStreamIfIdle();
    }, MIC_RELEASE_DELAY_MS);
  }

  function releaseMicStreamIfIdle() {
    if (pcmSessions.size > 0 || peerConnections.size > 0) {
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
