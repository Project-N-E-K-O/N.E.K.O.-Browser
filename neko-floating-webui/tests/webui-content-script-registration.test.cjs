const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./helpers/extract-function.cjs');

const projectRoot = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(projectRoot, 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src/manifest-base.json'), 'utf8'));
const DEFAULT_STATE = { webuiUrl: 'http://localhost:48911/' };
const SCRIPT_IDS = [
  'neko-webui-isolated-adapter',
  'neko-webui-main-world-adapters'
];

const createHarness = new Function(
  'scripting',
  'DEFAULT_STATE',
  'WEBUI_CONTENT_SCRIPT_IDS',
  `${extractFunction(background, 'normalizeNekoUrl')}
   ${extractFunction(background, 'createWebuiContentScriptRegistrations')}
   ${extractFunction(background, 'contentScriptRegistrationMatches')}
   ${extractFunction(background, 'createWebuiContentScriptRegistrar')}
   return {
     build: createWebuiContentScriptRegistrations,
     sync: createWebuiContentScriptRegistrar(scripting)
   };`
);
const createPreparationHarness = new Function(
  'initialStoredUrl',
  'webuiContentScriptRegistrationReady',
  'syncWebuiContentScripts',
  'DEFAULT_STATE',
  `let webuiUrlTransition = Promise.resolve();
   let storedWebuiUrl = initialStoredUrl;
   async function getStoredState() {
     return { webuiUrl: storedWebuiUrl };
   }
   ${extractFunction(background, 'normalizeNekoUrl')}
   ${extractFunction(background, 'queueWebuiUrlTransition')}
   ${extractFunction(background, 'prepareWebuiContentScripts')}
   return {
     prepare: prepareWebuiContentScripts,
     queue: queueWebuiUrlTransition,
     setStored: (value) => { storedWebuiUrl = value; },
     getStored: () => storedWebuiUrl
   };`
);
const createSetHarness = new Function(
  'initialStoredUrl',
  'syncWebuiContentScripts',
  'DEFAULT_STATE',
  'storageSetError',
  `let webuiUrlTransition = Promise.resolve();
   let storedWebuiUrl = initialStoredUrl;
   const storageWrites = [];
   const webuiContentScriptRegistrationReady = Promise.resolve();
   const chrome = {
     storage: {
       local: {
         async set(update) {
           storageWrites.push({ ...update });
           if (storageSetError) {
             throw storageSetError;
           }
           if (Object.prototype.hasOwnProperty.call(update, 'webuiUrl')) {
             storedWebuiUrl = update.webuiUrl;
           }
         }
       }
     }
   };
   async function getStoredState() {
     return { webuiUrl: storedWebuiUrl, activeTabId: null };
   }
   async function getLiveActiveTabId() {
     return null;
   }
   ${extractFunction(background, 'normalizeNekoUrl')}
   ${extractFunction(background, 'queueWebuiUrlTransition')}
   ${extractFunction(background, 'prepareWebuiContentScripts')}
   ${extractFunction(background, 'setWebuiUrl')}
   return {
     prepare: prepareWebuiContentScripts,
     setWebuiUrl,
     getStored: () => storedWebuiUrl,
     storageWrites
   };`
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createScripting(initial = []) {
  const registrations = new Map(initial.map((entry) => [entry.id, clone(entry)]));
  const calls = [];
  return {
    calls,
    registrations,
    async getRegisteredContentScripts(filter) {
      calls.push(['get', clone(filter)]);
      return filter.ids
        .filter((id) => registrations.has(id))
        .map((id) => clone(registrations.get(id)));
    },
    async registerContentScripts(entries) {
      calls.push(['register', clone(entries)]);
      entries.forEach((entry) => registrations.set(entry.id, clone(entry)));
    },
    async updateContentScripts(entries) {
      calls.push(['update', clone(entries)]);
      entries.forEach((entry) => registrations.set(entry.id, clone(entry)));
    }
  };
}

function harnessFor(scripting) {
  return createHarness(scripting, DEFAULT_STATE, SCRIPT_IDS);
}

test('manifest leaves WebUI adapters to target-scoped dynamic registrations', () => {
  const staticFiles = (manifest.content_scripts || []).flatMap((entry) => [
    ...(entry.js || []),
    ...(entry.css || [])
  ]);
  for (const fileName of [
    'transparent-page.js',
    'transparent-page.css',
    'embedded-surface.css',
    'transparent-main-world.js',
    'embedded-surface-main-world.js'
  ]) {
    assert.ok(!staticFiles.includes(fileName), `${fileName} must not be globally registered`);
  }
});

test('registration builder scopes both worlds to the configured WebUI origin', () => {
  const { build } = harnessFor(createScripting());
  const registrations = build('http://localhost:48911/app');
  assert.deepEqual(registrations, [
    {
      id: SCRIPT_IDS[0],
      matches: ['http://localhost:48911/*'],
      css: ['transparent-page.css', 'embedded-surface.css'],
      js: ['transparent-page.js'],
      allFrames: true,
      persistAcrossSessions: true,
      runAt: 'document_start',
      world: 'ISOLATED'
    },
    {
      id: SCRIPT_IDS[1],
      matches: ['http://localhost:48911/*'],
      js: ['transparent-main-world.js', 'embedded-surface-main-world.js'],
      allFrames: true,
      persistAcrossSessions: true,
      runAt: 'document_start',
      world: 'MAIN'
    }
  ]);
  assert.notDeepEqual(
    build('http://localhost:48912/')[0].matches,
    registrations[0].matches,
    'different ports must produce different match patterns'
  );
  assert.deepEqual(build('http://webui.example/')[0].matches, ['http://webui.example:80/*']);
  assert.deepEqual(build('https://webui.example/')[0].matches, ['https://webui.example:443/*']);
  assert.deepEqual(
    build('https://webui.example:444/')[0].matches,
    ['https://webui.example:444/*']
  );
});

test('registrar creates missing scripts, updates stale scripts, and skips identical scripts', async () => {
  const scripting = createScripting();
  const { build, sync } = harnessFor(scripting);

  await sync('https://webui.example:8443/');
  assert.deepEqual(scripting.calls.map(([name]) => name), ['get', 'register']);
  assert.deepEqual(
    scripting.calls[0][1],
    { ids: SCRIPT_IDS },
    'queries must stay scoped to N.E.K.O registrations'
  );

  scripting.calls.length = 0;
  await sync('https://webui.example:9443/');
  assert.deepEqual(scripting.calls.map(([name]) => name), ['get', 'update']);
  assert.deepEqual(
    scripting.calls[1][1].map((entry) => entry.matches),
    [['https://webui.example:9443/*'], ['https://webui.example:9443/*']]
  );

  scripting.calls.length = 0;
  await sync('https://webui.example:9443/');
  assert.deepEqual(scripting.calls.map(([name]) => name), ['get']);
  assert.deepEqual(
    Array.from(scripting.registrations.values()),
    build('https://webui.example:9443/')
  );
});

test('registrar serializes URL changes and recovers after an API failure', async () => {
  let releaseFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => { markFirstEntered = resolve; });
  let getCalls = 0;
  const scripting = createScripting();
  const originalGet = scripting.getRegisteredContentScripts;
  scripting.getRegisteredContentScripts = async function getRegisteredContentScripts(filter) {
    getCalls += 1;
    if (getCalls === 1) {
      markFirstEntered();
      await new Promise((resolve) => { releaseFirst = resolve; });
      throw new Error('transient failure');
    }
    return originalGet.call(this, filter);
  };
  const { sync } = harnessFor(scripting);

  const first = sync('http://old.example:4800/');
  const second = sync('http://new.example:4900/');
  await firstEntered;
  assert.equal(getCalls, 1, 'the second sync must wait for the first');
  releaseFirst();
  await assert.rejects(first, /transient failure/);
  await second;
  assert.equal(getCalls, 2);
  for (const registration of scripting.registrations.values()) {
    assert.deepEqual(registration.matches, ['http://new.example:4900/*']);
  }
});

test('a no-argument prepare waits for an in-flight URL commit', async () => {
  let releaseCommit;
  const synced = [];
  const harness = createPreparationHarness(
    'http://old.example:4800/',
    Promise.resolve(),
    async (value) => { synced.push(value); },
    DEFAULT_STATE
  );

  const commit = harness.queue(async () => {
    await new Promise((resolve) => { releaseCommit = resolve; });
    harness.setStored('http://new.example:4900/');
  });
  const prepared = harness.prepare();
  await Promise.resolve();
  assert.deepEqual(synced, [], 'prepare must not read storage before the commit finishes');
  releaseCommit();

  await commit;
  assert.equal(await prepared, 'http://new.example:4900/');
  assert.deepEqual(synced, ['http://new.example:4900/']);
  assert.equal(harness.getStored(), 'http://new.example:4900/');
});

test('a failed URL registration restores the persisted registration and leaves storage unchanged', async () => {
  const oldUrl = 'http://old.example:4800/';
  const newUrl = 'http://new.example:4900/';
  const syncCalls = [];
  let registeredUrl = oldUrl;
  let failNewRegistration = true;
  const harness = createSetHarness(
    oldUrl,
    async (value) => {
      syncCalls.push(value);
      registeredUrl = value;
      if (value === newUrl && failNewRegistration) {
        failNewRegistration = false;
        throw new Error('transient update failure');
      }
    },
    DEFAULT_STATE,
    null
  );

  await assert.rejects(harness.setWebuiUrl(newUrl), /transient update failure/);
  assert.equal(harness.getStored(), oldUrl);
  assert.equal(registeredUrl, oldUrl);
  assert.deepEqual(syncCalls, [newUrl, oldUrl]);
  assert.deepEqual(harness.storageWrites, []);

  assert.equal(await harness.prepare(), oldUrl);
  assert.equal(registeredUrl, oldUrl);
  assert.deepEqual(syncCalls, [newUrl, oldUrl, oldUrl]);
});

test('a failed URL storage write restores the persisted registration', async () => {
  const oldUrl = 'http://old.example:4800/';
  const newUrl = 'http://new.example:4900/';
  const syncCalls = [];
  let registeredUrl = oldUrl;
  const harness = createSetHarness(
    oldUrl,
    async (value) => {
      syncCalls.push(value);
      registeredUrl = value;
    },
    DEFAULT_STATE,
    new Error('storage write failure')
  );

  await assert.rejects(harness.setWebuiUrl(newUrl), /storage write failure/);
  assert.equal(harness.getStored(), oldUrl);
  assert.equal(registeredUrl, oldUrl);
  assert.deepEqual(syncCalls, [newUrl, oldUrl]);
  assert.deepEqual(harness.storageWrites, [{ webuiUrl: newUrl }]);
});
