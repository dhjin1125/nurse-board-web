import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { writeJobCacheAtomic } from '../lib/job-cache.mjs';
import { registerJobRoutes } from '../lib/job-routes.mjs';
import {
  createJobService,
  DEFAULT_REFRESH_SCHEDULE,
  DEFAULT_STALE_AFTER_MS,
  nextKoreaScheduledRun,
} from '../lib/job-service.mjs';

function sourceJob() {
  return {
    id: 'saramin-1', company: '(주)테스트', title: '산업간호사 보건관리자 채용',
    region: '서울', deadline: '07/20', source: '사람인', category: 'health', url: 'https://example.com/job/1',
  };
}

test('persists source caches, preserves firstSeenAt, and keeps successful data after failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurse-board-cache-'));
  const cacheFile = join(directory, 'jobs-cache.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let current = new Date('2026-07-11T00:00:00.000Z');
  let mode = 'success';
  const source = {
    id: 'saramin', name: '사람인', url: 'https://example.com',
    collect: async () => {
      if (mode === 'failure') throw new Error('외부 채용처 실패');
      if (mode === 'empty') return [];
      return [sourceJob()];
    },
  };
  const service = createJobService({ sources: [source], cacheFile, now: () => current });

  await service.refresh('first');
  let snapshot = await service.getSnapshot();
  const firstSeenAt = snapshot.jobs[0].firstSeenAt;
  assert.equal(snapshot.jobs.length, 1);
  assert.deepEqual(snapshot.reviewJobs, snapshot.needsReviewJobs);
  assert.equal(snapshot.refreshing, false);
  assert.equal(snapshot.sourceStatus[0].status, 'auto');
  assert.equal(snapshot.sourceStatus[0].dataOrigin, 'live');
  assert.equal(snapshot.sourceStatus[0].freshness, 'fresh');
  assert.equal(snapshot.dataTrust.state, 'fresh');
  assert.equal(snapshot.dataTrust.servedFromCache, false);
  assert.equal(snapshot.jobs[0].dataTrust.state, 'fresh');
  assert.equal(firstSeenAt, '2026-07-11T00:00:00.000Z');

  current = new Date('2026-07-12T00:00:00.000Z');
  await service.refresh('second');
  snapshot = await service.getSnapshot();
  assert.equal(snapshot.jobs[0].firstSeenAt, firstSeenAt);
  assert.equal(snapshot.jobs[0].lastSeenAt, '2026-07-12T00:00:00.000Z');

  mode = 'failure';
  current = new Date('2026-07-12T01:00:00.000Z');
  await service.refresh('failure');
  snapshot = await service.getSnapshot();
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.sourceStatus[0].status, 'stale');
  assert.equal(snapshot.sourceStatus[0].lastSuccessAt, '2026-07-12T00:00:00.000Z');
  assert.equal(snapshot.sourceStatus[0].lastAttemptAt, '2026-07-12T01:00:00.000Z');
  assert.equal(snapshot.sourceStatus[0].dataOrigin, 'fallback-cache');
  assert.equal(snapshot.sourceStatus[0].isFallback, true);
  assert.equal(snapshot.dataTrust.state, 'partial');
  assert.equal(snapshot.dataTrust.hasFallbackData, true);
  assert.equal(snapshot.jobs[0].dataTrust.state, 'fallback');
  assert.match(snapshot.sourceStatus[0].error, /외부 채용처 실패/);

  const restarted = createJobService({ sources: [source], cacheFile, now: () => current });
  const restored = await restarted.getSnapshot();
  assert.equal(restored.jobs.length, 1);
  assert.equal(restored.jobs[0].firstSeenAt, firstSeenAt);
  assert.equal(restored.sourceStatus[0].dataOrigin, 'fallback-cache');
  assert.equal(restored.dataTrust.servedFromCache, true);
});

test('identifies a successful persisted cache before this process collects fresh data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurse-board-restored-'));
  const cacheFile = join(directory, 'jobs-cache.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const current = new Date('2026-07-11T00:10:00.000Z');
  await writeJobCacheAtomic(cacheFile, {
    version: 1,
    savedAt: '2026-07-11T00:00:00.000Z',
    sources: {
      saramin: {
        id: 'saramin', name: '사람인', status: 'success', jobs: [sourceJob()], seen: {},
        lastAttemptAt: '2026-07-11T00:00:00.000Z', lastSuccessAt: '2026-07-11T00:00:00.000Z', error: null,
      },
    },
  });
  const service = createJobService({
    cacheFile,
    now: () => current,
    sources: [{ id: 'saramin', name: '사람인', collect: async () => [sourceJob()] }],
  });

  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.sourceStatus[0].status, 'auto');
  assert.equal(snapshot.sourceStatus[0].dataOrigin, 'cache');
  assert.equal(snapshot.sourceStatus[0].freshness, 'cached');
  assert.equal(snapshot.sourceStatus[0].servedFromCache, true);
  assert.equal(snapshot.dataTrust.state, 'cached');
  assert.equal(snapshot.dataTrust.cacheSavedAt, '2026-07-11T00:00:00.000Z');
  assert.equal(snapshot.jobs[0].dataTrust.state, 'cached');
});

test('keeps a recent automatic cache usable when a manual source is old', async () => {
  const current = new Date('2026-07-13T00:28:00.000Z');
  const service = createJobService({
    cacheFile: 'unused.json',
    now: () => current,
    sources: [{ id: 'saramin', name: '사람인', collect: async () => [sourceJob()] }],
    readCache: async () => ({
      version: 1,
      savedAt: '2026-07-13T00:10:00.000Z',
      sources: {
        saramin: {
          id: 'saramin', name: '사람인', status: 'success', jobs: [sourceJob()], seen: {},
          lastAttemptAt: '2026-07-13T00:10:00.000Z', lastSuccessAt: '2026-07-13T00:10:00.000Z', error: null,
        },
      },
    }),
  });

  const snapshot = await service.getSnapshot({
    extraSources: [
      {
        id: 'nurscape-recent', name: '너스케입 최근 가져오기', status: 'bridge',
        jobs: [{ ...sourceJob(), id: 'nurscape-recent-1', source: '너스케입' }],
        updatedAt: '2026-07-12T23:21:00.000Z',
      },
      {
        id: 'nurscape-old', name: '너스케입 오래된 가져오기', status: 'bridge',
        jobs: [{ ...sourceJob(), id: 'nurscape-old-1', source: '너스케입' }],
        updatedAt: '2026-07-11T23:21:00.000Z',
      },
    ],
  });

  assert.equal(snapshot.sourceStatus.find((source) => source.id === 'nurscape-recent').stale, false);
  assert.equal(snapshot.sourceStatus.find((source) => source.id === 'nurscape-old').stale, true);
  assert.equal(snapshot.dataTrust.state, 'mixed');
  assert.equal(snapshot.dataTrust.sources.stale, 1);
});

test('reload preserves freshness for the same successful collection', async () => {
  let durableCache = { version: 1, savedAt: null, sources: {} };
  const service = createJobService({
    cacheFile: 'unused.json',
    now: () => new Date('2026-07-13T00:10:00.000Z'),
    sources: [{ id: 'saramin', name: '사람인', collect: async () => [sourceJob()] }],
    readCache: async () => structuredClone(durableCache),
    writeCache: async (_cacheFile, cache) => { durableCache = structuredClone(cache); },
  });

  await service.refresh('manual');
  assert.equal((await service.getSnapshot()).dataTrust.state, 'fresh');
  assert.equal(await service.reload(), true);
  const reloaded = await service.getSnapshot();
  assert.equal(reloaded.sourceStatus[0].freshness, 'fresh');
  assert.equal(reloaded.dataTrust.state, 'fresh');
});

test('reuses a precomputed serialized snapshot and keeps imported sources across refreshes', async () => {
  let title = sourceJob().title;
  const service = createJobService({
    cacheFile: 'unused.json',
    now: () => new Date('2026-07-13T00:10:00.000Z'),
    sources: [{
      id: 'saramin', name: '사람인',
      collect: async () => [{ ...sourceJob(), title }],
    }],
    readCache: async () => ({ version: 1, savedAt: null, sources: {} }),
    writeCache: async () => {},
  });

  await service.refresh('seed');
  const importedSource = {
    id: 'nurscape', name: '너스케입', status: 'bridge', updatedAt: '2026-07-13T00:00:00.000Z',
    jobs: [{
      id: 'nurscape-99', company: '별도병원', title: '외래 간호사 채용', source: '너스케입',
      category: 'clinical', url: 'https://job.nurscape.net/Jobs/Details/99',
    }],
  };
  const first = await service.getSnapshot({ extraSources: [importedSource] });
  const cached = await service.getSnapshotPayload();

  assert.strictEqual(cached.snapshot, first);
  assert.equal(cached.body, JSON.stringify(first));
  assert.equal(first.sourceStatus.some((source) => source.id === 'nurscape'), true);

  title = '산업간호사 보건관리자 공개채용';
  const refreshed = await service.refresh('scheduled');
  assert.notStrictEqual(refreshed, first);
  assert.equal(refreshed.sourceStatus.some((source) => source.id === 'nurscape'), true);
  assert.equal(refreshed.jobs.some((job) => job.title === title), true);
});

test('reports cross-source duplicate removal and preserves both source provenance records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurse-board-dedupe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const current = new Date('2026-07-11T00:00:00.000Z');
  const service = createJobService({
    cacheFile: join(directory, 'jobs-cache.json'),
    now: () => current,
    sources: [
      { id: 'saramin', name: '사람인', collect: async () => [sourceJob()] },
      {
        id: 'jobkorea', name: '잡코리아', collect: async () => [{
          ...sourceJob(), id: 'jobkorea-2', source: '잡코리아', company: '㈜테스트',
          title: '테스트 산업간호사 보건관리자 모집', url: 'https://example.com/job/2',
        }],
      },
    ],
  });

  const snapshot = await service.refresh('dedupe');
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].duplicateCount, 1);
  assert.equal(snapshot.jobs[0].sourceCount, 2);
  assert.equal(snapshot.jobs[0].dataTrust.sources.length, 2);
  assert.deepEqual(snapshot.dataTrust.jobs, {
    raw: 2,
    merged: 1,
    duplicatesRemoved: 1,
    visible: 1,
    needsReview: 0,
  });
});

test('treats a surprising zero result as needs_review and retains prior jobs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurse-board-empty-'));
  const cacheFile = join(directory, 'jobs-cache.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let empty = false;
  let current = new Date('2026-07-11T00:00:00.000Z');
  const service = createJobService({
    cacheFile,
    now: () => current,
    sources: [{ id: 'saramin', name: '사람인', collect: async () => empty ? [] : [sourceJob()] }],
  });
  await service.refresh('seed');
  empty = true;
  current = new Date('2026-07-11T00:30:00.000Z');
  await service.refresh('empty');
  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.sourceStatus[0].status, 'needs_review');
  assert.equal(snapshot.sourceStatus[0].stale, true);
  assert.match(snapshot.sourceStatus[0].error, /0건/);
});

test('shows successful sources immediately when another source fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurse-board-partial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = createJobService({
    cacheFile: join(directory, 'jobs-cache.json'),
    now: () => new Date('2026-07-11T00:00:00.000Z'),
    sources: [
      { id: 'good', name: '정상 채용처', collect: async () => [sourceJob()] },
      { id: 'bad', name: '실패 채용처', collect: async () => { throw new Error('수집 차단'); } },
    ],
  });
  await service.refresh('partial');
  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.sourceStatus.find((source) => source.id === 'good').status, 'auto');
  assert.equal(snapshot.sourceStatus.find((source) => source.id === 'bad').status, 'error');
});

test('writes the persistent job cache atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurse-board-atomic-'));
  const cacheFile = join(directory, 'jobs-cache.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeJobCacheAtomic(cacheFile, { version: 1, savedAt: '2026-07-11T00:00:00.000Z', sources: { test: { jobs: [] } } });

  const parsed = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmp')), []);
});

test('Korea schedule selects the next 09:00, 12:00, or 18:00 run', () => {
  assert.equal(nextKoreaScheduledRun('2026-09-02T23:59:59.000Z').toISOString(), '2026-09-03T00:00:00.000Z');
  assert.equal(nextKoreaScheduledRun('2026-09-03T00:00:00.000Z').toISOString(), '2026-09-03T03:00:00.000Z');
  assert.equal(nextKoreaScheduledRun('2026-09-03T09:00:01.000Z').toISOString(), '2026-09-04T00:00:00.000Z');
});

test('scheduler waits for the next Korea schedule instead of collecting on startup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurse-board-schedule-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let scheduledMs;
  let scheduledCallback;
  let collectCount = 0;
  const currentTime = new Date('2026-09-03T00:30:00.000Z');
  const service = createJobService({
    cacheFile: join(directory, 'jobs-cache.json'),
    now: () => currentTime,
    sources: [{ id: 'one', name: '하나', collect: async () => { collectCount += 1; return []; } }],
    setTimeoutImpl: (callback, milliseconds) => {
      scheduledCallback = callback;
      scheduledMs = milliseconds;
      return { unref() {} };
    },
    clearTimeoutImpl: () => {},
  });
  t.after(() => service.stop());

  await service.start();
  assert.equal(collectCount, 0);
  assert.equal(scheduledMs, 2.5 * 60 * 60 * 1000);
  const health = await service.getHealth();
  assert.deepEqual(health.collection.schedule, DEFAULT_REFRESH_SCHEDULE.map(({ hour }) => `${String(hour).padStart(2, '0')}:00`));
  assert.equal(health.collection.timeZone, 'Asia/Seoul');
  assert.equal(health.collection.nextRunAt, '2026-09-03T03:00:00.000Z');
  assert.equal(health.collection.staleAfterMs, DEFAULT_STALE_AFTER_MS);

  scheduledCallback();
  await service.refresh('join-scheduled');
  assert.equal(collectCount, 1);
});

test('jobs, refresh, and health routes expose cached state and return 202 for refresh', async (t) => {
  const payload = { jobs: [sourceJob()], needsReviewJobs: [], refresh: { inProgress: false } };
  let triggerCount = 0;
  const fakeService = {
    getHealth: async () => ({ status: 'ok', ready: true }),
    getSnapshot: async () => payload,
    triggerRefresh: () => { triggerCount += 1; return { started: true, promise: Promise.resolve() }; },
    getRefreshState: () => ({ inProgress: true, reason: 'manual' }),
  };
  const app = express();
  registerJobRoutes(app, { jobService: fakeService });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const jobsResponse = await fetch(`${origin}/api/jobs`);
  assert.equal(jobsResponse.status, 200);
  const page = await jobsResponse.json();
  assert.deepEqual(page.jobs.map(job => job.id), payload.jobs.map(job => job.id));
  assert.equal(page.pagination.total, payload.jobs.length);
  assert.equal(page.pagination.limit, 24);
  assert.equal(page.pagination.hasMore, false);
  assert.deepEqual(page.refresh, payload.refresh);
  const refreshResponse = await fetch(`${origin}/api/refresh`, { method: 'POST' });
  assert.equal(refreshResponse.status, 202);
  assert.equal((await refreshResponse.json()).started, true);
  assert.equal(triggerCount, 1);
  const healthResponse = await fetch(`${origin}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ready, true);
});

test('reload replaces an initialized in-memory cache with the latest durable cache', async () => {
  let durableCache = {
    version: 1,
    savedAt: '2026-07-11T00:00:00.000Z',
    sources: {
      saramin: {
        id: 'saramin', name: '사람인', status: 'success', jobs: [sourceJob()], seen: {},
        lastAttemptAt: '2026-07-11T00:00:00.000Z', lastSuccessAt: '2026-07-11T00:00:00.000Z', error: null,
      },
    },
  };
  const service = createJobService({
    cacheFile: 'unused.json',
    sources: [{ id: 'saramin', name: '사람인', collect: async () => [] }],
    readCache: async () => structuredClone(durableCache),
  });

  assert.equal((await service.getSnapshot()).jobs[0].title, sourceJob().title);
  durableCache = structuredClone(durableCache);
  durableCache.savedAt = '2026-07-12T00:00:00.000Z';
  durableCache.sources.saramin.jobs[0].title = '새로 저장된 보건관리자 공고';
  durableCache.sources.saramin.lastSuccessAt = '2026-07-12T00:00:00.000Z';

  assert.equal(await service.reload(), true);
  const reloaded = await service.getSnapshot();
  assert.equal(reloaded.jobs[0].title, '새로 저장된 보건관리자 공고');
  assert.equal(reloaded.dataTrust.cacheSavedAt, '2026-07-12T00:00:00.000Z');
});

test('Vercel-style refresh waits for collection and cron requires its bearer secret', async (t) => {
  let completed = false;
  let beforeReadCount = 0;
  const payload = { jobs: [sourceJob()], reviewJobs: [], counts: { total: 1 }, lastSuccessAt: '2026-07-12T00:00:00.000Z' };
  const fakeService = {
    getHealth: async () => ({ status: 'ok', ready: true }),
    getSnapshot: async () => {
      assert.equal(completed, true);
      return payload;
    },
    triggerRefresh: () => ({
      started: true,
      promise: Promise.resolve().then(() => { completed = true; }),
    }),
    getRefreshState: () => ({ inProgress: !completed }),
  };
  const app = express();
  registerJobRoutes(app, {
    jobService: fakeService,
    awaitRefresh: true,
    cronSecret: 'test-cron-secret',
    beforeRead: async () => { beforeReadCount += 1; },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const manual = await fetch(`${origin}/api/refresh`, { method: 'POST' });
  assert.equal(manual.status, 202);
  assert.deepEqual((await manual.json()).snapshot, payload);
  assert.equal(beforeReadCount, 1);

  completed = false;
  const unauthorized = await fetch(`${origin}/api/cron/refresh`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${origin}/api/cron/refresh`, {
    headers: { authorization: 'Bearer test-cron-secret' },
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).ok, true);
  assert.equal(beforeReadCount, 2);
});

test('manual refresh cooldown prevents repeated collector bursts', async (t) => {
  let triggerCount = 0;
  const fakeService = {
    getHealth: async () => ({ status: 'ok', ready: true }),
    getSnapshot: async () => ({ jobs: [] }),
    triggerRefresh: () => {
      triggerCount += 1;
      return { started: true, promise: Promise.resolve() };
    },
    getRefreshState: () => ({ inProgress: false }),
  };
  const app = express();
  registerJobRoutes(app, { jobService: fakeService, manualRefreshCooldownMs: 300_000 });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${origin}/api/refresh`, { method: 'POST' })).status, 202);
  const repeated = await fetch(`${origin}/api/refresh`, { method: 'POST' });
  assert.equal(repeated.status, 429);
  assert.ok(Number(repeated.headers.get('retry-after')) >= 299);
  assert.equal(triggerCount, 1);
});
