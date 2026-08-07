const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src/manifest-base.json'), 'utf8'));
const NEKO_EXTENSION_ID = 'ndkhbmbopodofbilnhiicejdihjpfebj';
const NEKO_EXTENSION_ORIGIN = `chrome-extension://${NEKO_EXTENSION_ID}`;
const ATTACKER_EXTENSION_ORIGIN = `chrome-extension://${'b'.repeat(32)}`;

function deriveExtensionId(publicKey) {
  const digest = crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest();
  return Array.from(digest.subarray(0, 16), (byte) => (
    `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`
  )).join('');
}

function runMainWorld(fileName, {
  parentOrigin = NEKO_EXTENSION_ORIGIN,
  name = '',
  search = '?surface=embed',
  referrer = '',
  topLevel = false
} = {}) {
  const source = fs.readFileSync(path.join(projectRoot, fileName), 'utf8');
  const posts = [];
  const dispatched = [];
  const classes = new Set();
  const location = {
    href: `https://child.example/app${search}`,
    origin: 'https://child.example',
    search,
    ancestorOrigins: [parentOrigin]
  };
  const documentElement = {
    dataset: {},
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      toggle: (value, enabled) => (enabled ? classes.add(value) : classes.delete(value))
    },
    setAttribute() {},
    removeAttribute() {},
    style: { setProperty() {} }
  };
  const parent = { postMessage: (...args) => posts.push(args) };
  const document = {
    body: null,
    documentElement,
    referrer,
    currentScript: { src: `${NEKO_EXTENSION_ORIGIN}/${fileName}` },
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const window = {
    location,
    name,
    parent,
    top: {},
    addEventListener() {},
    dispatchEvent: (event) => dispatched.push(event),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1
  };
  if (topLevel) window.top = window;
  const originalGetUserMedia = () => Promise.resolve('original-stream');
  const navigator = { mediaDevices: { getUserMedia: originalGetUserMedia } };
  class TestEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  }

  vm.runInNewContext(source, {
    URL,
    URLSearchParams,
    console,
    document,
    location,
    navigator,
    window,
    MutationObserver: class { observe() {} },
    CustomEvent: TestEvent,
    Event: TestEvent,
    performance: { now: () => 0 }
  }, { filename: `${NEKO_EXTENSION_ORIGIN}/${fileName}` });

  return {
    classes,
    dispatched,
    documentElement,
    navigator,
    originalGetUserMedia,
    posts,
    window
  };
}

function runIsolatedWithParent(parentOrigin) {
  const fileName = 'transparent-page.js';
  const source = fs.readFileSync(path.join(projectRoot, fileName), 'utf8');
  const location = {
    href: 'https://child.example/app?surface=embed',
    origin: 'https://child.example',
    search: '?surface=embed',
    ancestorOrigins: [parentOrigin]
  };
  const documentElement = { dataset: {}, classList: { add() {} } };
  const document = {
    referrer: `${parentOrigin}/container`,
    documentElement
  };
  const window = {
    location,
    name: '',
    parent: {},
    top: {}
  };

  vm.runInNewContext(source, {
    URL,
    URLSearchParams,
    chrome: { runtime: { getURL: () => `${NEKO_EXTENSION_ORIGIN}/` } },
    console,
    document,
    location,
    window
  }, { filename: fileName });
  return { documentElement, window };
}

test('manifest public key and MAIN-world trust anchors resolve to the same stable extension ID', () => {
  assert.equal(deriveExtensionId(manifest.key), NEKO_EXTENSION_ID);
  for (const fileName of ['transparent-main-world.js', 'embedded-surface-main-world.js']) {
    const source = fs.readFileSync(path.join(projectRoot, fileName), 'utf8');
    assert.match(source, new RegExp(`const NEKO_EXTENSION_ORIGIN = '${NEKO_EXTENSION_ORIGIN}'`));
    assert.match(source, /window\.location\.ancestorOrigins\?\.\[0\] === NEKO_EXTENSION_ORIGIN/);
    assert.doesNotMatch(source, /error\??\.stack|prepareStackTrace|resolveInjectedExtensionOrigin/);
    assert.doesNotMatch(source, /document\.currentScript|document\.referrer/);
  }
});

test('MAIN-world adapters execute for the extension-owned floating frame', () => {
  const transparent = runMainWorld('transparent-main-world.js');
  assert.equal(transparent.window.__nekoFloatingTransparentMainWorld, true);
  assert.equal(transparent.documentElement.dataset.nekoFloatingTransparentMainWorld, 'enabled');
  assert.notEqual(transparent.navigator.mediaDevices.getUserMedia, transparent.originalGetUserMedia);

  const embedded = runMainWorld('embedded-surface-main-world.js');
  assert.equal(embedded.window.__nekoFloatingEmbeddedSurfaceLoaded, true);
  assert.ok(embedded.classes.has('neko-embedded-surface'));
  assert.equal(embedded.documentElement.dataset.nekoEmbeddedSurface, 'true');
  assert.ok(embedded.posts.some(([message, targetOrigin]) => (
    message.type === 'NEKO_EMBED_READY' && targetOrigin === NEKO_EXTENSION_ORIGIN
  )));
});

test('native side panel runs only the transparent MAIN-world adapter', () => {
  const transparent = runMainWorld('transparent-main-world.js', {
    name: 'neko-native-sidepanel',
    search: ''
  });
  assert.equal(transparent.window.__nekoFloatingTransparentMainWorld, true);
  assert.equal(transparent.documentElement.dataset.nekoNativeSidePanel, 'enabled');
  assert.equal(transparent.navigator.mediaDevices.getUserMedia, transparent.originalGetUserMedia);

  const embedded = runMainWorld('embedded-surface-main-world.js', {
    name: 'neko-native-sidepanel',
    search: ''
  });
  assert.equal(embedded.window.__nekoFloatingEmbeddedSurfaceLoaded, undefined);
});

test('ordinary pages, top-level pages, and a different extension parent are rejected', () => {
  const isolated = runIsolatedWithParent('https://parent.example');
  assert.equal(isolated.documentElement.dataset.nekoFloatingTransparent, undefined);

  for (const fileName of ['transparent-main-world.js', 'embedded-surface-main-world.js']) {
    const ordinary = runMainWorld(fileName, { parentOrigin: 'https://parent.example' });
    const attacker = runMainWorld(fileName, {
      parentOrigin: ATTACKER_EXTENSION_ORIGIN,
      referrer: `${NEKO_EXTENSION_ORIGIN}/floating-frame.html`
    });
    const topLevel = runMainWorld(fileName, { topLevel: true });
    const marker = fileName === 'transparent-main-world.js'
      ? '__nekoFloatingTransparentMainWorld'
      : '__nekoFloatingEmbeddedSurfaceLoaded';
    assert.equal(ordinary.window[marker], undefined);
    assert.equal(attacker.window[marker], undefined);
    assert.equal(topLevel.window[marker], undefined);
  }
});
