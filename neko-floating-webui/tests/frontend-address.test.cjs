const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./helpers/extract-function.cjs');

const projectRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(projectRoot, name), 'utf8');
const manifest = JSON.parse(read('src/manifest-base.json'));
const background = read('background.js');
const content = read('content.js');
const popupHtml = read('popup.html');
const popup = read('popup.js');
const sidepanel = read('sidepanel.js');
const transparentPage = read('transparent-page.js');
const transparentMainWorld = read('transparent-main-world.js');

test('popup exposes save and reset controls for the frontend address', () => {
  assert.match(popupHtml, /id="webui-url"/);
  assert.match(popupHtml, /id="save-webui-url"/);
  assert.match(popupHtml, /id="reset-webui-url"/);
  assert.match(popup, /type: 'NEKO_SET_WEBUI_URL'/);
  assert.match(popup, /saveWebuiUrl\(DEFAULT_WEBUI_URL\)/);
  assert.match(popup, /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/);
  assert.match(popup, /parsed\.username \|\| parsed\.password/);
});

test('background validates, persists, and applies the selected address', () => {
  assert.match(background, /message\.type === 'NEKO_SET_WEBUI_URL'/);
  assert.match(background, /await prepareWebuiContentScripts\(webuiUrl\)/);
  assert.match(background, /chrome\.storage\.local\.set\(\{ webuiUrl \}\)/);
  assert.match(background, /type: 'NEKO_APPLY_WEBUI_URL'/);
  assert.match(background, /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/);
  assert.match(background, /parsed\.username \|\| parsed\.password/);
  assert.match(background, /!isConfiguredFrontendPage\(page, webuiUrl\)/);
  assert.match(background, /await broadcastWebuiUrl\(webuiUrl\)/);
});

test('floating UI treats loopback aliases as the configured N.E.K.O frontend', () => {
  const defaultState = { webuiUrl: 'http://localhost:48911/' };
  const sharedFunctions = (source) => `
    ${extractFunction(source, 'normalizeNekoUrl')}
    ${extractFunction(source, 'isLoopbackHostname')}
    ${extractFunction(source, 'isConfiguredFrontendPage')}
  `;
  const isInjectableTab = Function(
    'DEFAULT_STATE',
    `${sharedFunctions(background)}
     ${extractFunction(background, 'isInjectableTab')}
     return isInjectableTab;`
  )(defaultState);
  const isConfiguredFrontendPage = Function(
    'DEFAULT_STATE',
    `${sharedFunctions(content)}
     return isConfiguredFrontendPage;`
  )(defaultState);

  for (const pageUrl of [
    'http://localhost:48911/',
    'http://127.0.0.1:48911/chat',
    'http://[::1]:48911/'
  ]) {
    assert.equal(isInjectableTab(pageUrl, defaultState.webuiUrl), false, pageUrl);
    assert.equal(isConfiguredFrontendPage(pageUrl, defaultState.webuiUrl), true, pageUrl);
  }

  for (const pageUrl of [
    'http://127.0.0.1:48912/',
    'http://127.1.2.3:48911/',
    'https://127.0.0.1:48911/',
    'http://192.168.1.10:48911/',
    'https://example.com/'
  ]) {
    assert.equal(isInjectableTab(pageUrl, defaultState.webuiUrl), true, pageUrl);
    assert.equal(isConfiguredFrontendPage(pageUrl, defaultState.webuiUrl), false, pageUrl);
  }

  assert.equal(
    isConfiguredFrontendPage('http://localhost:48911/', 'http://127.0.0.1:48911/'),
    true
  );
  assert.equal(
    isInjectableTab('https://example.com/path', 'https://example.com/'),
    false
  );
});

test('frontend URL changes reach inactive floating runtimes', async () => {
  const sent = [];
  const broadcastWebuiUrl = Function(
    'chrome',
    'sendTabMessage',
    `return (${extractFunction(background, 'broadcastWebuiUrl')});`
  )(
    {
      tabs: {
        query: async () => [{ id: 7 }, { id: 8 }, {}]
      }
    },
    async (tabId, message) => {
      sent.push([tabId, message]);
      return { ok: true };
    }
  );

  await broadcastWebuiUrl('http://127.0.0.1:48911/');

  assert.deepEqual(sent, [
    [7, { type: 'NEKO_APPLY_WEBUI_URL', webuiUrl: 'http://127.0.0.1:48911/' }],
    [8, { type: 'NEKO_APPLY_WEBUI_URL', webuiUrl: 'http://127.0.0.1:48911/' }]
  ]);
});

test('panel activation fails closed on the configured frontend', async () => {
  const storageWrites = [];
  const sent = [];
  let enforced = false;
  const activatePanelInTab = Function(
    'getStoredState',
    'getTab',
    'isInjectableTab',
    'sendTabMessage',
    'chrome',
    'getLiveActiveTabId',
    'minimizeTabPanel',
    'enforceSingleActivePanel',
    `return (${extractFunction(background, 'activatePanelInTab')});`
  )(
    async () => ({
      displayMode: 'floating',
      activeTabId: 7,
      webuiUrl: 'http://localhost:48911/'
    }),
    async () => ({ id: 7, url: 'http://127.0.0.1:48911/' }),
    () => false,
    async (tabId, message) => { sent.push([tabId, message]); },
    { storage: { local: { set: async (value) => { storageWrites.push(value); } } } },
    async () => 7,
    async () => {},
    async () => { enforced = true; }
  );

  assert.equal(await activatePanelInTab(7), false);
  assert.deepEqual(sent, [[7, { type: 'NEKO_FORCE_CLOSE' }]]);
  assert.deepEqual(storageWrites, [{
    activeTabId: null,
    minimized: true,
    avatarForm: 'cat',
    fullscreenFromCollapsedFloating: false
  }]);
  assert.equal(enforced, false);
});

test('a stale wake control removes itself on the configured frontend', async () => {
  let closed = 0;
  let messages = 0;
  let expanded = 0;
  const wakePanel = Function(
    'isConfiguredFrontendPage',
    'location',
    'closePanel',
    'chrome',
    'setAvatarForm',
    'setMinimized',
    'setTimeout',
    'webuiUrl',
    `return (${extractFunction(content, 'wakePanel')});`
  )(
    () => true,
    { href: 'http://127.0.0.1:48911/' },
    () => { closed += 1; },
    { runtime: { sendMessage: async () => { messages += 1; } } },
    () => {},
    () => { expanded += 1; },
    setTimeout,
    'http://localhost:48911/'
  );

  await wakePanel();

  assert.equal(closed, 1);
  assert.equal(messages, 0);
  assert.equal(expanded, 0);
});

test('wake control keeps its timeout fallback when the background does not respond', async () => {
  const minimizedCalls = [];
  const wakePanel = Function(
    'isConfiguredFrontendPage',
    'location',
    'closePanel',
    'chrome',
    'setAvatarForm',
    'setMinimized',
    'setTimeout',
    'webuiUrl',
    `return (${extractFunction(content, 'wakePanel')});`
  )(
    () => false,
    { href: 'https://example.com/' },
    () => {},
    { runtime: { sendMessage: () => new Promise(() => {}) } },
    () => {},
    (...args) => { minimizedCalls.push(args); },
    (callback) => { callback(); return 1; },
    'http://localhost:48911/'
  );

  await wakePanel();

  assert.deepEqual(minimizedCalls, [[false, true]]);
});

test('floating and side panel surfaces reload when the address changes', () => {
  assert.match(content, /message\.type === 'NEKO_APPLY_WEBUI_URL'/);
  assert.match(content, /function applyWebuiUrl/);
  assert.match(content, /unloadFrame\(\);\s*ensureFrameLoaded\(\);\s*checkHealth\(\);/);
  assert.match(sidepanel, /changes\.webuiUrl/);
  assert.match(sidepanel, /const urlChanged = nextUrl !== webuiUrl/);
  assert.match(sidepanel, /if \(urlChanged\) \{\s*unloadFrame\(\);/);
});

test('custom HTTP and HTTPS frames can load while adapters stay target-scoped', () => {
  assert.match(manifest.content_security_policy.extension_pages, /connect-src http: https:/);
  assert.match(manifest.content_security_policy.extension_pages, /frame-src http: https:/);

  const staticAdapter = manifest.content_scripts.find((entry) => (
    entry.js?.includes('transparent-page.js') || entry.world === 'MAIN'
  ));
  assert.equal(staticAdapter, undefined);
  assert.doesNotMatch(transparentPage, /createElement\(['"]script['"]\)/);

  for (const script of [transparentPage, transparentMainWorld]) {
    assert.match(script, /params\)\.get\('surface'\)|URLSearchParams\(location\.search\)\.get\('surface'\)/);
    assert.match(script, /isEmbeddedSurface/);
    assert.match(script, /isNativeSidePanel/);
    assert.match(script, /!isEmbeddedSurface && !isNativeSidePanel/);
  }
});
