import test from 'node:test';
import assert from 'node:assert/strict';
import { exceedsListingAgeLimit, jobMatchesFilters } from '../src/job-utils.js';
import { jobPage } from '../lib/job-page.mjs';

test('30-day visibility changes at KST midnight without extending on collection', () => {
  const job = { publishedAt: '2026-08-22', lastSeenAt: '2026-09-21T14:59:00Z', deadline: '상시채용' };
  assert.equal(exceedsListingAgeLimit(job, new Date('2026-09-21T14:59:59Z')), false);
  assert.equal(exceedsListingAgeLimit(job, new Date('2026-09-21T15:00:00Z')), true);
  assert.equal(jobMatchesFilters(job, { availability: '진행 중' }, new Date('2026-09-21T15:00:00Z')), false);
});

test('registration date takes precedence; missing dates use first collection, never last collection', () => {
  const now = new Date('2026-09-21T09:00:00Z');
  assert.equal(exceedsListingAgeLimit({ publishedAt: '2026-09-20', firstSeenAt: '2026-07-01' }, now), false);
  assert.equal(exceedsListingAgeLimit({ publishedAt: 'invalid', firstSeenAt: '2026-07-01', lastSeenAt: now.toISOString() }, now), true);
  assert.equal(exceedsListingAgeLimit({ lastSeenAt: now.toISOString() }, now), false);
  assert.equal(jobMatchesFilters({ publishedAt: '2026-07-01', deadlineAt: '2099-01-01' }, { availability: '진행 중' }, now), false);
});

test('pagination excludes old listings before counting but saved IDs remain accessible', () => {
  const snapshot = { jobs: [
    { id: 'old', title: '간호사', company: '병원', firstSeenAt: '2000-01-01', deadline: '상시채용' },
    { id: 'new', title: '간호사', company: '병원', publishedAt: new Date().toISOString(), deadline: '상시채용' },
  ] };
  const current = JSON.parse(jobPage(snapshot, { filters: JSON.stringify({ availability: '진행 중' }), limit: '1' }).body);
  assert.equal(current.pagination.total, 1);
  assert.deepEqual(current.jobs.map(j => j.id), ['new']);
  assert.equal(current.pagination.hasMore, false);
  const saved = JSON.parse(jobPage(snapshot, { ids: '["old"]' }).body);
  assert.deepEqual(saved.jobs.map(j => j.id), ['old']);
  assert.equal(snapshot.jobs.length, 2);
});
