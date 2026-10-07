import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { createPublishedFeed, firstPageKey } from '../lib/published-feed.mjs';
import { DEFAULT_FEED_FILTERS } from '../src/feed-defaults.js';
import { createApiApp } from '../api/index.mjs';

const snapshot = {
  jobs: Array.from({ length: 60 }, (_, i) => ({ id: String(i), title: `간호사 ${i}`,
    company: i === 59 ? '마지막기업' : '기업', region: '서울', employment: '정규직', deadline: '채용시까지' })),
  needsReviewJobs: [], updatedAt: '2026-09-14T00:00:00Z',
};
function fixture() {
  const data = new Map(), reads = [], writes = [];
  let offline = false, time = 0;
  const storeFactory = ({ pathname }) => ({ clearCache() {},
    async read() { reads.push(pathname); if (offline) throw new Error('offline'); return structuredClone(data.get(pathname)); },
    async write(value) { if (offline) throw new Error('offline'); writes.push(pathname); data.set(pathname, structuredClone(value)); },
  });
  return { feed: createPublishedFeed({ storeFactory, now: () => time }), data, reads, writes,
    offline: () => { offline = true; }, advance: () => { time += 61_000; } };
}

test('publication precomputes default pages; first reads do not download the full snapshot', async () => {
  const { feed, reads, writes } = fixture();
  assert.equal(await feed.publish(snapshot), true);
  assert.equal(await feed.publish(snapshot), false);
  assert.equal(writes.length, 2);
  const page = JSON.parse((await feed.page({ filters: JSON.stringify(DEFAULT_FEED_FILTERS), profile: '{"regionCodes":[]}', hidden: '[]' })).body);
  assert.equal(page.jobs.length, 24);
  assert.equal(page.pagination.total, 60);
  assert.deepEqual(reads, ['nurse-board/published-first-pages-v1.json']);
  assert.equal(firstPageKey({ profile: '{"regionCodes":["서울"]}' }), null);
  assert.equal(firstPageKey({ hidden: '["1"]' }), null);
  assert.equal(firstPageKey({ filters: 'null' }), null);
});

test('old policy and previous-day first pages are recalculated from the full publication', async () => {
  for (const policy of [undefined, { version: 1, day: '2000-01-01' }]) {
    const f = fixture();
    await f.feed.publish({ ...snapshot, jobs: snapshot.jobs.map((job, i) => ({
      ...job, firstSeenAt: i === 0 ? '2000-01-01' : new Date().toISOString(),
    })) });
    const prepared = f.data.get('nurse-board/published-first-pages-v1.json').firstPages.recommended;
    prepared.listingPolicy = policy;
    prepared.pagination.total = 999;
    const page = JSON.parse((await f.feed.page({ filters: JSON.stringify(DEFAULT_FEED_FILTERS) })).body);
    assert.equal(page.pagination.total, 59);
    assert.ok(page.jobs.every(job => job.id !== '0'));
    assert.ok(f.reads.includes('nurse-board/published-feed-v1.json'));
  }
});

test('search and later pages use full published data, with version reset and exclusions', async () => {
  const { feed } = fixture();
  await feed.publish(snapshot);
  const search = JSON.parse((await feed.page({ filters: '{"query":"마지막기업"}' })).body);
  assert.equal(search.jobs[0].id, '59');
  const next = JSON.parse((await feed.page({ offset: '24', version: snapshot.updatedAt })).body);
  assert.equal(next.pagination.offset, 24);
  const reset = JSON.parse((await feed.page({ offset: '24', version: 'old' })).body);
  assert.equal(reset.pagination.offset, 0);
  const hidden = JSON.parse((await feed.page({ hidden: '["59"]' })).body);
  assert.equal(hidden.pagination.total, 59);
});

test('failed or empty publications do not overwrite the last good data; expired readers retain it on outage', async () => {
  const f = fixture();
  await f.feed.publish(snapshot);
  await f.feed.page({});
  await f.feed.page({ offset: '24' });
  await assert.rejects(f.feed.publish({ jobs: [] }));
  f.advance();
  f.offline();
  await assert.rejects(f.feed.publish({ ...snapshot, updatedAt: 'new' }));
  assert.equal((await f.feed.page({})).stale, true);
  assert.equal((await f.feed.page({ offset: '24' })).stale, true);
  assert.equal(JSON.parse((await f.feed.page({})).body).pagination.total, 60);
});

test('concurrent cold requests share one read and recover after storage failure', async () => {
  const f = fixture();
  await assert.rejects(f.feed.page({}));
  await f.feed.publish(snapshot);
  f.reads.length = 0;
  await Promise.all(Array.from({ length: 5 }, () => f.feed.page({})));
  assert.equal(f.reads.length, 1);
});

test('published list requests never contact IWINV or load collectors, even when storage fails', async t => {
  const f = fixture();
  await f.feed.publish(snapshot);
  let localLoads = 0;
  const app = createApiApp({ feed: f.feed, origin: 'https://unreachable.invalid', token: 'test',
    loadLocalApp: () => { localLoads++; throw new Error('Must not load collectors'); } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/jobs?limit=24`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-nurse-board-api-origin'), 'vercel-blob');
  assert.equal((await response.json()).jobs.length, 24);
  const personal = await fetch(`${base}/api/jobs?hidden=%5B%221%22%5D`);
  assert.equal(personal.headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(`${base}/api/jobs?filters=null`)).status, 400);
  f.offline(); f.advance();
  const stale = await fetch(`${base}/api/jobs`);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('x-nurse-board-feed-stale'), 'true');
  assert.equal(localLoads, 0);
});

test('a cold storage outage returns an uncached 503 without reverting to the collector', async t => {
  const f = fixture(); f.offline();
  const app = createApiApp({ feed: f.feed, origin: 'https://unreachable.invalid', token: 'test',
    loadLocalApp: () => { throw new Error('Must not load collectors'); } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('stored detail reads are local but explicit detail refresh still uses the authenticated relay', async t => {
  const fetchLocal = globalThis.fetch;
  const local = express();
  local.get('/api/job', (_req, res) => res.json({ stored: true }));
  local.post('/api/job-detail', (_req, res) => res.json({ stored: true }));
  const app = createApiApp({ feed: fixture().feed, origin: 'https://collector.example', token: 'test', loadLocalApp: () => local });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  let remoteCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    remoteCalls++;
    assert.equal(options.headers.get('authorization'), 'Bearer test');
    return Response.json({ refreshed: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetchLocal(`${base}/api/job?id=1`)).json(), { stored: true });
  const casemanagerUrl = 'https://www.casemanager.or.kr/bbs/board.php?bo_table=recruit_people&wr_id=1';
  assert.deepEqual(await (await fetchLocal(`${base}/api/job-detail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: casemanagerUrl }) })).json(), { stored: true });
  assert.equal(remoteCalls, 0);
  assert.deepEqual(await (await fetchLocal(`${base}/api/job-detail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: true, url: 'https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=1' }) })).json(), { refreshed: true });
  assert.equal(remoteCalls, 1);
});
