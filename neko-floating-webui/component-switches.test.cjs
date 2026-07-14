const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const background = read('background.js');
const popupHtml = read('popup.html');
const popup = read('popup.js');
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

test('background normalizes, stores, and forwards component state', () => {
  assert.match(background, /surfaceComponents: SURFACE_COMPONENT_ORDER\.slice\(\)/);
  assert.match(background, /message\.type === 'NEKO_SET_SURFACE_COMPONENTS'/);
  assert.match(background, /chrome\.storage\.local\.set\(\{ surfaceComponents \}\)/);
  assert.match(background, /type: 'NEKO_APPLY_SURFACE_COMPONENTS'/);
  assert.match(background, /return SURFACE_COMPONENT_ORDER\.filter/);
});

test('floating toolbar exposes and persists the same component switches', () => {
  assert.match(content, /data-action="components"/);
  for (const component of components) {
    assert.match(content, new RegExp(`data-floating-surface-component="${component}"`));
  }
  assert.match(content, /function updateSurfaceComponentsFromFloatingPanel/);
  assert.match(content, /type: 'NEKO_SET_SURFACE_COMPONENTS'/);
  assert.match(content, /function syncSurfaceComponentControls/);
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
