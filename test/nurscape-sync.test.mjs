import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { collectNurscapeSnapshot, sendNurscapeSnapshot, NURSCAPE_LIST_URL } from '../lib/nurscape-sync.mjs';

const job = (id) => ({ id: String(id), title: `간호사 ${id}`, company: '기관', url: `https://job.nurscape.net/Jobs/Details/${id}` });
function browserStub({ status = 200, title = '채용정보', first, next, url = NURSCAPE_LIST_URL } = {}) {
  const calls = { closed: false, wait: false, pageLimit: null };
  const page = {
    goto: async () => ({ status: () => status }), title: async () => title, url: () => url,
    waitForSelector: async () => { calls.wait = true; }, addScriptTag: async () => {},
    evaluate: async (_fn, arg) => {
      if (typeof arg === 'number') {
        calls.pageLimit = arg;
        return first || { jobs: [job(1)], pages: [{ page: 2, url: 'https://recruit.nurscape.net/Jobs/ListPaging', body: 'currentPage=2' }], hasMore: true };
      }
      if (next instanceof Error) throw next;
      return next || { status: 200, title: '', contentType: 'text/html', jobs: [job(1), job(2)] };
    },
  };
  return { calls, browserType: { launch: async () => ({ newPage: async () => page, close: async () => { calls.closed = true; } }) } };
}

test('a Cloudflare response is diagnosed before waiting for a nonexistent list', async () => {
  const stub = browserStub({ status: 403, title: 'Attention Required! | Cloudflare' });
  await assert.rejects(collectNurscapeSnapshot(stub), /접근 확인/);
  assert.equal(stub.calls.wait, false);
  assert.equal(stub.calls.closed, true);
});

test('a login redirect cannot become a successful empty snapshot', async () => {
  const stub = browserStub({ url: 'https://nid.nurscape.net/Account/Login' });
  await assert.rejects(collectNurscapeSnapshot(stub), /다른 페이지/);
  assert.equal(stub.calls.closed, true);
});

test('a missing pagination form fails instead of replacing the feed with page one', async () => {
  const stub = browserStub({ first: { jobs: [job(1)], pages: [], hasMore: true } });
  await assert.rejects(collectNurscapeSnapshot(stub), /페이지 이동 정보/);
});

test('a failed, empty, or challenged later page never returns a partial snapshot', async () => {
  for (const next of [new Error('timeout'), { status: 200, contentType: 'text/html', jobs: [] },
    { status: 200, contentType: 'text/html', title: 'Just a moment', jobs: [job(2)] }]) {
    const stub = browserStub({ next });
    await assert.rejects(collectNurscapeSnapshot(stub));
    assert.equal(stub.calls.closed, true);
  }
});

test('a complete run honors the requested page limit and deduplicates jobs', async () => {
  const stub = browserStub();
  const result = await collectNurscapeSnapshot({ ...stub, maxPages: 2 });
  assert.deepEqual(result.jobs.map((item) => item.id), ['1', '2']);
  assert.deepEqual(result.pages, [{ page: 1, count: 1 }, { page: 2, count: 2 }]);
  assert.equal(result.complete, true);
  assert.equal(stub.calls.pageLimit, 2);
  assert.equal(stub.calls.closed, true);
});

test('invalid limits fail before opening a browser and oversized snapshots cannot be truncated', async () => {
  await assert.rejects(collectNurscapeSnapshot({ maxPages: 0 }), /1~20/);
  const stub = browserStub({ first: { jobs: Array.from({ length: 451 }, (_, i) => job(i)), pages: [], hasMore: false } });
  await assert.rejects(collectNurscapeSnapshot(stub), /한도/);
});

test('local success never hides a production import failure', async () => {
  const result = await sendNurscapeSnapshot([job(1)], {
    urls: ['https://online.test/import', 'http://127.0.0.1:4174/api/import/nurscape'],
    fetchImpl: async (url) => url.startsWith('https:') ? { ok: false, status: 503 }
      : { ok: true, json: async () => ({ received: 1, inserted: 1, updated: 0, rejected: 0 }) },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.targets.map((item) => item.ok), [false, true]);
});

test('a partial server acceptance or hung body is an import failure', async () => {
  const partial = await sendNurscapeSnapshot([job(1)], {
    fetchImpl: async () => ({ ok: true, json: async () => ({ received: 1, inserted: 0, updated: 0, rejected: 1 }) }),
  });
  assert.equal(partial.ok, false);
  const hung = await sendNurscapeSnapshot([job(1)], { timeoutMs: 10,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  });
  assert.equal(hung.ok, false);
  assert.match(hung.targets[0].error, /초과/);
});

test('the extension popup does not present a ten-day-old upload as healthy', async () => {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { addEventListener() {} });
    return elements.get(selector);
  };
  const source = await fs.readFile(new URL('../nurscape-bridge/popup.js', import.meta.url), 'utf8');
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  vm.runInNewContext(source, { Date, Intl, Map, Promise,
    document: { querySelector: element }, chrome: {
      runtime: { sendMessage: (_message, callback) => callback({ connectionStatus: 'connected', lastSuccessAt: tenDaysAgo }) },
      storage: { onChanged: { addListener() {} } },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(element('#status-label').textContent, /동기화 지연/);
  assert.match(element('#status-notice').textContent, /24시간/);
});
