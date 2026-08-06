const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const manifest = JSON.parse(read('src/manifest-base.json'));
const content = read('content.js');
const popupHtml = read('popup.html');
const popup = read('popup.js');
const wxtConfig = read('wxt.config.ts');

test('BrowserSkill permissions, daemon CSP, and native N.E.K.O surfaces share one manifest base', () => {
  for (const permission of ['debugger', 'idle', 'notifications', 'tabs', 'webNavigation', 'windows']) {
    assert.ok(manifest.permissions.includes(permission), `missing ${permission}`);
  }
  assert.match(manifest.content_security_policy.extension_pages, /ws:\/\/127\.0\.0\.1:52800/);
  assert.equal(manifest.minimum_chrome_version, '142');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
});

test('N.E.K.O automation leases preserve hide, passthrough, and normal priority', () => {
  const resolver = content.slice(
    content.indexOf('function resolveAutomationSurfaceMode()'),
    content.indexOf('function applyAutomationSurfaceState')
  );
  assert.ok(resolver.indexOf("modes.has('capture-hide')") < resolver.indexOf("modes.has('record-passthrough')"));
  assert.ok(resolver.indexOf("modes.has('record-passthrough')") < resolver.indexOf("modes.has('pointer-bypass')"));
  assert.match(content, /data-neko-automation-surface="pointer-bypass"/);
  assert.match(content, /data-neko-automation-surface="record-passthrough"/);
  assert.match(content, /visibility', 'hidden', 'important'/);
  assert.match(content, /NEKO_AUTOMATION_LEASE_RESET/);
  assert.match(content, /message\.mode === 'capture-hide' && message\.active/);
  assert.match(content, /waitForAutomationPaint\(\)\.then\(\(\) => sendResponse\(\{ ok: true \}\)\)/);
  assert.match(content, /secondFrame = requestAnimationFrame\(finish\)/);
});

test('N.E.K.O stays above BrowserSkill and is excluded from semantic observations', () => {
  assert.match(content, /nextHost\.dataset\.bskObservationIgnore = ''/);
  assert.doesNotMatch(content, /nextHost\.dataset\.bskOverlay = ''/);
  assert.match(content, /nextHost\.style\.zIndex = '2147483647'/);
  assert.match(content, /BSK_OVERLAY_Z_INDEX = '2147483646'/);
  assert.match(content, /browserSkillHost\.style\.setProperty\('z-index', BSK_OVERLAY_Z_INDEX, 'important'\)/);
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
  assert.match(wxtConfig, /fileName: "THIRD_PARTY_NOTICES\.md"/);
  assert.match(wxtConfig, /resolve\(here, "\.\.\/THIRD_PARTY_NOTICES\.md"\)/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md')));
});
