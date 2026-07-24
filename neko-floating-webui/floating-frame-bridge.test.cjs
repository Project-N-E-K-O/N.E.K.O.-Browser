const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
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
  assert.match(bridge, /frame\.contentWindow\.postMessage\(data, targetOrigin/);
  assert.match(bridge, /window\.parent\.postMessage\(data, parentOrigin/);
});

test('the bridge transfers the microphone port instead of cloning it', () => {
  assert.match(content, /postFrameBridgeMessage\(\{[\s\S]*?type: 'NEKO_PCM_PORT'[\s\S]*?\}, \[channel\.port2\]\)/);
  assert.match(bridge, /Array\.from\(event\.ports \|\| \[\]\)/);
  assert.match(bridge, /data\.type\.startsWith\('NEKO_PCM_'\) && data\._sender === 'floating'/);
});
