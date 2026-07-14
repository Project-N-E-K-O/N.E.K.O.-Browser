const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const adapter = read('embedded-surface-main-world.js');
const css = read('embedded-surface.css');

test('the extension owns and injects the embedded surface adapter', () => {
  const localScripts = manifest.content_scripts.filter((entry) => (
    entry.matches.includes('http://localhost:48911/*')
  ));
  const isolated = localScripts.find((entry) => entry.js?.includes('transparent-page.js'));
  const mainWorld = localScripts.find((entry) => entry.world === 'MAIN');

  assert.ok(isolated?.css?.includes('embedded-surface.css'));
  assert.ok(mainWorld?.js?.includes('embedded-surface-main-world.js'));
  assert.equal(mainWorld.run_at, 'document_start');
  assert.equal(mainWorld.all_frames, true);
});

test('the adapter activates from the extension query marker without host globals', () => {
  assert.match(adapter, /params\.get\('surface'\)/);
  assert.match(adapter, /surface !== 'embed'/);
  assert.match(adapter, /params\.get\('components'\)/);
  assert.match(adapter, /document\.documentElement\.classList\.add\('neko-embedded-surface'\)/);
  assert.doesNotMatch(adapter, /__NEKO_EMBEDDED_SURFACE_CONFIG__/);
  assert.doesNotMatch(adapter, /COMPONENT_ALIASES/);
});

test('the adapter fixes chat size through the host chat surface API', () => {
  assert.match(adapter, /params\.get\('chat_mode'\)/);
  assert.match(adapter, /window\.reactChatWindowHost/);
  assert.match(adapter, /host\.getChatSurfaceMode\(\)/);
  assert.match(adapter, /host\.setChatSurfaceMode\(mode\)/);
  assert.match(adapter, /data\.type === 'NEKO_EMBED_SET_CHAT_MODE'/);
  assert.match(adapter, /window\.addEventListener\('chat-surface-mode-change'/);
  assert.match(adapter, /window\.requestAnimationFrame\(syncFixedChatMode\)/);
  assert.match(adapter, /fixedChatMode: true/);
  assert.match(adapter, /chatMode: fixedChatMode/);
});

test('component visibility and hit testing stay in extension-owned assets', () => {
  for (const component of ['avatar', 'chat', 'subtitle', 'controls', 'agent-hud', 'status']) {
    assert.ok(adapter.includes(`'${component}'`));
    assert.match(css, new RegExp(`data-neko-surface-${component}`));
  }

  for (const messageType of [
    'NEKO_EMBED_READY',
    'NEKO_EMBED_SET_COMPONENTS',
    'NEKO_EMBED_INTERACTIVE_REGIONS',
    'NEKO_EMBED_POINTER',
    'NEKO_EMBED_HIT_TEST'
  ]) {
    assert.match(adapter, new RegExp(messageType));
  }

  assert.match(adapter, /'#agent-task-hud-header'/);
  assert.match(css, /#agent-task-hud-header/);
});

test('danmaku subtitle bounds stay controllable while the host requests passthrough', () => {
  for (const selector of [
    '#subtitle-display',
    '#subtitle-panel-controls',
    '#subtitle-settings-btn',
    '.subtitle-panel-control-btn',
    '#subtitle-settings-panel',
    '.subtitle-resize-edge'
  ]) {
    assert.ok(adapter.includes(`'${selector}'`));
  }
  assert.match(adapter, /function acceptsPointerlessRegion/);
  assert.match(adapter, /function isDanmakuSubtitleDisplay/);
  assert.match(adapter, /element\.dataset\.subtitleDanmakuActive === 'true'/);
  assert.match(adapter, /document\.getElementById\('subtitle-danmaku-mode-btn'\)/);
  assert.match(adapter, /settings\.subtitleDanmakuMode === true/);
  assert.match(adapter, /style\.pointerEvents === 'none' && !acceptsPointerlessRegion\(component, element\)/);
  assert.match(adapter, /'data-subtitle-danmaku-active'/);
  assert.match(adapter, /'data-subtitle-panel-state'/);
  assert.match(adapter, /'data-subtitle-interaction-passthrough'/);
});
