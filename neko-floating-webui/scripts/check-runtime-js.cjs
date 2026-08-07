const path = require('node:path');
const ts = require('typescript');

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
  18004 // Shorthand property has no value in scope.
]);

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

const diagnostics = [
  ...program.getSyntacticDiagnostics(),
  ...program.getSemanticDiagnostics().filter((diagnostic) => (
    checkedSemanticCodes.has(diagnostic.code)
  ))
];

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
