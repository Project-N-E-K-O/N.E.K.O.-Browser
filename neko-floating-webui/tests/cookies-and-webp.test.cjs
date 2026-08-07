const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./helpers/extract-function.cjs');

const projectRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(projectRoot, name), 'utf8');
const background = read('background.js');
const content = read('content.js');
const manifest = JSON.parse(read('src/manifest-base.json'));
const popup = read('popup.js');
const popupHtml = read('popup.html');

function createCookieReader() {
  return Function(
    `${extractFunction(background, 'normalizeWindowId')}
     ${extractFunction(background, 'getCurrentPageCookies')}
     return getCurrentPageCookies;`
  )();
}

test('built-in wake animation is an animated WebP and all runtime references use it', () => {
  const webpPath = path.join(projectRoot, 'assets', 'cat-idle-cat1.webp');
  const gifPath = path.join(projectRoot, 'assets', 'cat-idle-cat1.gif');
  const webp = fs.readFileSync(webpPath);

  assert.equal(webp.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(webp.subarray(8, 12).toString('ascii'), 'WEBP');
  assert.ok(webp.includes(Buffer.from('ANIM')), 'WebP must retain animation metadata');
  assert.ok(webp.includes(Buffer.from('ANMF')), 'WebP must contain animation frames');
  assert.equal(fs.existsSync(gifPath), false);
  assert.match(content, /assets\/cat-idle-cat1\.webp/);
  assert.doesNotMatch(content, /assets\/cat-idle-cat1\.gif/);
  assert.ok(manifest.web_accessible_resources[0].resources.includes('assets/cat-idle-cat1.webp'));
});

test('current-page cookie reader targets the active tab in the popup window', async () => {
  const getCurrentPageCookies = createCookieReader();
  const queries = [];
  const cookieQueries = [];
  const partitionKeyQueries = [];
  const partitionKey = {
    topLevelSite: 'https://example.com',
    hasCrossSiteAncestor: false
  };
  const cookies = [
    { name: 'session', value: 'secret', httpOnly: true },
    { name: 'csrf', value: 'a=b', httpOnly: false }
  ];
  const partitionedCookies = [
    { name: 'partitioned-session', value: 'partition-secret', partitionKey }
  ];
  const response = await getCurrentPageCookies(7, {
    tabs: {
      async query(query) {
        queries.push(query);
        return [{ id: 42, title: 'Example', url: 'https://example.com/path?q=1' }];
      }
    },
    cookies: {
      async getAllCookieStores() {
        return [
          { id: '0', tabIds: [3] },
          { id: '1', tabIds: [42] }
        ];
      },
      async getPartitionKey(query) {
        partitionKeyQueries.push(query);
        return { partitionKey };
      },
      async getAll(query) {
        cookieQueries.push(query);
        return query.partitionKey ? partitionedCookies : cookies;
      }
    }
  });

  assert.deepEqual(queries, [{ active: true, windowId: 7 }]);
  assert.deepEqual(partitionKeyQueries, [{ tabId: 42, frameId: 0 }]);
  assert.deepEqual(cookieQueries, [
    {
      url: 'https://example.com/path?q=1',
      storeId: '1'
    },
    {
      url: 'https://example.com/path?q=1',
      storeId: '1',
      partitionKey
    }
  ]);
  assert.deepEqual(response, {
    ok: true,
    page: { title: 'Example', url: 'https://example.com/path?q=1' },
    cookieCount: 3,
    cookieEntries: [
      { name: 'session', value: 'secret' },
      { name: 'csrf', value: 'a=b' },
      { name: 'partitioned-session', value: 'partition-secret' }
    ],
    cookieHeader: 'session=secret; csrf=a=b; partitioned-session=partition-secret'
  });
});

test('current-page cookie reader rejects browser-internal pages', async () => {
  const getCurrentPageCookies = createCookieReader();
  let readCookies = false;
  await assert.rejects(
    getCurrentPageCookies(null, {
      tabs: { query: async () => [{ url: 'chrome://extensions/' }] },
      cookies: {
        getAll: async () => {
          readCookies = true;
          return [];
        }
      }
    }),
    /HTTP 或 HTTPS/
  );
  assert.equal(readCookies, false);
});

test('cookie access is permissioned, extension-page-only, and exposed through the popup', () => {
  assert.ok(manifest.permissions.includes('cookies'));
  assert.match(background, /message\?\.type !== 'NEKO_GET_CURRENT_PAGE_COOKIES'/);
  assert.match(background, /sender\?\.id === chrome\.runtime\.id && !sender\.tab/);
  assert.match(popupHtml, /id="read-current-page-cookies"/);
  assert.match(popupHtml, /id="current-page-cookies-summary"/);
  assert.match(popupHtml, /id="current-page-cookies-list"/);
  assert.match(popupHtml, /id="copy-current-page-cookies"/);
  assert.match(popup, /type: 'NEKO_GET_CURRENT_PAGE_COOKIES'/);
  assert.match(background, /cookieHeader: cookies\.map/);
  assert.match(background, /cookieEntries: cookies\.map/);
  assert.match(popup, /response\?\.cookieHeader/);
  assert.match(popup, /value\.textContent = '••••••••'/);
  assert.match(popup, /value\.textContent = revealed \? \(cookie\.value \|\| '\(空值\)'\)/);
  assert.match(popup, /clipboard\.writeText\(`\$\{cookie\.name\}=\$\{cookie\.value\}`\)/);
  assert.match(popup, /row\.append\(revealButton, itemCopyButton\)/);
  assert.match(popup, /cookieList\.hidden = cookieEntries\.length === 0/);
  assert.match(popup, /clipboard\.writeText\(cookieHeaderForCopy\)/);
  assert.doesNotMatch(popup, /JSON\.stringify\(\{/);
});
