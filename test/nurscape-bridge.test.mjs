import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';

const projectRoot = path.resolve(import.meta.dirname, '..');
const bridgeCoreSource = await fs.readFile(path.join(projectRoot, 'nurscape-bridge/bridge-core.js'), 'utf8');
const backgroundSource = await fs.readFile(path.join(projectRoot, 'nurscape-bridge/background.js'), 'utf8');
const contentSource = await fs.readFile(path.join(projectRoot, 'nurscape-bridge/content.js'), 'utf8');
const bridgeContext = { TextEncoder, AbortController, setTimeout, clearTimeout, crypto: globalThis.crypto, module: { exports: {} } };
bridgeContext.globalThis = bridgeContext;
vm.runInNewContext(bridgeCoreSource, bridgeContext, { filename: 'nurscape-bridge/bridge-core.js' });
const {
  createBridgeController,
  DEFAULT_SYNC_SCHEDULE,
  fingerprintJobs,
  nextKoreaScheduledRun,
} = bridgeContext.module.exports;

function rawJob(id) {
  return {
    id: String(id),
    title: `보건관리자 ${id} 채용`,
    company: `테스트기업 ${id}`,
    url: `https://job.nurscape.net/Jobs/Details/${id}`,
  };
}

function memoryStorage() {
  const values = {};
  return {
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, structuredClone(update)); },
    snapshot() { return structuredClone(values); },
  };
}

test('online failure survives local success and health checks; retry sends only online', async () => {
  const storage = memoryStorage();
  let online = false;
  const sent = [];
  const controller = createBridgeController({ storage, fetchImpl: async (url, options) => {
    if (options.method === 'POST') {
      sent.push(url);
      if (url.startsWith('https:') && !online) throw new Error('online import unavailable');
    }
    return { ok: true, json: async () => ({ received: 1 }) };
  } });
  const first = await controller.enqueue({ jobs: [rawJob(1)] });
  assert.equal(first.ok, false);
  assert.equal(first.queued, true);
  assert.equal(first.state.connectionStatus, 'disconnected');
  assert.equal(first.state.lastSuccessAt, null);
  assert.equal(first.state.pending.remainingUrls.length, 1);
  const health = await controller.checkHealth();
  assert.equal(health.healthStatus, 'reachable');
  assert.equal(health.lastError, 'online import unavailable');
  assert.equal(health.connectionStatus, 'disconnected');
  online = true;
  const retry = await controller.retryPending();
  assert.equal(retry.ok, true);
  assert.equal(retry.state.pending, null);
  assert.equal(sent.filter(url => url.startsWith('http:')).length, 1);
  assert.equal(sent.filter(url => url.startsWith('https:')).length, 2);
});

test('local failure does not erase online success and only local is retried', async () => {
  let local = false;
  const sent = [];
  const controller = createBridgeController({ storage: memoryStorage(), fetchImpl: async (url) => {
    sent.push(url);
    if (url.startsWith('http:') && !local) throw new Error('local offline');
    return { ok: true, json: async () => ({ received: 1 }) };
  } });
  const first = await controller.enqueue({ jobs: [rawJob(1)] });
  assert.equal(first.ok, true);
  assert.equal(first.queued, true);
  assert.equal(first.state.connectionStatus, 'connected');
  const stamp = first.state.lastSuccessAt;
  local = true;
  const retry = await controller.retryPending();
  assert.equal(retry.state.pending, null);
  assert.equal(retry.state.lastSuccessAt, stamp);
  assert.equal(sent.filter(url => url.startsWith('https:')).length, 1);
});

test('a hung target times out and retains data for retry', async () => {
  const controller = createBridgeController({ storage: memoryStorage(), requestTimeoutMs: 10,
    fetchImpl: async url => url.startsWith('https:') ? new Promise(() => {}) : { ok: true, json: async () => ({ received: 1 }) },
  });
  const result = await controller.enqueue({ jobs: [rawJob(1)] });
  assert.equal(result.ok, false);
  assert.equal(result.queued, true);
  assert.match(result.state.lastError, /초과/);
});

test('new snapshots replace failed target payloads and legacy pending is retried', async () => {
  const storage = memoryStorage();
  await storage.set({ nurseBoardBridgeState: { pending: { jobs: [rawJob(1)], fingerprint: 'legacy' } } });
  let fail = true;
  const sent = [];
  const controller = createBridgeController({ storage, fetchImpl: async (url, options) => {
    sent.push({ url, id: JSON.parse(options.body).jobs[0].id });
    if (url.startsWith('https:') && fail) throw new Error('offline');
    return { ok: true, json: async () => ({ received: 1 }) };
  } });
  await controller.retryPending();
  await controller.enqueue({ jobs: [rawJob(2)] });
  fail = false;
  const result = await controller.retryPending();
  assert.equal(result.state.pending, null);
  assert.equal(sent.at(-1).id, '2');
});

test('popup distinguishes online failure, local success, and collection errors', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
  await page.setContent((await fs.readFile(path.join(projectRoot, 'nurscape-bridge/popup.html'), 'utf8')).replace(/<script[^>]*><\/script>/g, ''));
  await page.addStyleTag({ path: path.join(projectRoot, 'nurscape-bridge/popup.css') });
  await page.evaluate(() => {
    window.messages = [];
    window.chrome = {
      runtime: { sendMessage: (message, callback) => {
        window.messages.push(message.type);
        callback({ connectionStatus: 'disconnected', collectionError: '2페이지 HTTP 403',
          pending: { jobs: [{}] }, targets: {
            'https://example.test/import': { lastError: 'online failed' },
            'http://127.0.0.1/import': { lastSuccessAt: '2026-09-12T03:00:00Z' },
          } });
      } },
      storage: { onChanged: { addListener: () => {} } },
    };
  });
  await page.addScriptTag({ path: path.join(projectRoot, 'nurscape-bridge/popup.js') });
  assert.equal(await page.locator('#status-label').textContent(), '온라인 전송 실패');
  const notice = await page.locator('#status-notice').textContent();
  assert.match(notice, /온라인: 전송 대기/);
  assert.match(notice, /로컬: 전송 성공/);
  assert.match(notice, /공고 수집 실패: 2페이지 HTTP 403/);
  await page.locator('#retry-button').click();
  assert.deepEqual(await page.evaluate(() => window.messages), ['GET_BRIDGE_STATUS', 'RETRY_NURSCAPE']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});

test('DOM fixture collector reads only real nurscape list containers', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const fixture = await fs.readFile(path.join(projectRoot, 'test/fixtures/nurscape-list.html'), 'utf8');
  await page.setContent(fixture);
  await page.addScriptTag({ path: path.join(projectRoot, 'nurscape-bridge/collector.js') });
  const jobs = await page.evaluate(() => globalThis.NurseBoardNurscapeCollector.collectNurscapeJobs(document));

  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => job.id), ['588917', '588641']);
  assert.equal(jobs[0].company, '호반블루에너지(주)');
  assert.equal(jobs[0].region, '전남');
  assert.equal(jobs[0].deadline, 'D-15');
  assert.equal(jobs[0].publishedAt, '방금 전');
  assert.equal(jobs[0].experience, '3년 이상');
  assert.equal(jobs[0].employment, '계약직');
  assert.equal(jobs[0].url, 'https://job.nurscape.net/Jobs/Details/588917');
  assert.equal(jobs.some((job) => job.id === '999999'), false);
});

test('collector creates only same-origin Nurscape pagination POST requests for pages 2 through 15', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<form id="frmListPaging" method="post" action="https://recruit.nurscape.net/Jobs/ListPaging?currentPage=0&page=1&pageSize=20&totalCount=2611&filterSeqno=0&unexpected=drop">
    <input id="currentPage" name="currentPage" value="1">
  </form>
  ${Array.from({ length: 15 }, (_, index) => `<a class="number-page" data-page-number="${index + 1}">${index + 1}</a>`).join('')}`);
  await page.addScriptTag({ path: path.join(projectRoot, 'nurscape-bridge/collector.js') });
  const requests = await page.evaluate(() => globalThis.NurseBoardNurscapeCollector.collectNurscapePageRequests(
    document,
    'https://recruit.nurscape.net/Jobs/List',
    15,
  ));

  assert.equal(requests.length, 14);
  assert.deepEqual(requests.map((request) => request.page), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(new URL(requests[0].url).pathname, '/Jobs/ListPaging');
  assert.equal(new URL(requests[0].url).searchParams.has('unexpected'), false);
  assert.equal(new URLSearchParams(requests.at(-1).body).get('currentPage'), '15');

  const blocked = await page.evaluate(() => {
    document.querySelector('#frmListPaging').setAttribute('action', 'https://evil.example/Jobs/ListPaging');
    return globalThis.NurseBoardNurscapeCollector.collectNurscapePageRequests(document, 'https://recruit.nurscape.net/Jobs/List', 15);
  });
  assert.deepEqual(blocked, []);
});

test('pagination uses the result count when the live pager has only ten links and no inline script', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<form id="frmListPaging" action="/Jobs/ListPaging?currentPage=0&page=1&pageSize=20&totalCount=2741"></form>
    ${Array.from({ length: 10 }, (_, i) => `<a class="number-page" data-page-number="${i + 1}">${i + 1}</a>`).join('')}`);
  await page.addScriptTag({ path: path.join(projectRoot, 'nurscape-bridge/collector.js') });
  const requests = await page.evaluate(() => globalThis.NurseBoardNurscapeCollector.collectNurscapePageRequests(
    document, 'https://recruit.nurscape.net/Jobs/List', 15,
  ));
  assert.deepEqual(requests.map(r => r.page), Array.from({ length: 14 }, (_, i) => i + 2));
  assert.equal(new URLSearchParams(requests.at(-1).body).get('currentPage'), '15');

  for (const [query, expectedCount] of [
    ['pageSize=20&totalCount=41', 2],
    ['pageSize=0&totalCount=2741', 0],
    ['pageSize=20&totalCount=invalid', 0],
    ['pageSize=20&totalCount=-1', 0],
  ]) {
    const count = await page.evaluate(query => {
      document.querySelectorAll('.number-page').forEach(n => n.remove());
      document.querySelector('#frmListPaging').setAttribute('action', `/Jobs/ListPaging?${query}`);
      return globalThis.NurseBoardNurscapeCollector.collectNurscapePageRequests(document, 'https://recruit.nurscape.net/Jobs/List', 15).length;
    }, query);
    assert.equal(count, expectedCount, query);
  }
});

test('automatic Nurscape sync uses 15 pages on the three daily Korea schedule', () => {
  assert.match(contentSource, /collectNurscapePageRequests\(document, location\.href, 15\)/);
  assert.match(backgroundSource, /nextKoreaScheduledRun\(new Date\(\), NURSCAPE_SYNC_SCHEDULE\)/);
  assert.match(backgroundSource, /NURSCAPE_SYNC_ALARM, \{ when: scheduledTime \}/);
  assert.match(backgroundSource, /!existing\.periodInMinutes/);
  assert.doesNotMatch(backgroundSource, /NURSCAPE_SYNC_INTERVAL_MINUTES/);
  assert.equal(nextKoreaScheduledRun('2026-09-03T00:00:00.000Z', DEFAULT_SYNC_SCHEDULE).toISOString(), '2026-09-03T03:00:00.000Z');
  assert.equal(nextKoreaScheduledRun('2026-09-03T10:00:00.000Z', DEFAULT_SYNC_SCHEDULE).toISOString(), '2026-09-04T00:00:00.000Z');
});

test('fingerprint is stable across order changes and changes with payload content', async () => {
  const first = await fingerprintJobs([rawJob(2), rawJob(1)]);
  const reordered = await fingerprintJobs([rawJob(1), rawJob(2)]);
  const changed = await fingerprintJobs([rawJob(1), { ...rawJob(2), title: '수정된 제목' }]);
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test('background controller prevents successful payload retransmission by fingerprint', async () => {
  const storage = memoryStorage();
  let requests = 0;
  const controller = createBridgeController({
    storage,
    now: () => new Date('2026-07-11T04:00:00.000Z'),
    fetchImpl: async () => {
      requests += 1;
      return { ok: true, status: 200, json: async () => ({ received: 1, inserted: 1, updated: 0, rejected: 0 }) };
    },
  });
  const jobs = [rawJob(1)];
  const fingerprint = await fingerprintJobs(jobs);
  assert.equal((await controller.enqueue({ jobs, fingerprint })).ok, true);
  const duplicate = await controller.enqueue({ jobs, fingerprint });
  assert.equal(duplicate.duplicate, true);
  assert.equal(requests, 2);
});

test('background controller refreshes an unchanged snapshot after the resend guard', async () => {
  const storage = memoryStorage();
  let currentTime = new Date('2026-07-11T04:00:00.000Z');
  let requests = 0;
  const controller = createBridgeController({
    storage,
    now: () => currentTime,
    fetchImpl: async () => {
      requests += 1;
      return { ok: true, status: 200, json: async () => ({ received: 1, inserted: 0, updated: 1, rejected: 0 }) };
    },
  });
  const jobs = [rawJob(1)];
  const fingerprint = await fingerprintJobs(jobs);
  await controller.enqueue({ jobs, fingerprint });
  currentTime = new Date('2026-07-11T05:59:00.000Z');
  const duplicate = await controller.enqueue({ jobs, fingerprint });
  assert.equal(duplicate.duplicate, true);
  assert.equal(requests, 2);
  currentTime = new Date('2026-07-11T06:01:00.000Z');
  const refreshed = await controller.enqueue({ jobs, fingerprint });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.duplicate, undefined);
  assert.equal(requests, 4);
  assert.equal((await controller.getStatus()).lastSuccessAt, '2026-07-11T06:01:00.000Z');
});

test('failed sends retain the latest payload and retry it after the server returns', async () => {
  const storage = memoryStorage();
  let online = false;
  const requestBodies = [];
  const controller = createBridgeController({
    storage,
    now: () => new Date('2026-07-11T05:00:00.000Z'),
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      if (!online) throw new Error('server offline');
      return { ok: true, status: 200, json: async () => ({ received: 1, inserted: 1, updated: 0, rejected: 0 }) };
    },
  });

  const first = await controller.enqueue({ jobs: [rawJob(1)] });
  assert.equal(first.queued, true);
  const second = await controller.enqueue({ jobs: [rawJob(2)] });
  assert.equal(second.queued, true);
  let state = await controller.getStatus();
  assert.equal(state.pending.jobs[0].id, '2');
  assert.equal(state.connectionStatus, 'disconnected');

  online = true;
  const retry = await controller.retryPending();
  assert.equal(retry.ok, true);
  state = await controller.getStatus();
  assert.equal(state.pending, null);
  assert.equal(state.connectionStatus, 'connected');
  assert.equal(state.lastCount, 1);
  assert.equal(requestBodies.at(-1).jobs[0].id, '2');
});
