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

  const reflowBlock = functionBlock('requestReflow');
  const guards = reflowBlock.match(/isReflowInteractionActive\(\)/g) || [];
  assert.equal(guards.length, 2, 'reflow must check before both synthetic resize events');
  assert.ok(
    reflowBlock.indexOf('isReflowInteractionActive()')
      < reflowBlock.indexOf("window.dispatchEvent(new Event('resize'))"),
    'the synchronous resize must be guarded'
  );
  assert.match(reflowBlock, /requestAnimationFrame\(\(\) => \{[\s\S]*?isReflowInteractionActive\(\)[\s\S]*?dispatchEvent/);
});
