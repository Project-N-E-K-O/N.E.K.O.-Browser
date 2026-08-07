const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function runWithWebParent(fileName) {
  const source = fs.readFileSync(path.join(projectRoot, fileName), 'utf8');
  const originalGetUserMedia = () => Promise.resolve('original-stream');
  const location = {
    href: 'https://child.example/app?surface=embed',
    origin: 'https://child.example',
    search: '?surface=embed',
    ancestorOrigins: ['https://parent.example']
  };
  const documentElement = {
    dataset: {},
    classList: {
      add() {
        throw new Error(`${fileName} mutated an unauthenticated page`);
      }
    }
  };
  const document = {
    referrer: 'https://parent.example/container',
    documentElement
  };
  const window = {
    location,
    name: 'neko-native-sidepanel',
    parent: {},
    top: {}
  };
  const navigator = {
    mediaDevices: { getUserMedia: originalGetUserMedia }
  };

  vm.runInNewContext(source, {
    URL,
    URLSearchParams,
    chrome: {
      runtime: {
        getURL: (value) => `chrome-extension://neko/${String(value || '').replace(/^\//, '')}`
      }
    },
    console,
    document,
    location,
    navigator,
    window
  }, { filename: fileName });

  return { documentElement, navigator, originalGetUserMedia, window };
}

test('embedded runtime scripts ignore query markers and frame names from ordinary websites', () => {
  const isolated = runWithWebParent('transparent-page.js');
  assert.equal(isolated.documentElement.dataset.nekoFloatingTransparent, undefined);

  const transparentMain = runWithWebParent('transparent-main-world.js');
  assert.equal(transparentMain.window.__nekoFloatingTransparentMainWorld, undefined);
  assert.equal(transparentMain.navigator.mediaDevices.getUserMedia, transparentMain.originalGetUserMedia);

  const embeddedMain = runWithWebParent('embedded-surface-main-world.js');
  assert.equal(embeddedMain.window.__nekoFloatingEmbeddedSurfaceLoaded, undefined);
  assert.equal(embeddedMain.documentElement.dataset.nekoEmbeddedSurface, undefined);
});
