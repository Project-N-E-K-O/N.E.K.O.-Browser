const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'transparent-page.js'), 'utf8');

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
  assert.notEqual(end, -1, `missing ${nextName}`);
  return source.slice(start, end);
}

test('synthetic reflow pauses while any known floating surface owns geometry', () => {
  const activeBlock = functionBlock('isReflowInteractionActive', 'ensureRuntimeStyle');
  for (const marker of [
    'react-chat-window-dragging',
    'react-chat-window-resizing',
    'neko-model-dragging',
    'neko-agent-hud-dragging',
    'jukebox-dragging',
    '#subtitle-display.dragging',
    '#subtitle-display.resizing',
    '#chat-container.dragging',
    '#chat-container.is-resizing',
    '.card-companion-dragging',
    '[data-dragging="true"]',
    '[data-neko-cat1-playground-dragging]'
  ]) {
    assert.ok(activeBlock.includes(marker), `missing interaction marker: ${marker}`);
  }

  const reflowBlock = functionBlock('requestReflow', 'scheduleReflowRetry');
  const guards = reflowBlock.match(/isReflowInteractionActive\(\)/g) || [];
  assert.equal(guards.length, 2, 'reflow must check both before scheduling and before delivery');
  assert.equal(
    (reflowBlock.match(/scheduleReflowRetry\(\)/g) || []).length,
    2,
    'both interaction guards must preserve a forced reflow'
  );
  assert.match(reflowBlock, /if \(force\)[\s\S]*?forcedReflowPending = true/);
  assert.match(reflowBlock, /forcedReflowStartedAt = Date\.now\(\)/);
  assert.match(reflowBlock, /!forcedReflowPending[\s\S]*?width === lastReflowWidth[\s\S]*?height === lastReflowHeight/);
  assert.match(reflowBlock, /if \(reflowFrame\)/);
  assert.match(reflowBlock, /requestAnimationFrame\(\(\) => \{[\s\S]*?isReflowInteractionActive\(\)/);
  assert.match(reflowBlock, /NEKO_FLOATING_WEBUI_MAIN_WORLD_REFLOW/);
  assert.doesNotMatch(reflowBlock, /dispatchEvent\(new Event\('resize'\)\)/);
  assert.ok(
    reflowBlock.indexOf('lastReflowWidth = width')
      > reflowBlock.lastIndexOf('isReflowInteractionActive()'),
    'dimensions must only be recorded after the guarded reflow is delivered'
  );

  const retryBlock = functionBlock('scheduleReflowRetry', 'clearForcedReflowState');
  assert.match(retryBlock, /reflowRetryTimer \|\| !forcedReflowPending/);
  assert.match(retryBlock, /REFLOW_RETRY_MAX_WAIT_MS - \(Date\.now\(\) - forcedReflowStartedAt\)/);
  assert.match(retryBlock, /if \(remainingWait <= 0\)[\s\S]*?clearForcedReflowState\(\)/);
  assert.match(retryBlock, /window\.setTimeout/);
  assert.match(retryBlock, /Date\.now\(\) - forcedReflowStartedAt[\s\S]*?REFLOW_RETRY_MAX_WAIT_MS/);
  assert.match(retryBlock, /Math\.min\(REFLOW_RETRY_INTERVAL_MS, remainingWait\)/);
  assert.match(retryBlock, /requestReflow\(\)/);

  const clearBlock = functionBlock('clearForcedReflowState');
  assert.match(clearBlock, /forcedReflowPending = false/);
  assert.match(clearBlock, /forcedReflowStartedAt = 0/);
  assert.match(clearBlock, /window\.clearTimeout\(reflowRetryTimer\)/);
  assert.match(source, /const REFLOW_RETRY_MAX_WAIT_MS = 10000/);
});

test('periodic transparency maintenance does not create a resize storm', () => {
  assert.match(source, /let lastReflowWidth = -1/);
  assert.match(source, /let lastReflowHeight = -1/);
  assert.match(source, /requestReflow\(event\.data\.force === true\)/);
  assert.match(source, /const intervalId = window\.setInterval\(\(\) => \{[\s\S]*?requestReflow\(\)/);
  assert.equal(
    (source.match(/dispatchEvent\(new Event\('resize'\)\)/g) || []).length,
    0,
    'the isolated adapter must delegate one coalesced resize to the main-world adapter'
  );
});
