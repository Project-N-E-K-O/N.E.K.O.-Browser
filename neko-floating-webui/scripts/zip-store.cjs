// Builds the Chrome Web Store package: same output as `pnpm build`, but the
// manifest omits `key` (the store rejects it) and WXT zips dist/chrome-mv3.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');

const result = spawnSync('wxt', ['zip'], {
  cwd: extensionRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, NEKO_STORE_BUILD: '1' }
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, 'dist', 'chrome-mv3', 'manifest.json'), 'utf8')
);
if ('key' in manifest) {
  console.error('Store package manifest still contains "key"; the Chrome Web Store will reject it.');
  process.exit(1);
}
const zips = fs.readdirSync(path.join(extensionRoot, 'dist')).filter((name) => (
  name.endsWith(`-${manifest.version}-chrome.zip`)
));
console.log(`\nChrome Web Store package ready: ${zips.map((name) => `dist/${name}`).join(', ')}`);
console.log('Note: dist/chrome-mv3 is now keyless; run `pnpm build` again before loading it unpacked.');
