import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import {
  LEGACY_SAVED_SYNC_CODE_STORAGE_KEY,
  SAVED_SYNC_TOKEN_STORAGE_KEY,
  clearPendingSavedSyncMutations,
  enqueueSavedSyncMutation,
  formatPairingCode,
  isValidPairingCode,
  isValidSyncToken,
  mergeSavedSnapshots,
  normalizePairingCode,
  readPendingSavedSyncMutations,
  readSavedSyncToken,
  replaceSavedSnapshots,
  writeSavedSyncToken,
} from '../src/saved-sync.js';
import { createUserState, saveJobSnapshot } from '../src/user-state.js';
import { registerSavedSyncRoutes, savedSyncId, savedSyncPairingId } from '../lib/saved-sync.mjs';

const NOW = '2026-08-21T09:00:00.000Z';
const LATER = '2026-08-21T10:00:00.000Z';
const TOKEN = 'A'.repeat(43);
const LEGACY_TOKEN = "synthetic-legacy-sync";
const PAIRING_CODE = '0427';
const job = (id, title = `공고 ${id}`) => ({
  id,
  dedupeKey: `병원:${id}`,
  company: '테스트병원',
  title,
  region: '서울',
  url: `https://example.com/${id}`,
});

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function memorySyncStore() {
  const values = new Map();
  return {
    values,
    async read(id) { return values.has(id) ? structuredClone(values.get(id)) : null; },
    async update(id, updater) {
      const next = await updater(values.has(id) ? structuredClone(values.get(id)) : null);
      values.set(id, structuredClone(next));
      return structuredClone(next);
    },
  };
}

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('연결 화면은 숫자 4자리만 받고 영구 기기키는 별도로 저장한다', () => {
  assert.equal(normalizePairingCode(' 04-27 '), PAIRING_CODE);
  assert.equal(formatPairingCode('0427'), PAIRING_CODE);
  assert.equal(isValidPairingCode(PAIRING_CODE), true);
  assert.equal(isValidPairingCode('427'), false);
  assert.equal(isValidPairingCode('ABCD'), false);
  assert.equal(isValidSyncToken(TOKEN), true);

  const storage = new MemoryStorage();
  storage.setItem(LEGACY_SAVED_SYNC_CODE_STORAGE_KEY, LEGACY_TOKEN);
  assert.equal(readSavedSyncToken(storage), LEGACY_TOKEN.replaceAll('-', ''));
  writeSavedSyncToken(storage, TOKEN);
  assert.equal(storage.getItem(SAVED_SYNC_TOKEN_STORAGE_KEY), TOKEN);
  assert.equal(storage.getItem(LEGACY_SAVED_SYNC_CODE_STORAGE_KEY), null);
});

test('서로 다른 기기의 기존 스크랩을 합치고 최신 스냅샷을 선택한다', () => {
  const first = saveJobSnapshot(createUserState(NOW), job('one', '처음 제목'), NOW).savedSnapshots;
  const secondState = saveJobSnapshot(createUserState(NOW), job('two'), NOW);
  const second = saveJobSnapshot(secondState, job('one', '바뀐 제목'), LATER).savedSnapshots;
  const merged = mergeSavedSnapshots(first, second, LATER);

  assert.deepEqual(Object.keys(merged).sort(), ['병원:one', '병원:two']);
  assert.equal(merged['병원:one'].title, '바뀐 제목');

  const replaced = replaceSavedSnapshots(saveJobSnapshot(createUserState(NOW), job('old'), NOW), merged, LATER);
  assert.equal(replaced.savedSnapshots['병원:old'], undefined);
  assert.equal(Object.keys(replaced.savedSnapshots).length, 2);
});

test('오프라인 동기화 작업은 영구 기기키별 순서를 보존하고 연속 작업을 압축한다', () => {
  const storage = new MemoryStorage();
  const snapshot = saveJobSnapshot(createUserState(NOW), job('one'), NOW).savedSnapshots['병원:one'];
  enqueueSavedSyncMutation(storage, TOKEN, { action: 'save', snapshot });
  enqueueSavedSyncMutation(storage, TOKEN, { action: 'remove', jobKey: snapshot.jobKey });
  assert.equal(readPendingSavedSyncMutations(storage, TOKEN).length, 1);
  assert.equal(readPendingSavedSyncMutations(storage, TOKEN)[0].action, 'remove');

  clearPendingSavedSyncMutations(storage, TOKEN);
  assert.deepEqual(readPendingSavedSyncMutations(storage), []);
});

test('API의 4자리 코드는 한 번만 사용하고 연결 뒤에는 영구 기기키로 동기화한다', async (t) => {
  const app = express();
  const store = memorySyncStore();
  let clock = new Date(NOW);
  app.set('trust proxy', 1);
  app.use(express.json());
  registerSavedSyncRoutes(app, {
    store,
    now: () => clock,
    createToken: () => TOKEN,
    createPairingCode: () => PAIRING_CODE,
  });
  const origin = await listen(app, t);
  const firstSaved = saveJobSnapshot(createUserState(NOW), job('one'), NOW).savedSnapshots;
  const secondSaved = saveJobSnapshot(createUserState(NOW), job('two'), NOW).savedSnapshots;

  const created = await fetch(`${origin}/api/saved-sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create-pairing', savedSnapshots: firstSaved }),
  });
  assert.equal(created.status, 200);
  const createdData = await created.json();
  assert.equal(createdData.token, TOKEN);
  assert.equal(createdData.pairingCode, PAIRING_CODE);
  assert.equal(Object.keys(createdData.savedSnapshots).length, 1);

  clock = new Date(new Date(NOW).getTime() + 5 * 60_000);
  const redeemed = await fetch(`${origin}/api/saved-sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'redeem-pairing', pairingCode: PAIRING_CODE, savedSnapshots: secondSaved }),
  });
  assert.equal(redeemed.status, 200);
  const merged = await redeemed.json();
  assert.equal(merged.token, TOKEN);
  assert.deepEqual(Object.keys(merged.savedSnapshots).sort(), ['병원:one', '병원:two']);

  const reused = await fetch(`${origin}/api/saved-sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'redeem-pairing', pairingCode: PAIRING_CODE, savedSnapshots: {} }),
  });
  assert.equal(reused.status, 410);

  const tokenHeaders = { 'content-type': 'application/json', 'x-nurse-board-sync-token': TOKEN };
  const removed = await fetch(`${origin}/api/saved-sync`, {
    method: 'POST', headers: tokenHeaders, body: JSON.stringify({ action: 'remove', jobKey: '병원:one' }),
  });
  assert.deepEqual(Object.keys((await removed.json()).savedSnapshots), ['병원:two']);

  const pulled = await fetch(`${origin}/api/saved-sync`, { headers: { 'x-nurse-board-sync-token': TOKEN } });
  assert.match(pulled.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Object.keys((await pulled.json()).savedSnapshots), ['병원:two']);
  assert.equal(store.values.has(TOKEN), false);
  assert.equal(store.values.has(PAIRING_CODE), false);
  assert.equal(store.values.has(savedSyncId(TOKEN)), true);
  assert.equal(store.values.has(savedSyncPairingId(PAIRING_CODE)), true);
  assert.equal(store.values.get(savedSyncPairingId(PAIRING_CODE)).token, null);
});

test('4자리 연결 코드는 10분 뒤 만료되고 기존 16자리 연결은 계속 동작한다', async (t) => {
  const app = express();
  const store = memorySyncStore();
  let clock = new Date(NOW);
  app.use(express.json());
  registerSavedSyncRoutes(app, {
    store,
    now: () => clock,
    createToken: () => TOKEN,
    createPairingCode: () => '9134',
  });
  const origin = await listen(app, t);

  const created = await fetch(`${origin}/api/saved-sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create-pairing', savedSnapshots: {} }),
  });
  assert.equal(created.status, 200);
  clock = new Date(new Date(NOW).getTime() + 11 * 60_000);
  const expired = await fetch(`${origin}/api/saved-sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'redeem-pairing', pairingCode: '9134', savedSnapshots: {} }),
  });
  assert.equal(expired.status, 410);

  const legacySaved = saveJobSnapshot(createUserState(NOW), job('legacy'), NOW).savedSnapshots;
  const legacy = await fetch(`${origin}/api/saved-sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nurse-board-sync-code': LEGACY_TOKEN },
    body: JSON.stringify({ action: 'connect', savedSnapshots: legacySaved }),
  });
  assert.equal(legacy.status, 200);
  assert.deepEqual(Object.keys((await legacy.json()).savedSnapshots), ['병원:legacy']);
});
