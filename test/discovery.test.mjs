import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import express from 'express';
import {
  normalizeDiscovery, discoveryJobIds, markJobViewed, discoverySeenIds, appliedJobIds,
  discoveryTimestamp, filterDiscoveryJobs, discoveryCheckpoint, advanceDiscoveryCheckpoint,
} from '../src/discovery.js';
import { jobPage } from '../lib/job-page.mjs';
import { createPublishedFeed, firstPageKey, registerPublishedFeedRoutes } from '../lib/published-feed.mjs';
import { registerJobRoutes } from '../lib/job-routes.mjs';
import { applicationTierProfileKey, listingPolicyDay, sortJobs } from '../src/job-utils.js';
import { DEFAULT_FEED_FILTERS } from '../src/feed-defaults.js';

const since = '2026-09-19T00:00:00.000Z';
const now = '2026-09-22T00:00:00.000Z';
const query = (patch = {}) => ({ mode: 'new', since, seen: [], applied: [], ...patch });
const request = (patch = {}) => ({ discovery: JSON.stringify(query(patch)) });
const ids = jobs => jobs.map(job => job.id);
const page = (snapshot, options = {}) => JSON.parse(jobPage(snapshot, options).body);
const job = (id, extra = {}) => ({ id, title: '간호사 채용', company: '병원', region: '서울',
  employment: '정규직', deadline: '채용시까지', ...extra });

test('optional/legacy discovery state normalizes safely and retains the 200 most recent entries', () => {
  for (const raw of [undefined, null, false, 'legacy', [], 1, { viewed: [] }, { viewed: null }]) {
    assert.deepEqual(normalizeDiscovery(raw), { lastCheckedAt: null, viewed: {} });
  }
  const raw = {
    lastCheckedAt: '2026-09-19T09:00:00+09:00',
    viewed: Object.fromEntries(Array.from({ length: 240 }, (_, i) => [`id-${i}`, new Date(Date.parse(since) + i * 1000).toISOString()])),
  };
  const before = structuredClone(raw);
  const normalized = normalizeDiscovery(raw);
  assert.equal(normalized.lastCheckedAt, since);
  assert.equal(Object.keys(normalized.viewed).length, 200);
  assert.equal(Object.keys(normalized.viewed)[0], 'id-239');
  assert.ok(!('id-39' in normalized.viewed));
  assert.ok('id-40' in normalized.viewed);
  assert.deepEqual(raw, before);
  assert.deepEqual(normalizeDiscovery({ lastCheckedAt: 'yesterday', viewed: {
    valid: since, invalid: '09/21/2026', rollover: '2026-02-30', blank: '', object: {}, '': since,
    ...JSON.parse(`{"__proto__":"${since}","constructor":"${since}"}`),
  } }), { lastCheckedAt: null, viewed: { valid: since } });
});

test('viewing stores one primary ID, keeps other user state intact and never mutates its input', () => {
  const state = Object.freeze({ version: 2, profile: { custom: true }, savedSnapshots: { saved: {} },
    applications: { applied: {} }, hiddenSnapshots: { hidden: {} }, notifications: ['keep'], meta: { updatedAt: since },
    futureField: { preserve: true }, discovery: Object.freeze({ lastCheckedAt: since, viewed: Object.freeze({ old: since }) }) });
  const viewed = markJobViewed(state, { id: 'primary', sourceIds: ['alias', 'primary'], dedupeKey: 'long-key' }, now);
  assert.deepEqual(viewed.discovery, { lastCheckedAt: since, viewed: { primary: now, old: since } });
  for (const key of Object.keys(state).filter(key => key !== 'discovery')) assert.strictEqual(viewed[key], state[key]);
  assert.deepEqual(discoverySeenIds(viewed), ['primary', 'old']);
  assert.deepEqual(discoverySeenIds({}), []);
  assert.deepEqual(state.discovery.viewed, { old: since });
  assert.equal(markJobViewed(viewed, { id: 'primary' }, since).discovery.viewed.primary, now);
  assert.strictEqual(markJobViewed(state, {}, now), state);
  assert.strictEqual(markJobViewed(state, { id: 'id' }, 'invalid'), state);
  let bounded = {};
  for (let i = 0; i < 205; i++) bounded = markJobViewed(bounded, { id: `job-${i}`, sourceIds: [`alias-${i}`] }, Date.parse(since) + i);
  assert.equal(discoverySeenIds(bounded).length, 200);
  assert.equal(discoverySeenIds(bounded)[0], 'job-204');
  assert.ok(!discoverySeenIds(bounded).includes('job-4'));
});

test('discovery identity uses primary/source IDs, falling back to dedupe and job keys without a primary', () => {
  assert.deepEqual(discoveryJobIds({ id: 'p', sourceIds: ['a', 'p', '', 2], dedupeKey: 'd', jobKey: 'k' }), ['p', 'a']);
  assert.deepEqual(discoveryJobIds({ sourceIds: ['a'], dedupeKey: 'd', jobKey: 'k' }), ['a', 'd', 'k']);
  assert.deepEqual(discoveryJobIds({ dedupeKey: 'd' }), ['d']);
  assert.deepEqual(discoveryJobIds({ jobKey: 'k' }), ['k']);
  assert.deepEqual(discoveryJobIds(null), []);
  assert.deepEqual(discoverySeenIds(markJobViewed({}, { dedupeKey: 'fallback' }, now)), ['fallback']);
});

test('applied IDs resolve saved snapshots and exclude only applied, interview and final statuses', () => {
  const state = {
    savedSnapshots: {
      saved: { id: 'primary', dedupeKey: 'dedupe', jobKey: 'canonical', sourceIds: ['source'] },
      interviewing: { id: 'interview-id', dedupeKey: 'interview-key' },
      final: { id: 'final-id' },
      interest: { id: 'interest-id' },
      preparing: { id: 'preparing-id' },
    },
    applications: {
      legacy: { jobKey: 'source', status: 'applied' },
      interviewing: { status: 'interview' },
      final: { status: 'final', finalResult: 'withdrawn' },
      interest: { status: 'interested' },
      preparing: { status: 'preparing' },
      orphan: { status: 'applied', jobKey: 'missing-snapshot' },
      broken: null,
    },
  };
  const before = structuredClone(state), applied = new Set(appliedJobIds(state));
  for (const id of ['saved', 'primary', 'dedupe', 'canonical', 'source', 'legacy', 'interview-id', 'interview-key',
    'interviewing', 'final', 'final-id', 'orphan', 'missing-snapshot']) assert.ok(applied.has(id), id);
  for (const id of ['interest', 'interest-id', 'preparing', 'preparing-id', 'broken']) assert.ok(!applied.has(id), id);
  assert.deepEqual(state, before);
  assert.deepEqual(appliedJobIds(null), []);
});

test('discovery timestamps prefer first collection, accept only ISO fallback dates and ignore lastSeenAt', () => {
  assert.equal(discoveryTimestamp({ firstSeenAt: since, publishedAt: now, lastSeenAt: now }), Date.parse(since));
  assert.equal(discoveryTimestamp({ firstSeenAt: 'invalid', publishedAt: '2026-09-20' }), Date.parse('2026-09-20'));
  assert.equal(discoveryTimestamp({ publishedAt: '어제', postedAt: '2026-09-21T09:00:00+09:00' }), Date.parse('2026-09-21'));
  assert.equal(discoveryTimestamp({ publishedAt: '2024-02-29' }), Date.parse('2024-02-29'));
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-09-21T24:00:00Z', '2026-09-21T12:60:00Z',
    '2026-09-21T12:00:00+24:00', '2026-09-21T12:00:00', '2026.09.21', '09/21/2026', 'September 21, 2026', '2026', '1', 1]) {
    assert.equal(discoveryTimestamp({ firstSeenAt: date, publishedAt: date, postedAt: date, lastSeenAt: now }), null, String(date));
  }
  assert.equal(discoveryTimestamp({ lastSeenAt: now }), null);
  assert.equal(discoveryTimestamp(null), null);
});

const discoveryJobs = [
  job('old', { firstSeenAt: '2026-09-18', lastSeenAt: now }),
  job('fresh', { firstSeenAt: '2026-09-20' }),
  job('equal', { firstSeenAt: since }),
  job('seen', { sourceIds: ['seen-alias'], firstSeenAt: now }),
  job('applied', { dedupeKey: 'applied-key', firstSeenAt: now }),
  job('undated', { lastSeenAt: now }),
  job('published', { publishedAt: '2026-09-20' }),
  job('posted', { postedAt: '2026-09-21' }),
  job('text', { publishedAt: 'September 22, 2026', lastSeenAt: now }),
];
const personal = { seen: ['seen-alias'], applied: ['applied-key'] };

test('an omitted discovery query preserves the full view and has no discovery metadata', () => {
  for (const q of [undefined, null]) {
    const result = filterDiscoveryJobs(discoveryJobs, q);
    assert.strictEqual(result.jobs, discoveryJobs);
    assert.equal(result.meta, null);
  }
  assert.strictEqual(filterDiscoveryJobs(discoveryJobs).jobs, discoveryJobs);
});

test('scope counts precede selection; new is strictly after since and never based on last collection', () => {
  const before = structuredClone(discoveryJobs);
  for (const mode of ['new', 'unseen', 'all']) {
    const result = filterDiscoveryJobs(discoveryJobs, query({ ...personal, mode }));
    assert.deepEqual(result.meta, { mode, since, firstVisit: false, newCount: 3, unseenCount: 7, allCount: 9, appliedCount: 1 });
    assert.deepEqual(ids(result.jobs), mode === 'new' ? ['fresh', 'published', 'posted']
      : mode === 'unseen' ? ['old', 'fresh', 'equal', 'undated', 'published', 'posted', 'text'] : ids(discoveryJobs));
  }
  assert.deepEqual(discoveryJobs, before);
});

test('first visit explicitly includes every unseen job, including fixtures with no firstSeenAt/date', () => {
  const result = filterDiscoveryJobs(discoveryJobs, query({ ...personal, since: null }));
  assert.equal(result.meta.firstVisit, true);
  assert.equal(result.meta.newCount, 7);
  assert.equal(result.meta.unseenCount, 7);
  assert.deepEqual(ids(result.jobs), ['old', 'fresh', 'equal', 'undated', 'published', 'posted', 'text']);
  const undated = page({ jobs: [job('a'), job('b')] }, request({ since: null }));
  assert.equal(undated.pagination.total, 2);
  assert.equal(undated.discovery.firstVisit, true);
  assert.equal(undated.discovery.newCount, 2);
  assert.equal(page({ jobs: [job('a'), job('b')] }, request()).pagination.total, 0);
});

test('seen/applied matching checks id, dedupeKey, jobKey and every source alias', () => {
  const merged = job('primary', { dedupeKey: 'dedupe', jobKey: 'job-key', sourceIds: ['alias-1', 'alias-2'], firstSeenAt: now });
  for (const id of ['primary', 'dedupe', 'job-key', 'alias-1', 'alias-2']) {
    for (const field of ['seen', 'applied']) {
      for (const mode of ['new', 'unseen', 'all']) {
        const { jobs, meta } = filterDiscoveryJobs([merged], query({ mode, [field]: [id, id] }));
        assert.equal(jobs.length, mode === 'all' ? 1 : 0);
        assert.equal(meta.unseenCount, 0);
        assert.equal(meta.newCount, 0);
        assert.equal(meta.appliedCount, field === 'applied' ? 1 : 0);
      }
    }
  }
});

test('server filters/hidden/included IDs run before discovery and counts stay complete across pagination', () => {
  const snapshot = { jobs: [...discoveryJobs, job('busan', { region: '부산', firstSeenAt: now }),
    job('hidden', { jobKey: 'hide-key', firstSeenAt: now })], updatedAt: since };
  const options = { ...request(personal), filters: '{"region":"서울"}', hidden: '["hide-key"]', limit: '1' };
  const first = page(snapshot, options), second = page(snapshot, { ...options, offset: '1', version: first.pagination.version });
  assert.equal(first.discovery.allCount, 9);
  assert.equal(first.pagination.total, 3);
  assert.equal(first.pagination.hasMore, true);
  assert.equal(first.pagination.nextOffset, 1);
  assert.equal(first.jobs[0].id, 'posted');
  assert.deepEqual(first.discovery, second.discovery);
  assert.notEqual(first.jobs[0].id, second.jobs[0].id);
  const last = page(snapshot, { ...options, offset: '2' });
  assert.equal(last.pagination.hasMore, false);
  assert.equal(last.discovery.newCount, 3);
  assert.deepEqual(page(snapshot, { ...request({ mode: 'all' }), ids: '["hide-key"]' }).jobs.map(j => j.id), ['hidden']);
  assert.equal(page(snapshot, { ...request({ mode: 'all' }), ids: '["hide-key"]' }).discovery.allCount, 1);
  assert.equal(page(snapshot, { ...options, offset: '1', version: 'old' }).pagination.offset, 0);
  assert.deepEqual(JSON.parse(gunzipSync(jobPage(snapshot, options).gzip)), first);
});

test('new and unseen filter by discovery time but preserve personalized tier ranking', () => {
  const prepared = (id, tier, firstSeenAt, publishedAt = firstSeenAt) => job(id, {
    firstSeenAt, publishedAt, applicationTierGroup: tier, applicationTierGroupScore: 80,
    presentation: { profileKey: applicationTierProfileKey({}), applicationTier: { tier, score: 80 } },
  });
  const snapshot = { jobs: [prepared('new-C', 'C', '2026-09-21', '2026-09-01'),
    prepared('new-A', 'A', '2026-09-20', '2026-09-01'), prepared('old-S', 'S', '2026-09-18', now)] };
  const original = ids(sortJobs(snapshot.jobs, '워라벨 우선', {}, { tierLatest: true }));
  assert.equal(original[0], 'old-S');
  assert.deepEqual(ids(page(snapshot, request()).jobs), ['new-A', 'new-C']);
  assert.deepEqual(ids(page(snapshot, request({ mode: 'unseen' })).jobs), ['old-S', 'new-A', 'new-C']);
  assert.deepEqual(ids(page(snapshot, request({ mode: 'all' })).jobs), original);
});

test('the recommendation feed keeps recent older jobs, sorts newest within tier, and drops listings over 30 days', () => {
  const today = listingPolicyDay();
  const day = offset => new Date(Date.parse(`${today}T00:00:00+09:00`) + offset * 86400000).toISOString().slice(0, 10);
  const prepared = (id, tier, age) => job(id, {
    company: '한빛전자', title: '사업장 보건관리자 간호사 채용',
    publishedAt: day(-age), firstSeenAt: `${day(-age)}T00:00:00.000Z`, applicationTierGroup: tier,
    applicationTierGroupScore: 80, presentation: { profileKey: applicationTierProfileKey({}),
      applicationTier: { tier, score: 80, eligibility: { label: '지원 검토 가능' }, reasons: [], cautions: [] } },
  });
  const snapshot = { jobs: [prepared('S-older', 'S', 12), prepared('A-today', 'A', 0),
    prepared('S-latest', 'S', 1), prepared('S-stale', 'S', 31)] };
  const current = page(snapshot, { ...request({ mode: 'all', since: `${today}T00:00:00.000Z` }),
    filters: JSON.stringify({ availability: '진행 중', sort: '워라벨 우선' }) });
  assert.equal(current.discovery.newCount, 0);
  assert.deepEqual(ids(current.jobs), ['S-latest', 'S-older', 'A-today']);
  assert.equal(current.pagination.total, 3);
});

test('same-snapshot and compressed page caches are scoped to every discovery query field', () => {
  const snapshot = { jobs: discoveryJobs, updatedAt: since };
  const options = request({ since: null });
  const first = jobPage(snapshot, options);
  assert.strictEqual(jobPage(snapshot, options), first);
  assert.equal(page(snapshot, options).pagination.total, 9);
  for (const patch of [{ seen: ['fresh'] }, { applied: ['fresh'] }, { since }, { mode: 'unseen' }, { mode: 'all' }]) {
    assert.notStrictEqual(jobPage(snapshot, request({ since: null, ...patch })), first);
  }
  assert.equal(page(snapshot, request({ since: null, seen: ['fresh'] })).pagination.total, 8);
  assert.equal(page(snapshot, request({ since: null, applied: ['fresh'] })).discovery.appliedCount, 1);
  const next = { ...request({ since: null, seen: ['fresh'] }), offset: '1', limit: '1' };
  assert.notStrictEqual(jobPage(snapshot, next), jobPage(snapshot, { ...options, offset: '1', limit: '1' }));
  assert.equal(page(snapshot).discovery, undefined);
  assert.equal(page(snapshot).pagination.total, 9);
  assert.strictEqual(jobPage(snapshot, options), first);
});

const malformed = [null, [], {}, { mode: 'invalid' }, query({ since: 'yesterday' }), query({ since: '2026-02-30' }),
  query({ since: 1 }), query({ seen: null }), query({ seen: {} }), query({ seen: [1] }), query({ applied: [''] }),
  query({ seen: ['a'.repeat(513)] }), query({ seen: Array(2001).fill('id') }), query({ applied: Array(2001).fill('id') })];

test('request validation rejects malformed scopes, dates and unbounded IDs but accepts 2000 IDs per set', () => {
  for (const value of malformed) assert.throws(() => page({ jobs: [] }, { discovery: JSON.stringify(value) }));
  for (const value of ['{', '', ['{}'], {}, ' '.repeat(256001)]) assert.throws(() => page({ jobs: [] }, { discovery: value }));
  const many = Array.from({ length: 2000 }, (_, i) => `source-identity-${i}`);
  assert.equal(page({ jobs: discoveryJobs }, request({ seen: many, applied: many })).discovery.allCount, 9);
  const offset = page({ jobs: [] }, request({ since: '2026-09-19T09:00:00+09:00' }));
  assert.equal(offset.discovery.since, since);
});

function publishedFixture() {
  const data = new Map(), reads = [];
  const feed = createPublishedFeed({ storeFactory: ({ pathname }) => ({
    clearCache() {},
    async read() { reads.push(pathname); return structuredClone(data.get(pathname)); },
    async write(value) { data.set(pathname, structuredClone(value)); },
  }) });
  return { feed, reads, data };
}

test('precomputed pages invalidate old/missing tier tags and listing policy before reuse', async () => {
  const cases = [
    { name: 'missing page version', invalidate: (_page, stored) => { delete stored.profileKey; } },
    { name: 'old page version', invalidate: (_page, stored) => { stored.profileKey = 'care-role-v1'; } },
    { name: 'missing job version', invalidate: page => { delete page.jobs[1].presentation; } },
    { name: 'old job version', invalidate: page => { page.jobs[1].presentation.profileKey = 'care-role-v1'; } },
    { name: 'wrong job profile', invalidate: page => { page.jobs[1].presentation.profileKey = applicationTierProfileKey({ regionCodes: ['부산'] }); } },
    { name: 'old policy', invalidate: page => { page.listingPolicy.version = 0; } },
    { name: 'old policy day', invalidate: page => { page.listingPolicy.day = '2000-01-01'; } },
  ];
  for (const key of ['all', 'recommended']) {
    const options = key === 'all' ? {} : { filters: JSON.stringify(DEFAULT_FEED_FILTERS) };
    for (const { name, invalidate } of cases) {
      const f = publishedFixture();
      const current = new Date().toISOString();
      const snapshot = { jobs: [job('one', { firstSeenAt: current }), job('two', { firstSeenAt: current })] };
      await f.feed.publish(snapshot);
      const stored = f.data.get('nurse-board/published-first-pages-v1.json');
      invalidate(stored.firstPages[key], stored);
      stored.firstPages[key].pagination.total = 999;
      const result = JSON.parse((await f.feed.page(options)).body);
      assert.equal(result.pagination.total, 2, `${key}: ${name}`);
      assert.ok(result.jobs.every(job => job.presentation.profileKey === applicationTierProfileKey()), name);
      assert.deepEqual(f.reads, ['nurse-board/published-first-pages-v1.json', 'nurse-board/published-feed-v1.json'], name);
    }
  }
});

test('current precomputed tiers stay fast and empty pages still require a current version tag', async () => {
  const f = publishedFixture();
  await f.feed.publish({ jobs: [job('outside', { region: '부산' })] });
  const stored = f.data.get('nurse-board/published-first-pages-v1.json');
  assert.equal(stored.profileKey, applicationTierProfileKey());
  const options = { filters: JSON.stringify(DEFAULT_FEED_FILTERS) };
  assert.equal(JSON.parse((await f.feed.page(options)).body).pagination.total, 0);
  assert.deepEqual(f.reads, ['nurse-board/published-first-pages-v1.json']);

  const stale = publishedFixture();
  await stale.feed.publish({ jobs: [job('inside', { firstSeenAt: new Date().toISOString() })] });
  const staleStored = stale.data.get('nurse-board/published-first-pages-v1.json');
  delete staleStored.profileKey;
  staleStored.firstPages.recommended.jobs = [];
  staleStored.firstPages.recommended.pagination.total = 0;
  assert.equal(JSON.parse((await stale.feed.page(options)).body).pagination.total, 1);
  assert.ok(stale.reads.includes('nurse-board/published-feed-v1.json'));
});

test('every discovery mode bypasses public precomputed pages and reads the full publication', async () => {
  const { feed, reads } = publishedFixture();
  await feed.publish({ jobs: discoveryJobs, updatedAt: since });
  for (const mode of ['new', 'unseen', 'all']) {
    for (const filters of [{}, DEFAULT_FEED_FILTERS]) assert.equal(firstPageKey({ ...request({ mode }), filters: JSON.stringify(filters) }), null);
    const result = JSON.parse((await feed.page(request({ ...personal, mode, since: null }))).body);
    assert.equal(result.discovery.mode, mode);
    assert.equal(result.pagination.total, mode === 'all' ? 9 : 7);
  }
  for (const discovery of ['null', '{', '']) assert.equal(firstPageKey({ discovery }), null);
  assert.deepEqual(reads, ['nurse-board/published-feed-v1.json']);
  assert.equal(JSON.parse((await feed.page({})).body).discovery, undefined);
});

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const type of ['collector', 'published']) {
  test(`${type} route isolates personal responses, including validation errors, and validates before reads`, async t => {
    const app = express(), snapshot = { jobs: discoveryJobs, lastSuccessAt: since };
    let reads = 0;
    if (type === 'collector') registerJobRoutes(app, { jobService: { async getSnapshot() { reads++; return snapshot; } } });
    else registerPublishedFeedRoutes(app, { async page(q) { reads++; return jobPage(snapshot, q); } });
    const base = await listen(app, t);
    // Oversized ID lists are covered directly above: Node rejects their encoded
    // URLs at the HTTP parser's header-size limit before Express can validate.
    for (const value of malformed.slice(0, -2)) {
      const response = await fetch(`${base}/api/jobs?${new URLSearchParams({ discovery: JSON.stringify(value) })}`);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
    assert.equal(reads, 0);
    for (const encoding of ['gzip', 'identity']) {
      const response = await fetch(`${base}/api/jobs?${new URLSearchParams(request(personal))}`, { headers: { 'accept-encoding': encoding } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('content-encoding'), encoding === 'gzip' ? 'gzip' : null);
      const body = await response.json();
      assert.equal(body.discovery.newCount, 3);
      assert.equal(body.discovery.seen, undefined);
      assert.equal(body.discovery.applied, undefined);
    }
    const plain = await fetch(`${base}/api/jobs`);
    assert.match(plain.headers.get('cache-control'), /^public,/);
    assert.equal((await plain.json()).discovery, undefined);
    for (const q of [{ ids: '["fresh"]' }, { hidden: '["fresh"]' }, { profile: '{}' }]) {
      assert.equal((await fetch(`${base}/api/jobs?${new URLSearchParams(q)}`)).headers.get('cache-control'), 'private, no-store');
    }
  });

  test(`${type} route errors retain private/no-store on discovery requests`, async t => {
    const app = express();
    if (type === 'collector') registerJobRoutes(app, { jobService: { async getSnapshot() { throw new Error('offline'); } } });
    else registerPublishedFeedRoutes(app, { async page() { throw new Error('offline'); } });
    const base = await listen(app, t);
    const response = await fetch(`${base}/api/jobs?${new URLSearchParams(request())}`);
    assert.equal(response.status, type === 'collector' ? 500 : 503);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });
}

test('checkpoint candidates use collection timestamps, fall back safely and are bounded by now', () => {
  assert.equal(discoveryCheckpoint({ lastSuccessAt: since, dataTrust: { lastCollectedAt: now, generatedAt: now } }, now), since);
  assert.equal(discoveryCheckpoint({ lastSuccessAt: 'bad', dataTrust: { lastCollectedAt: since } }, now), since);
  assert.equal(discoveryCheckpoint({ dataTrust: { lastCollectedAt: '2099-01-01' } }, now), now);
  assert.equal(discoveryCheckpoint({ updatedAt: now, dataTrust: { generatedAt: now } }, now), null);
  assert.equal(discoveryCheckpoint({ lastSuccessAt: '09/19/2026' }, now), null);
  assert.equal(discoveryCheckpoint({ lastSuccessAt: since }, 'invalid'), null);
  assert.equal(discoveryCheckpoint(null, now), null);
});

test('successful loads advance checkpoints monotonically from served data and preserve publication gaps', () => {
  const initial = { discovery: { lastCheckedAt: '2026-09-18T00:00:00.000Z', viewed: { saved: since } },
    savedSnapshots: { preserve: {} }, meta: { updatedAt: since }, unknownField: true };
  const loaded = { jobs: [job('old', { firstSeenAt: '2026-09-18' })], lastSuccessAt: since, dataTrust: { generatedAt: now } };
  const advanced = advanceDiscoveryCheckpoint(initial, loaded, now);
  assert.equal(advanced.discovery.lastCheckedAt, since);
  assert.deepEqual(advanced.discovery.viewed, initial.discovery.viewed);
  assert.strictEqual(advanced.savedSnapshots, initial.savedSnapshots);
  assert.strictEqual(advanced.meta, initial.meta);
  assert.equal(advanced.unknownField, true);
  assert.equal(initial.discovery.lastCheckedAt, '2026-09-18T00:00:00.000Z');
  assert.strictEqual(advanceDiscoveryCheckpoint(advanced, loaded, now), advanced);
  assert.strictEqual(advanceDiscoveryCheckpoint(advanced, { ...loaded, lastSuccessAt: '2026-09-17' }, now), advanced);
  for (const response of [null, { lastSuccessAt: now }, { jobs: [] }, { jobs: [], error: 'failed', lastSuccessAt: now },
    { jobs: [], ok: false, lastSuccessAt: now }, { jobs: [], lastSuccessAt: now, refresh: { inProgress: true } }]) {
    assert.strictEqual(advanceDiscoveryCheckpoint(advanced, response, now), advanced);
  }
  // This job was collected between the publication we read and the load time.
  const nextPublication = [job('gap', { firstSeenAt: '2026-09-20T00:00:00Z' })];
  assert.deepEqual(ids(filterDiscoveryJobs(nextPublication, query({ since: advanced.discovery.lastCheckedAt })).jobs), ['gap']);
  assert.equal(advanceDiscoveryCheckpoint({}, { jobs: [], lastSuccessAt: since }, now).discovery.lastCheckedAt, since);
});
