const path = require('node:path');
const ts = require('typescript');
const semanticBaseline = require('./runtime-semantic-baseline.json');

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

const semanticCounts = new Map();
for (const diagnostic of semanticDiagnostics) {
  if (!ratchetedSemanticCodes.has(diagnostic.code) || !diagnostic.file) continue;
  const fileName = path.relative(projectRoot, diagnostic.file.fileName).replaceAll('\\', '/');
  const key = `${fileName}:${diagnostic.code}`;
  semanticCounts.set(key, (semanticCounts.get(key) || 0) + 1);
}

for (const fileName of runtimeFiles) {
  for (const code of ratchetedSemanticCodes) {
    const expected = Number(semanticBaseline[fileName]?.[code] || 0);
    const actual = semanticCounts.get(`${fileName}:${code}`) || 0;
    if (actual === expected) continue;
    const action = actual < expected
      ? 'lower the checked-in baseline to preserve the improvement'
      : 'fix the new diagnostics instead of increasing the checked-in baseline';
    diagnostics.push({
      category: ts.DiagnosticCategory.Error,
      code,
      file: undefined,
      start: undefined,
      length: undefined,
      messageText: `${fileName} diagnostic TS${code} count changed from ${expected} to ${actual}; ${action}.`
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
