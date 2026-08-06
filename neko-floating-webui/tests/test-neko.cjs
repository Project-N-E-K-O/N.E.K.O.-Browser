const { readdirSync } = require('node:fs');
const { resolve } = require('node:path');

const testDirectory = __dirname;

for (const fileName of readdirSync(testDirectory).filter((name) => name.endsWith('.test.cjs')).sort()) {
  require(resolve(testDirectory, fileName));
}
