import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshHasPublished } from '../src/refresh-status.js';
import { createUserState, normalizeUserState, saveJobSnapshot, upsertApplication, createLocalStorageAdapter } from '../src/user-state.js';
import { markJobViewed, advanceDiscoveryCheckpoint } from '../src/discovery.js';
import { replaceSavedSnapshots } from '../src/saved-sync.js';

test('a cached completed refresh does not finish a newly started collection', () => {
  const start = '2026-09-21T09:00:00Z';
  assert.equal(refreshHasPublished({ refresh: { inProgress: false, startedAt: '2026-09-21T03:00:00Z', completedAt: '2026-09-21T03:00:30Z' } }, start), false);
  assert.equal(refreshHasPublished({ refresh: { inProgress: true, startedAt: start, completedAt: start } }, start), false);
  assert.equal(refreshHasPublished({ refresh: { inProgress: false, startedAt: start, completedAt: '2026-09-21T09:00:30Z' } }, start), true);
  assert.equal(refreshHasPublished({}, start), false);
});

test('optional discovery state survives v2 persistence without losing saved/application records', () => {
  const now = '2026-09-21T09:00:00Z';
  const job = { id: 'snubh-1', dedupeKey: 'hospital:job', title: '전담간호사' };
  let state = saveJobSnapshot(createUserState(now), job, now);
  state = upsertApplication(state, job, { status: 'applied', note: '외과 지원', dueAt: '2026-09-29' }, now);
  state = markJobViewed(state, job, now);
  state = advanceDiscoveryCheckpoint(state, { jobs: [job], lastSuccessAt: now }, now);
  const items = new Map();
  const adapter = createLocalStorageAdapter({ getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) }, { now });
  adapter.save(state);
  const loaded = adapter.load();
  assert.equal(loaded.discovery.lastCheckedAt, '2026-09-21T09:00:00.000Z');
  assert.ok(loaded.discovery.viewed[job.id]);
  assert.equal(loaded.applications[job.dedupeKey].note, '외과 지원');
  assert.equal(loaded.savedSnapshots[job.dedupeKey].title, job.title);
  assert.equal(normalizeUserState({ ...loaded, profile: { careerDomains: ['clinical'], preferredCareRole: 'pa' } }, now).profile.preferredCareRole, 'pa');
  const synced = replaceSavedSnapshots(loaded, {}, now);
  assert.equal(synced.savedSnapshots[job.dedupeKey].title, job.title);
  assert.equal(synced.applications[job.dedupeKey].note, '외과 지원');
  const remapped = replaceSavedSnapshots(loaded, { remote: { ...job, dedupeKey: 'new-key', jobKey: 'new-key' } }, now);
  assert.ok(remapped.savedSnapshots[job.dedupeKey]);
  assert.equal(Object.keys(remapped.savedSnapshots).length, 1);
});

test('collector persistence failure never advances the discovery checkpoint', () => {
  const state = createUserState('2026-09-20T09:00:00Z');
  const response = { jobs: [], lastSuccessAt: '2026-09-21T09:00:00Z' };
  assert.strictEqual(advanceDiscoveryCheckpoint(state, { ...response, refresh: { error: 'write failed' } }), state);
  assert.strictEqual(advanceDiscoveryCheckpoint(state, { ...response, dataTrust: { cacheWriteFailed: true } }), state);
});
