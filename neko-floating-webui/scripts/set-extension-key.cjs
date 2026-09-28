// Replaces the manifest public key and every place that hardcodes the
// extension ID derived from it. Use the Chrome Web Store item's public key
// (Developer Dashboard → Package → View public key) so unpacked builds share
// the store extension ID.
//
//   node scripts/set-extension-key.cjs "<base64 key>"   (or a path to the .pem)
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(extensionRoot, 'src', 'manifest-base.json');
const idFiles = [
  'transparent-main-world.js',
  'embedded-surface-main-world.js',
  'tests/embedded-target-auth.test.cjs'
];

function deriveExtensionId(publicKey) {
  const digest = crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest();
  return Array.from(digest.subarray(0, 16), (byte) => (
    `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`
  )).join('');
}

function normalizeKey(input) {
  const raw = fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : input;
  const key = raw
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || Buffer.from(key, 'base64').length < 128) {
    throw new Error('Expected a base64 SubjectPublicKeyInfo public key.');
  }
  return key;
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/set-extension-key.cjs "<base64 public key>"');
  process.exit(1);
}

const nextKey = normalizeKey(input);
const manifestSource = fs.readFileSync(manifestPath, 'utf8');
const previousKey = JSON.parse(manifestSource).key;
const previousId = deriveExtensionId(previousKey);
const nextId = deriveExtensionId(nextKey);

fs.writeFileSync(manifestPath, manifestSource.replace(previousKey, nextKey));
for (const relativePath of idFiles) {
  const filePath = path.join(extensionRoot, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes(previousId)) {
    throw new Error(`${relativePath} does not contain the previous extension ID ${previousId}.`);
  }
  fs.writeFileSync(filePath, source.replaceAll(previousId, nextId));
}

console.log(`Extension ID: ${previousId} -> ${nextId}`);
