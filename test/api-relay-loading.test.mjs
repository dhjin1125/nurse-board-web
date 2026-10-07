import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { createApiApp } from '../api/index.mjs';
import { registerIwinvRelay } from '../lib/api-relay.mjs';

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('normal list and detail reads relay without importing collectors or local stores', async (t) => {
  const fetchLocal = globalThis.fetch;
  let localLoads = 0;
  const requests = [];
  const origin = await listen(createApiApp({
    origin: 'https://collector.example', token: 'test-relay-token',
    loadLocalApp: () => { localLoads++; throw new Error('Local server must stay unloaded'); },
  }), t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return Response.json({ cached: true });
  });
  for (const [path, options] of [
    ['/api/jobs'], ['/api/job?id=123'],
    ['/api/job-detail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.nursejob.co.kr/recruit/123' }) }],
  ]) {
    const response = await fetchLocal(`${origin}${path}`, options);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cached: true });
  }
  assert.equal(localLoads, 0);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ options }) => options.headers.get('authorization') === 'Bearer test-relay-token'));
});

test('Saramin detail refresh runs locally so the parser can persist its source image', async (t) => {
  const fetchLocal = globalThis.fetch;
  let localLoads = 0;
  let relayCalls = 0;
  const local = express();
  local.use(express.json());
  local.post('/api/job-detail', (req, res) => res.json({ local: true, refresh: req.body.refresh }));
  const origin = await listen(createApiApp({
    origin: 'https://collector.example', token: 'test-relay-token',
    loadLocalApp: () => { localLoads += 1; return local; },
  }), t);
  t.mock.method(globalThis, 'fetch', async () => { relayCalls += 1; return Response.json({ relayed: true }); });
  const response = await fetchLocal(`${origin}/api/job-detail`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true, url: 'https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=55102113' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { local: true, refresh: true });
  assert.equal(localLoads, 1);
  assert.equal(relayCalls, 0);
});

test('an unavailable collector loads the fallback once and does not relay the same request twice', async (t) => {
  const fetchLocal = globalThis.fetch;
  let localLoads = 0;
  let remoteCalls = 0;
  const fallback = express();
  registerIwinvRelay(fallback, { origin: 'https://collector.example', token: 'test-relay-token' });
  fallback.get('/api/jobs', (_req, res) => res.json({ jobs: ['last-success'] }));
  const origin = await listen(createApiApp({
    origin: 'https://collector.example', token: 'test-relay-token',
    loadLocalApp: () => { localLoads++; return fallback; },
  }), t);
  t.mock.method(globalThis, 'fetch', async () => { remoteCalls++; throw new Error('offline'); });
  for (let index = 0; index < 2; index++) {
    const response = await fetchLocal(`${origin}/api/jobs`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { jobs: ['last-success'] });
  }
  assert.equal(localLoads, 1);
  assert.equal(remoteCalls, 2);
});

test('a truncated upstream body falls back before committing cache headers or partial JSON', async (t) => {
  const fetchLocal = globalThis.fetch;
  const fallback = express();
  fallback.get('/api/jobs', (_req, res) => res.json({ jobs: ['complete-cache'] }));
  const origin = await listen(createApiApp({
    origin: 'https://collector.example', token: 'test', loadLocalApp: () => fallback,
  }), t);
  let brokenBody;
  t.mock.method(globalThis, 'fetch', async () => new Response(brokenBody, {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=30' },
  }));
  for (brokenBody of ['{"jobs":[{"title":"cut', '']) {
    const response = await fetchLocal(`${origin}/api/jobs`);
    assert.deepEqual(await response.json(), { jobs: ['complete-cache'] });
    assert.equal(response.headers.get('x-nurse-board-api-origin'), 'vercel-fallback');
    assert.equal(response.headers.get('cache-control'), null);
  }
});

test('a body stream failure falls back without sending a partial success', async (t) => {
  const fetchLocal = globalThis.fetch;
  const fallback = express();
  fallback.get('/api/jobs', (_req, res) => res.json({ jobs: [] }));
  const origin = await listen(createApiApp({ origin: 'https://collector.example', token: 'test', loadLocalApp: () => fallback }), t);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"jobs":[')); },
    pull(controller) { controller.error(new Error('body timed out')); },
  }), { headers: { 'content-type': 'application/json' } }));
  const response = await fetchLocal(`${origin}/api/jobs`);
  assert.deepEqual(await response.json(), { jobs: [] });
  assert.equal(response.headers.get('x-nurse-board-api-origin'), 'vercel-fallback');
});

test('large relayed lists are compressed and preserve the complete JSON', async (t) => {
  const fetchLocal = globalThis.fetch;
  const payload = { jobs: Array.from({ length: 100 }, (_, id) => ({ id, title: '간호사 채용 공고' })) };
  const origin = await listen(createApiApp({ origin: 'https://collector.example', token: 'test' }), t);
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
  const response = await fetchLocal(`${origin}/api/jobs`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.match(response.headers.get('vary'), /Accept-Encoding/);
  assert.ok(Number(response.headers.get('content-length')) < Buffer.byteLength(JSON.stringify(payload)) / 2);
  assert.deepEqual(await response.json(), payload);
});
