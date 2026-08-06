const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./helpers/extract-function.cjs');

const background = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');

function createHarness(mediaRoutes, ensureOffscreen, sendOffscreenMessage, logger = null) {
  return new Function(
    'mediaRoutes',
    'ensureOffscreen',
    'sendOffscreenMessage',
    'console',
    `${extractFunction(background, 'handlePcmStart')}
     ${extractFunction(background, 'handlePcmStop')}
     ${extractFunction(background, 'stopPcmRoutesForTab')}
     ${extractFunction(background, 'stopOffscreenPcmSession')}
     return { handlePcmStart, handlePcmStop, stopPcmRoutesForTab };`
  )(
    mediaRoutes,
    ensureOffscreen,
    sendOffscreenMessage,
    logger || { log() {}, warn() {} }
  );
}

test('PCM routes roll back when startup or shutdown cannot reach offscreen', async () => {
  const mediaRoutes = new Map();
  let ensureError = new Error('offscreen unavailable');
  let startError = null;
  const warnings = [];
  const harness = createHarness(
    mediaRoutes,
    () => ensureError ? Promise.reject(ensureError) : Promise.resolve(),
    (message) => {
      if (message.type === 'NEKO_PCM_START' && startError) {
        return Promise.reject(startError);
      }
      return Promise.resolve({ ok: true });
    },
    {
      log() {},
      warn(...args) { warnings.push(args); }
    }
  );
  const sender = { tab: { id: 7 }, frameId: 0 };

  await assert.rejects(
    harness.handlePcmStart({ requestId: 'start-failure', fromFloating: true }, sender),
    /offscreen unavailable/
  );
  assert.equal(mediaRoutes.has('start-failure'), false);

  ensureError = null;
  startError = new Error('capture rejected');
  await assert.rejects(
    harness.handlePcmStart({ requestId: 'start-rejected', fromFloating: true }, sender),
    /capture rejected/
  );
  assert.equal(mediaRoutes.has('start-rejected'), false);

  startError = null;
  await harness.handlePcmStart({ requestId: 'stop-failure', fromFloating: true }, sender);
  assert.equal(mediaRoutes.has('stop-failure'), true);
  ensureError = new Error('offscreen stopped responding');
  await harness.handlePcmStop({ requestId: 'stop-failure' });
  assert.equal(mediaRoutes.has('stop-failure'), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].join(' '), /stop-failure/);
  assert.match(warnings[0].join(' '), /offscreen stopped responding/);
});

test('function extraction respects name boundaries and JavaScript brace syntax', () => {
  const fixture = `
    function handlePcmStopAll() { return 'wrong'; }
    async function handlePcmStop() {
      const text = 'literal } brace';
      const pattern = /[{}]/;
      return ` + '`template ${text} { brace }`' + `;
    }
  `;
  const extracted = extractFunction(fixture, 'handlePcmStop');
  assert.match(extracted, /^async function handlePcmStop\s*\(/);
  assert.match(extracted, /template/);
  assert.doesNotMatch(extracted, /handlePcmStopAll/);
});

test('closing or navigating a tab stops only its PCM routes', async () => {
  const mediaRoutes = new Map([
    ['tab-7-a', { extensionPage: true, tabId: 7, frameId: 0 }],
    ['tab-8', { extensionPage: true, tabId: 8, frameId: 0 }],
    ['tab-7-b', { extensionPage: true, tabId: 7, frameId: 0 }]
  ]);
  const stopped = [];
  const harness = createHarness(
    mediaRoutes,
    () => Promise.resolve(),
    (message) => {
      if (message.type === 'NEKO_PCM_STOP') stopped.push(message.requestId);
      return Promise.resolve({ ok: true });
    }
  );

  await harness.stopPcmRoutesForTab(7);
  assert.deepEqual(Array.from(mediaRoutes.keys()), ['tab-8']);
  assert.deepEqual(stopped.sort(), ['tab-7-a', 'tab-7-b']);
  assert.match(background, /chrome\.tabs\.onRemoved\.addListener\([\s\S]*?stopPcmRoutesForTab\(tabId\)/);
  assert.match(background, /changeInfo\.status !== 'loading'[\s\S]*?stopPcmRoutesForTab\(tabId\)/);
});

test('a route stopped while offscreen starts does not restart capture', async () => {
  const mediaRoutes = new Map();
  const sent = [];
  let resolveOffscreen;
  const offscreenReady = new Promise((resolve) => {
    resolveOffscreen = resolve;
  });
  const harness = createHarness(
    mediaRoutes,
    () => offscreenReady,
    (message) => {
      sent.push(message.type);
      return Promise.resolve({ ok: true });
    }
  );

  const start = harness.handlePcmStart(
    { requestId: 'pending-start', fromFloating: true },
    { tab: { id: 7 }, frameId: 0 }
  );
  const stop = harness.stopPcmRoutesForTab(7);
  resolveOffscreen();
  await Promise.all([start, stop]);

  assert.equal(mediaRoutes.has('pending-start'), false);
  assert.deepEqual(sent, ['NEKO_PCM_STOP']);
});
