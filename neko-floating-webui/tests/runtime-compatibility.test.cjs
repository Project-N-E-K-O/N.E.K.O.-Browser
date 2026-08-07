const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const lockfile = fs.readFileSync(path.join(projectRoot, 'pnpm-lock.yaml'), 'utf8');
const readme = fs.readFileSync(path.resolve(projectRoot, '..', 'README.md'), 'utf8');

test('the project Node range covers the complete build and test dependency graph', () => {
  const listr2Entry = lockfile.match(
    /^ {2}listr2@10\.2\.2:\r?\n(?:(?!^ {2}\S)[\s\S])*/m
  );
  assert.notEqual(listr2Entry, null);
  assert.match(listr2Entry[0], /^ {4}engines: \{node: '>=22\.13\.0'\}/m);
  assert.equal(packageJson.engines.node, '^22.13.0 || >=24.0.0');
  assert.match(readme, /22\.13\.0–22\.x 或 24\.0\.0 及以上/);
  assert.doesNotMatch(packageJson.engines.node, /\^20\./);
});
