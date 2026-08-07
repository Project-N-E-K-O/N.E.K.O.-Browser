const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(projectRoot, name), 'utf8');
const manifest = JSON.parse(read('src/manifest-base.json'));
const adapter = read('embedded-surface-main-world.js');
const transparentPage = read('transparent-page.js');
const css = read('embedded-surface.css');

function functionBlock(name, nextName) {
  const start = adapter.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = adapter.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(end, -1, `missing ${nextName}`);
  return adapter.slice(start, end);
}

function executableFunction(name, nextName, context = {}) {
  return vm.runInNewContext(`(${functionBlock(name, nextName).trim()})`, context);
}

test('the extension owns and injects the embedded surface adapter', () => {
  const webScripts = manifest.content_scripts.filter((entry) => (
    entry.matches.includes('http://*/*') && entry.matches.includes('https://*/*')
  ));
  const isolated = webScripts.find((entry) => entry.js?.includes('transparent-page.js'));
  const mainWorld = webScripts.find((entry) => entry.world === 'MAIN');
  const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources || []);

  assert.ok(isolated?.css?.includes('embedded-surface.css'));
  assert.equal(mainWorld, undefined, 'MAIN-world code must not run before isolated authorization');
  assert.ok(resources.includes('embedded-surface-main-world.js'));
  assert.match(transparentPage, /injectMainWorldScript\('embedded-surface-main-world\.js'\)/);
});

test('the adapter requires the embed marker and its injector\'s exact extension origin', () => {
  assert.match(adapter, /params\.get\('surface'\)/);
  assert.match(adapter, /surface !== 'embed'/);
  assert.match(adapter, /!extensionParentOrigin/);
  assert.match(adapter, /document\.currentScript\?\.getAttribute\('src'\)/);
  assert.match(adapter, /`\$\{parent\.protocol\}\/\/\$\{parent\.host\}` === extensionOrigin/);
  assert.match(adapter, /event\.origin !== extensionParentOrigin/);
  assert.match(adapter, /window\.parent\.postMessage\([\s\S]*?extensionParentOrigin\)/);
  assert.doesNotMatch(adapter, /window\.parent\.postMessage\([\s\S]*?['"]\*['"]\s*\)/);
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

test('floating avatar rebound uses a visible-ratio buffer and preserves fullscreen behavior', () => {
  assert.match(adapter, /FLOATING_AVATAR_HORIZONTAL_TRIGGER_RATIO = 0\.75/);
  assert.match(adapter, /FLOATING_AVATAR_HORIZONTAL_TARGET_RATIO = 0\.82/);
  assert.match(adapter, /FLOATING_AVATAR_VERTICAL_TRIGGER_RATIO = 0\.65/);
  assert.match(adapter, /FLOATING_AVATAR_VERTICAL_TARGET_RATIO = 0\.75/);
  assert.match(adapter, /FLOATING_AVATAR_CORE_TRIGGER_INSET_RATIO = 0\.06/);
  assert.match(adapter, /FLOATING_AVATAR_CORE_TARGET_INSET_RATIO = 0\.12/);
  assert.match(adapter, /THREE_MODEL_VIEWPORT_RECOVERY_HORIZONTAL_TRIGGER_RATIO = 0\.88/);
  assert.match(adapter, /THREE_MODEL_VIEWPORT_RECOVERY_HORIZONTAL_TARGET_RATIO = 0\.94/);
  assert.match(adapter, /THREE_MODEL_VIEWPORT_RECOVERY_VERTICAL_TRIGGER_RATIO = 0\.82/);
  assert.match(adapter, /THREE_MODEL_VIEWPORT_RECOVERY_VERTICAL_TARGET_RATIO = 0\.9/);
  assert.match(adapter, /data\.displayMode !== undefined\) setEmbeddedDisplayMode\(data\.displayMode\)/);
  assert.match(adapter, /displayModeAware: true/);

  const live2dBlock = adapter.slice(
    adapter.indexOf('function installLive2DSnapAdapter'),
    adapter.indexOf('function getFloatingLive2DSnap')
  );
  assert.match(live2dBlock, /embeddedDisplayMode === 'floating'/);
  assert.match(live2dBlock, /options\.threshold === undefined/);
  assert.match(live2dBlock, /checkSnapRequired\.call\(this, model, options\)/);

  const threeBlock = adapter.slice(
    adapter.indexOf('function installThreeModelSnapAdapter'),
    adapter.indexOf('function getFloatingAxisCorrection')
  );
  assert.match(threeBlock, /embeddedDisplayMode === 'floating'/);
  assert.match(threeBlock, /getFloatingThreeModelTarget/);
  assert.match(adapter, /installThreeModelSnapAdapter\(window\.vrmManager\)/);
  assert.match(adapter, /installThreeModelSnapAdapter\(window\.mmdManager\)/);
  assert.match(adapter, /manager\.getBodyScreenRectInfo\(\)\?\.rect/);
  assert.match(adapter, /getBone\('leftToes'\) \|\| getBone\('leftFoot'\)/);
  assert.match(adapter, /getBone\('rightToes'\) \|\| getBone\('rightFoot'\)/);
  assert.match(adapter, /leftPosition\.z > -1/);
  assert.match(adapter, /leftPosition\.z < 1/);
});

test('embedded 3D models recover after viewport changes in floating and fullscreen modes', () => {
  const resizeListener = adapter.match(
    /window\.addEventListener\('resize', \(\) => \{([^{}]*)\}\);/
  );
  assert.ok(resizeListener, 'missing the window resize listener');
  assert.match(resizeListener[1], /scheduleThreeModelViewportRecovery\(\)/);
  assert.match(
    adapter,
    /eventName === 'vrm-model-loaded' \|\| eventName === 'mmd-model-loaded'[\s\S]*?scheduleThreeModelViewportRecovery\(\)/
  );

  const schedulerBlock = functionBlock(
    'scheduleThreeModelViewportRecovery',
    'getLive2DHorizontalCore'
  );
  assert.match(schedulerBlock, /EMBED_DISPLAY_MODES\.includes\(embeddedDisplayMode\)/);
  assert.doesNotMatch(schedulerBlock, /embeddedDisplayMode === 'floating'/);
  assert.match(schedulerBlock, /window\.requestAnimationFrame/);
  assert.match(schedulerBlock, /window\.clearTimeout\(threeModelViewportRecoveryTimer\)/);

  const position = {
    x: 1,
    y: 2,
    z: 3,
    clone() {
      return { x: this.x, y: this.y, z: this.z };
    },
    copy(target) {
      this.x = target.x;
      this.y = target.y;
      this.z = target.z;
    }
  };
  let matrixUpdates = 0;
  let cacheDeletes = 0;
  const root = {
    position,
    updateMatrixWorld(force) {
      assert.equal(force, true);
      matrixUpdates += 1;
    }
  };
  const manager = {
    interaction: {
      isDragging: false,
      _isSnappingModel: false,
      clampModelPosition(candidate) {
        assert.notEqual(candidate, position);
        return { x: 4, y: 5, z: 6 };
      }
    }
  };
  let proportionalRecoveryCalls = 0;
  const recover = executableFunction(
    'recoverThreeModelViewport',
    'recoverThreeModelViewports',
    {
      EMBED_DISPLAY_MODES: ['floating', 'fullscreen'],
      embeddedDisplayMode: 'fullscreen',
      getThreeModelRoot: () => root,
      getThreeModelRecoveryTarget: () => {
        proportionalRecoveryCalls += 1;
        return { x: 4, y: 5, z: 6 };
      },
      cursorBoundsStates: { delete: () => { cacheDeletes += 1; } }
    }
  );

  assert.equal(recover(manager), true);
  assert.deepEqual({ x: position.x, y: position.y, z: position.z }, { x: 4, y: 5, z: 6 });
  assert.equal(matrixUpdates, 1);
  assert.equal(cacheDeletes, 1);
  assert.equal(proportionalRecoveryCalls, 1);

  manager.interaction.isDragging = true;
  assert.equal(recover(manager), false, 'viewport recovery must not fight an active drag');

  const recoveryBlock = functionBlock('recoverThreeModelViewport', 'recoverThreeModelViewports');
  assert.match(
    recoveryBlock,
    /getThreeModelRecoveryTarget\(manager, currentPosition\)[\s\S]*?interaction\.clampModelPosition\(currentPosition\)/
  );
  assert.doesNotMatch(recoveryBlock, /_snapModelIntoScreen|_savePositionAfterInteraction/);
});

test('floating avatar rebound allows partial overflow and restores only to the target ratio', () => {
  const start = adapter.indexOf('function getFloatingAxisCorrection');
  const end = adapter.indexOf('\n    function capitalize', start);
  assert.notEqual(start, -1, 'missing getFloatingAxisCorrection');
  assert.notEqual(end, -1, 'missing end of getFloatingAxisCorrection');
  const functionSource = adapter.slice(start, end);
  const getCorrection = new Function(`${functionSource}; return getFloatingAxisCorrection;`)();

  assert.equal(getCorrection(-60, 240, 0, 420, 0.75, 0.82), 0, '20% horizontal overflow remains adjustable');
  assert.ok(
    Math.abs(getCorrection(-90, 210, 0, 420, 0.75, 0.82) - 36) < 1e-9,
    'left overflow restores to 82% visible'
  );
  assert.ok(
    Math.abs(getCorrection(210, 510, 0, 420, 0.75, 0.82) + 36) < 1e-9,
    'right overflow restores symmetrically'
  );
  assert.equal(getCorrection(-100, 500, 0, 420, 0.75, 0.82), 0, 'an oversized model covering the viewport stays put');
  assert.equal(getCorrection(-90, 210, 0, 420, 0.65, 0.75), 0, 'the same overflow remains valid vertically');
});

test('horizontal rebound keeps the character core and feet inside a safety band', () => {
  const start = adapter.indexOf('function getFloatingCoreCorrection');
  const end = adapter.indexOf('\n    function getFloatingAxisCorrection', start);
  assert.notEqual(start, -1, 'missing getFloatingCoreCorrection');
  assert.notEqual(end, -1, 'missing end of horizontal core helpers');
  const helperSource = adapter.slice(start, end);
  const helpers = new Function(
    'FLOATING_AVATAR_CORE_TRIGGER_INSET_RATIO',
    'FLOATING_AVATAR_CORE_TARGET_INSET_RATIO',
    `${helperSource}; return { getFloatingCoreCorrection, combineHorizontalCorrections };`
  )(0.06, 0.12);

  assert.ok(
    Math.abs(helpers.getFloatingCoreCorrection(10, 0, 420) - 40.4) < 1e-9,
    'a left-side core moves into the 12% safety band'
  );
  assert.equal(helpers.getFloatingCoreCorrection(30, 0, 420), 0, 'a core outside the 6% trigger band stays adjustable');
  assert.ok(
    Math.abs(helpers.getFloatingCoreCorrection(410, 0, 420) + 40.4) < 1e-9,
    'right-side core correction is symmetric'
  );
  assert.ok(
    Math.abs(helpers.combineHorizontalCorrections(20, 40.4) - 40.4) < 1e-9,
    'core visibility wins when bounds correction is insufficient'
  );
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

test('leaving a fullscreen return cat does not end the embedded drag lock', () => {
  const leaveListener = adapter.match(
    /window\.addEventListener\('pointerout', \(event\) => \{([\s\S]*?)\}, \{ passive: true, capture: true \}\);/
  );
  assert.ok(leaveListener, 'missing the embedded pointerout listener');
  assert.match(
    leaveListener[1],
    /if\s*\(\s*event\.relatedTarget\s*\)\s*return;[\s\S]*?finishActiveThreeModelDrags\(event, true\)[\s\S]*?relayPointerImmediately\(event, 'leave'\)/,
    'descendant pointerleave events must be ignored before the drag lock is released'
  );
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
  assert.match(pointerMoveListener[1], /finishActiveThreeModelDrags\(event, false\)/);
  assert.ok(
    pointerMoveListener[1].indexOf('finishActiveThreeModelDrags(event, false)')
      < pointerMoveListener[1].indexOf('relayPointerMove(event)'),
    'a stale drag must end before the re-entry move reaches document handlers'
  );
  assert.match(pointerMoveListener[1], /relayPointerMove\(event\)/);
  assert.match(pointerMoveListener[1], /schedulePointerRegionRefresh\(\)/);
  assert.doesNotMatch(pointerMoveListener[1], /scheduleRegionReport\(\)/);

  const pointerOutListener = adapter.match(
    /window\.addEventListener\('pointerout', \(event\) => \{([\s\S]*?)\}, \{ passive: true, capture: true \}\);/
  );
  assert.ok(pointerOutListener, 'missing the document-exit pointer relay');
  assert.match(pointerOutListener[1], /if \(event\.relatedTarget\) return/);
  assert.match(pointerOutListener[1], /finishActiveThreeModelDrags\(event, true\)/);
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
  assert.doesNotMatch(optimizeBlock, /CURSOR_DRAG_BOUNDS_REFRESH_MS/);
  assert.match(optimizeBlock, /state\.model !== model/);
  assert.match(optimizeBlock, /manager\.interaction/);
  assert.match(optimizeBlock, /Object\.create\(manager\)/);
  assert.match(optimizeBlock, /Object\.defineProperty\(managerFacade, 'getModelScreenBounds'/);
  assert.match(optimizeBlock, /const realManager = this\.manager/);
  assert.doesNotMatch(optimizeBlock, /cursorBoundsStates\.delete\(manager\)/);
  assert.match(optimizeBlock, /try \{/);
  assert.match(optimizeBlock, /finally \{\s*this\.manager = realManager/);
  assert.match(optimizeBlock, /original\.apply\(this, args\)/);
  assert.doesNotMatch(adapter, /manager\.getModelScreenBounds\s*=(?!=)/);
});

test('3D pan dragging uses fixed camera depth and total pointer displacement', () => {
  const stateBlock = functionBlock('createStablePanDragState', 'applyStablePanDragPosition');
  assert.match(stateBlock, /new THREE\.Box3\(\)\.setFromObject\(modelRoot\)\.getCenter/);
  assert.match(stateBlock, /applyMatrix4\(camera\.matrixWorldInverse\)/);
  assert.match(stateBlock, /Math\.abs\(Number\(cameraSpacePosition\.z\)\)/);
  assert.match(stateBlock, /camera\.getEffectiveFOV/);
  assert.doesNotMatch(stateBlock, /camera\.position\.distanceTo/);

  const stabilizeBlock = functionBlock('stabilizeModelPanDrag', 'capitalize');
  assert.match(stabilizeBlock, /document\.removeEventListener\('mousemove', original\)/);
  assert.match(stabilizeBlock, /interaction\.dragMode !== 'pan'/);
  assert.match(
    stabilizeBlock,
    /interaction\.previousMousePosition = \{[\s\S]*?runStablePanHostHandler\(manager, interaction, original, event\)[\s\S]*?applyStablePanDragPosition\(state, interaction, event\)/,
    'the host incremental delta must be neutralized before total displacement is applied'
  );
  assert.match(stabilizeBlock, /applyStablePanDragPosition\(state, interaction, event\)/);
  assert.match(stabilizeBlock, /document\.addEventListener\('mousemove', wrapped\)/);

  const syncBlock = functionBlock('syncAvatarRendering', 'normalizeThreeScreenBounds');
  assert.match(syncBlock, /stabilizeModelPanDrag\(window\.vrmManager\)/);
  assert.match(syncBlock, /stabilizeModelPanDrag\(window\.mmdManager\)/);

  assert.match(
    adapter,
    /window\.addEventListener\('pointerdown', \(event\) => \{[\s\S]*?clearThreeModelPanDragStates\(\)[\s\S]*?relayPointerImmediately\(event, 'down'\)/
  );
});

test('stable 3D pan preserves host bookkeeping without executing its translation branch', () => {
  const calls = [];
  const interaction = {
    isDragging: true,
    dragMode: 'pan',
    _rememberPanDragPointer(event) {
      calls.push(['pointer', event.clientX]);
    },
    _rememberDragHintPanPointer(event) {
      calls.push(['hint', event.clientX]);
    },
    _recordDragHintPointerEdgeApproach(modelType) {
      calls.push(['edge', modelType]);
    }
  };
  const manager = {};
  const windowStub = { vrmManager: manager };
  const runStablePanHostHandler = executableFunction(
    'runStablePanHostHandler',
    'stabilizeModelPanDrag',
    { window: windowStub }
  );
  let originalRuns = 0;
  let legacyTranslationRuns = 0;
  const original = () => {
    originalRuns += 1;
    if (manager._isModelReadyForInteraction === false) return;
    if (interaction.dragMode === 'pan') legacyTranslationRuns += 1;
  };

  assert.equal(
    runStablePanHostHandler(manager, interaction, original, { clientX: 12 }),
    true
  );
  assert.equal(originalRuns, 1);
  assert.equal(legacyTranslationRuns, 0);
  assert.equal(interaction.dragMode, 'pan');
  assert.deepEqual(calls, [
    ['pointer', 12],
    ['hint', 12],
    ['edge', 'vrm']
  ]);

  calls.length = 0;
  manager._isModelReadyForInteraction = false;
  assert.equal(
    runStablePanHostHandler(manager, interaction, original, { clientX: 13 }),
    false
  );
  assert.equal(originalRuns, 2);
  assert.equal(legacyTranslationRuns, 0);
  assert.deepEqual(calls, []);
});

test('3D pan dragging discards clamped overshoot so reversing moves immediately', () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    copy(other) {
      this.x = other.x;
      this.y = other.y;
      this.z = other.z;
      return this;
    }

    clone() {
      return new Vector3(this.x, this.y, this.z);
    }

    addScaledVector(vector, scale) {
      this.x += vector.x * scale;
      this.y += vector.y * scale;
      this.z += vector.z * scale;
      return this;
    }
  }

  const applyStablePanDragPosition = executableFunction(
    'applyStablePanDragPosition',
    'runStablePanHostHandler'
  );
  const state = {
    modelRoot: { position: new Vector3() },
    pointerX: 0,
    pointerY: 0,
    startPosition: new Vector3(),
    right: new Vector3(1, 0, 0),
    up: new Vector3(0, 1, 0),
    pixelToWorldX: 1,
    pixelToWorldY: 1,
    nextPosition: new Vector3()
  };
  const interaction = {
    clampModelPosition(position) {
      return new Vector3(Math.min(position.x, 10), position.y, position.z);
    }
  };

  applyStablePanDragPosition(state, interaction, { clientX: 15, clientY: 0 });
  assert.equal(state.modelRoot.position.x, 10);
  assert.equal(state.pointerX, 15);
  assert.equal(state.startPosition.x, 10);

  applyStablePanDragPosition(state, interaction, { clientX: 14, clientY: 0 });
  assert.equal(
    state.modelRoot.position.x,
    9,
    'one pixel of reverse pointer motion must move the model immediately'
  );
});

test('leaving the window or re-entering with no buttons ends stale 3D drags', () => {
  const finishBlock = functionBlock('finishActiveThreeModelDrags', 'postToParent');
  assert.match(finishBlock, /!force && Number\(event\?\.buttons\) !== 0/);
  assert.match(finishBlock, /if \(!vrmActive && !mmdActive\) return/);
  assert.ok(
    finishBlock.indexOf('if (!vrmActive && !mmdActive) return')
      < finishBlock.indexOf('const releaseEvent'),
    'the common pointermove path must return before allocating a release event'
  );
  assert.match(finishBlock, /interaction\.mouseUpHandler\(releaseEvent\)/);
  assert.match(finishBlock, /cursorBoundsStates\.delete\(manager\)/);
  assert.match(finishBlock, /\.finally\(scheduleRegionReport\)/);
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
