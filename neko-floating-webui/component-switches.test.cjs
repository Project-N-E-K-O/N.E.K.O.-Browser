const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const background = read('background.js');
const popupHtml = read('popup.html');
const popup = read('popup.js');
const popupCss = read('popup.css');
const content = read('content.js');

const components = ['avatar', 'chat', 'subtitle', 'controls', 'agent-hud', 'status'];

test('popup exposes one checkbox for every canonical surface component', () => {
  for (const component of components) {
    assert.match(popupHtml, new RegExp(`data-surface-component="${component}"`));
  }
  assert.doesNotMatch(popupHtml, /data-surface-component="(?:agent|agenthud|hud|task-hud)"/);
  assert.match(popupHtml, /<h3>界面组件<\/h3>/);
  assert.match(popupHtml, /当前浮窗或全屏页面/);
});

test('popup persists component changes without closing itself', () => {
  assert.match(popup, /type: 'NEKO_SET_SURFACE_COMPONENTS'/);
  assert.match(popup, /surfaceComponents: next/);
  assert.match(popup, /currentComponents = normalizeSurfaceComponents/);
  assert.match(popup, /当前浮窗页面/);
  assert.match(popup, /当前全屏页面/);
});

test('display mode selector slides its indicator and stays open after switching', () => {
  assert.match(popupHtml, /class="modes" data-active-mode="floating"/);
  assert.match(popupHtml, /class="modes-indicator"/);
  assert.match(popup, /modesEl\.dataset\.activeMode = currentMode/);
  assert.match(popupCss, /\.modes\.is-ready \.modes-indicator/);
  assert.match(popupCss, /translateX\(calc\(200% \+ 8px\)\)/);

  const modeClickMarker = popup.indexOf("btn.addEventListener('click'");
  const modeHandlerStart = popup.lastIndexOf('modeButtons.forEach', modeClickMarker);
  const modeHandlerEnd = popup.indexOf("toggleButton.addEventListener", modeHandlerStart);
  const modeHandler = popup.slice(modeHandlerStart, modeHandlerEnd);
  assert.ok(modeClickMarker >= 0 && modeHandlerStart >= 0 && modeHandlerEnd > modeHandlerStart);
  assert.match(modeHandler, /currentMode = mode/);
  assert.doesNotMatch(modeHandler, /window\.close\(\)/);
});

test('feature panels use a simple hover lift on fine pointers', () => {
  assert.match(popup, /setupPanelHover\(\)/);
  assert.match(popup, /matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/);
  assert.match(popupCss, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(popupCss, /\.section-hover-zone:hover \.section/);
  assert.match(popupCss, /--panel-lift: -3px/);
  assert.match(popupCss, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(popupCss, /rotate[XY]\(|perspective\(/);
  assert.doesNotMatch(popup, /pointermove|--panel-rotate/);
});

test('panel hover uses a stationary zone instead of its shifted bounds', () => {
  assert.match(popup, /hoverZone\.className = 'section-hover-zone'/);
  assert.match(popup, /section\.parentNode\.insertBefore\(hoverZone, section\)/);
  assert.match(popupCss, /\.section-hover-zone/);
});

test('popup uses a compact single-row title bar', () => {
  assert.match(popupHtml, /<header class="hero">/);
  assert.match(popupHtml, /<h1>浏览器伴侣<\/h1>/);
  assert.match(popupHtml, /<div class="hero-meta" title="WebUI 快捷控制">/);
  assert.doesNotMatch(popupHtml, /hero-logo|hero-paws|hero-badge/);
  assert.match(popupCss, /\.hero \{[\s\S]*display: flex;[\s\S]*min-height: 54px;/);
  assert.match(popupCss, /\.hero::before \{[\s\S]*url\("assets\/ui\/icon_systray\.ico"\)/);
  assert.match(popupCss, /\.hero::before \{[\s\S]*opacity: 0\.52;/);
  assert.doesNotMatch(popupCss, /\.hero-brand \{[^}]*margin-left:/);
  assert.doesNotMatch(popupCss, /\.hero-logo|\.hero::after|\.hero-paws|\.hero-badge/);
});

test('background normalizes, stores, and forwards component state', () => {
  assert.match(background, /surfaceComponents: SURFACE_COMPONENT_ORDER\.slice\(\)/);
  assert.match(background, /message\.type === 'NEKO_SET_SURFACE_COMPONENTS'/);
  assert.match(background, /chrome\.storage\.local\.set\(\{ surfaceComponents \}\)/);
  assert.match(background, /type: 'NEKO_APPLY_SURFACE_COMPONENTS'/);
  assert.match(background, /return SURFACE_COMPONENT_ORDER\.filter/);
});

test('component switches live only in the popup instead of the floating toolbar', () => {
  assert.doesNotMatch(content, /data-action="components"/);
  assert.doesNotMatch(content, /data-floating-surface-component/);
  assert.doesNotMatch(content, /function updateSurfaceComponentsFromFloatingPanel/);
  assert.match(content, /message\.type === 'NEKO_APPLY_SURFACE_COMPONENTS'/);
});

test('popup can persist a fixed compact or full chat surface mode', () => {
  for (const [value, label] of [
    ['auto', '跟随页面'],
    ['compact', '固定小聊天框'],
    ['full', '固定大聊天框']
  ]) {
    assert.match(popupHtml, new RegExp(`<option value="${value}">${label}</option>`));
  }

  assert.match(popup, /type: 'NEKO_SET_CHAT_SURFACE_MODE'/);
  assert.match(popup, /chatSurfaceMode: normalizeChatSurfaceMode/);
  assert.match(background, /chatSurfaceMode: 'auto'/);
  assert.match(background, /message\.type === 'NEKO_SET_CHAT_SURFACE_MODE'/);
  assert.match(background, /chrome\.storage\.local\.set\(\{ chatSurfaceMode \}\)/);
  assert.match(background, /type: 'NEKO_APPLY_CHAT_SURFACE_MODE'/);
  assert.match(content, /message\.type === 'NEKO_APPLY_CHAT_SURFACE_MODE'/);
  assert.match(content, /type: 'NEKO_EMBED_SET_CHAT_MODE'/);
});
