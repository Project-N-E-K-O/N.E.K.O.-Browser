const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'offscreen.js'), 'utf8');

test('a STOP received while getUserMedia is pending cancels PCM startup', async () => {
  let runtimeListener = null;
  let resolveStream;
  let audioContextCount = 0;
  let stoppedTracks = 0;
  const track = {
    readyState: 'live',
    stop() {
      if (track.readyState === 'ended') return;
      track.readyState = 'ended';
      stoppedTracks += 1;
    }
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track]
  };
  const getUserMedia = () => new Promise((resolve) => {
    resolveStream = resolve;
  });

  const context = vm.createContext({
    ArrayBuffer,
    AudioContext: class FakeAudioContext {
      constructor() {
        audioContextCount += 1;
      }
    },
    AudioWorkletNode: undefined,
    DOMException,
    Map,
    Number,
    Promise,
    String,
    Uint8Array,
    btoa,
    chrome: {
      runtime: {
        getURL: (value) => value,
        onMessage: {
          addListener: (listener) => {
            runtimeListener = listener;
          }
        },
        sendMessage: () => Promise.resolve()
      }
    },
    clearTimeout,
    console: { log() {}, warn() {} },
    navigator: { mediaDevices: { getUserMedia } },
    setTimeout
  });
  vm.runInContext(source, context);
  assert.equal(typeof runtimeListener, 'function');

  runtimeListener(
    { type: 'NEKO_PCM_START', requestId: 'pending-start', constraints: { audio: true } },
    {},
    () => {}
  );
  runtimeListener(
    { type: 'NEKO_PCM_STOP', requestId: 'pending-start' },
    {},
    () => {}
  );
  resolveStream(stream);

  const deadline = Date.now() + 1500;
  while (stoppedTracks !== 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(audioContextCount, 0, 'cancelled startup must not construct an AudioContext');
  assert.equal(stoppedTracks, 1, 'the late microphone stream must be released');
});
