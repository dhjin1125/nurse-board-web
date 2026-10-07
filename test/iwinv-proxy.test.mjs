import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

const ENV_KEYS = [
  'VERCEL', 'IWINV_COLLECTOR', 'IWINV_API_ORIGIN', 'IWINV_RELAY_TOKEN',
  'BLOB_READ_WRITE_TOKEN', 'OPENAI_API_KEY',
];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Vercel API requests are authenticated and proxied to IWINV', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = snapshotEnv();
  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
  });
  process.env.VERCEL = '1';
  delete process.env.IWINV_COLLECTOR;
  process.env.IWINV_API_ORIGIN = 'https://collector.example';
  process.env.IWINV_RELAY_TOKEN = 'relay-test-secret';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.OPENAI_API_KEY;
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url: String(url), options };
    return new Response(JSON.stringify({ mode: 'iwinv' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  };

  const { app } = await import(`../server.mjs?proxy=${Date.now()}`);
  const origin = await listen(app, t);
  const response = await originalFetch(`${origin}/api/ai/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://nurse-board.example' },
    body: JSON.stringify({ query: '서울 보건관리자' }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-nurse-board-api-origin'), 'iwinv');
  assert.deepEqual(await response.json(), { mode: 'iwinv' });
  assert.equal(forwarded.url, 'https://collector.example/api/ai/intent');
  assert.equal(forwarded.options.headers.get('authorization'), 'Bearer relay-test-secret');
  assert.equal(forwarded.options.headers.get('origin'), 'https://nurse-board.example');
  assert.deepEqual(JSON.parse(forwarded.options.body), { query: '서울 보건관리자' });

  const proxiedRequest = forwarded;
  const savedSync = await originalFetch(`${origin}/api/saved-sync`, {
    headers: { 'x-nurse-board-sync-code': '2345-6789-ABCD-EFGH' },
  });
  assert.equal(savedSync.status, 200);
  assert.deepEqual((await savedSync.json()).savedSnapshots, {});
  assert.equal(forwarded, proxiedRequest, '스크랩 동기화는 IWINV가 아닌 Vercel의 private 저장소에서 처리해야 합니다.');

  const feedback = await originalFetch(`${origin}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '자동 라우팅 점검입니다.', website: 'bot-check' }),
  });
  assert.equal(feedback.status, 201);
  assert.equal((await feedback.json()).ok, true);
  assert.equal(forwarded, proxiedRequest, '피드백 제출은 IWINV로 공개 중계하지 않고 Vercel의 private 저장소에서 처리해야 합니다.');
  const privateFeedback = await originalFetch(`${origin}/api/feedback`);
  assert.equal(privateFeedback.status, 404);
  assert.equal(forwarded, proxiedRequest, '피드백 목록은 공개 경로에서 조회할 수 없어야 합니다.');

  globalThis.fetch = async (url, options) => {
    forwarded = { url: String(url), options };
    return new Response(JSON.stringify({
      detailVerified: true,
      detailBodyAvailable: true,
      detailOrigin: 'original',
      experience: 'IRB 업무 경력 1년 이상',
      duties: '연구윤리 심의 지원',
      description: '국립암센터 공식 채용 페이지에서 확인',
      descriptionKind: 'content',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const relayedDetail = await originalFetch(`${origin}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=1205157' }),
  });
  assert.equal(relayedDetail.status, 200);
  assert.equal(relayedDetail.headers.get('x-nurse-board-api-origin'), 'iwinv');
  assert.equal((await relayedDetail.json()).experience, 'IRB 업무 경력 1년 이상');
  assert.equal(forwarded.url, 'https://collector.example/api/job-detail');
  assert.equal(forwarded.options.headers.get('authorization'), 'Bearer relay-test-secret');
  assert.deepEqual(JSON.parse(forwarded.options.body), {
    url: 'https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=1205157',
  });

  globalThis.fetch = async () => { throw new Error('collector offline'); };
  const fallback = await originalFetch(`${origin}/api/ai/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '서울 보건관리자' }),
  });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get('x-nurse-board-api-origin'), 'vercel-fallback');
  assert.equal((await fallback.json()).mode, 'local');

  globalThis.fetch = async () => new Response('<h1>upstream unavailable</h1>', {
    status: 503,
    headers: { 'content-type': 'text/html' },
  });
  for (const [path, options] of [
    ['/api/health?probe=1', undefined],
    ['/api/refresh?force=1', { method: 'POST' }],
    ['/api/import/nurscape?source=extension', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobs: [] }),
    }],
  ]) {
    const unavailable = await originalFetch(`${origin}${path}`, options);
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.headers.get('content-type'), /application\/json/);
    assert.equal(unavailable.headers.get('x-nurse-board-api-origin'), 'iwinv-unavailable');
    assert.deepEqual(await unavailable.json(), { error: 'IWINV 수집 서버에 연결하지 못했습니다.' });
  }

  const jobsFallback = await originalFetch(`${origin}/api/jobs?view=latest`);
  assert.equal(jobsFallback.status, 200);
  assert.equal(jobsFallback.headers.get('x-nurse-board-api-origin'), 'vercel-fallback');
  assert.ok(Array.isArray((await jobsFallback.json()).jobs));

  globalThis.fetch = async () => new Response('not json', {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
  const nonJsonMutation = await originalFetch(`${origin}/api/refresh?force=2`, { method: 'POST' });
  assert.equal(nonJsonMutation.status, 503);
  assert.match(nonJsonMutation.headers.get('content-type'), /application\/json/);

  globalThis.fetch = async () => { throw new Error('collector network error'); };
  const networkMutation = await originalFetch(`${origin}/api/import/nurscape?source=retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobs: [] }),
  });
  assert.equal(networkMutation.status, 503);
  assert.deepEqual(await networkMutation.json(), { error: 'IWINV 수집 서버에 연결하지 못했습니다.' });

  const nearMatch = await originalFetch(`${origin}/api/refreshing?force=1`, { method: 'POST' });
  assert.equal(nearMatch.status, 404);
});

test('collector mode wins over Vercel, requires auth, and exposes a Blob-free liveness route', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = snapshotEnv();
  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
  });
  process.env.VERCEL = '1';
  process.env.IWINV_COLLECTOR = 'true';
  process.env.IWINV_API_ORIGIN = 'https://must-not-be-used.example';
  process.env.IWINV_RELAY_TOKEN = 'relay-test-secret';
  process.env.BLOB_READ_WRITE_TOKEN = 'invalid-but-present-test-token';
  globalThis.fetch = async () => { throw new Error('proxy or Blob access must not occur'); };

  const { app } = await import(`../server.mjs?relay=${Date.now()}`);
  const origin = await listen(app, t);
  const rejected = await originalFetch(`${origin}/api/healthz`);
  assert.equal(rejected.status, 401);
  const accepted = await originalFetch(`${origin}/api/healthz`, {
    headers: { authorization: 'Bearer relay-test-secret' },
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { status: 'ok', live: true });
});

test('collector mode fails fast when either required secret is missing', async (t) => {
  const originalEnv = snapshotEnv();
  t.after(() => restoreEnv(originalEnv));
  process.env.IWINV_COLLECTOR = 'true';
  delete process.env.VERCEL;
  delete process.env.IWINV_RELAY_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = 'blob-test-token';
  await assert.rejects(
    import(`../server.mjs?missing-relay=${Date.now()}`),
    /IWINV_RELAY_TOKEN is required/,
  );

  process.env.IWINV_RELAY_TOKEN = 'relay-test-secret';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await assert.rejects(
    import(`../server.mjs?missing-blob=${Date.now()}`),
    /BLOB_READ_WRITE_TOKEN is required/,
  );
});
