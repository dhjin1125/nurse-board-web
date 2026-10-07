import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import {
  NURSCAPE_EXTENSION_ID,
  NURSCAPE_EXTENSION_ORIGIN,
  NURSCAPE_IMPORT_LIMIT,
  NurscapeImportError,
  createNurscapeImportCors,
  createNurscapeImportHandler,
  importNurscapePayload,
  prepareNurscapeImport,
  readNurscapeImportCache,
  validateNurscapeJob,
  writeNurscapeImportCacheAtomic,
} from '../lib/nurscape-import.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');

function rawJob(id, overrides = {}) {
  return {
    id: String(id),
    company: `테스트기업 ${id}`,
    title: `보건관리자 ${id} 채용`,
    region: '서울',
    url: `https://job.nurscape.net/Jobs/Details/${id}?r=test`,
    ...overrides,
  };
}

async function temporaryCache(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nurse-board-nurscape-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'nurscape-import.json');
}

test('manifest key fixes the extension ID used by the import Origin allowlist', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'nurscape-bridge/manifest.json'), 'utf8'));
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const derivedId = [...digest].map((value) => String.fromCharCode(97 + Number.parseInt(value, 16))).join('');
  assert.equal(derivedId, NURSCAPE_EXTENSION_ID);
  assert.equal(NURSCAPE_EXTENSION_ORIGIN, `chrome-extension://${derivedId}`);
});

test('validates HTTPS nurscape detail URLs and exact payload ID matches', () => {
  assert.equal(validateNurscapeJob(rawJob(590410)).ok, true);
  const invalidJobs = [
    rawJob(1, { url: 'http://job.nurscape.net/Jobs/Details/1' }),
    rawJob(1, { url: 'https://nurscape.net/Jobs/Details/1' }),
    rawJob(1, { url: 'https://job.nurscape.net.evil.example/Jobs/Details/1' }),
    rawJob(1, { url: 'https://job.nurscape.net/Jobs/Details/2' }),
    rawJob(1, { url: 'https://job.nurscape.net/Jobs/Details/1/apply' }),
    rawJob('abc1'),
  ];
  for (const job of invalidJobs) assert.equal(validateNurscapeJob(job).ok, false, job.url);
});

test('rejects an empty import without changing the existing cache', async (t) => {
  const cachePath = await temporaryCache(t);
  const original = '{"updatedAt":"safe","jobs":[{"id":"nurscape-1"}]}\n';
  await fs.writeFile(cachePath, original);
  await assert.rejects(
    importNurscapePayload({ jobs: [] }, { cachePath }),
    (error) => error instanceof NurscapeImportError && error.statusCode === 400,
  );
  assert.equal(await fs.readFile(cachePath, 'utf8'), original);
});

test('replaces the synchronized page snapshot and preserves firstSeenAt for jobs still present', async (t) => {
  const cachePath = await temporaryCache(t);
  const firstAt = '2026-07-11T01:00:00.000Z';
  const secondAt = '2026-07-11T02:00:00.000Z';
  const firstResult = await importNurscapePayload({ jobs: [rawJob(1), rawJob(2)] }, { cachePath, now: firstAt });
  assert.deepEqual(firstResult, { received: 2, inserted: 2, updated: 0, rejected: 0, sourceUpdatedAt: firstAt });

  const secondResult = await importNurscapePayload({ jobs: [rawJob(2, { title: '수정된 보건관리자 채용' }), rawJob(3)] }, { cachePath, now: secondAt });
  assert.deepEqual(secondResult, { received: 2, inserted: 1, updated: 1, rejected: 0, sourceUpdatedAt: secondAt });

  const cache = await readNurscapeImportCache(cachePath);
  assert.equal(cache.jobs.length, 2);
  const jobs = new Map(cache.jobs.map((job) => [job.id, job]));
  assert.equal(jobs.has('nurscape-1'), false);
  assert.equal(jobs.get('nurscape-2').firstSeenAt, firstAt);
  assert.equal(jobs.get('nurscape-2').lastSeenAt, secondAt);
  assert.equal(jobs.get('nurscape-2').title, '수정된 보건관리자 채용');
  assert.equal(jobs.get('nurscape-3').firstSeenAt, secondAt);
});

test('counts invalid and duplicate payload entries as rejected while keeping valid jobs', async (t) => {
  const cachePath = await temporaryCache(t);
  const result = await importNurscapePayload({
    jobs: [rawJob(1), rawJob(1), rawJob(2, { url: 'https://evil.example/Jobs/Details/2' })],
  }, { cachePath, now: '2026-07-11T03:00:00.000Z' });
  assert.deepEqual(result, {
    received: 3,
    inserted: 1,
    updated: 0,
    rejected: 2,
    sourceUpdatedAt: '2026-07-11T03:00:00.000Z',
  });
});

test('accepts a 15-page snapshot up to the 450-job import limit', () => {
  assert.equal(NURSCAPE_IMPORT_LIMIT, 450);
  const incoming = Array.from({ length: 451 }, (_, index) => rawJob(index + 1));
  const prepared = prepareNurscapeImport(incoming, { jobs: [] }, { now: '2026-07-11T03:30:00.000Z' });
  assert.equal(prepared.cache.jobs.length, 450);
  assert.equal(prepared.result.received, 451);
  assert.equal(prepared.result.inserted, 450);
  assert.equal(prepared.result.rejected, 1);
});

test('atomic cache write leaves the previous file intact when rename fails', async (t) => {
  const cachePath = await temporaryCache(t);
  const original = '{"safe":true}\n';
  await fs.writeFile(cachePath, original);
  const fsApi = {
    mkdir: fs.mkdir.bind(fs),
    writeFile: fs.writeFile.bind(fs),
    unlink: fs.unlink.bind(fs),
    rename: async () => { throw new Error('simulated rename failure'); },
  };
  await assert.rejects(
    writeNurscapeImportCacheAtomic(cachePath, { jobs: [] }, { fsApi, suffix: 'failure-test' }),
    /simulated rename failure/,
  );
  assert.equal(await fs.readFile(cachePath, 'utf8'), original);
  assert.deepEqual((await fs.readdir(path.dirname(cachePath))).filter((name) => name.endsWith('.tmp')), []);
});

test('import CORS permits only the fixed extension Origin', () => {
  const middleware = createNurscapeImportCors();
  const createResponse = () => ({
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    vary(value) { this.headers.Vary = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    sendStatus(value) { this.statusCode = value; return this; },
  });

  const allowedResponse = createResponse();
  let nextCalled = false;
  middleware({ method: 'POST', headers: { origin: NURSCAPE_EXTENSION_ORIGIN } }, allowedResponse, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(allowedResponse.headers['Access-Control-Allow-Origin'], NURSCAPE_EXTENSION_ORIGIN);

  const maliciousResponse = createResponse();
  middleware({ method: 'POST', headers: { origin: 'https://malicious.example' } }, maliciousResponse, () => assert.fail('must not call next'));
  assert.equal(maliciousResponse.statusCode, 403);

  const preflightResponse = createResponse();
  middleware({ method: 'OPTIONS', headers: { origin: NURSCAPE_EXTENSION_ORIGIN } }, preflightResponse, () => assert.fail('preflight must finish'));
  assert.equal(preflightResponse.statusCode, 204);
});

test('import middleware rejects a malicious Origin and returns the required result schema', async (t) => {
  const cachePath = await temporaryCache(t);
  let importedResult;
  const app = express();
  app.use(express.json());
  const cors = createNurscapeImportCors();
  app.options('/api/import/nurscape', cors);
  app.post('/api/import/nurscape', cors, createNurscapeImportHandler({
    cachePath,
    now: () => new Date('2026-07-11T06:00:00.000Z'),
    onImported: async (result) => { importedResult = result; },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const malicious = await fetch(`${baseUrl}/api/import/nurscape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://malicious.example' },
    body: JSON.stringify({ jobs: [rawJob(10)] }),
  });
  assert.equal(malicious.status, 403);

  const allowed = await fetch(`${baseUrl}/api/import/nurscape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: NURSCAPE_EXTENSION_ORIGIN },
    body: JSON.stringify({ jobs: [rawJob(10)] }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), NURSCAPE_EXTENSION_ORIGIN);
  assert.deepEqual(await allowed.json(), {
    received: 1,
    inserted: 1,
    updated: 0,
    rejected: 0,
    sourceUpdatedAt: '2026-07-11T06:00:00.000Z',
  });
  assert.equal(importedResult.inserted, 1);
});

test('nurscape import can persist through a durable cache store without a file path', async () => {
  let stored = { updatedAt: null, sourceUpdatedAt: null, jobs: [] };
  const cacheStore = {
    read: async () => structuredClone(stored),
    write: async (value) => { stored = structuredClone(value); },
  };

  const result = await importNurscapePayload({ jobs: [rawJob(21)] }, {
    cacheStore,
    now: new Date('2026-07-12T00:00:00.000Z'),
  });

  assert.equal(result.inserted, 1);
  assert.equal(stored.jobs[0].id, 'nurscape-21');
  assert.equal(stored.sourceUpdatedAt, '2026-07-12T00:00:00.000Z');
  assert.deepEqual(await readNurscapeImportCache(undefined, { cacheStore }), stored);
});
