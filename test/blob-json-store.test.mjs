import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobJsonStore } from '../lib/blob-json-store.mjs';

const jsonStream = (value) => new Response(JSON.stringify(value)).body;

test('returns a fresh seed without loading Blob when the token is missing', async () => {
  let getCalls = 0;
  const seed = { version: 1, sources: {} };
  const store = createBlobJsonStore({
    pathname: 'cache/jobs.json',
    seed,
    token: '',
    getBlob: async () => { getCalls += 1; },
  });

  const value = await store.read();
  value.sources.changed = true;

  assert.deepEqual(await store.read(), seed);
  assert.equal(getCalls, 0);
});

test('returns and caches the seed when the Blob does not exist', async () => {
  let getCalls = 0;
  const store = createBlobJsonStore({
    pathname: 'cache/jobs.json',
    seed: () => ({ version: 1, sources: {} }),
    token: 'test-token',
    getBlob: async () => { getCalls += 1; return null; },
  });

  assert.deepEqual(await store.read(), { version: 1, sources: {} });
  assert.deepEqual(await store.read(), { version: 1, sources: {} });
  assert.equal(getCalls, 1);
});

test('reads JSON from the Blob stream and uses the in-process cache', async () => {
  let getCalls = 0;
  const stored = { version: 1, savedAt: '2026-07-12T00:00:00.000Z' };
  const store = createBlobJsonStore({
    pathname: 'cache/jobs.json',
    seed: {},
    token: 'test-token',
    getBlob: async (pathname, options) => {
      getCalls += 1;
      assert.equal(pathname, 'cache/jobs.json');
      assert.deepEqual(options, { access: 'private', token: 'test-token', useCache: false });
      return { statusCode: 200, stream: jsonStream(stored) };
    },
  });

  assert.deepEqual(await Promise.all([store.read(), store.read()]), [stored, stored]);
  assert.deepEqual(await store.read(), stored);
  assert.equal(getCalls, 1);
});

test('writes JSON with a stable pathname and explicit overwrite options', async () => {
  const calls = [];
  const store = createBlobJsonStore({
    pathname: 'cache/jobs.json',
    seed: {},
    token: 'test-token',
    access: 'private',
    putBlob: async (...args) => {
      calls.push(args);
      return { pathname: args[0], etag: 'etag-1' };
    },
  });
  const value = { version: 1, sources: { saramin: { jobs: [] } } };

  const result = await store.write(value);

  assert.deepEqual(result, { pathname: 'cache/jobs.json', etag: 'etag-1' });
  assert.deepEqual(calls, [[
    'cache/jobs.json',
    JSON.stringify(value),
    {
      access: 'private',
      token: 'test-token',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    },
  ]]);
  assert.deepEqual(await store.read(), value);
});

test('clearCache makes the next read fetch Blob JSON again', async () => {
  let revision = 0;
  const store = createBlobJsonStore({
    pathname: 'cache/jobs.json',
    seed: {},
    token: 'test-token',
    getBlob: async () => ({ statusCode: 200, stream: jsonStream({ revision: ++revision }) }),
  });

  assert.deepEqual(await store.read(), { revision: 1 });
  store.clearCache();
  assert.deepEqual(await store.read(), { revision: 2 });
});
