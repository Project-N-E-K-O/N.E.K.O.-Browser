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
    { name: 'session', value: 'secret', domain: '.example.com', path: '/', httpOnly: true },
    { name: 'csrf', value: 'a=b', domain: 'example.com', path: '/', httpOnly: false }
  ];
  const partitionedCookies = [
    {
      name: 'session',
      value: 'partition-secret',
      domain: 'example.com',
      path: '/path',
      partitionKey
    }
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
      {
        name: 'session',
        value: 'partition-secret',
        domain: 'example.com',
        path: '/path',
        partitioned: true
      },
      {
        name: 'session',
        value: 'secret',
        domain: '.example.com',
        path: '/',
        partitioned: false
      },
      {
        name: 'csrf',
        value: 'a=b',
        domain: 'example.com',
        path: '/',
        partitioned: false
      }
    ],
    cookieHeader: 'session=partition-secret; session=secret; csrf=a=b',
    cookieHeaderWarning: ''
  });
});

test('ambiguous cross-partition cookie order suppresses the generated header', async () => {
  const getCurrentPageCookies = createCookieReader();
  const partitionKey = {
    topLevelSite: 'https://example.com',
    hasCrossSiteAncestor: false
  };
  const response = await getCurrentPageCookies(7, {
    tabs: {
      async query() {
        return [{ id: 42, title: 'Example', url: 'https://example.com/account' }];
      }
    },
    cookies: {
      async getAllCookieStores() {
        return [{ id: '1', tabIds: [42] }];
      },
      async getPartitionKey() {
        return { partitionKey };
      },
      async getAll(query) {
        return query.partitionKey
          ? [{
            name: 'session',
            value: 'partition-secret',
            domain: 'example.com',
            path: '/',
            partitionKey
          }]
          : [{ name: 'session', value: 'secret', domain: '.example.com', path: '/' }];
      }
    }
  });

  assert.equal(response.cookieCount, 2);
  assert.equal(response.cookieHeader, '');
  assert.match(response.cookieHeaderWarning, /无法准确还原完整 Header/);
  assert.deepEqual(response.cookieEntries, [
    {
      name: 'session',
      value: 'secret',
      domain: '.example.com',
      path: '/',
      partitioned: false
    },
    {
      name: 'session',
      value: 'partition-secret',
      domain: 'example.com',
      path: '/',
      partitioned: true
    }
  ]);
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
  assert.match(background, /cookieHeader: cookieHeaderWarning/);
  assert.match(background, /\? ''\s+: cookies\.map/);
  assert.match(background, /cookieHeaderWarning/);
  assert.match(background, /cookieEntries: cookies\.map/);
  assert.match(background, /partitioned: Boolean\(cookie\.partitionKey\)/);
  assert.match(popup, /response\?\.cookieHeader/);
  assert.match(popup, /value\.textContent = '••••••••'/);
  assert.match(popup, /value\.textContent = revealed \? \(cookie\.value \|\| '\(空值\)'\)/);
  assert.match(popup, /clipboard\.writeText\(`\$\{cookie\.name\}=\$\{cookie\.value\}`\)/);
  assert.match(popup, /row\.append\(revealButton, itemCopyButton\)/);
  assert.match(popup, /cookieList\.hidden = cookieEntries\.length === 0/);
  assert.match(popup, /cookieHeaderForCopy = cookieHeaderWarning \? '' : cookieHeader/);
  assert.match(popup, /cookieNameCounts\.get\(cookie\.name\)/);
  assert.match(popup, /cookie\.partitioned \? '分区' : '普通'/);
  assert.match(popup, /keyGroup\.append\(scope\)/);
  assert.match(popup, /summary\.hidden = cookieCount === 0/);
  assert.match(popup, /hint\.textContent = '读取失败，请检查当前页面后重试。'/);
  assert.match(popup, /clipboard\.writeText\(cookieHeaderForCopy\)/);
  assert.doesNotMatch(popup, /JSON\.stringify\(\{/);
});
