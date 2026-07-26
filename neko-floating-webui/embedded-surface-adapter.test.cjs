const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const adapter = read('embedded-surface-main-world.js');
const css = read('embedded-surface.css');

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

test('floating avatar rebound uses a visible-ratio buffer and preserves fullscreen behavior', () => {
  assert.match(adapter, /FLOATING_AVATAR_HORIZONTAL_TRIGGER_RATIO = 0\.75/);
  assert.match(adapter, /FLOATING_AVATAR_HORIZONTAL_TARGET_RATIO = 0\.82/);
  assert.match(adapter, /FLOATING_AVATAR_VERTICAL_TRIGGER_RATIO = 0\.65/);
  assert.match(adapter, /FLOATING_AVATAR_VERTICAL_TARGET_RATIO = 0\.75/);
  assert.match(adapter, /FLOATING_AVATAR_CORE_TRIGGER_INSET_RATIO = 0\.06/);
  assert.match(adapter, /FLOATING_AVATAR_CORE_TARGET_INSET_RATIO = 0\.12/);
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
    /document\.addEventListener\('pointerleave', \(event\) => \{([\s\S]*?)\}, \{ passive: true, capture: true \}\);/
  );
  assert.ok(leaveListener, 'missing the embedded pointerleave listener');
  assert.match(leaveListener[1], /event\.target !== document\.documentElement/);
  assert.match(leaveListener[1], /\|\| event\.relatedTarget\) return/);
  assert.ok(
    leaveListener[1].indexOf('event.target') < leaveListener[1].indexOf("relayPointerImmediately(event, 'leave')"),
    'descendant pointerleave events must be ignored before the drag lock is released'
  );
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
