const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./helpers/extract-function.cjs');

const projectRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(projectRoot, name), 'utf8');
const manifest = JSON.parse(read('src/manifest-base.json'));
const background = read('background.js');
const content = read('content.js');
const popupHtml = read('popup.html');
const popup = read('popup.js');
const popupCss = read('popup.css');
const wxtConfig = read('wxt.config.ts');
const vitestConfig = read('vitest.config.ts');
const packageJson = JSON.parse(read('package.json'));
const ensureBrowserSkill = read('scripts/ensure-browser-skill.cjs');
const browserSkillContent = read('vendor/browser-skill/apps/extension/src/entrypoints/content.ts');
const controlOverlay = read('src/browser-skill/ui/ControlOverlay.tsx');
const helpRequestOverlay = read('src/browser-skill/ui/HelpRequestOverlay.tsx');
const browserControlIcon = read('src/browser-skill/ui/BrowserControlIcon.tsx');
const profileName = read('src/browser-skill/ui/profile-name.ts');

test('BrowserSkill permissions, daemon CSP, and native N.E.K.O surfaces share one manifest base', () => {
  for (const permission of ['debugger', 'idle', 'notifications', 'tabs', 'webNavigation', 'windows']) {
    assert.ok(manifest.permissions.includes(permission), `missing ${permission}`);
  }
  assert.match(manifest.content_security_policy.extension_pages, /ws:\/\/127\.0\.0\.1:52800/);
  assert.equal(manifest.minimum_chrome_version, '142');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
});

test('build entrypoints initialize the BrowserSkill submodule when its sources are absent', () => {
  for (const script of ['build', 'compile', 'test:integration', 'postinstall']) {
    assert.match(packageJson.scripts[script], /^node scripts\/ensure-browser-skill\.cjs && /);
  }
  assert.match(ensureBrowserSkill, /submodule'\s*,\s*'update'/);
  assert.match(ensureBrowserSkill, /'--init'/);
  assert.match(ensureBrowserSkill, /'--recursive'/);
  assert.match(ensureBrowserSkill, /neko-floating-webui\/vendor\/browser-skill/);
  assert.match(ensureBrowserSkill, /'ls-files'/);
  assert.match(ensureBrowserSkill, /'--stage'/);
  assert.doesNotMatch(ensureBrowserSkill, /'ls-tree'\s*,\s*'HEAD'/);
  assert.match(ensureBrowserSkill, /'rev-parse'/);
  assert.match(ensureBrowserSkill, /actualSubmoduleCommit\(\) !== expectedCommit/);
  assert.match(ensureBrowserSkill, /timeout:\s*SUBMODULE_UPDATE_TIMEOUT_MS/);
  assert.match(ensureBrowserSkill, /GIT_TERMINAL_PROMPT:\s*'0'/);
});

test('N.E.K.O automation leases apply hide, passthrough, and normal priority', () => {
  const automationLeases = new Map();
  const createHarness = new Function(
    'automationLeases',
    `${extractFunction(content, 'resolveAutomationSurfaceMode')}
     ${extractFunction(content, 'applyAutomationSurfaceState')}
     return { applyAutomationSurfaceState, resolveAutomationSurfaceMode };`
  );
  const harness = createHarness(automationLeases);
  const styleValues = new Map();
  const targetHost = {
    dataset: {},
    style: {
      setProperty: (name, value, priority) => styleValues.set(name, { value, priority }),
      removeProperty: (name) => styleValues.delete(name)
    }
  };

  harness.applyAutomationSurfaceState(targetHost);
  assert.equal(targetHost.dataset.nekoAutomationSurface, undefined);
  assert.equal(styleValues.has('visibility'), false);

  automationLeases.set('click', 'pointer-bypass');
  harness.applyAutomationSurfaceState(targetHost);
  assert.equal(targetHost.dataset.nekoAutomationSurface, 'pointer-bypass');

  automationLeases.set('record', 'record-passthrough');
  harness.applyAutomationSurfaceState(targetHost);
  assert.equal(targetHost.dataset.nekoAutomationSurface, 'record-passthrough');

  automationLeases.set('capture', 'capture-hide');
  harness.applyAutomationSurfaceState(targetHost);
  assert.equal(targetHost.dataset.nekoAutomationSurface, 'capture-hide');
  assert.deepEqual(styleValues.get('visibility'), { value: 'hidden', priority: 'important' });

  automationLeases.delete('capture');
  harness.applyAutomationSurfaceState(targetHost);
  assert.equal(targetHost.dataset.nekoAutomationSurface, 'record-passthrough');
  assert.equal(styleValues.has('visibility'), false);

  assert.match(content, /data-neko-automation-surface="pointer-bypass"/);
  assert.match(content, /data-neko-automation-surface="record-passthrough"/);
  assert.match(
    content,
    /:host\(\[data-neko-automation-surface="pointer-bypass"\]\) #\$\{PANEL_ID\}\[data-display-mode="fullscreen"\]\[data-embed-interactive="true"\] #\$\{FRAME_ID\}/
  );
  assert.match(content, /NEKO_AUTOMATION_LEASE_RESET/);
  assert.match(content, /message\.mode === 'capture-hide' && message\.active/);
  assert.match(content, /waitForAutomationPaint\(\)\.then\(\(\) => sendResponse\(\{ ok: true \}\)\)/);
});

test('automation visibility acknowledgement waits across a paint boundary', async () => {
  const callbacks = new Map();
  const timers = new Map();
  let nextId = 1;
  const waitForAutomationPaint = new Function(
    'host',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'setTimeout',
    'clearTimeout',
    `${extractFunction(content, 'waitForAutomationPaint')}; return waitForAutomationPaint;`
  )(
    { isConnected: true, getBoundingClientRect: () => ({}) },
    (callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    (id) => callbacks.delete(id),
    (callback) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    (id) => timers.delete(id)
  );

  let settled = false;
  const pending = waitForAutomationPaint().then(() => { settled = true; });
  assert.equal(callbacks.size, 1);
  const firstFrame = callbacks.entries().next().value;
  callbacks.delete(firstFrame[0]);
  firstFrame[1]();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(callbacks.size, 1);
  const secondFrame = callbacks.entries().next().value;
  callbacks.delete(secondFrame[0]);
  secondFrame[1]();
  await pending;
  assert.equal(settled, true);
  assert.equal(timers.size, 0);
});

test('N.E.K.O stays above BrowserSkill and is excluded from semantic observations', () => {
  assert.match(content, /nextHost\.dataset\.bskObservationIgnore = ''/);
  assert.doesNotMatch(content, /nextHost\.dataset\.bskOverlay = ''/);
  assert.match(content, /nextHost\.style\.zIndex = '2147483647'/);
  assert.match(content, /BSK_OVERLAY_Z_INDEX = '2147483646'/);
  assert.match(content, /browserSkillHost\.style\.setProperty\('z-index', BSK_OVERLAY_Z_INDEX, 'important'\)/);
  assert.doesNotMatch(content, /document\.documentElement\.append\(host\)/);
  assert.match(content, /integrationLayerObserver\.observe\(document\.documentElement, \{ childList: true \}\)/);
  assert.doesNotMatch(content, /integrationLayerObserver\.observe\([^\n]+subtree: true/);
});

test('native popup uses the bsk-popup runtime port and exposes connection and recording controls', () => {
  assert.match(popup, /chrome\.runtime\.connect\(\{ name: 'bsk-popup' \}\)/);
  assert.match(popupHtml, /id="bsk-connection-toggle"/);
  assert.match(popupHtml, /id="bsk-instance-id"/);
  assert.match(popupHtml, /id="bsk-daemon-version"/);
  assert.match(popupHtml, /id="bsk-protocol-version"/);
  assert.match(popupHtml, /id="bsk-record-purpose"/);
  assert.match(popupHtml, /id="bsk-record-url"/);
  assert.match(popupHtml, /id="bsk-copy-record"/);
  assert.match(popupHtml, /class="bsk-status-line" aria-live="polite"/);
  assert.match(popupCss, /\.bsk-status-badge\s*\{[\s\S]*?font-size:\s*10px/);
  assert.match(popupCss, /\.bsk-mini-button\s*\{[\s\S]*?font-size:\s*10px/);
});

test('N.E.K.O owns the BrowserSkill control pill without modifying the pinned submodule', () => {
  assert.match(
    wxtConfig,
    /"@\/content\/ControlOverlay": resolve\(here, "src\/browser-skill\/ui\/ControlOverlay\.tsx"\)/,
  );
  assert.match(browserSkillContent, /from "@\/content\/ControlOverlay"/);
  assert.match(controlOverlay, /BrowserControlIcon/);
  assert.match(browserControlIcon, /Browser window \+ pointer/);
  assert.match(browserControlIcon, /transform="translate\(0 1\)"/);
  assert.match(controlOverlay, /#40c5f1/i);
  assert.match(controlOverlay, /#e45f70/i);
  assert.match(controlOverlay, /prefers-color-scheme: dark/);
  assert.match(profileName, /NEKO_GET_CURRENT_CATGIRL/);
  assert.match(controlOverlay, /formatControlStatus\(t\("controlOverlay\.status"\), profileName\)/);
  assert.match(background, /new URL\('\/api\/characters\/current_catgirl', webuiUrl\)/);
  assert.match(background, /payload\?\.current_catgirl/);
  assert.doesNotMatch(controlOverlay, /Agent_on\.png|assets\/logo\.png|#f97316|rgba\(249,\s*115,\s*22/);
});

test('N.E.K.O owns the BrowserSkill help card and removes upstream Agent branding', () => {
  assert.match(
    wxtConfig,
    /"@\/content\/HelpRequestOverlay": resolve\([\s\S]*?"src\/browser-skill\/ui\/HelpRequestOverlay\.tsx"/,
  );
  assert.match(browserSkillContent, /from "@\/content\/HelpRequestOverlay"/);
  assert.match(helpRequestOverlay, /@browser-skill-upstream\/content\/HelpRequestOverlay/);
  assert.match(helpRequestOverlay, /replaceAgentTerms\(request\.prompt, profileName\)/);
  assert.match(helpRequestOverlay, /getResourceBundle\(locale, "extension"\)/);
  assert.match(helpRequestOverlay, /addResourceBundle\(locale, "extension", baseBundle, true, true\)/);
  assert.match(helpRequestOverlay, /continue: "完成并交还控制权"/);
  assert.match(helpRequestOverlay, /cancel: "取消请求"/);
  assert.match(helpRequestOverlay, /helpRequest\.\$\{key\}/);
  assert.match(helpRequestOverlay, /transform='translate\(0 1\)'/);
  assert.match(helpRequestOverlay, /#40c5f1/i);
  assert.match(helpRequestOverlay, /#18a7ff/i);
  assert.match(helpRequestOverlay, /prefers-color-scheme: dark/);
  assert.match(helpRequestOverlay, /help-highlight/);
  assert.doesNotMatch(helpRequestOverlay, /assets\/logo\.png|Agent_on\.png|#f97316/);
  assert.doesNotMatch(controlOverlay, /linear-gradient\(145deg, #fff, #e9f9ff\)/);
});

test('current catgirl profile names are normalized before leaving the background', () => {
  const normalizeCatgirlProfileName = Function(
    `${extractFunction(background, 'normalizeCatgirlProfileName')}; return normalizeCatgirlProfileName;`
  )();

  assert.equal(normalizeCatgirlProfileName('  猫娘\n档案  '), '猫娘 档案');
  assert.equal(normalizeCatgirlProfileName(null), '');
  assert.equal(normalizeCatgirlProfileName('喵'.repeat(140)), '喵'.repeat(128));
});

test('popup metadata and copy feedback use generated versions and one restore timer', () => {
  assert.match(popup, /BSK_PROTOCOL_VERSION = '__NEKO_BSK_PROTOCOL_VERSION__'/);
  assert.match(popup, /扩展协议 v\$\{BSK_PROTOCOL_VERSION\}/);
  assert.doesNotMatch(popup, /扩展协议 v1\.0/);
  assert.match(wxtConfig, /PROTOCOL_VERSION as browserSkillProtocolVersion/);
  assert.match(wxtConfig, /replaceAll\(browserSkillProtocolPlaceholder, browserSkillProtocolVersion\)/);
  assert.match(popup, /button\.dataset\.originalLabel/);
  assert.match(popup, /window\.clearTimeout\(previousTimer\)/);
  assert.match(popup, /button\.dataset\.restoreTimer = String\(restoreTimer\)/);
  assert.match(vitestConfig, /vendor\/browser-skill\/apps\/extension\/package\.json/);
  assert.match(vitestConfig, /JSON\.stringify\(browserSkillPackage\.version\)/);
});

test('record prompt remains available for compatible protocol skew and quotes PowerShell arguments', () => {
  assert.match(popup, /status === 'connected' \|\| status === 'version_skew'/);
  assert.match(popup, /在 PowerShell 中执行/);
  assert.match(popup, /& bsk record start --browser \$\{quotePowerShellArg\(bskSnapshot\.instanceId\)\}/);

  const quoteSource = popup.match(/function quotePowerShellArg\(value\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(quoteSource, 'missing quotePowerShellArg');
  const quotePowerShellArg = Function(`${quoteSource}; return quotePowerShellArg;`)();
  assert.equal(
    quotePowerShellArg("$(Get-Item secret); O'Brien"),
    "'$(Get-Item secret); O''Brien'"
  );
});

test('daemon endpoint drives both the runtime constant and extension CSP', () => {
  assert.match(wxtConfig, /const browserSkillDaemonUrl = process\.env\.BSK_DAEMON_WS_URL/);
  assert.match(wxtConfig, /url\.protocol !== "ws:" && url\.protocol !== "wss:"/);
  assert.match(wxtConfig, /`connect-src http: https: \$\{browserSkillDaemonOrigin\}`/);
  assert.match(wxtConfig, /__BSK_DAEMON_WS_URL__: JSON\.stringify\(browserSkillDaemonUrl\)/);
});

test('production bundle includes the repository third-party notice', () => {
  assert.match(wxtConfig, /relativeDest: "THIRD_PARTY_NOTICES\.md"/);
  assert.match(wxtConfig, /resolve\(here, "\.\.\/THIRD_PARTY_NOTICES\.md"\)/);
  assert.match(wxtConfig, /"build:publicAssets"/);
  assert.doesNotMatch(wxtConfig, /name: "neko-runtime-assets"/);
  assert.ok(fs.existsSync(path.join(projectRoot, '..', 'THIRD_PARTY_NOTICES.md')));
});
