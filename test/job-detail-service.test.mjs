import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobDetailService, readDetailCache, writeDetailCache } from '../lib/job-detail-service.mjs';

const job = { url: 'https://www.nursejob.co.kr/recruit/view?id=1' };
const detail = { detailVerified: true, duties: '건강상담' };

test('detail reads never collect, including a cold cache and concurrent visits', async () => {
  let collections = 0;
  const service = createJobDetailService({ collect: async () => { collections++; return detail; } });
  assert.deepEqual(await Promise.all([service.read(job.url), service.read(job.url)]), [null, null]);
  assert.equal(collections, 0);
});

test('warm results survive a process restart and failed refreshes retain verified detail', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurse-detail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'details.json');
  const storage = { readCache: () => readDetailCache(path), writeCache: (value) => writeDetailCache(path, value) };
  let time = Date.now();
  const first = createJobDetailService({ ...storage, now: () => time, collect: async () => detail });
  await first.warm([job]);
  time += 7 * 60 * 60 * 1000;
  const restarted = createJobDetailService({ ...storage, now: () => time, collect: async () => { throw new Error('source offline'); } });
  assert.equal((await restarted.read(job.url)).duties, detail.duties);
  assert.equal((await restarted.read(job.url)).detailStale, true);
  await restarted.refresh(job);
  assert.equal((await restarted.read(job.url)).duties, detail.duties);
  assert.equal((await readDetailCache(path)).entries[job.url].detail.duties, detail.duties);
});

test('worker limits concurrency, deduplicates URLs and backs off failed sources', async () => {
  let active = 0;
  let peak = 0;
  let attempts = 0;
  const service = createJobDetailService({
    concurrency: 2,
    collect: async () => {
      attempts++;
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      throw new Error('blocked');
    },
  });
  const jobs = Array.from({ length: 5 }, (_, id) => ({ url: `${job.url}&n=${id}` }));
  await Promise.all([service.warm([...jobs, ...jobs]), service.warm(jobs)]);
  await service.warm(jobs);
  assert.equal(attempts, 5);
  assert.equal(peak, 2);
});

test('concurrent explicit retries share one collection and one durable write', async () => {
  let calls = 0;
  let writes = 0;
  const service = createJobDetailService({
    collect: async () => { calls++; await new Promise((resolve) => setImmediate(resolve)); return detail; },
    writeCache: async () => { writes++; },
  });
  const results = await Promise.all([service.refresh(job), service.refresh(job)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(calls, 1);
  assert.equal(writes, 1);
});
