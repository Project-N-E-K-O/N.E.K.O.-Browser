const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
const background = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');

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

test('manual reload stays inside the extension frame bridge', () => {
  const block = functionBlock('handleAction', 'setRoutesOpen');
  assert.match(block, /resetEmbedPassthrough\('manual-reload'\)/);
  assert.match(block, /type: 'NEKO_FLOATING_FRAME_RELOAD'/);
  assert.match(block, /reloadFrameBridge\(\)/);
  assert.doesNotMatch(block, /frame\.src\s*=\s*getFrameTargetUrl\(\)/);
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
  const interactionBlock = functionBlock(
    'updateFrameInteractionFromLastPointer',
    'setFrameInteractive'
  );
  assert.match(
    interactionBlock,
    /model-bounds[\s\S]*?pointInConservativeEmbedModelBounds[\s\S]*?setFrameInteractive\([\s\S]*?requestEmbedHitTest/
  );
  assert.ok(
    interactionBlock.indexOf('setFrameInteractive(')
      < interactionBlock.indexOf('requestEmbedHitTest('),
    'the narrow 3D model region must activate before its asynchronous confirmation'
  );
  const conservativeBlock = functionBlock(
    'pointInConservativeEmbedModelBounds',
    'updateFrameInteractionFromLastPointer'
  );
  assert.match(conservativeBlock, /halfWidth[\s\S]*?\* 0\.5 \* 0\.4/);
  assert.match(conservativeBlock, /halfHeight[\s\S]*?\* 0\.5 \* 0\.9/);
  const pointerBlock = functionBlock('handleHostPointerMove', 'scheduleEmbedRegionRefresh');
  assert.ok(
    pointerBlock.indexOf('lastHostPointer =') < pointerBlock.indexOf('!isEmbedPassthroughActive()'),
    'the last host pointer must be remembered before fullscreen starts'
  );
});

test('3D hit tests are coalesced to one in-flight request', () => {
  const requestBlock = functionBlock('requestEmbedHitTest', 'scheduleEmbedHitTest');
  assert.match(requestBlock, /queuedEmbedHitTest =/);
  assert.doesNotMatch(requestBlock, /postEmbedMessage/);

  const scheduleBlock = functionBlock('scheduleEmbedHitTest', 'cancelEmbedHitTests');
  assert.match(scheduleBlock, /window\.requestAnimationFrame/);
  assert.match(scheduleBlock, /pendingEmbedHitTest \|\| !queuedEmbedHitTest/);
  assert.match(scheduleBlock, /const sent = postEmbedMessage/);
  assert.match(scheduleBlock, /if \(!sent\)[\s\S]*?setFrameInteractive\(false, 'model-hit-test-unavailable'\)/);
  assert.ok(
    scheduleBlock.indexOf('const sent = postEmbedMessage')
      < scheduleBlock.indexOf('pendingEmbedHitTest ='),
    'a hit test must only become pending after the bridge accepts it'
  );
  assert.match(scheduleBlock, /window\.setTimeout\([\s\S]*?model-hit-test-timeout[\s\S]*?EMBED_HIT_TEST_TIMEOUT_MS/);

  const cancelBlock = functionBlock('cancelEmbedHitTests', 'handleEmbedHitTestResult');
  assert.match(cancelBlock, /window\.clearTimeout\(embedHitTestTimeout\)/);

  const resultBlock = functionBlock('handleEmbedHitTestResult', 'handleEmbeddedPointer');
  assert.match(resultBlock, /pendingEmbedHitTest = null/);
  assert.match(resultBlock, /window\.clearTimeout\(embedHitTestTimeout\)/);
  assert.match(
    resultBlock,
    /Math\.abs\(lastHostPointer\.y - pending\.hostY\) > 1[\s\S]*?requestEmbedHitTest\(point\.x, point\.y, lastHostPointer\)/
  );
  assert.ok(
    resultBlock.indexOf('pendingEmbedHitTest = null')
      < resultBlock.indexOf('embedPointerLock !== null'),
    'a matching result must release the in-flight slot even if dragging has started'
  );

  const postBlock = functionBlock('postEmbedMessage', 'handleEmbedMessage');
  assert.match(postBlock, /return false/);
  assert.match(postBlock, /return postFrameBridgeMessage\(payload\)/);
  assert.match(source, /NEKO_FLOATING_FRAME_ERROR[\s\S]*?resetEmbedPassthrough\('frame-error'\)/);
});

test('passthrough pointer movement refreshes embedded regions at bounded cadence', () => {
  const hostPointerBlock = functionBlock('handleHostPointerMove', 'scheduleEmbedRegionRefresh');
  assert.match(hostPointerBlock, /scheduleEmbedRegionRefresh\(\)/);

  const refreshBlock = functionBlock('scheduleEmbedRegionRefresh', 'updateFrameInteractionFromLastPointer');
  assert.match(refreshBlock, /EMBED_REGION_REFRESH_MS/);
  assert.match(refreshBlock, /embedRegionRefreshTimer/);
  assert.match(refreshBlock, /window\.setTimeout/);
  assert.match(refreshBlock, /NEKO_EMBED_GET_REGIONS/);

  const resetBlock = functionBlock('resetEmbedPassthrough', 'startEmbeddedSurfaceHandshake');
  assert.match(
    resetBlock,
    /embedRegionRefreshTimer[\s\S]*?window\.clearTimeout\(embedRegionRefreshTimer\)[\s\S]*?embedRegionRefreshTimer = 0/
  );
  assert.match(resetBlock, /lastEmbedRegionRefreshAt = 0/);
});

test('fullscreen uses the embedded avatar without a separate extension wake button', () => {
  assert.match(
    source,
    /data-display-mode="fullscreen"\]\s+#\$\{WAKE_ID\}\s*\{\s*display: none !important/
  );
  const dragBlock = functionBlock('startWakeDrag', 'moveWakeDrag');
  assert.match(dragBlock, /displayMode === 'fullscreen'/);
  assert.doesNotMatch(source, /wakeFullscreen/);
});

test('the collapsed cat uses a normal click event while dragging suppresses accidental clicks', () => {
  assert.match(source, /wakeButton\.addEventListener\('click', handleWakeClick\)/);
  const clickBlock = functionBlock('handleWakeClick', 'closePanel');
  assert.match(clickBlock, /panel\?\.dataset\.minimized === 'true'/);
  assert.match(clickBlock, /wakePanel\(\)/);
  const endDragBlock = functionBlock('endWakeDrag', 'handleWakeClick');
  assert.match(endDragBlock, /suppressWakeClick = true/);
  assert.doesNotMatch(endDragBlock, /wakePanel\(\)/);
});

test('a new content runtime replaces stale panel DOM left by an extension reload', () => {
  assert.match(source, /const CONTENT_RUNTIME_ID =/);
  const ensureBlock = functionBlock('ensurePanel', 'bindActions');
  assert.match(
    ensureBlock,
    /existingHost\.dataset\.nekoContentRuntimeId !== CONTENT_RUNTIME_ID/
  );
  assert.match(ensureBlock, /existingHost\.remove\(\)/);
  const hostBlock = functionBlock('createHost', 'resolveEmbeddingColorScheme');
  assert.match(hostBlock, /nextHost\.dataset\.nekoContentRuntimeId = CONTENT_RUNTIME_ID/);
});

test('switching between floating and fullscreen reflows the live WebUI without reloading it', () => {
  const block = functionBlock('applyDisplayMode', 'ensurePanel');
  assert.match(block, /previousMode !== mode/);
  assert.match(block, /requestAnimationFrame/);
  assert.match(block, /scheduleWebuiReflow\(\)/);
  assert.doesNotMatch(block, /reloadFrameBridge|NEKO_FLOATING_FRAME_RELOAD/);

  const reflowBlock = functionBlock('scheduleWebuiReflow', 'checkHealth');
  assert.match(reflowBlock, /\[0, 240, 1200\]/);
  assert.match(reflowBlock, /force: true/);
  assert.doesNotMatch(reflowBlock, /force: delay === 0/);
});

test('expanded floating panels cannot cross the left or top viewport edge', () => {
  const block = functionBlock('normalizePanel', 'clampMinimizedPanelPosition').trim();
  const normalizePanel = new Function(
    'MIN_SIZE',
    'DEFAULT_STATE',
    'window',
    `${block}; return normalizePanel;`
  )(
    { width: 320, height: 420 },
    { panel: { width: 420, height: 680, right: 24, bottom: 24 } },
    { innerWidth: 800, innerHeight: 600 }
  );

  assert.deepEqual(normalizePanel({
    width: 420,
    height: 500,
    right: 9999,
    bottom: 9999
  }), {
    width: 420,
    height: 500,
    right: 372,
    bottom: 92
  });
});

test('a collapsed floating surface becomes a live fullscreen surface requesting the host cat form', () => {
  assert.match(
    background,
    /transferCollapsedFloatingToFullscreen = mode === 'fullscreen'[\s\S]*?previous\.displayMode === 'floating'[\s\S]*?previous\.minimized === true/
  );
  const transferCondition = background.match(
    /const transferCollapsedFloatingToFullscreen =[\s\S]*?previous\.minimized === true;/
  );
  assert.ok(transferCondition, 'missing collapsed floating transfer condition');
  assert.doesNotMatch(
    transferCondition[0],
    /previous\.enabled/,
    'fresh installs are collapsed before enabled is initialized'
  );
  assert.match(background, /activatePanelInTab\(tab\.id, \{ avatarForm: 'cat' \}\)/);
  assert.match(background, /type: 'NEKO_APPLY_DISPLAY_MODE',[\s\S]*?minimized,[\s\S]*?avatarForm/);
  assert.match(
    background,
    /restoreCollapsedFloating = mode === 'floating'[\s\S]*?previous\.displayMode === 'fullscreen'[\s\S]*?previous\.fullscreenFromCollapsedFloating === true/
  );
  assert.match(background, /fullscreenFromCollapsedFloating = transferCollapsedFloatingToFullscreen/);

  const modeBlock = functionBlock('applyDisplayMode', 'ensurePanel');
  assert.match(modeBlock, /setAvatarForm\(options\.avatarForm, false\)/);
  assert.match(modeBlock, /setMinimized\(options\.minimized, false\)/);

  const targetBlock = functionBlock('getFrameTargetUrl', 'resetFrameBridgeState');
  assert.match(targetBlock, /avatarForm === 'cat'/);
  assert.match(targetBlock, /searchParams\.set\('avatar_form', 'cat'\)/);
  assert.match(targetBlock, /searchParams\.set\('avatar_request_id', avatarFormRequestId\)/);

  const connectBlock = functionBlock('sendEmbedConnect', 'postEmbedMessage');
  assert.match(connectBlock, /avatarForm,/);
  assert.match(connectBlock, /avatarFormRequestId,/);
  assert.match(source, /data\.type === 'NEKO_EMBED_AVATAR_FORM_STATE'/);
  assert.match(source, /data\.status === 'applied'/);
  assert.match(source, /type: 'NEKO_AVATAR_FORM_STATE'/);
});

test('fullscreen transfer state survives awake status updates until an explicit collapse', () => {
  const start = background.indexOf("if (message.type === 'NEKO_PANEL_STATE'");
  const end = background.indexOf("if (message.type === 'NEKO_AVATAR_FORM_STATE'", start);
  const block = background.slice(start, end);

  assert.ok(start >= 0 && end > start, 'missing NEKO_PANEL_STATE handler');
  assert.match(
    block,
    /if \(message\.minimized\) \{\s*payload\.fullscreenFromCollapsedFloating = false;\s*\}/
  );
  assert.equal(
    block.match(/payload\.fullscreenFromCollapsedFloating = false;/g)?.length,
    1,
    'awake status updates must not clear the collapsed-floating transfer marker'
  );
});

test('ordinary display mode changes intentionally restore the model form', () => {
  assert.match(
    background,
    /const avatarForm = transferCollapsedFloatingToFullscreen\s*\?\s*'cat'\s*:\s*\(restoreCollapsedFloating\s*\?\s*'cat'\s*:\s*'model'\);/
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
  assert.ok(
    block.indexOf('cancelEmbedHitTests()') < block.indexOf("phase === 'down'"),
    'every newer embedded pointer result must retire stale model hit tests'
  );
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

test('messages are restricted to the current extension bridge frame and origin', () => {
  assert.match(source, /event\.source !== frame\.contentWindow/);
  assert.match(source, /event\.origin !== FRAME_BRIDGE_ORIGIN/);
  assert.match(source, /data\._sender === FRAME_BRIDGE_SENDER/);
  assert.match(source, /data\._sender === 'neko-embedded-surface'/);
});
