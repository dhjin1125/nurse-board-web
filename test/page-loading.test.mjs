import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { app, jobService, jobDetailService } from '../server.mjs';
import { createJobService } from '../lib/job-service.mjs';
import { registerJobRoutes } from '../lib/job-routes.mjs';
import { prepareJobForDisplay } from '../lib/job-presentation.mjs';
import { applicationTierFor } from '../src/job-utils.js';

const job = {
  id: 'page-loading-fixture', title: '사업장 보건관리자 간호사', company: '테스트기업',
  url: 'https://www.nursejob.co.kr/recruit/page-loading-fixture',
  region: '서울', employment: '정규직', deadline: '채용시까지', duties: '직원 건강상담',
};

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('opening uncached and cached detail only reads stored data, without collecting or writing', async (t) => {
  const origin = await listen(app, t);
  const request = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Page reads must not fetch an original website'); });
  t.mock.method(jobDetailService, 'refresh', () => { assert.fail('Page reads must not start collection'); });
  t.mock.method(jobDetailService, 'read', async () => null);
  const response = await request(`${origin}/api/job-detail`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: job.url, job }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-nurse-board-detail-cache'), 'miss');
  assert.equal((await response.json()).detailVerified, false);

  t.mock.method(jobDetailService, 'read', async () => ({ detailVerified: true, duties: '서버에 저장된 상세' }));
  const cached = await request(`${origin}/api/job-detail`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: job.url, job }),
  });
  assert.equal(cached.headers.get('x-nurse-board-detail-cache'), 'hit');
  assert.equal((await cached.json()).duties, '서버에 저장된 상세');
});

test('a direct detail URL returns its job and stored detail in one API response', async (t) => {
  const origin = await listen(app, t);
  const prepared = prepareJobForDisplay(job);
  t.mock.method(jobService, 'getSnapshot', async () => ({ jobs: [prepared], needsReviewJobs: [] }));
  t.mock.method(jobDetailService, 'read', async () => ({ detailVerified: true, duties: '직원 건강상담' }));
  const request = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Direct detail reads must not scrape'); });
  const response = await request(`${origin}/api/job?id=${job.id}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.job.id, job.id);
  assert.equal(data.detail.duties, '직원 건강상담');
  assert.deepEqual(data.job.presentation.applicationTier, applicationTierFor(job));
  assert.equal((await request(`${origin}/api/job?id=missing-fixture`)).status, 404);
});

test('list requests reuse server-prepared, compressed responses without collecting', async (t) => {
  let preparations = 0;
  const service = createJobService({
    sources: [{ id: 'test', name: '테스트', collect: () => assert.fail('A read cannot collect') }],
    cacheFile: 'unused.json',
    readCache: async () => ({ version: 1, sources: { test: { jobs: [job], status: 'success' } } }),
    prepareJob: (job) => { preparations++; return prepareJobForDisplay(job); },
  });
  const server = express();
  registerJobRoutes(server, { jobService: service });
  const origin = await listen(server, t);
  const response = await fetch(`${origin}/api/jobs`, { headers: { 'accept-encoding': 'gzip' } });
  const payload = await response.text();
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.ok(Number(response.headers.get('content-length')) < Buffer.byteLength(payload));
  assert.ok(JSON.parse(payload).jobs[0].presentation.applicationTier);
  await fetch(`${origin}/api/jobs`);
  assert.equal(preparations, 1);
});

test('server assessments are reused for the matching profile and recomputed for different preferences', () => {
  const prepared = prepareJobForDisplay(job);
  assert.strictEqual(applicationTierFor(prepared), prepared.presentation.applicationTier);
  assert.notStrictEqual(applicationTierFor(prepared, { regionCodes: ['부산'] }), prepared.presentation.applicationTier);
});
