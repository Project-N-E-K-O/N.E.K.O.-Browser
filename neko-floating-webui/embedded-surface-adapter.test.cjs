const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const adapter = read('embedded-surface-main-world.js');
const css = read('embedded-surface.css');

function functionBlock(name, nextName) {
  const start = adapter.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = adapter.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(end, -1, `missing ${nextName}`);
  return adapter.slice(start, end);
}

test('the extension owns and injects the embedded surface adapter', () => {
  const webScripts = manifest.content_scripts.filter((entry) => (
    entry.matches.includes('http://*/*') && entry.matches.includes('https://*/*')
  ));
  const isolated = webScripts.find((entry) => entry.js?.includes('transparent-page.js'));
  const mainWorld = webScripts.find((entry) => entry.world === 'MAIN');

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

test('the adapter delegates moved chat viewport correction to the host geometry API', () => {
  assert.match(adapter, /host\.ensureChatSurfaceVisible\(\)/);
  const resizeListener = adapter.match(
    /window\.addEventListener\('resize', \(\) => \{([^{}]*)\}\);/
  );
  assert.ok(resizeListener, 'missing the window resize listener');
  assert.match(resizeListener[1], /scheduleChatVisibilityCheck\(\)/);
  assert.match(adapter, /getCurrentChatMode\(\) === 'minimized'/);
  assert.doesNotMatch(adapter, /shell\.style\.(left|top|transform)\s*=/);
});

test('crossing the mobile breakpoint rebuilds only the active avatar controls', () => {
  assert.match(adapter, /const MOBILE_VIEWPORT_MAX_WIDTH = 768/);
  assert.match(adapter, /mobileViewport === lastMobileViewport/);
  assert.match(adapter, /document\.getElementById\(`\$\{candidate\.prefix\}-floating-buttons`\)/);
  assert.match(adapter, /active\.prefix === 'live2d'/);
  assert.match(adapter, /manager\.setupFloatingButtons\(model\)/);
  assert.match(adapter, /manager\.setupFloatingButtons\(\)/);
  assert.match(adapter, /manager\._isInReturnState \|\| manager\._goodbyeClicked/);
  const responsiveBlock = adapter.slice(
    adapter.indexOf('function syncResponsiveViewportMode'),
    adapter.indexOf('function scheduleResponsiveViewportSync')
  );
  assert.match(responsiveBlock, /const controlsRebuilt = rebuildActiveAvatarControls\(\)/);
  assert.match(responsiveBlock, /if \(!controlsRebuilt\) return false/);
  assert.ok(
    responsiveBlock.indexOf('if (!controlsRebuilt)') < responsiveBlock.indexOf('lastMobileViewport = mobileViewport'),
    'the mobile breakpoint must remain pending until avatar controls are rebuilt'
  );
  const resizeListener = adapter.match(
    /window\.addEventListener\('resize', \(\) => \{([^{}]*)\}\);/
  );
  assert.ok(resizeListener, 'missing the window resize listener');
  assert.match(resizeListener[1], /scheduleResponsiveViewportSync\(\)/);
  const avatarSyncBlock = adapter.slice(
    adapter.indexOf('function syncRequestedAvatarForm'),
    adapter.indexOf('function dispatchAvatarReturnToModel')
  );
  assert.match(
    avatarSyncBlock,
    /requestedAvatarForm === 'model'[\s\S]*?syncResponsiveViewportMode\(\)/
  );
});

test('the adapter acknowledges the host cat form only after the return cat is rendered', () => {
  assert.match(adapter, /params\.get\('avatar_form'\)/);
  assert.match(adapter, /data\.type === 'NEKO_EMBED_SET_AVATAR_FORM'/);
  assert.match(adapter, /new CustomEvent\('live2d-goodbye-click'/);
  assert.match(adapter, /source: 'browser-extension-avatar-form'/);
  assert.match(adapter, /\[data-neko-return-visible="true"\]/);
  assert.match(adapter, /isRendered\(container\)/);
  assert.match(adapter, /requestApplied = requestedAvatarForm === 'cat'/);
  assert.match(adapter, /state\.avatarForm === 'cat' && state\.visible/);
  assert.match(adapter, /type,\s*protocolVersion/);
  assert.match(adapter, /postToParent\('NEKO_EMBED_AVATAR_FORM_STATE'/);
  assert.match(adapter, /avatarFormControl: true/);
  assert.match(adapter, /'pngtuber-return-click'/);
  assert.match(adapter, /function dispatchAvatarReturnToModel\(\)/);
  assert.match(adapter, /new CustomEvent\(`\$\{prefix\}-return-click`/);
  assert.match(css, /data-neko-avatar-form-request="cat"/);

  const controlsRule = css.match(
    /html\.neko-embedded-surface\[data-neko-surface-controls="off"\][\s\S]*?\{[\s\S]*?\}/
  );
  assert.ok(controlsRule, 'missing controls visibility rule');
  assert.doesNotMatch(controlsRule[0], /return-button-container/);
  assert.match(
    adapter,
    /avatar:\s*\[\s*'\[id\$="-return-button-container"\]'/
  );
});

test('a connect message without avatar state preserves the URL avatar request', () => {
  const connectHandler = adapter.match(
    /if \(data\.type === 'NEKO_EMBED_CONNECT'\) \{[\s\S]*?postReady\(data\.requestId\);\s*return;\s*\}/
  );
  assert.ok(connectHandler, 'missing NEKO_EMBED_CONNECT handler');
  assert.match(
    connectHandler[0],
    /if \(data\.avatarForm !== undefined\) \{\s*requestAvatarForm\(data\.avatarForm, data\.avatarFormRequestId, 'parent-connect'\);\s*\}/
  );
  assert.equal(
    (connectHandler[0].match(/\brequestAvatarForm\(/g) || []).length,
    1,
    'connect handler must not issue an unconditional avatar request'
  );
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

test('pointer hover reuses reported regions and refreshes them at bounded cadence', () => {
  const collectBlock = functionBlock('collectRegions', 'scheduleRegionReport');
  assert.match(collectBlock, /cachedElementRegions =/);
  assert.match(collectBlock, /cachedAvatarBoundsRegion = avatarRegion/);

  const uiHitBlock = functionBlock('hitTestUi', 'hitTestLive2D');
  assert.match(uiHitBlock, /cachedElementRegions \|\| collectElementRegions\(\)/);

  const pointerMoveListener = adapter.match(
    /window\.addEventListener\('pointermove', \(event\) => \{([\s\S]*?)\}, \{ passive: true, capture: true \}\);/
  );
  assert.ok(pointerMoveListener, 'missing pointermove relay');
  assert.match(pointerMoveListener[1], /relayPointerMove\(event\)/);
  assert.match(pointerMoveListener[1], /schedulePointerRegionRefresh\(\)/);
  assert.doesNotMatch(pointerMoveListener[1], /scheduleRegionReport\(\)/);

  const pointerOutListener = adapter.match(
    /window\.addEventListener\('pointerout', \(event\) => \{([\s\S]*?)\}, \{ passive: true, capture: true \}\);/
  );
  assert.ok(pointerOutListener, 'missing the document-exit pointer relay');
  assert.match(pointerOutListener[1], /event\.relatedTarget !== null/);
  assert.match(pointerOutListener[1], /relayPointerImmediately\(event, 'leave'\)/);
  assert.doesNotMatch(adapter, /document\.addEventListener\('pointerleave'/);

  const refreshBlock = functionBlock('schedulePointerRegionRefresh', 'reportRegions');
  assert.match(refreshBlock, /POINTER_REGION_REFRESH_MS/);
  assert.match(refreshBlock, /pointerRegionRefreshTimer/);
  assert.match(refreshBlock, /window\.setTimeout/);
  assert.match(refreshBlock, /scheduleRegionReport\(\)/);
});

test('Live2D pointer hit testing falls back before avatar bounds are cached', () => {
  const pointerHitBlock = functionBlock('hitTestPointerSurface', 'relayPointerMove');
  assert.match(
    pointerHitBlock,
    /cachedAvatarBoundsRegion\?\.id === 'live2d-model'[\s\S]*?getLive2DBoundsRegion\(\)/
  );
  assert.equal(
    (pointerHitBlock.match(/getLive2DBoundsRegion\(\)/g) || []).length,
    1,
    'the uncached Live2D fallback should calculate only Live2D bounds once'
  );
});

test('embedded 3D hover avoids raycasting without replacing host manager behavior', () => {
  const threeRegionBlock = functionBlock('getThreeBoundsRegion', 'getPngtuberBoundsRegion');
  assert.match(threeRegionBlock, /manager\.interaction\?\._cachedScreenBounds/);
  assert.match(
    threeRegionBlock,
    /cachedBounds\s*\|\|\s*\(typeof manager\.getModelScreenBounds === 'function'/
  );

  const threeHitBlock = functionBlock('hitTestThreeManager', 'hitTestPngtuber');
  assert.match(threeHitBlock, /cachedAvatarBoundsRegion/);
  assert.match(threeHitBlock, /normalizeThreeScreenBounds\(manager\.interaction\?\._cachedScreenBounds\)/);
  assert.match(threeHitBlock, /interactionBounds \|\| reportedBounds/);
  assert.match(threeHitBlock, /pointInAvatarConservativeBounds/);
  assert.doesNotMatch(threeHitBlock, /_hitTestModel|intersectObject/);
  assert.doesNotMatch(adapter, /manager\.getModelScreenBounds\s*=(?!=)/);
  assert.doesNotMatch(adapter, /activityOwner\._hasRenderActivity\s*=(?!=)/);
  assert.doesNotMatch(adapter, /interaction\.updateModelBoundsCache\s*=(?!=)/);
});

test('cursor-follow bounds are cached without changing the host manager contract', () => {
  const optimizeBlock = functionBlock('readCursorFollowBounds', 'capitalize');
  assert.match(optimizeBlock, /CURSOR_BOUNDS_REFRESH_MS/);
  assert.match(optimizeBlock, /state\.model !== model/);
  assert.match(optimizeBlock, /manager\.interaction/);
  assert.match(optimizeBlock, /Object\.create\(manager\)/);
  assert.match(optimizeBlock, /Object\.defineProperty\(managerFacade, 'getModelScreenBounds'/);
  assert.match(optimizeBlock, /const realManager = this\.manager/);
  assert.match(optimizeBlock, /try \{/);
  assert.match(optimizeBlock, /finally \{\s*this\.manager = realManager/);
  assert.match(optimizeBlock, /original\.apply\(this, args\)/);
  assert.doesNotMatch(adapter, /manager\.getModelScreenBounds\s*=(?!=)/);
});

test('3D passthrough keeps only the narrow model-centered part of broad bounds', () => {
  const conservativeBoundsBlock = functionBlock('pointInAvatarConservativeBounds', 'hitTestUi');
  assert.match(conservativeBoundsBlock, /halfWidth[\s\S]*?\* 0\.5 \* 0\.4/);
  assert.match(conservativeBoundsBlock, /halfHeight[\s\S]*?\* 0\.5 \* 0\.9/);
  assert.match(conservativeBoundsBlock, /Math\.abs\(x - centerX\) <= halfWidth/);
  assert.match(conservativeBoundsBlock, /Math\.abs\(y - centerY\) <= halfHeight/);
  assert.doesNotMatch(conservativeBoundsBlock, /\*\* 4/);
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
