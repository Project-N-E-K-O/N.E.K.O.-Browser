const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');

const {
  createDiagnosticEnclosingContext,
  createDiagnosticFingerprint,
  compareFingerprintMultisets
} = require('../scripts/runtime-semantic-fingerprint.cjs');

const DEFAULT_CONTEXT = {
  scopes: ['FunctionDeclaration:first#0'],
  syntaxPath: [],
  structuralPath: []
};

function fingerprint(sourceLine, enclosingContext = DEFAULT_CONTEXT) {
  return createDiagnosticFingerprint({
    fileName: 'popup.js',
    code: 2339,
    messageText: "Property 'value' does not exist on type 'Element'.",
    sourceLine,
    enclosingContext
  });
}

test('an incompatible TypeScript compiler fails with an explicit message', () => {
  assert.throws(
    () => createDiagnosticEnclosingContext({}, null, 0),
    /installed TypeScript version is incompatible/
  );
});

test('TypeScript AST context distinguishes the same source line across functions', () => {
  const repeatedLine = 'const value = node.value;';
  const sourceText = [
    'function first() {',
    `  ${repeatedLine}`,
    '}',
    'function second() {',
    `  ${repeatedLine}`,
    '}'
  ].join('\n');
  const sourceFile = ts.createSourceFile(
    'popup.js',
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const firstPosition = sourceText.indexOf('node.value') + 'node.'.length;
  const secondPosition = sourceText.lastIndexOf('node.value') + 'node.'.length;
  const firstContext = createDiagnosticEnclosingContext(ts, sourceFile, firstPosition);
  const secondContext = createDiagnosticEnclosingContext(ts, sourceFile, secondPosition);

  assert.deepEqual(firstContext.scopes, ['FunctionDeclaration:first#0']);
  assert.deepEqual(secondContext.scopes, ['FunctionDeclaration:second#0']);
  assert.notEqual(
    fingerprint(repeatedLine, firstContext),
    fingerprint(repeatedLine, secondContext)
  );
});

test('outer named scopes still distinguish otherwise identical nested functions', () => {
  const repeatedLine = 'const value = node.value;';
  const sourceText = [
    'function first() {',
    `  function target() { ${repeatedLine} }`,
    '}',
    'function second() {',
    `  function target() { ${repeatedLine} }`,
    '}'
  ].join('\n');
  const sourceFile = ts.createSourceFile(
    'popup.js',
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const firstPosition = sourceText.indexOf('node.value') + 'node.'.length;
  const secondPosition = sourceText.lastIndexOf('node.value') + 'node.'.length;
  const firstContext = createDiagnosticEnclosingContext(ts, sourceFile, firstPosition);
  const secondContext = createDiagnosticEnclosingContext(ts, sourceFile, secondPosition);

  assert.deepEqual(firstContext.scopes, [
    'FunctionDeclaration:first#0',
    'FunctionDeclaration:target#0'
  ]);
  assert.deepEqual(secondContext.scopes, [
    'FunctionDeclaration:second#0',
    'FunctionDeclaration:target#0'
  ]);
  assert.notEqual(
    fingerprint(repeatedLine, firstContext),
    fingerprint(repeatedLine, secondContext)
  );
});

test('stable scope ordinals distinguish same-name declarations in one parent scope', () => {
  const repeatedLine = 'const value = node.value;';
  const sourceText = [
    `function duplicate() { ${repeatedLine} }`,
    `function duplicate() { ${repeatedLine} }`
  ].join('\n');
  const sourceFile = ts.createSourceFile(
    'popup.js',
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const firstPosition = sourceText.indexOf('node.value') + 'node.'.length;
  const secondPosition = sourceText.lastIndexOf('node.value') + 'node.'.length;
  const firstContext = createDiagnosticEnclosingContext(ts, sourceFile, firstPosition);
  const secondContext = createDiagnosticEnclosingContext(ts, sourceFile, secondPosition);

  assert.deepEqual(firstContext.scopes, ['FunctionDeclaration:duplicate#0']);
  assert.deepEqual(secondContext.scopes, ['FunctionDeclaration:duplicate#1']);
  assert.notEqual(
    fingerprint(repeatedLine, firstContext),
    fingerprint(repeatedLine, secondContext)
  );
});

test('stable scope ordinals distinguish repeated object methods and property arrows', () => {
  const repeatedLine = 'const value = node.value;';
  const sourceText = [
    'function outer() {',
    `  const first = { handler() { ${repeatedLine} } };`,
    `  const second = { handler() { ${repeatedLine} } };`,
    `  const third = { callback: () => { ${repeatedLine} } };`,
    `  const fourth = { callback: () => { ${repeatedLine} } };`,
    '}'
  ].join('\n');
  const sourceFile = ts.createSourceFile(
    'popup.js',
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const positions = [];
  let offset = 0;
  while ((offset = sourceText.indexOf('node.value', offset)) !== -1) {
    positions.push(offset + 'node.'.length);
    offset += 'node.value'.length;
  }
  const contexts = positions.map((position) => (
    createDiagnosticEnclosingContext(ts, sourceFile, position)
  ));

  assert.deepEqual(contexts[0].scopes, [
    'FunctionDeclaration:outer#0',
    'MethodDeclaration:handler#0'
  ]);
  assert.deepEqual(contexts[1].scopes, [
    'FunctionDeclaration:outer#0',
    'MethodDeclaration:handler#1'
  ]);
  assert.deepEqual(contexts[2].scopes, [
    'FunctionDeclaration:outer#0',
    'ArrowFunction:property:callback#0'
  ]);
  assert.deepEqual(contexts[3].scopes, [
    'FunctionDeclaration:outer#0',
    'ArrowFunction:property:callback#1'
  ]);
  assert.notEqual(
    fingerprint(repeatedLine, contexts[0]),
    fingerprint(repeatedLine, contexts[1])
  );
  assert.notEqual(
    fingerprint(repeatedLine, contexts[2]),
    fingerprint(repeatedLine, contexts[3])
  );
});

test('structural child path distinguishes identical diagnostics in sibling branches', () => {
  const repeatedLine = 'const value = node.value;';
  const sourceText = [
    'function outer(flag) {',
    `  if (flag) { ${repeatedLine} }`,
    `  if (flag) { ${repeatedLine} }`,
    '}'
  ].join('\n');
  const sourceFile = ts.createSourceFile(
    'popup.js',
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const firstPosition = sourceText.indexOf('node.value') + 'node.'.length;
  const secondPosition = sourceText.lastIndexOf('node.value') + 'node.'.length;
  const firstContext = createDiagnosticEnclosingContext(ts, sourceFile, firstPosition);
  const secondContext = createDiagnosticEnclosingContext(ts, sourceFile, secondPosition);

  assert.deepEqual(firstContext.scopes, ['FunctionDeclaration:outer#0']);
  assert.deepEqual(firstContext.syntaxPath, secondContext.syntaxPath);
  assert.notDeepEqual(firstContext.structuralPath, secondContext.structuralPath);
  assert.notEqual(
    fingerprint(repeatedLine, firstContext),
    fingerprint(repeatedLine, secondContext)
  );
});

test('a preceding unrelated function does not change a named function fingerprint', () => {
  const repeatedLine = 'const value = node.value;';
  const originalText = [
    'function target() {',
    `  ${repeatedLine}`,
    '}'
  ].join('\n');
  const insertedText = [
    'function unrelated() { return 42; }',
    originalText
  ].join('\n');
  const originalFile = ts.createSourceFile(
    'popup.js',
    originalText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const insertedFile = ts.createSourceFile(
    'popup.js',
    insertedText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const originalContext = createDiagnosticEnclosingContext(
    ts,
    originalFile,
    originalText.indexOf('node.value') + 'node.'.length
  );
  const insertedContext = createDiagnosticEnclosingContext(
    ts,
    insertedFile,
    insertedText.indexOf('node.value') + 'node.'.length
  );

  assert.deepEqual(insertedContext, originalContext);
  assert.equal(
    fingerprint(repeatedLine, insertedContext),
    fingerprint(repeatedLine, originalContext)
  );
});

test('a different preceding if statement does not change the target fingerprint', () => {
  const repeatedLine = 'const value = node.value;';
  const originalText = [
    'function outer(flag) {',
    `  if (flag) { ${repeatedLine} }`,
    '}'
  ].join('\n');
  const insertedText = [
    'function outer(flag) {',
    '  if (flag === null) { console.warn("missing"); }',
    `  if (flag) { ${repeatedLine} }`,
    '}'
  ].join('\n');
  const originalFile = ts.createSourceFile(
    'popup.js',
    originalText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const insertedFile = ts.createSourceFile(
    'popup.js',
    insertedText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const originalContext = createDiagnosticEnclosingContext(
    ts,
    originalFile,
    originalText.indexOf('node.value') + 'node.'.length
  );
  const insertedContext = createDiagnosticEnclosingContext(
    ts,
    insertedFile,
    insertedText.indexOf('node.value') + 'node.'.length
  );

  assert.deepEqual(insertedContext, originalContext);
  assert.equal(
    fingerprint(repeatedLine, insertedContext),
    fingerprint(repeatedLine, originalContext)
  );
});

test('structural child path distinguishes identical diagnostics in anonymous callbacks', () => {
  const repeatedLine = 'const value = node.value;';
  const sourceText = [
    'function outer(items) {',
    `  items.forEach(() => { ${repeatedLine} });`,
    `  items.forEach(() => { ${repeatedLine} });`,
    '}'
  ].join('\n');
  const sourceFile = ts.createSourceFile(
    'popup.js',
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const firstPosition = sourceText.indexOf('node.value') + 'node.'.length;
  const secondPosition = sourceText.lastIndexOf('node.value') + 'node.'.length;
  const firstContext = createDiagnosticEnclosingContext(ts, sourceFile, firstPosition);
  const secondContext = createDiagnosticEnclosingContext(ts, sourceFile, secondPosition);

  assert.deepEqual(firstContext.scopes, secondContext.scopes);
  assert.deepEqual(firstContext.syntaxPath, secondContext.syntaxPath);
  assert.notDeepEqual(firstContext.structuralPath, secondContext.structuralPath);
  assert.notEqual(
    fingerprint(repeatedLine, firstContext),
    fingerprint(repeatedLine, secondContext)
  );
});

test('equal diagnostic counts report both a replacement and a removal', () => {
  const unchanged = fingerprint('const first = node.value;');
  const replaced = fingerprint('const second = other.value;');
  const baseline = new Map([
    [unchanged, 1],
    [fingerprint('const stable = input.value;'), 1]
  ]);
  const actual = new Map([
    [replaced, 1],
    [fingerprint('const stable = input.value;'), 1]
  ]);
  const difference = compareFingerprintMultisets(baseline, actual);

  assert.notEqual(unchanged, replaced);
  assert.deepEqual([...difference.added], [[replaced, 1]]);
  assert.deepEqual([...difference.removed], [[unchanged, 1]]);
});

test('a net diagnostic count decrease cannot hide a new fingerprint', () => {
  const first = fingerprint('const first = node.value;');
  const second = fingerprint('const second = node.value;');
  const replacement = fingerprint('const replacement = other.value;');
  const difference = compareFingerprintMultisets(
    new Map([[first, 1], [second, 1]]),
    new Map([[replacement, 1]])
  );

  assert.deepEqual([...difference.added], [[replacement, 1]]);
  assert.deepEqual([...difference.removed], [[first, 1], [second, 1]]);
});

test('fingerprint multiset comparison preserves duplicate counts', () => {
  const repeated = fingerprint('const value = node.value;');
  const difference = compareFingerprintMultisets(
    new Map([[repeated, 2]]),
    new Map([[repeated, 1]])
  );

  assert.deepEqual([...difference.added], []);
  assert.deepEqual([...difference.removed], [[repeated, 1]]);
});
