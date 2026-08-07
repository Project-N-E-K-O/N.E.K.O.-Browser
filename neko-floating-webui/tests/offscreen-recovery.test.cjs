const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./helpers/extract-function.cjs');

const background = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');

function createRecoveryHarness(chrome, sendOffscreenMessage, logger = null) {
  return new Function(
    'chrome',
    'sendOffscreenMessage',
    'console',
    'OFFSCREEN_DOCUMENT_PATH',
    `${extractFunction(background, 'hasExistingOffscreenDocument')}
     ${extractFunction(background, 'cleanupOrphanedOffscreenPcmSessions')}
     return { hasExistingOffscreenDocument, cleanupOrphanedOffscreenPcmSessions };`
  )(
    chrome,
    sendOffscreenMessage,
    logger || { warn() {} },
    'offscreen.html'
  );
}

test('background startup stops PCM left in an existing offscreen document', async () => {
  const sent = [];
  let contextQuery = null;
  let closed = 0;
  const harness = createRecoveryHarness(
    {
      runtime: {
        getURL: (value) => `chrome-extension://test/${value}`,
        getContexts: async (query) => {
          contextQuery = query;
          return [{ contextType: 'OFFSCREEN_DOCUMENT' }];
        }
      },
      offscreen: {
        closeDocument: async () => { closed += 1; }
      }
    },
    async (message) => { sent.push(message); }
  );

  const result = await harness.cleanupOrphanedOffscreenPcmSessions();
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ type: 'NEKO_PCM_STOP_ALL' }]);
  assert.equal(closed, 0);
  assert.deepEqual(contextQuery, {
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: ['chrome-extension://test/offscreen.html']
  });
});

test('background startup closes offscreen when STOP_ALL cannot be delivered', async () => {
  let closed = 0;
  const warnings = [];
  const harness = createRecoveryHarness(
    {
      runtime: {
        getURL: (value) => `chrome-extension://test/${value}`,
        getContexts: async () => [{}]
      },
      offscreen: {
        closeDocument: async () => { closed += 1; }
      }
    },
    async () => { throw new Error('offscreen did not respond'); },
    { warn(...args) { warnings.push(args); } }
  );

  const result = await harness.cleanupOrphanedOffscreenPcmSessions();
  assert.equal(result.ok, true);
  assert.equal(closed, 1);
  assert.match(warnings.flat().join(' '), /offscreen did not respond/);
});

test('new PCM work waits for startup recovery and fails closed if cleanup is impossible', async () => {
  const harness = createRecoveryHarness(
    {
      runtime: {
        getURL: (value) => `chrome-extension://test/${value}`,
        getContexts: async () => [{}]
      },
      offscreen: {
        closeDocument: async () => { throw new Error('close denied'); }
      }
    },
    async () => { throw new Error('stop denied'); }
  );

  const result = await harness.cleanupOrphanedOffscreenPcmSessions();
  assert.equal(result.ok, false);
  assert.match(result.error.message, /close denied/);
  assert.match(background, /const offscreenRecoveryPromise = cleanupOrphanedOffscreenPcmSessions\(\)/);
  assert.match(
    extractFunction(background, 'ensureOffscreen'),
    /const recovery = await offscreenRecoveryPromise;[\s\S]*?if \(!recovery\.ok\)/
  );
});

test('startup recovery does not create an offscreen document when none exists', async () => {
  let sent = 0;
  const harness = createRecoveryHarness(
    {
      runtime: {
        getURL: (value) => `chrome-extension://test/${value}`,
        getContexts: async () => []
      },
      offscreen: {}
    },
    async () => { sent += 1; }
  );

  const result = await harness.cleanupOrphanedOffscreenPcmSessions();
  assert.equal(result.ok, true);
  assert.equal(sent, 0);
});
