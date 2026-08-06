const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const background = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function createHarness(mediaRoutes, ensureOffscreen, sendOffscreenMessage) {
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
    { log() {} }
  );
}

test('PCM routes roll back when startup or shutdown cannot reach offscreen', async () => {
  const mediaRoutes = new Map();
  let ensureError = new Error('offscreen unavailable');
  let startResponse = { ok: true };
  const harness = createHarness(
    mediaRoutes,
    () => ensureError ? Promise.reject(ensureError) : Promise.resolve(),
    (message) => Promise.resolve(message.type === 'NEKO_PCM_START' ? startResponse : { ok: true })
  );
  const sender = { tab: { id: 7 }, frameId: 0 };

  await assert.rejects(
    harness.handlePcmStart({ requestId: 'start-failure', fromFloating: true }, sender),
    /offscreen unavailable/
  );
  assert.equal(mediaRoutes.has('start-failure'), false);

  ensureError = null;
  startResponse = { ok: false, error: 'capture rejected' };
  await assert.rejects(
    harness.handlePcmStart({ requestId: 'start-rejected', fromFloating: true }, sender),
    /capture rejected/
  );
  assert.equal(mediaRoutes.has('start-rejected'), false);

  startResponse = { ok: true };
  await harness.handlePcmStart({ requestId: 'stop-failure', fromFloating: true }, sender);
  assert.equal(mediaRoutes.has('stop-failure'), true);
  ensureError = new Error('offscreen stopped responding');
  await harness.handlePcmStop({ requestId: 'stop-failure' });
  assert.equal(mediaRoutes.has('stop-failure'), false);
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
