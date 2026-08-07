const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function runWithParent(fileName, parentOrigin) {
  const source = fs.readFileSync(path.join(projectRoot, fileName), 'utf8');
  const originalGetUserMedia = () => Promise.resolve('original-stream');
  const location = {
    href: 'https://child.example/app?surface=embed',
    origin: 'https://child.example',
    search: '?surface=embed',
    ancestorOrigins: [parentOrigin]
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
    currentScript: {
      getAttribute: (name) => (
        name === 'src' ? `chrome-extension://neko/${fileName}` : null
      )
    },
    referrer: `${parentOrigin}/container`,
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

function collectAuthorizedMainWorldScripts() {
  const source = fs.readFileSync(path.join(projectRoot, 'transparent-page.js'), 'utf8');
  const appendedScripts = [];
  const location = {
    origin: 'https://child.example',
    search: '?surface=embed',
    ancestorOrigins: ['chrome-extension://neko']
  };
  const documentElement = {
    appendChild(element) {
      if (element.tagName === 'SCRIPT') appendedScripts.push(element.src);
    },
    classList: { add() {}, contains: () => false, remove() {} },
    dataset: {},
    style: { setProperty() {} }
  };
  const document = {
    body: null,
    documentElement,
    head: null,
    readyState: 'complete',
    referrer: 'chrome-extension://neko/floating-frame.html',
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        addEventListener() {},
        remove() {}
      };
    },
    getElementById: () => null,
    querySelector: () => null
  };
  const window = {
    location,
    name: '',
    parent: {},
    top: {},
    addEventListener() {},
    clearInterval() {},
    clearTimeout() {},
    innerHeight: 720,
    innerWidth: 1280,
    requestAnimationFrame: () => 1,
    setInterval: () => 1,
    setTimeout: () => 1
  };

  vm.runInNewContext(source, {
    MutationObserver: class { observe() {} },
    URL,
    URLSearchParams,
    chrome: {
      runtime: {
        getURL: (value) => `chrome-extension://neko/${String(value || '').replace(/^\//, '')}`
      }
    },
    document,
    location,
    window
  }, { filename: 'transparent-page.js' });

  return appendedScripts;
}

test('embedded runtime scripts ignore query markers and frame names from ordinary websites', () => {
  const isolated = runWithParent('transparent-page.js', 'https://parent.example');
  assert.equal(isolated.documentElement.dataset.nekoFloatingTransparent, undefined);

  const transparentMain = runWithParent('transparent-main-world.js', 'https://parent.example');
  assert.equal(transparentMain.window.__nekoFloatingTransparentMainWorld, undefined);
  assert.equal(transparentMain.navigator.mediaDevices.getUserMedia, transparentMain.originalGetUserMedia);

  const embeddedMain = runWithParent('embedded-surface-main-world.js', 'https://parent.example');
  assert.equal(embeddedMain.window.__nekoFloatingEmbeddedSurfaceLoaded, undefined);
  assert.equal(embeddedMain.documentElement.dataset.nekoEmbeddedSurface, undefined);
});

test('MAIN-world adapters reject a different extension parent', () => {
  const transparentMain = runWithParent(
    'transparent-main-world.js',
    'chrome-extension://attacker'
  );
  assert.equal(transparentMain.window.__nekoFloatingTransparentMainWorld, undefined);
  assert.equal(transparentMain.navigator.mediaDevices.getUserMedia, transparentMain.originalGetUserMedia);

  const embeddedMain = runWithParent(
    'embedded-surface-main-world.js',
    'chrome-extension://attacker'
  );
  assert.equal(embeddedMain.window.__nekoFloatingEmbeddedSurfaceLoaded, undefined);
  assert.equal(embeddedMain.documentElement.dataset.nekoEmbeddedSurface, undefined);
});

test('the isolated-world guard injects both adapters for its own extension parent', () => {
  assert.deepEqual(collectAuthorizedMainWorldScripts(), [
    'chrome-extension://neko/transparent-main-world.js',
    'chrome-extension://neko/embedded-surface-main-world.js'
  ]);
});
