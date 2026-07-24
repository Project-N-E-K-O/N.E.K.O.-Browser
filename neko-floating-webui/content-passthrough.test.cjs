const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
  assert.notEqual(end, -1, `missing ${nextName}`);
  return source.slice(start, end);
}

test('floating and fullscreen load the embedded surface with explicit components', () => {
  const block = functionBlock('getFrameTargetUrl', 'isEmbeddedSurfaceActive');
  assert.match(block, /isEmbeddedDisplayMode\(displayMode\)/);
  assert.match(block, /searchParams\.set\('surface', 'embed'\)/);
  assert.match(block, /surfaceComponents\.join\(','\)/);
  assert.match(block, /surfaceComponents\.length[\s\S]*?'none'/);
  assert.match(block, /searchParams\.set\('chat_mode', chatSurfaceMode\)/);
  for (const component of ['avatar', 'chat', 'subtitle', 'controls', 'agent-hud', 'status']) {
    assert.match(source, new RegExp(`'${component.replace('-', '\\-')}'`));
  }
});

test('fixed chat mode is included in both initial URL and live embed messages', () => {
  const connectBlock = functionBlock('sendEmbedConnect', 'postEmbedMessage');
  assert.match(connectBlock, /chatMode: chatSurfaceMode/);
  const applyBlock = functionBlock('applyChatSurfaceMode', 'canInjectHere');
  assert.match(applyBlock, /normalizeChatSurfaceMode\(value\)/);
  assert.match(applyBlock, /isEmbeddedSurfaceActive\(\) && embedReady/);
  assert.match(applyBlock, /type: 'NEKO_EMBED_SET_CHAT_MODE'/);
  assert.match(applyBlock, /chatMode: chatSurfaceMode/);
});

test('component switches use strict canonical names and update a live embed', () => {
  assert.match(source, /const EMBED_SURFACE_COMPONENT_ORDER = Object\.freeze/);
  assert.match(source, /message\.type === 'NEKO_APPLY_SURFACE_COMPONENTS'/);
  assert.match(source, /type: 'NEKO_EMBED_SET_COMPONENTS'/);
  assert.match(source, /components: surfaceComponents\.slice\(\)/);
  assert.match(source, /isEmbeddedSurfaceActive\(\) && embedReady/);
  const activeBlock = functionBlock('isEmbeddedSurfaceActive', 'isEmbedPassthroughActive');
  assert.match(activeBlock, /isEmbeddedDisplayMode\(displayMode\)/);
  const loadBlock = functionBlock('ensureFrameLoaded', 'unloadFrame');
  assert.match(loadBlock, /!embedReady && isEmbeddedSurfaceActive\(\)/);
  assert.match(loadBlock, /startEmbeddedSurfaceHandshake\(\)/);
});

test('the floating toolbar opens a menu overlay without resizing the WebUI', () => {
  assert.match(source, /title="菜单"[\s\S]*?aria-label="菜单"/);
  assert.doesNotMatch(source, /title="入口"|aria-label="入口"/);
  assert.match(source, /grid-template-rows: 46px minmax\(0, 1fr\)/);
  assert.doesNotMatch(
    source,
    /data-routes-open="true"\][\s\S]{0,120}grid-template-rows/
  );
  assert.match(
    source,
    /\.routes\s*\{[\s\S]*?position: absolute;[\s\S]*?z-index: 10;/
  );
  assert.match(source, /\.route-mark svg\s*\{/);
  assert.doesNotMatch(
    source,
    /class="route-mark"[^>]*>(主|聊|模|钥|忆)</
  );
  assert.match(source, /\.content\s*\{[\s\S]*?grid-row: 2;/);

  const actionBlock = functionBlock('handleAction', 'setRoutesOpen');
  const menuAction = actionBlock.match(
    /if \(action === 'routes'\) \{([\s\S]*?)\n    \}/
  );
  assert.ok(menuAction, 'missing menu action');
  assert.match(menuAction[1], /setRoutesOpen/);
  assert.doesNotMatch(menuAction[1], /scheduleWebuiReflow/);

  const menuBlock = functionBlock('setRoutesOpen', 'openRoute');
  assert.match(menuBlock, /routesEl\.hidden = !open/);
  assert.match(menuBlock, /setAttribute\('aria-expanded', String\(open\)\)/);
  const routeBlock = functionBlock('openRoute', 'isFrameReadyForWebui');
  assert.match(routeBlock, /setRoutesOpen\(false\)/);
});

test('the floating toolbar action group keeps a stable cursor and never starts panel dragging', () => {
  assert.match(source, /\.actions\s*\{[\s\S]*?cursor:\s*pointer/);

  const block = functionBlock('bindToolbarDrag', 'endToolbarDrag');
  assert.match(block, /event\.target\.closest\('\.actions'\)/);
});

test('fullscreen iframe is click-through until an interactive region is selected', () => {
  assert.match(source, /data-display-mode="fullscreen"\]\s+#\$\{FRAME_ID\}[\s\S]*?pointer-events: none !important/);
  assert.match(source, /data-embed-interactive="true"[\s\S]*?pointer-events: auto !important/);
  assert.match(source, /findEmbedRegionAtPoint\(point\.x, point\.y\)/);
  assert.match(source, /setFrameInteractive\(Boolean\(region\), reason\)/);
  const pointerBlock = functionBlock('handleHostPointerMove', 'updateFrameInteractionFromLastPointer');
  assert.ok(
    pointerBlock.indexOf('lastHostPointer =') < pointerBlock.indexOf('!isEmbedPassthroughActive()'),
    'the last host pointer must be remembered before fullscreen starts'
  );
});

test('embedded iframe inherits the page color scheme to preserve dark-page transparency', () => {
  assert.match(source, /:host\s*\{[\s\S]*?color-scheme:\s*inherit/);
  assert.match(source, /#\$\{FRAME_ID\}\s*\{[\s\S]*?color-scheme:\s*inherit/);
  const resolveBlock = functionBlock('resolveEmbeddingColorScheme', 'syncFrameColorScheme');
  assert.match(resolveBlock, /getComputedStyle\(element\)\.colorScheme/);
  assert.match(resolveBlock, /value !== 'normal'/);
  assert.match(resolveBlock, /return 'light';/);
  const syncBlock = functionBlock('syncFrameColorScheme', 'applyPanelMessage');
  assert.match(syncBlock, /host\?\.style\.setProperty\('color-scheme', scheme\)/);
  assert.match(syncBlock, /frame\.style\.setProperty\('color-scheme', scheme\)/);
  assert.match(source, /embeddingColorSchemeMedia\?\.addEventListener\('change', syncFrameColorScheme\)/);
  assert.match(source, /new MutationObserver\(syncFrameColorScheme\)/);
});

test('embedded pointer relay locks interaction for the full drag lifetime', () => {
  const block = functionBlock('handleEmbeddedPointer', 'createHost');
  assert.match(block, /phase === 'down'[\s\S]*?embedPointerLock = pointerId/);
  assert.match(block, /phase === 'up' \|\| phase === 'cancel' \|\| phase === 'leave'/);
  assert.match(block, /embedPointerLock = null/);
  const releaseIndex = block.indexOf("phase === 'up'");
  const buttonsIndex = block.indexOf('Number(data.buttons) > 0');
  assert.ok(releaseIndex < buttonsIndex, 'cancel/leave must release even when buttons is non-zero');
  assert.match(block, /embedPointerLock !== null && Number\(data\.buttons\) === 0/);
});

test('a missing or incompatible injected adapter falls back to an interactive iframe', () => {
  const block = functionBlock('startEmbeddedSurfaceHandshake', 'sendEmbedConnect');
  assert.match(block, /EMBED_PROTOCOL_FALLBACK_MS/);
  assert.match(block, /!isEmbeddedSurfaceActive\(\) \|\| embedReady/);
  assert.match(block, /setFrameInteractive\(true, 'legacy-fallback'\)/);
});

test('messages are restricted to the current WebUI frame and origin', () => {
  assert.match(source, /event\.source !== frame\.contentWindow/);
  assert.match(source, /event\.origin !== getWebuiOrigin\(\)/);
  assert.match(source, /data\._sender === 'neko-embedded-surface'/);
});
