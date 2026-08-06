const assert = require('node:assert/strict');

function extractFunction(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:async\\s+)?function\\s+${escapedName}\\s*\\(`).exec(source);
  assert.notEqual(match, null, `missing function ${name}`);

  const start = match.index;
  const firstBrace = source.indexOf('{', start);
  assert.notEqual(firstBrace, -1, `missing function body ${name}`);

  // Let the JavaScript parser identify the first complete function expression.
  // This remains correct when strings, templates, regexes, or comments contain braces.
  for (let index = firstBrace; index < source.length; index += 1) {
    if (source[index] !== '}') continue;
    const candidate = source.slice(start, index + 1);
    try {
      Function(`return (${candidate});`);
      return candidate;
    } catch {}
  }

  throw new Error(`unterminated function ${name}`);
}

module.exports = { extractFunction };
