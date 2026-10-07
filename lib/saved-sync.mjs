import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBlobJsonStore } from './blob-json-store.mjs';
import {
  isValidPairingCode,
  mergeSavedSnapshots,
  normalizePairingCode,
  normalizeSavedSnapshots,
  normalizeSyncToken,
} from '../src/saved-sync.js';

const SYNC_VERSION = 1;
const MAX_SAVED_SNAPSHOTS = 500;
const PAIRING_CODE_TTL_MS = 10 * 60_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const MAX_PAIRING_ATTEMPTS_PER_WINDOW = 8;
const MAX_PAIRING_CODES_PER_WINDOW = 6;

const asString = (value) => typeof value === 'string' ? value.trim() : '';
const cloneJson = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function emptyRecord() {
  return { version: SYNC_VERSION, revision: 0, updatedAt: null, savedSnapshots: {} };
}

function normalizeRecord(value, now = new Date()) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: SYNC_VERSION,
    revision: Math.max(0, Number.isSafeInteger(record.revision) ? record.revision : 0),
    updatedAt: asString(record.updatedAt) || null,
    savedSnapshots: normalizeSavedSnapshots(record.savedSnapshots, now),
  };
}

function assertSnapshotLimit(savedSnapshots) {
  if (Object.keys(savedSnapshots).length > MAX_SAVED_SNAPSHOTS) {
    throw Object.assign(new Error(`스크랩은 최대 ${MAX_SAVED_SNAPSHOTS}개까지 동기화할 수 있습니다.`), { status: 413 });
  }
}

export function savedSyncId(token) {
  const normalized = normalizeSyncToken(token);
  if (!normalized) throw Object.assign(new Error('기기 동기화 연결키가 올바르지 않습니다.'), { status: 401 });
  return createHash('sha256').update(`nurse-board:saved-sync:v1:${normalized}`).digest('hex');
}

export function savedSyncPairingId(code) {
  const normalized = normalizePairingCode(code);
  if (!isValidPairingCode(normalized)) throw Object.assign(new Error('4자리 연결 코드를 확인해 주세요.'), { status: 400 });
  return createHash('sha256').update(`nurse-board:saved-sync:pairing:v1:${normalized}`).digest('hex');
}

export function generateSavedSyncToken(randomBytesImpl = randomBytes) {
  return randomBytesImpl(32).toString('base64url');
}

export function createFileSavedSyncStore({ directory }) {
  if (!directory) throw new TypeError('directory is required');
  const locks = new Map();
  const pathFor = (id) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError('invalid sync id');
    return join(directory, `${id}.json`);
  };

  async function read(id) {
    try {
      return JSON.parse(await readFile(pathFor(id), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function write(id, value) {
    await mkdir(directory, { recursive: true });
    const target = pathFor(id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  async function update(id, updater) {
    const previous = locks.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const next = await updater(await read(id));
      await write(id, next);
      return cloneJson(next);
    });
    locks.set(id, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(id) === operation) locks.delete(id);
    }
  }

  return { read, write, update };
}

export function createBlobSavedSyncStore({ token, createStore = createBlobJsonStore } = {}) {
  if (!token) throw new TypeError('token is required');
  const stores = new Map();
  const locks = new Map();
  const storeFor = (id) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError('invalid sync id');
    if (!stores.has(id)) stores.set(id, createStore({
      pathname: `nurse-board/saved-sync/${id}.json`,
      seed: null,
      token,
    }));
    return stores.get(id);
  };

  async function read(id) {
    const store = storeFor(id);
    store.clearCache();
    return store.read();
  }

  async function write(id, value) {
    return storeFor(id).write(value);
  }

  async function update(id, updater) {
    const previous = locks.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const next = await updater(await read(id));
      await write(id, next);
      return cloneJson(next);
    });
    locks.set(id, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(id) === operation) locks.delete(id);
    }
  }

  return { read, write, update };
}

export function createSavedSyncStore({ token, directory } = {}) {
  return token
    ? createBlobSavedSyncStore({ token })
    : createFileSavedSyncStore({ directory });
}

function removeSnapshot(savedSnapshots, jobKey) {
  const requested = asString(jobKey);
  if (!requested) throw Object.assign(new Error('삭제할 공고 식별자가 필요합니다.'), { status: 400 });
  return Object.fromEntries(Object.entries(savedSnapshots).filter(([key, snapshot]) => {
    return ![key, snapshot.jobKey, snapshot.dedupeKey, snapshot.id].map(asString).includes(requested);
  }));
}

function publicRecord(record, now = new Date()) {
  return normalizeRecord(record, now);
}

export function registerSavedSyncRoutes(app, {
  store,
  now = () => new Date(),
  createToken = () => generateSavedSyncToken(),
  createPairingCode = () => String(randomInt(0, 10_000)).padStart(4, '0'),
  pairingCodeTtlMs = PAIRING_CODE_TTL_MS,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new TypeError('Express app is required');
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') throw new TypeError('saved sync store is required');

  const pairingAttempts = new Map();
  const pairingCreations = new Map();
  const currentDate = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };
  const requestToken = (req) => normalizeSyncToken(
    req.get('x-nurse-board-sync-token') || req.get('x-nurse-board-sync-code'),
  );
  const identify = (req) => savedSyncId(requestToken(req));
  const respond = (res, record, extra = {}) => {
    res.set('cache-control', 'no-store, private');
    return res.json({ ...publicRecord(record, currentDate()), ...extra });
  };
  const rateLimit = (bucket, key, limit, at) => {
    const cutoff = at.getTime() - RATE_LIMIT_WINDOW_MS;
    const attempts = (bucket.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (attempts.length >= limit) {
      throw Object.assign(new Error('연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'), { status: 429 });
    }
    attempts.push(at.getTime());
    bucket.set(key, attempts);
  };
  const isActivePairing = (value, at) => {
    const token = normalizeSyncToken(value?.token);
    const expiresAt = new Date(value?.expiresAt || 0).getTime();
    return value?.kind === 'saved-sync-pairing' && token && !value.consumedAt
      && Number.isFinite(expiresAt) && expiresAt > at.getTime();
  };
  const updateRecord = (token, action, payload, at) => store.update(savedSyncId(token), (stored) => {
    const current = normalizeRecord(stored, at);
    let savedSnapshots;
    if (action === 'connect') {
      savedSnapshots = mergeSavedSnapshots(current.savedSnapshots, payload?.savedSnapshots, at);
    } else if (action === 'save') {
      const incoming = normalizeSavedSnapshots({ candidate: payload?.snapshot }, at);
      if (!Object.keys(incoming).length) throw Object.assign(new Error('저장할 공고 정보가 올바르지 않습니다.'), { status: 400 });
      savedSnapshots = mergeSavedSnapshots(current.savedSnapshots, incoming, at);
    } else {
      savedSnapshots = removeSnapshot(current.savedSnapshots, payload?.jobKey);
    }
    assertSnapshotLimit(savedSnapshots);
    return {
      version: SYNC_VERSION,
      revision: current.revision + 1,
      updatedAt: at.toISOString(),
      savedSnapshots,
    };
  });
  const issuePairingCode = async (token, at) => {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const code = normalizePairingCode(createPairingCode());
      if (!isValidPairingCode(code)) continue;
      const id = savedSyncPairingId(code);
      try {
        const pairing = await store.update(id, (stored) => {
          if (isActivePairing(stored, at)) throw Object.assign(new Error('pairing-code-collision'), { collision: true });
          return {
            kind: 'saved-sync-pairing',
            token,
            createdAt: at.toISOString(),
            expiresAt: new Date(at.getTime() + pairingCodeTtlMs).toISOString(),
            consumedAt: null,
          };
        });
        return { pairingCode: code, expiresAt: pairing.expiresAt };
      } catch (error) {
        if (!error?.collision) throw error;
      }
    }
    throw Object.assign(new Error('새 연결 코드를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.'), { status: 503 });
  };

  app.get('/api/saved-sync', async (req, res) => {
    try {
      const record = await store.read(identify(req));
      return respond(res, record || emptyRecord());
    } catch (error) {
      return res.status(error?.status || 503).json({ error: error?.status ? error.message : '스크랩 저장소를 불러오지 못했습니다.' });
    }
  });

  app.post('/api/saved-sync', async (req, res) => {
    try {
      const action = asString(req.body?.action);
      const at = currentDate();

      if (action === 'create-pairing') {
        rateLimit(pairingCreations, req.ip || 'unknown', MAX_PAIRING_CODES_PER_WINDOW, at);
        const existingToken = requestToken(req);
        const token = existingToken || normalizeSyncToken(createToken());
        if (!token) throw Object.assign(new Error('기기 연결키를 만들지 못했습니다.'), { status: 503 });
        const record = await updateRecord(token, 'connect', req.body, at);
        const pairing = await issuePairingCode(token, at);
        return respond(res, record, { token, ...pairing });
      }

      if (action === 'redeem-pairing') {
        rateLimit(pairingAttempts, req.ip || 'unknown', MAX_PAIRING_ATTEMPTS_PER_WINDOW, at);
        const pairingCode = normalizePairingCode(req.body?.pairingCode);
        if (!isValidPairingCode(pairingCode)) return res.status(400).json({ error: '4자리 연결 코드를 확인해 주세요.' });
        let claimedToken = '';
        await store.update(savedSyncPairingId(pairingCode), (stored) => {
          if (!isActivePairing(stored, at)) {
            throw Object.assign(new Error('연결 코드가 만료되었거나 이미 사용되었습니다. 다른 기기에서 새 코드를 만들어 주세요.'), { status: 410 });
          }
          claimedToken = normalizeSyncToken(stored.token);
          return { ...stored, token: null, consumedAt: at.toISOString() };
        });
        const record = await updateRecord(claimedToken, 'connect', req.body, at);
        return respond(res, record, { token: claimedToken });
      }

      if (!['connect', 'save', 'remove'].includes(action)) {
        return res.status(400).json({ error: '지원하지 않는 동기화 작업입니다.' });
      }
      const token = requestToken(req);
      const record = await updateRecord(token, action, req.body, at);
      return respond(res, record);
    } catch (error) {
      if (error?.status === 429) res.set('retry-after', '600');
      return res.status(error?.status || 503).json({ error: error?.status ? error.message : '스크랩을 동기화하지 못했습니다.' });
    }
  });
}
