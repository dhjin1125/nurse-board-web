import test from 'node:test';
import assert from 'node:assert/strict';
import { jobPage } from '../lib/job-page.mjs';
import { createJobService } from '../lib/job-service.mjs';

const snapshot = {
  jobs: Array.from({ length: 75 }, (_, i) => ({ id: `job-${i}`, dedupeKey: `key-${i}`,
    title: `산업간호사 ${i}`, company: i === 74 ? '마지막기업' : '기업',
    region: i % 2 ? '서울' : '부산', employment: '정규직', deadline: '채용시까지',
    publishedAt: `2026-09-${String(1 + i % 14).padStart(2, '0')}`, source: '테스트',
  })), needsReviewJobs: [{ id: 'review' }], reviewJobs: [{ id: 'review' }],
  updatedAt: '2026-09-14T00:00:00Z', counts: { total: 75 },
};
const page = (query = {}, data = snapshot) => JSON.parse(jobPage(data, query).body);

test('list API payload is bounded and pages cover the complete server result without duplicates', () => {
  const first = page();
  assert.equal(first.jobs.length, 24);
  assert.equal(first.pagination.total, 75);
  assert.deepEqual(first.needsReviewJobs, []);
  const ids = [];
  for (let offset = 0; offset < 75; offset += 24) ids.push(...page({ offset: String(offset) }).jobs.map(j => j.id));
  assert.equal(new Set(ids).size, 75);
  assert.equal(page({ offset: '72' }).pagination.hasMore, false);
  assert.equal(page({ limit: '10000' }).pagination.limit, 100);
  assert.strictEqual(jobPage(snapshot), jobPage(snapshot));
});

test('search, region filtering, exclusions and sorting happen before pagination', () => {
  const result = page({ filters: JSON.stringify({ query: '마지막기업' }) });
  assert.deepEqual(result.jobs.map(j => j.id), ['job-74']);
  const filtered = page({ filters: JSON.stringify({ region: '서울', sort: '최신 등록순' }), hidden: '["job-1"]' });
  assert.equal(filtered.pagination.total, 36);
  assert.ok(filtered.jobs.every(j => j.region === '서울' && j.id !== 'job-1'));
  assert.ok(filtered.jobs.every((j, i, all) => !i || all[i - 1].publishedAt >= j.publishedAt));
  assert.deepEqual(page({ ids: '["key-74"]' }).jobs.map(j => j.id), ['job-74']);
});

test('changed snapshots reset paging and malformed requests are rejected', () => {
  assert.equal(page({ offset: '24', version: 'old' }).pagination.offset, 0);
  assert.equal(page({ offset: '24', version: snapshot.updatedAt }).pagination.offset, 24);
  assert.throws(() => page({ filters: '{' }));
  assert.throws(() => page({ hidden: '{}' }));
  assert.throws(() => page({ offset: 'Infinity' }));
});

test('unchanged extra sources preserve the prepared snapshot', async () => {
  let prepared = 0;
  const service = createJobService({ sources: [], cacheFile: 'unused.json', readCache: async () => ({ sources: {} }),
    prepareJob: j => { prepared++; return j; } });
  const extra = [{ id: 'nurscape', name: '너스케입', jobs: [snapshot.jobs[0]], updatedAt: snapshot.updatedAt }];
  const first = await service.getSnapshot({ extraSources: extra });
  const next = await service.getSnapshot({ extraSources: structuredClone(extra) });
  assert.strictEqual(next, first);
  assert.equal(prepared, 1);
});
