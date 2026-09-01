const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./helpers/extract-function.cjs');

const background = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');

test('background toggles wake a minimized owner without re-entering the panel queue', () => {
  assert.match(
    background,
    /type: state\.minimized === true \? 'NEKO_OPEN_SINGLETON' : 'NEKO_TOGGLE_SINGLETON'/
  );
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const firstState = deferred();
  const cleanupCalls = [];
  const storageWrites = [];
  const tabMessages = [];
  let stateReadCount = 0;

  const harness = new Function(
    'firstState',
    'cleanupCalls',
    'storageWrites',
    'tabMessages',
    'readState',
    `let panelSyncSeq = 0;
     let panelSyncTransition = Promise.resolve();
     const chrome = {
       storage: { local: { set: async (value) => storageWrites.push(value) } },
       tabs: { sendMessage: async (tabId, message) => tabMessages.push({ tabId, message }) }
     };
     const getStoredState = async () => {
       const readIndex = readState();
       if (readIndex === 1) return firstState.promise;
       return {
         displayMode: 'floating',
         webuiUrl: 'http://localhost:48911/',
         enabled: true,
         activeTabId: 2
       };
     };
     const getTab = async () => null;
     const isInjectableTab = () => false;
     const enforceSingleActivePanel = async (tabId) => cleanupCalls.push(tabId);
     const deactivateAllTabPanels = async () => {};
     const stopPcmRoutesForTab = async () => {};
     const sendTabMessage = async (tabId, message) => chrome.tabs.sendMessage(tabId, message);
     const normalizeAvatarForm = (value) => value === 'cat' ? 'cat' : 'model';
     ${extractFunction(background, 'applyPanelStateMessage')}
     ${extractFunction(background, 'queuePanelTransition')}
     ${extractFunction(background, 'queuePanelMutation')}
     ${extractFunction(background, 'syncPanelToTab')}
     ${extractFunction(background, 'performPanelSyncToTab')}
     return {
       applyPanelStateMessage,
       queuePanelMutation,
       syncPanelToTab,
       setSequence(value) { panelSyncSeq = value; }
     };`
  )(
    firstState,
    cleanupCalls,
    storageWrites,
    tabMessages,
    () => {
      stateReadCount += 1;
      return stateReadCount;
    }
  );

  return { ...harness, firstState, cleanupCalls, storageWrites, tabMessages };
}

test('a stale tab sync cannot clean up after a newer ownership mutation', async () => {
  const harness = createHarness();
  harness.setSequence(1);
  const staleSync = harness.syncPanelToTab(1, 1);
  await Promise.resolve();
  await Promise.resolve();

  const panelState = { minimized: false, avatarForm: 'model' };
  const currentMutation = harness.queuePanelMutation(
    () => harness.applyPanelStateMessage(panelState, 2)
  );
  harness.firstState.resolve({
    displayMode: 'floating',
    webuiUrl: 'http://localhost:48911/',
    enabled: true
  });

  const [staleResult, mutationResult] = await Promise.all([staleSync, currentMutation]);
  assert.deepEqual(staleResult, { ok: false, awake: false });
  assert.deepEqual(mutationResult, { ok: true });
  assert.deepEqual(harness.cleanupCalls, [2]);
  assert.deepEqual(harness.storageWrites, [{
    minimized: false,
    avatarForm: 'model',
    wakeStateInitialized: true,
    activeTabId: 2,
    enabled: true
  }]);
  assert.deepEqual(harness.tabMessages, [{ tabId: 2, message: panelState }]);
});

test('panel sync transitions recover after a rejected transition', async () => {
  const harness = createHarness();
  harness.setSequence(1);
  const failedSync = harness.syncPanelToTab(1, 1);
  const rejection = assert.rejects(failedSync, /state read failed/);
  await Promise.resolve();
  await Promise.resolve();
  const recoveredMutation = harness.queuePanelMutation(async () => {
    harness.storageWrites.push({ activeTabId: 2 });
    return { ok: true };
  });
  harness.firstState.reject(new Error('state read failed'));
  await rejection;

  assert.deepEqual(await recoveredMutation, { ok: true });
  assert.deepEqual(harness.cleanupCalls, []);
  assert.deepEqual(harness.storageWrites, [{ activeTabId: 2 }]);
});

test('a late state message from the previous owner is ignored', async () => {
  const harness = createHarness();
  const result = harness.applyPanelStateMessage({ closed: true }, 1);
  harness.firstState.resolve({ activeTabId: 2 });

  assert.deepEqual(await result, { ok: true, ignored: true });
  assert.deepEqual(harness.cleanupCalls, []);
  assert.deepEqual(harness.storageWrites, []);
  assert.deepEqual(harness.tabMessages, []);
});
