const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const popupHtml = read('popup.html');
const popup = read('popup.js');
const permissionHtml = read('mic-permission.html');
const permissionPage = read('mic-permission.js');
const offscreen = read('offscreen.js');

test('popup exposes an explicit microphone authorization control', () => {
  assert.match(popupHtml, /id="authorize-microphone"/);
  assert.match(popupHtml, />授权麦克风<\/button>/);
  assert.match(popupHtml, /id="microphone-permission-hint"/);
});

test('popup opens a stable visible extension page instead of requesting from a transient popup', () => {
  assert.match(popup, /chrome\.runtime\.getURL\('mic-permission\.html'\)/);
  assert.match(popup, /chrome\.tabs\.create/);
  assert.doesNotMatch(popup, /mediaDevices\.getUserMedia/);
});

test('the dedicated page requests permission and releases its probe stream', () => {
  assert.match(permissionHtml, /id="request-microphone"/);
  assert.match(permissionHtml, /id="open-microphone-settings"/);
  assert.match(permissionPage, /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/);
  assert.match(permissionPage, /stream\?\.getTracks\(\)\.forEach/);
  assert.match(permissionPage, /track\.stop\(\)/);
  assert.match(permissionPage, /navigator\.permissions\.query\(\{ name: 'microphone' \}\)/);
  assert.match(permissionPage, /dismissed\|取消\|关闭/);
});

test('offscreen capture continues to use the same extension-origin Web permission', () => {
  assert.match(offscreen, /navigator\.mediaDevices\.getUserMedia\(audioConstraints\)/);
  assert.match(offscreen, /cachedStreams\.set\(STREAM_KEY, stream\)/);
});
