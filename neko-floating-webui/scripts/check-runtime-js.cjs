const path = require('node:path');
const ts = require('typescript');
const semanticBaseline = require('./runtime-semantic-baseline.json');
const {
  createDiagnosticEnclosingContext,
  createDiagnosticFingerprint,
  compareFingerprintMultisets
} = require('./runtime-semantic-fingerprint.cjs');

const projectRoot = path.resolve(__dirname, '..');
const runtimeFiles = [
  'background.js',
  'content.js',
  'embedded-surface-main-world.js',
  'floating-frame.js',
  'mic-permission.js',
  'offscreen.js',
  'pcm-audio-worklet.js',
  'popup.js',
  'sidepanel.js',
  'transparent-main-world.js',
  'transparent-page.js'
];
const checkedSemanticCodes = new Set([
  // The browser entrypoints intentionally use dynamic DOM/Chrome APIs. Keep the
  // signal high while still rejecting the mistakes that make raw scripts fail.
  2304, // Cannot find name.
  2552, // Cannot find name; did you mean ...?
  6133, // Declared but never read.
  6196, // Declared but never used.
  7027, // Unreachable code detected.
  18004, // Shorthand property has no value in scope.
  2322, // Type is not assignable.
  2339, // Property does not exist on type.
  2345 // Argument is not assignable to parameter.
]);
const ratchetedSemanticCodes = new Set([2322, 2339, 2345]);
const printSemanticBaseline = process.argv.includes('--print-semantic-baseline');

const program = ts.createProgram({
  rootNames: [
    ...runtimeFiles.map((file) => path.resolve(projectRoot, file)),
    path.resolve(projectRoot, 'src/runtime-globals.d.ts')
  ],
  options: {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    noUnusedLocals: true,
    allowUnreachableCode: false,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['chrome']
  }
});

const semanticDiagnostics = program.getSemanticDiagnostics().filter((diagnostic) => (
  checkedSemanticCodes.has(diagnostic.code)
));
const diagnostics = [
  ...program.getSyntacticDiagnostics(),
  ...semanticDiagnostics.filter((diagnostic) => !ratchetedSemanticCodes.has(diagnostic.code))
];

function getRelativeFileName(diagnostic) {
  if (!diagnostic.file) return '';
  return path.relative(projectRoot, diagnostic.file.fileName).replaceAll('\\', '/');
}

function getDiagnosticSourceLine(diagnostic) {
  if (!diagnostic.file || diagnostic.start === undefined) return '';
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const lineStart = diagnostic.file.getPositionOfLineAndCharacter(line, 0);
  const lineEnd = line + 1 < diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.file.getEnd()
  ).line + 1
    ? diagnostic.file.getPositionOfLineAndCharacter(line + 1, 0)
    : diagnostic.file.getEnd();
  return diagnostic.file.text.slice(lineStart, lineEnd).trim().replace(/\s+/g, ' ');
}

function getDiagnosticEnclosingContext(diagnostic) {
  if (!diagnostic.file || diagnostic.start === undefined) return null;
  return createDiagnosticEnclosingContext(ts, diagnostic.file, diagnostic.start);
}

function getSemanticFingerprint(diagnostic) {
  return createDiagnosticFingerprint({
    fileName: getRelativeFileName(diagnostic),
    code: diagnostic.code,
    messageText: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      .replace(/\s+/g, ' ')
      .trim(),
    sourceLine: getDiagnosticSourceLine(diagnostic),
    enclosingContext: getDiagnosticEnclosingContext(diagnostic)
  });
}

const semanticFingerprints = new Map();
for (const diagnostic of semanticDiagnostics) {
  if (!ratchetedSemanticCodes.has(diagnostic.code) || !diagnostic.file) continue;
  const fileName = getRelativeFileName(diagnostic);
  const fingerprint = getSemanticFingerprint(diagnostic);
  const key = `${fileName}\0${diagnostic.code}\0${fingerprint}`;
  const entry = semanticFingerprints.get(key) || {
    fileName,
    code: diagnostic.code,
    fingerprint,
    diagnostics: [],
    count: 0
  };
  entry.count += 1;
  entry.diagnostics.push(diagnostic);
  semanticFingerprints.set(key, entry);
}

function createSemanticGroups() {
  const groups = new Map();
  for (const entry of semanticFingerprints.values()) {
    const key = `${entry.fileName}\0${entry.code}`;
    const group = groups.get(key) || {
      fileName: entry.fileName,
      code: entry.code,
      count: 0,
      fingerprintCounts: new Map(),
      fingerprintDiagnostics: new Map()
    };
    group.count += entry.count;
    group.fingerprintCounts.set(entry.fingerprint, entry.count);
    group.fingerprintDiagnostics.set(entry.fingerprint, entry.diagnostics);
    groups.set(key, group);
  }
  return groups;
}

const semanticGroups = createSemanticGroups();

function serializeSemanticBaseline() {
  const serialized = { version: 2, diagnostics: {} };
  const groups = [...semanticGroups.values()].sort((left, right) => (
    left.fileName.localeCompare(right.fileName) || left.code - right.code
  ));
  for (const group of groups) {
    const fileDiagnostics = serialized.diagnostics[group.fileName] ||= {};
    fileDiagnostics[group.code] = {
      fingerprints: Object.fromEntries(
        [...group.fingerprintCounts].sort(([left], [right]) => left.localeCompare(right))
      )
    };
  }
  return serialized;
}

if (printSemanticBaseline) {
  process.stdout.write(`${JSON.stringify(serializeSemanticBaseline(), null, 2)}\n`);
  process.exit(0);
}

const expectedGroups = new Map();
if (semanticBaseline.version !== 2 || !semanticBaseline.diagnostics) {
  diagnostics.push({
    category: ts.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    start: undefined,
    length: undefined,
    messageText: 'runtime-semantic-baseline.json must use fingerprint multiset baseline version 2.'
  });
} else {
  for (const [fileName, codes] of Object.entries(semanticBaseline.diagnostics)) {
    for (const [codeText, baselineGroup] of Object.entries(codes)) {
      const code = Number(codeText);
      const key = `${fileName}\0${code}`;
      expectedGroups.set(key, {
        fileName,
        code,
        fingerprintCounts: new Map(
          Object.entries(baselineGroup.fingerprints || {}).map(([fingerprint, count]) => (
            [fingerprint, Number(count)]
          ))
        )
      });
    }
  }
}

for (const entry of expectedGroups.values()) {
  if (!runtimeFiles.includes(entry.fileName) || !ratchetedSemanticCodes.has(entry.code)) {
    diagnostics.push({
      category: ts.DiagnosticCategory.Error,
      code: entry.code,
      file: undefined,
      start: undefined,
      length: undefined,
      messageText: `Fingerprint baseline contains unsupported entry ${entry.fileName}:TS${entry.code}.`
    });
  }
}

const semanticGroupKeys = new Set([...expectedGroups.keys(), ...semanticGroups.keys()]);
for (const key of semanticGroupKeys) {
  const expected = expectedGroups.get(key);
  const actual = semanticGroups.get(key);
  const fileName = actual?.fileName || expected.fileName;
  const code = actual?.code || expected.code;
  const difference = compareFingerprintMultisets(
    expected?.fingerprintCounts || new Map(),
    actual?.fingerprintCounts || new Map()
  );

  for (const [fingerprint, count] of difference.added) {
    const addedDiagnostics = actual.fingerprintDiagnostics.get(fingerprint) || [];
    diagnostics.push(...addedDiagnostics.slice(0, count));
    diagnostics.push({
      category: ts.DiagnosticCategory.Error,
      code,
      file: undefined,
      start: undefined,
      length: undefined,
      messageText: `${fileName} has ${count} new TS${code} diagnostic fingerprint ${fingerprint}; fix the located diagnostic instead of adding it to the baseline.`
    });
  }

  for (const [fingerprint, count] of difference.removed) {
    diagnostics.push({
      category: ts.DiagnosticCategory.Error,
      code,
      file: undefined,
      start: undefined,
      length: undefined,
      messageText: `${fileName} resolved ${count} baseline TS${code} diagnostic fingerprint ${fingerprint}; remove that fingerprint from the checked-in baseline to preserve the improvement.`
    });
  }
}

if (diagnostics.length > 0) {
  const host = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => '\n'
  };
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${runtimeFiles.length} runtime JavaScript files.\n`);
}
