const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const sidepanel = read('sidepanel.js');
const css = read('sidepanel.css');
const mainWorld = read('transparent-main-world.js');
const transparentCss = read('transparent-page.css');
const transparentPage = read('transparent-page.js');
const embeddedCss = read('embedded-surface.css');

test('side panel shell stays transparent instead of painting over the page', () => {
  assert.match(css, /:root[\s\S]*background: transparent/);
  assert.match(css, /html,\s*\nbody[\s\S]*background: transparent !important/);
  assert.match(css, /\.shell[\s\S]*background: transparent/);
  assert.match(css, /\.content[\s\S]*background: transparent/);
  assert.match(css, /#webui[\s\S]*color-scheme: inherit/);
});

test('dark mode styles only bounded controls and the offline state', () => {
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /--sidebar-toolbar: rgba\(15, 23, 42, 0\.96\)/);
  assert.match(css, /--sidebar-routes: rgba\(15, 23, 42, 0\.96\)/);
  assert.match(css, /--sidebar-offline: #0f172a/);
  assert.doesNotMatch(css, /--sidebar-surface/);
});

test('theme messaging cannot turn the entire extension surface opaque', () => {
  assert.doesNotMatch(sidepanel, /NEKO_SIDEBAR_THEME/);
  assert.doesNotMatch(mainWorld, /NEKO_SIDEBAR_THEME/);
  assert.match(transparentCss, /#react-chat-window-overlay[\s\S]*background: transparent !important/);
  assert.match(transparentCss, /color-scheme: light dark !important/);
  assert.match(transparentPage, /#react-chat-window-overlay/);
  assert.match(transparentPage, /setProperty\('color-scheme', 'light dark', 'important'\)/);
  assert.match(embeddedCss, /#react-chat-window-overlay[\s\S]*background: transparent !important/);
});
