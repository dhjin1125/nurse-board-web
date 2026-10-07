import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import {
  createBlobFeedbackStore,
  normalizeFeedback,
  registerFeedbackRoutes,
} from '../lib/feedback.mjs';

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function memoryStore() {
  const records = [];
  return {
    records,
    async write(record) { records.push(structuredClone(record)); return record; },
    async list({ limit } = {}) { return records.slice().reverse().slice(0, Number(limit) || 100); },
  };
}

test('feedback normalization keeps only bounded useful context', () => {
  const record = normalizeFeedback({
    category: 'data',
    message: '  이 공고의 마감일이 원문과 달라요.  ',
    context: {
      pagePath: '/recruitment/fixture-1',
      viewport: 'mobile',
      view: 'all',
      jobId: 'fixture-1',
      jobSource: '고용24',
      secret: 'discard-me',
    },
  }, {
    now: () => new Date('2026-09-03T06:00:00.000Z'),
    createId: () => 'feedback-test-id',
  });

  assert.deepEqual(record, {
    version: 1,
    id: 'feedback-test-id',
    category: 'data',
    message: '이 공고의 마감일이 원문과 달라요.',
    context: {
      pagePath: '/recruitment/fixture-1',
      viewport: 'mobile',
      view: 'all',
      jobId: 'fixture-1',
      jobSource: '고용24',
    },
    status: 'new',
    createdAt: '2026-09-03T06:00:00.000Z',
  });
  assert.throws(() => normalizeFeedback({ message: '짧음' }), /4자 이상/);
  assert.throws(() => normalizeFeedback({ message: '가'.repeat(1501) }), /1500자/);
});

test('Blob feedback store writes each submission to an immutable private object', async () => {
  const puts = [];
  const record = normalizeFeedback({ category: 'idea', message: '지도에서 근무지를 보고 싶어요.' }, {
    now: () => new Date('2026-09-03T06:10:00.000Z'),
    createId: () => 'feedback-blob-id',
  });
  const store = createBlobFeedbackStore({
    token: 'blob-test-token',
    putBlob: async (...args) => { puts.push(args); return { pathname: args[0] }; },
    listBlobs: async () => ({ blobs: [], hasMore: false }),
    getBlob: async () => null,
  });

  await store.write(record);

  assert.equal(puts.length, 1);
  assert.match(puts[0][0], /^nurse-board\/feedback\/2026-09-03\/.*feedback-blob-id\.json$/);
  assert.equal(puts[0][1], JSON.stringify(record));
  assert.deepEqual(puts[0][2], {
    access: 'private',
    token: 'blob-test-token',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: false,
  });
});

test('public feedback route accepts submissions but never exposes the list', async (t) => {
  const store = memoryStore();
  let nextId = 0;
  const app = express();
  app.use(express.json());
  registerFeedbackRoutes(app, {
    store,
    now: () => new Date('2026-09-03T06:20:00.000Z'),
    createId: () => `feedback-route-${++nextId}`,
  });
  const origin = await listen(app, t);

  const response = await fetch(`${origin}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'bug', message: '상세 화면 버튼이 잘리지 않는지 확인해 주세요.', context: { viewport: 'mobile' } }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    id: 'feedback-route-1',
    createdAt: '2026-09-03T06:20:00.000Z',
  });
  assert.equal(store.records.length, 1);

  const listResponse = await fetch(`${origin}/api/feedback`);
  assert.equal(listResponse.status, 404);
  assert.deepEqual(await listResponse.json(), { error: '찾을 수 없는 경로입니다.' });

  const honeypot = await fetch(`${origin}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '자동 입력입니다.', website: 'https://spam.example' }),
  });
  assert.equal(honeypot.status, 201);
  assert.equal(store.records.length, 1);
});

test('protected collector route can list feedback and submission bursts are limited', async (t) => {
  const store = memoryStore();
  const app = express();
  app.use(express.json());
  registerFeedbackRoutes(app, {
    store,
    allowRead: true,
    maxSubmissionsPerWindow: 1,
    now: () => new Date('2026-09-03T06:30:00.000Z'),
    createId: () => 'feedback-admin-id',
  });
  const origin = await listen(app, t);

  const payload = { category: 'other', message: '첫 번째 피드백입니다.' };
  assert.equal((await fetch(`${origin}/api/feedback`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })).status, 201);
  const limited = await fetch(`${origin}/api/feedback`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(limited.status, 429);

  const listResponse = await fetch(`${origin}/api/feedback?limit=10`);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(listed.count, 1);
  assert.equal(listed.feedback[0].id, 'feedback-admin-id');
});
