const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const sidepanelHtml = read('sidepanel.html');
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
  assert.match(css, /--sidebar-toolbar: rgba\(15, 23, 42, 0\.98\)/);
  assert.match(css, /--sidebar-routes: #111c2b/);
  assert.match(css, /--sidebar-offline: #0f172a/);
  assert.doesNotMatch(css, /--sidebar-surface/);
});

test('side panel title bar matches the floating toolbar and opens a menu overlay', () => {
  assert.match(sidepanelHtml, /class="brand-title">N\.E\.K\.O</);
  assert.match(sidepanelHtml, /class="brand-state"[\s\S]*?<span>WebUI<\/span>/);
  assert.match(sidepanelHtml, /data-action="routes"[\s\S]*?title="菜单"[\s\S]*?aria-controls="routes"[\s\S]*?aria-expanded="false"/);
  assert.match(sidepanelHtml, /id="routes" aria-label="菜单"/);
  assert.doesNotMatch(sidepanelHtml, /role="menu(?:item)?"|aria-haspopup="menu"/);
  assert.match(sidepanelHtml, /class="routes-head"[\s\S]*?<span>菜单<\/span>/);
  assert.doesNotMatch(sidepanelHtml, /入口|>↻<|>☰<|>↗</);

  assert.match(css, /\.shell\s*\{[\s\S]*?grid-template-rows: 46px minmax\(0, 1fr\)/);
  assert.match(css, /\.toolbar\s*\{[\s\S]*?linear-gradient/);
  assert.match(css, /\.actions button svg\s*\{[\s\S]*?stroke-width: 1\.8/);
  assert.match(css, /\.routes\s*\{[\s\S]*?position: absolute[\s\S]*?top: 52px/);
  assert.match(css, /\.routes\s*\{[\s\S]*?max-height: calc\(100% - 60px\)/);
  assert.match(css, /\.routes-list\s*\{[\s\S]*?overflow-y: auto/);
  assert.doesNotMatch(css, /\.shell\[data-routes-open="true"\]/);

  assert.match(sidepanel, /menuButton\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(sidepanel, /event\.key === 'Escape'[\s\S]*?setRoutesOpen\(false, \{ restoreFocus: true \}\)/);
  assert.match(sidepanel, /options\.restoreFocus === true[\s\S]*?menuButton\.focus\(\{ preventScroll: true \}\)/);
  const frameLoadHandler = sidepanel.match(
    /frame\.addEventListener\('load', \(\) => \{([\s\S]*?)\n  \}\);/
  );
  assert.ok(frameLoadHandler, 'missing side panel iframe load handler');
  assert.match(frameLoadHandler[1], /scheduleSidePanelTheme\(\)/);
  assert.match(frameLoadHandler[1], /scheduleWebuiReflow\(\)/);
  const menuAction = sidepanel.match(
    /if \(action === 'routes'\) \{([\s\S]*?)\n    \}/
  );
  assert.ok(menuAction, 'missing side panel menu action');
  assert.match(menuAction[1], /const shouldOpen = routesEl\.hidden/);
  assert.match(menuAction[1], /setRoutesOpen\(shouldOpen, \{[\s\S]*?restoreFocus:/);
  assert.doesNotMatch(menuAction[1], /scheduleWebuiReflow/);
});

test('side panel applies the browser theme inside WebUI without persisting it', () => {
  assert.match(sidepanel, /matchMedia\?\.\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(sidepanel, /preferredColorScheme\?\.addEventListener\('change', scheduleSidePanelTheme\)/);
  assert.match(sidepanel, /frame\.contentWindow\.postMessage\(\{[\s\S]*?type: 'NEKO_SIDEBAR_THEME'[\s\S]*?theme[\s\S]*?getWebuiOrigin\(\)/);
  assert.match(sidepanel, /const generation = \+\+themeSyncGeneration/);
  assert.match(sidepanel, /generation !== themeSyncGeneration \|\| !isOwner \|\| !frame\.contentWindow/);
  assert.doesNotMatch(sidepanel, /frame\.style\.setProperty\('color-scheme'/);

  assert.match(transparentPage, /event\.data\.type === SIDEPANEL_THEME_MESSAGE[\s\S]*?NEKO_SIDEBAR_THEME_APPLY[\s\S]*?_sender: 'isolated'/);
  assert.match(mainWorld, /event\.data\.type === 'NEKO_SIDEBAR_THEME_APPLY'/);
  assert.match(mainWorld, /event\.data\._sender === 'isolated'/);
  assert.match(mainWorld, /window\.nekoTheme\.apply\(isDark, \{ persist: false \}\)/);
  assert.doesNotMatch(mainWorld, /localStorage\.setItem\(['"]neko-dark-mode/);
  assert.match(transparentCss, /#react-chat-window-overlay[\s\S]*background: transparent !important/);
  assert.match(transparentCss, /color-scheme: light dark !important/);
  assert.match(transparentPage, /#react-chat-window-overlay/);
  assert.match(transparentPage, /setProperty\('color-scheme', 'light dark', 'important'\)/);
  assert.match(embeddedCss, /#react-chat-window-overlay[\s\S]*background: transparent !important/);
});
