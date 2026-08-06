const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
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
  assert.match(background, /chrome\.storage\.local\.set\(\{ webuiUrl \}\)/);
  assert.match(background, /type: 'NEKO_APPLY_WEBUI_URL'/);
  assert.match(background, /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/);
  assert.match(background, /parsed\.username \|\| parsed\.password/);
  assert.match(background, /page\.origin !== frontend\.origin/);
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

  const isolated = manifest.content_scripts.find((entry) => entry.js?.includes('transparent-page.js'));
  const mainWorld = manifest.content_scripts.find((entry) => entry.js?.includes('transparent-main-world.js'));
  for (const entry of [isolated, mainWorld]) {
    assert.ok(entry.matches.includes('http://*/*'));
    assert.ok(entry.matches.includes('https://*/*'));
    assert.equal(entry.all_frames, true);
  }

  for (const script of [transparentPage, transparentMainWorld]) {
    assert.match(script, /params\)\.get\('surface'\)|URLSearchParams\(location\.search\)\.get\('surface'\)/);
    assert.match(script, /isEmbeddedSurface/);
    assert.match(script, /isNativeSidePanel/);
    assert.match(script, /!isEmbeddedSurface && !isNativeSidePanel/);
  }
});
