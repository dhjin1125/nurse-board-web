import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const fixture = await fs.readFile(new URL('./fixtures/nurscape-list.html', import.meta.url), 'utf8');
const collectorSource = await fs.readFile(new URL('../nurscape-bridge/collector.js', import.meta.url), 'utf8');
const contentSource = await fs.readFile(new URL('../nurscape-bridge/content.js', import.meta.url), 'utf8');

async function contentPage(t, { paging = false, fullPagination = false } = {}) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Every request stays inside this fixture; no real site or import API is called.
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto('https://recruit.nurscape.net/Jobs/List');
  await page.evaluate(({ paging, fullPagination, fixture }) => {
    window.bridgeMessages = [];
    window.manualResponses = [];
    window.pendingImports = [];
    window.retryCallbacks = [];
    window.failPage = false;
    window.fetchPages = [];
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 30_000) {
        window.retryCallbacks.push(callback);
        return -window.retryCallbacks.length;
      }
      return realSetTimeout(callback, delay, ...args);
    };
    window.chrome = { runtime: {
      getManifest: () => ({ version: 'test' }),
      sendMessage(message, callback) {
        window.bridgeMessages.push(message);
        if (message.type === 'IMPORT_NURSCAPE') window.pendingImports.push(callback);
        else callback({ ok: true });
      },
      onMessage: { addListener(listener) { window.collectListener = listener; } },
    } };
    if (paging || fullPagination) {
      document.body.insertAdjacentHTML('beforeend', fullPagination
        ? `<form id="frmListPaging" action="/Jobs/ListPaging?pageSize=20&totalCount=2741"></form>${Array.from({ length: 10 }, (_, i) => `<a class="number-page" data-page-number="${i + 1}">${i + 1}</a>`).join('')}`
        : '<form id="frmListPaging" action="/Jobs/ListPaging?pageSize=20"></form><a class="number-page" data-page-number="2">2</a>');
      window.fetch = async (_url, options) => {
        const requestedPage = new URLSearchParams(options.body).get('currentPage');
        window.fetchPages.push(requestedPage);
        return new Response(window.failPage ? 'temporarily unavailable'
          : fixture.replaceAll('588641', fullPagination ? String(600000 + Number(requestedPage)) : '588642'), {
          status: window.failPage ? 503 : 200,
          headers: { 'content-type': 'text/html' },
        });
      };
    }
  }, { paging, fullPagination, fixture });
  await page.addScriptTag({ content: collectorSource });
  return { page, errors };
}

test('the real content script starts, shares an in-flight collection and releases it for the next run', { timeout: 15_000 }, async t => {
  const { page, errors } = await contentPage(t);
  await page.addScriptTag({ content: contentSource });
  await page.waitForFunction(() => window.pendingImports.length === 1);
  assert.deepEqual(errors, [], 'content script must not throw during bootstrap');
  await page.evaluate(() => {
    for (let i = 0; i < 2; i += 1) {
      window.collectListener({ type: 'COLLECT_NURSCAPE_NOW' }, {}, response => window.manualResponses.push(response));
    }
    window.pendingImports.shift()({ ok: true });
  });
  await page.waitForFunction(() => window.manualResponses.length === 2);
  assert.equal(await page.evaluate(() => window.bridgeMessages.filter(m => m.type === 'IMPORT_NURSCAPE').length), 1);
  assert.deepEqual(await page.evaluate(() => window.manualResponses.map(r => ({ ok: r.ok, count: r.count }))), [
    { ok: true, count: 2 }, { ok: true, count: 2 },
  ]);
  await page.evaluate(() => window.collectListener({ type: 'COLLECT_NURSCAPE_NOW' }, {}, response => window.manualResponses.push(response)));
  await page.waitForFunction(() => window.pendingImports.length === 1);
  await page.evaluate(() => window.pendingImports.shift()({ ok: true }));
  await page.waitForFunction(() => window.manualResponses.length === 3);
  assert.equal(await page.evaluate(() => window.bridgeMessages.filter(m => m.type === 'IMPORT_NURSCAPE').length), 2);
  assert.deepEqual(errors, []);
});

test('a failed page is reported without importing a partial snapshot and the scheduled retry recovers', { timeout: 15_000 }, async t => {
  const { page, errors } = await contentPage(t, { paging: true });
  await page.evaluate(() => { window.failPage = true; });
  await page.addScriptTag({ content: contentSource });
  await page.waitForFunction(() => window.retryCallbacks.length === 1);
  assert.deepEqual(errors, [], 'collection errors must be handled');
  assert.equal(await page.evaluate(() => window.pendingImports.length), 0);
  assert.match(await page.evaluate(() => window.bridgeMessages.at(-1).error), /2페이지 HTTP 503/);
  await page.evaluate(() => {
    window.failPage = false;
    window.retryCallbacks.shift()();
  });
  await page.waitForFunction(() => window.pendingImports.length === 1);
  assert.deepEqual(await page.evaluate(() => window.bridgeMessages.find(m => m.type === 'IMPORT_NURSCAPE').jobs.map(j => j.id)), ['588917', '588641', '588642']);
  assert.deepEqual(await page.evaluate(() => window.fetchPages), ['2', '2']);
  await page.evaluate(() => window.pendingImports.shift()({ ok: true }));
  assert.deepEqual(errors, []);
});

test('the real content script completes all fifteen pages when only ten pager links are rendered', { timeout: 15_000 }, async t => {
  const { page, errors } = await contentPage(t, { fullPagination: true });
  await page.addScriptTag({ content: contentSource });
  await page.waitForFunction(() => window.pendingImports.length === 1);
  assert.deepEqual(await page.evaluate(() => window.fetchPages.map(Number).sort((a,b) => a-b)), Array.from({ length: 14 }, (_, i) => i + 2));
  const jobs = await page.evaluate(() => window.bridgeMessages.find(m => m.type === 'IMPORT_NURSCAPE').jobs);
  assert.equal(jobs.length, 16);
  assert.ok(jobs.some(j => j.id === '600015'), 'the fifteenth page must be included in the import');
  await page.evaluate(() => window.pendingImports.shift()({ ok: true }));
  assert.deepEqual(errors, []);
});
