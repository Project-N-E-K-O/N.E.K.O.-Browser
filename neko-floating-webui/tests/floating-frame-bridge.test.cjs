const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(projectRoot, name), 'utf8');
const manifest = JSON.parse(read('src/manifest-base.json'));
const background = read('background.js');
const content = read('content.js');
const bridgeHtml = read('floating-frame.html');
const bridgeCss = read('floating-frame.css');
const bridge = read('floating-frame.js');

test('floating surfaces navigate to an extension bridge instead of the WebUI origin', () => {
  const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources || []);
  assert.ok(resources.includes('floating-frame.html'));
  assert.match(content, /chrome\.runtime\.getURL\('floating-frame\.html'\)/);
  assert.match(content, /frame\.src = FRAME_BRIDGE_URL/);
  assert.match(content, /targetUrl: getFrameTargetUrl\(\)/);
  assert.doesNotMatch(content, /frame\.src = getFrameTargetUrl\(\)/);
});

test('the bridge owns the WebUI iframe and remains transparent', () => {
  assert.match(bridgeHtml, /<iframe[\s\S]*?id="webui"/);
  assert.match(bridgeHtml, /allow="[^"]*microphone \*/);
  assert.match(bridgeHtml, /src="floating-frame\.js"/);
  assert.match(bridgeCss, /background:\s*transparent/);
  assert.match(bridgeCss, /color-scheme:\s*inherit/);
});

test('the bridge validates configured targets and both relay directions', () => {
  assert.match(bridge, /event\.source === window\.parent/);
  assert.match(bridge, /event\.source === frame\.contentWindow/);
  assert.match(bridge, /event\.origin !== parentOrigin/);
  assert.match(bridge, /event\.origin !== targetOrigin/);
  assert.match(bridge, /type: 'NEKO_GET_STATE'/);
  assert.match(bridge, /candidate\.origin !== configured\.origin/);
  assert.match(bridge, /candidate\.pathname !== configured\.pathname/);
  assert.match(bridge, /frame\.contentWindow\.postMessage\(payload, targetOrigin/);
  assert.match(bridge, /window\.parent\.postMessage\(data, parentOrigin/);
});

test('the first bridge load is authenticated with an extension-owned session token', () => {
  assert.match(background, /message\.type === 'NEKO_GET_FRAME_BRIDGE_TOKEN'/);
  assert.match(background, /chrome\.storage\.session\.get\(FRAME_BRIDGE_TOKEN_KEY\)/);
  assert.match(background, /crypto\.randomUUID\(\)/);
  assert.match(content, /type: 'NEKO_GET_FRAME_BRIDGE_TOKEN'/);
  assert.match(content, /bridgeToken: frameBridgeToken/);
  assert.match(bridge, /type: 'NEKO_GET_FRAME_BRIDGE_TOKEN'/);

  const handlerStart = bridge.indexOf('function handleParentMessage');
  const handlerEnd = bridge.indexOf('function handleWebuiMessage', handlerStart);
  const handler = bridge.slice(handlerStart, handlerEnd);
  const tokenCheck = handler.indexOf('data.bridgeToken !== bridgeToken');
  const trustAssignment = handler.indexOf('parentOrigin = event.origin');
  assert.notEqual(tokenCheck, -1);
  assert.notEqual(trustAssignment, -1);
  assert.ok(tokenCheck < trustAssignment, 'the token must be checked before trusting the first parent');
  assert.match(handler, /delete payload\.bridgeToken/);
});

test('the bridge transfers the microphone port instead of cloning it', () => {
  assert.match(content, /postFrameBridgeMessage\(\{[\s\S]*?type: 'NEKO_PCM_PORT'[\s\S]*?\}, \[channel\.port2\]\)/);
  assert.match(bridge, /Array\.from\(event\.ports \|\| \[\]\)/);
  assert.match(bridge, /data\.type\.startsWith\('NEKO_PCM_'\) && data\._sender === 'floating'/);
});

test('fullscreen loads are health-gated before the WebUI iframe navigates', () => {
  assert.match(content, /requireOnline: displayMode === 'fullscreen'/);
  assert.match(bridge, /loadAllowedTarget\(data\.targetUrl, data\.requireOnline === true\)/);

  const loadStart = bridge.indexOf('async function loadAllowedTarget');
  const loadEnd = bridge.indexOf('async function initialize', loadStart);
  const loadBlock = bridge.slice(loadStart, loadEnd);
  const healthCheck = loadBlock.indexOf('checkHealthWithTimeout()');
  const navigation = loadBlock.indexOf('frame.src = targetUrl');
  assert.notEqual(healthCheck, -1);
  assert.notEqual(navigation, -1);
  assert.ok(healthCheck < navigation, 'health must be checked before navigating the WebUI iframe');
  assert.match(loadBlock, /NEKO_FLOATING_FRAME_OFFLINE/);
  assert.match(loadBlock, /frame\.src = 'about:blank'/);
});

test('the fullscreen health gate times out to the offline fallback', () => {
  assert.match(bridge, /const HEALTH_GATE_TIMEOUT_MS = 4000/);
  assert.match(bridge, /const health = await checkHealthWithTimeout\(\)/);

  const timeoutStart = bridge.indexOf('async function checkHealthWithTimeout');
  const timeoutEnd = bridge.indexOf('async function resolveAllowedTarget', timeoutStart);
  const timeoutBlock = bridge.slice(timeoutStart, timeoutEnd);
  assert.match(timeoutBlock, /Promise\.race\(/);
  assert.match(timeoutBlock, /type: 'NEKO_HEALTH_CHECK'/);
  assert.match(timeoutBlock, /window\.setTimeout\([\s\S]*?HEALTH_GATE_TIMEOUT_MS/);
  assert.match(timeoutBlock, /window\.clearTimeout\(timeoutId\)/);
});

test('the parent can clear an offline WebUI document without unloading the bridge', () => {
  assert.match(content, /type: 'NEKO_FLOATING_FRAME_CLEAR'/);
  assert.match(bridge, /data\.type === 'NEKO_FLOATING_FRAME_CLEAR'/);
  assert.match(bridge, /function clearWebui\(\)[\s\S]*?frame\.src = 'about:blank'/);
});

test('an existing floating document is health-gated before fullscreen reveals it', () => {
  assert.match(content, /type: 'NEKO_FLOATING_FRAME_VERIFY'/);
  assert.match(bridge, /data\.type === 'NEKO_FLOATING_FRAME_VERIFY'/);

  const verifyStart = bridge.indexOf('async function verifyLoadedTarget');
  const verifyEnd = bridge.indexOf('async function initialize', verifyStart);
  const verifyBlock = bridge.slice(verifyStart, verifyEnd);
  const healthCheck = verifyBlock.indexOf('checkHealthWithTimeout()');
  const verified = verifyBlock.indexOf("postToParent('NEKO_FLOATING_FRAME_VERIFIED'");
  assert.notEqual(healthCheck, -1);
  assert.notEqual(verified, -1);
  assert.ok(healthCheck < verified, 'the existing frame must pass health verification before reveal');
  assert.match(verifyBlock, /NEKO_FLOATING_FRAME_OFFLINE/);
  assert.match(verifyBlock, /frame\.src = 'about:blank'/);
});
