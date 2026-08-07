const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sidepanelSource = fs.readFileSync(path.resolve(__dirname, '..', 'sidepanel.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createElement(initial = {}) {
  return {
    addEventListener() {},
    dataset: {},
    hidden: false,
    removeAttribute() {},
    setAttribute() {},
    ...initial
  };
}

function createFrame() {
  const attributes = new Set();
  let src = '';
  return createElement({
    contentWindow: { postMessage() {} },
    hasAttribute: (name) => attributes.has(name),
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'src') src = '';
    },
    get src() {
      return src;
    },
    set src(value) {
      src = value;
      attributes.add('src');
    }
  });
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test('side panel ignores a stale health response after the frontend address changes', async () => {
  const frame = createFrame();
  const statusDot = createElement();
  const offline = createElement({ hidden: true });
  const offlineMessage = createElement({ textContent: '' });
  const routes = createElement({ hidden: true });
  const shell = createElement();
  const menuButton = createElement({ focus() {} });
  let storageListener = null;
  let state = {
    activeSidePanelWindowId: 7,
    displayMode: 'sidebar',
    webuiUrl: 'http://old.example/'
  };
  const healthRequests = [];

  const document = {
    addEventListener() {},
    getElementById(id) {
      return {
        webui: frame,
        status: statusDot,
        offline,
        'offline-message': offlineMessage,
        routes
      }[id];
    },
    querySelector(selector) {
      return selector === '.shell' ? shell : menuButton;
    }
  };
  const window = {
    addEventListener() {},
    clearTimeout,
    matchMedia: () => ({ addEventListener() {}, matches: false }),
    setTimeout
  };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        if (message.type === 'NEKO_SIDEBAR_CLAIM') {
          return { ok: true, owner: true, state };
        }
        if (message.type === 'NEKO_GET_STATE') {
          return state;
        }
        if (message.type === 'NEKO_HEALTH_CHECK') {
          const request = deferred();
          healthRequests.push(request);
          return request.promise;
        }
        return { ok: true };
      }
    },
    storage: {
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        }
      }
    },
    windows: {
      async getCurrent() {
        return { id: 7 };
      }
    }
  };

  vm.runInNewContext(sidepanelSource, {
    URL,
    chrome,
    console,
    document,
    setTimeout,
    window
  }, { filename: 'sidepanel.js' });

  await flushAsyncWork();
  assert.equal(healthRequests.length, 1);

  state = { ...state, webuiUrl: 'http://new.example/' };
  storageListener({ webuiUrl: { newValue: state.webuiUrl } }, 'local');
  await flushAsyncWork();
  assert.equal(healthRequests.length, 2);

  healthRequests[1].resolve({ online: true });
  await flushAsyncWork();
  assert.equal(statusDot.dataset.state, 'online');
  assert.equal(offline.hidden, true);

  healthRequests[0].resolve({ online: false });
  await flushAsyncWork();
  assert.equal(statusDot.dataset.state, 'online');
  assert.equal(offline.hidden, true);
});
