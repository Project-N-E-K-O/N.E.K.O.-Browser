const { readdirSync } = require('node:fs');
const { resolve } = require('node:path');

for (const fileName of readdirSync(__dirname).filter((name) => name.endsWith('.test.cjs')).sort()) {
  require(resolve(__dirname, fileName));
}
