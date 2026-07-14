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
