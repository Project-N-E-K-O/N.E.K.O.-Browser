const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./helpers/extract-function.cjs');

const background = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');

function createTimeoutHarness(timeoutMs = 10) {
  return new Function(
    'chrome',
    'PANEL_TAB_MESSAGE_TIMEOUT_MS',
    'console',
    `let panelSyncSeq = 0;
     let panelSyncTransition = Promise.resolve();
     ${extractFunction(background, 'withTimeout')}
     ${extractFunction(background, 'sendTabMessage')}
     ${extractFunction(background, 'queuePanelTransition')}
     ${extractFunction(background, 'queuePanelMutation')}
     return { sendTabMessage, queuePanelMutation };`
  )(
    {
      tabs: {
        sendMessage: () => new Promise(() => {})
      }
    },
    timeoutMs,
    { warn() {} }
  );
}

test('a tab message that never responds cannot poison later panel mutations', async () => {
  const harness = createTimeoutHarness();
  const stalledMutation = harness.queuePanelMutation(
    () => harness.sendTabMessage(7, { type: 'NEKO_FORCE_CLOSE' })
  );
  const laterMutation = harness.queuePanelMutation(async () => ({ ok: true }));

  const result = await Promise.race([
    Promise.all([stalledMutation, laterMutation]),
    new Promise((resolve) => setTimeout(() => resolve('outer-timeout'), 250))
  ]);

  assert.deepEqual(result, [null, { ok: true }]);
  assert.match(
    extractFunction(background, 'applyPanelStateMessage'),
    /await sendTabMessage\(tabId, message\)/
  );
});

test('bulk panel cleanup skips frozen and discarded tabs', () => {
  const isReady = new Function(
    `return (${extractFunction(background, 'isTabReadyForPanelMessage')});`
  )();

  assert.equal(isReady({ id: 1 }), true);
  assert.equal(isReady({ id: 2, frozen: true }), false);
  assert.equal(isReady({ id: 3, discarded: true }), false);
  assert.equal(isReady({}), false);

  const deactivateAll = extractFunction(background, 'deactivateAllTabPanels');
  const enforceSingle = extractFunction(background, 'enforceSingleActivePanel');
  assert.match(deactivateAll, /isTabReadyForPanelMessage\(tab\)/);
  assert.match(enforceSingle, /isTabReadyForPanelMessage\(tab\)/);

  const syncPanel = extractFunction(background, 'performPanelSyncToTab');
  assert.match(
    syncPanel,
    /state\.displayMode === 'sidebar'[\s\S]*?sendTabMessage\(tabId, \{ type: 'NEKO_FORCE_CLOSE' \}\)/
  );
});

test('content script injection is bounded after an unresponsive ping', () => {
  const ensureContentScript = extractFunction(background, 'ensureContentScript');
  assert.match(ensureContentScript, /withTimeout\(/);
  assert.match(ensureContentScript, /PANEL_SCRIPT_INJECTION_TIMEOUT_MS/);
  assert.match(ensureContentScript, /chrome\.scripting\.executeScript/);
});

test('side panel closing is bounded and mode changes use the bounded helper', async () => {
  const closeSidePanelWindow = new Function(
    'sidePanelLifecycle',
    'SIDE_PANEL_CLOSE_TIMEOUT_MS',
    'console',
    `${extractFunction(background, 'withTimeout')}
     ${extractFunction(background, 'closeSidePanelWindow')}
     return closeSidePanelWindow;`
  )(
    { close: () => new Promise(() => {}) },
    10,
    { warn() {} }
  );

  assert.equal(await closeSidePanelWindow(9), false);
  assert.match(extractFunction(background, 'setDisplayMode'), /closeSidePanelWindow\(previousSidePanelWindowId\)/);
  assert.match(extractFunction(background, 'claimSidePanel'), /closeSidePanelWindow\(previousWindowId\)/);
});
