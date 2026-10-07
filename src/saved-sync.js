import { normalizeUserState } from './user-state.js';

export const SAVED_SYNC_TOKEN_STORAGE_KEY = 'nurse-saved-sync-token';
export const LEGACY_SAVED_SYNC_CODE_STORAGE_KEY = 'nurse-saved-sync-code';
export const SAVED_SYNC_PENDING_STORAGE_KEY = 'nurse-saved-sync-pending';
export const SAVED_SYNC_PAIRING_CODE_LENGTH = 4;

const LEGACY_SYNC_CODE_LENGTH = 16;
const LEGACY_SYNC_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_PENDING_MUTATIONS = 100;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asString = (value) => typeof value === 'string' ? value.trim() : '';

function normalizeLegacySyncCode(value) {
  return asString(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isValidLegacySyncCode(value) {
  const normalized = normalizeLegacySyncCode(value);
  return normalized.length === LEGACY_SYNC_CODE_LENGTH
    && [...normalized].every((character) => LEGACY_SYNC_CODE_ALPHABET.includes(character));
}

export function normalizePairingCode(value) {
  return asString(value).replace(/\D/g, '').slice(0, SAVED_SYNC_PAIRING_CODE_LENGTH);
}

export function isValidPairingCode(value) {
  return /^\d{4}$/.test(normalizePairingCode(value));
}

export function formatPairingCode(value) {
  return normalizePairingCode(value);
}

export function normalizeSyncToken(value) {
  const raw = asString(value);
  if (/^[A-Za-z0-9_-]{32,128}$/.test(raw)) return raw;
  const legacy = normalizeLegacySyncCode(raw);
  return isValidLegacySyncCode(legacy) ? legacy : '';
}

export function isValidSyncToken(value) {
  return Boolean(normalizeSyncToken(value));
}

export function readSavedSyncToken(storage = globalThis.localStorage) {
  const current = normalizeSyncToken(storage?.getItem?.(SAVED_SYNC_TOKEN_STORAGE_KEY));
  if (current) return current;
  return normalizeSyncToken(storage?.getItem?.(LEGACY_SAVED_SYNC_CODE_STORAGE_KEY));
}

export function writeSavedSyncToken(storage = globalThis.localStorage, token) {
  const normalized = normalizeSyncToken(token);
  if (!normalized) throw new TypeError('기기 동기화 연결키 형식이 올바르지 않습니다.');
  storage?.setItem?.(SAVED_SYNC_TOKEN_STORAGE_KEY, normalized);
  storage?.removeItem?.(LEGACY_SAVED_SYNC_CODE_STORAGE_KEY);
  return normalized;
}

export function clearSavedSyncToken(storage = globalThis.localStorage) {
  storage?.removeItem?.(SAVED_SYNC_TOKEN_STORAGE_KEY);
  storage?.removeItem?.(LEGACY_SAVED_SYNC_CODE_STORAGE_KEY);
}

export function normalizeSavedSnapshots(value, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const state = normalizeUserState({
    savedSnapshots: isRecord(value) ? value : {},
    meta: { createdAt: at.toISOString(), updatedAt: at.toISOString() },
  }, at);
  return state.savedSnapshots;
}

function snapshotIdentity(snapshot = {}) {
  return [...new Set([snapshot.jobKey, snapshot.dedupeKey, snapshot.id].map(asString).filter(Boolean))];
}

function snapshotTime(snapshot = {}) {
  const time = new Date(snapshot.snapshotUpdatedAt || snapshot.savedAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function findSnapshotEntry(snapshots, candidate) {
  const identities = new Set(snapshotIdentity(candidate));
  return Object.entries(snapshots).find(([key, snapshot]) => identities.has(key)
    || snapshotIdentity(snapshot).some((identity) => identities.has(identity)));
}

export function mergeSavedSnapshots(first, second, now = new Date()) {
  const left = normalizeSavedSnapshots(first, now);
  const right = normalizeSavedSnapshots(second, now);
  const merged = { ...left };

  for (const incoming of Object.values(right)) {
    const existingEntry = findSnapshotEntry(merged, incoming);
    if (!existingEntry) {
      merged[incoming.jobKey] = incoming;
      continue;
    }
    const [existingKey, existing] = existingEntry;
    const newer = snapshotTime(incoming) >= snapshotTime(existing) ? incoming : existing;
    const older = newer === incoming ? existing : incoming;
    const jobKey = newer.jobKey || older.jobKey || existingKey;
    if (existingKey !== jobKey) delete merged[existingKey];
    merged[jobKey] = {
      ...older,
      ...newer,
      jobKey,
      savedAt: [existing.savedAt, incoming.savedAt].filter(Boolean).sort()[0] || newer.savedAt,
      snapshotUpdatedAt: newer.snapshotUpdatedAt || older.snapshotUpdatedAt,
    };
  }

  return normalizeSavedSnapshots(merged, now);
}

export function replaceSavedSnapshots(state, savedSnapshots, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const current = normalizeUserState(state, at);
  const incoming = normalizeSavedSnapshots(savedSnapshots, at);
  // Application notes live only on this device. A remote bookmark removal or
  // an older sync response must not orphan their locally retained posting.
  const applicationKeys = new Set(Object.entries(current.applications).flatMap(([key, application]) => [key, application.jobKey]));
  for (const [key, snapshot] of Object.entries(current.savedSnapshots)) {
    if (!applicationKeys.has(key) && !snapshotIdentity(snapshot).some(id => applicationKeys.has(id))) continue;
    const existing = findSnapshotEntry(incoming, snapshot);
    if (existing && existing[0] !== key) delete incoming[existing[0]];
    incoming[key] = snapshot;
  }
  return normalizeUserState({
    ...current,
    savedSnapshots: incoming,
    meta: { ...current.meta, updatedAt: at.toISOString() },
  }, at);
}

function normalizeMutation(value) {
  if (!isRecord(value)) return null;
  const token = normalizeSyncToken(value.token || value.code);
  const action = value.action;
  if (!token || !['save', 'remove'].includes(action)) return null;
  if (action === 'save') {
    const snapshot = Object.values(normalizeSavedSnapshots({ candidate: value.snapshot }))[0];
    if (!snapshot) return null;
    return { token, action, snapshot };
  }
  const jobKey = asString(value.jobKey);
  if (!jobKey) return null;
  return { token, action, jobKey };
}

export function readPendingSavedSyncMutations(storage = globalThis.localStorage, token = '') {
  let value;
  try {
    value = JSON.parse(storage?.getItem?.(SAVED_SYNC_PENDING_STORAGE_KEY) || '[]');
  } catch {
    value = [];
  }
  const normalized = Array.isArray(value) ? value.map(normalizeMutation).filter(Boolean) : [];
  const requestedToken = normalizeSyncToken(token);
  return requestedToken ? normalized.filter((mutation) => mutation.token === requestedToken) : normalized;
}

function writePendingSavedSyncMutations(storage, mutations) {
  if (!mutations.length) storage?.removeItem?.(SAVED_SYNC_PENDING_STORAGE_KEY);
  else storage?.setItem?.(SAVED_SYNC_PENDING_STORAGE_KEY, JSON.stringify(mutations.slice(-MAX_PENDING_MUTATIONS)));
}

export function enqueueSavedSyncMutation(storage = globalThis.localStorage, token, mutation) {
  const normalized = normalizeMutation({ ...mutation, token });
  if (!normalized) throw new TypeError('저장 공고 동기화 작업이 올바르지 않습니다.');
  const pending = readPendingSavedSyncMutations(storage);
  const previous = pending.at(-1);

  if (previous?.token === normalized.token) {
    const previousKey = previous.action === 'save' ? previous.snapshot.jobKey : previous.jobKey;
    const nextKey = normalized.action === 'save' ? normalized.snapshot.jobKey : normalized.jobKey;
    if (previousKey === nextKey) pending.pop();
  }
  pending.push(normalized);
  writePendingSavedSyncMutations(storage, pending);
  return normalized;
}

export function removePendingSavedSyncMutation(storage = globalThis.localStorage, token) {
  const normalizedToken = normalizeSyncToken(token);
  const pending = readPendingSavedSyncMutations(storage);
  const index = pending.findIndex((mutation) => mutation.token === normalizedToken);
  if (index >= 0) pending.splice(index, 1);
  writePendingSavedSyncMutations(storage, pending);
}

export function clearPendingSavedSyncMutations(storage = globalThis.localStorage, token = '') {
  const normalizedToken = normalizeSyncToken(token);
  if (!normalizedToken) {
    writePendingSavedSyncMutations(storage, []);
    return;
  }
  writePendingSavedSyncMutations(storage, readPendingSavedSyncMutations(storage)
    .filter((mutation) => mutation.token !== normalizedToken));
}

export async function requestSavedSync(token = '', options = {}) {
  const normalizedToken = normalizeSyncToken(token);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const action = options.action || 'read';
  const tokenRequired = ['read', 'connect', 'save', 'remove'].includes(action);
  if (tokenRequired && !normalizedToken) throw new TypeError('이 기기의 동기화 연결키가 올바르지 않습니다.');

  const response = await fetchImpl('/api/saved-sync', {
    method: action === 'read' ? 'GET' : 'POST',
    headers: {
      accept: 'application/json',
      ...(normalizedToken ? { 'x-nurse-board-sync-token': normalizedToken } : {}),
      ...(action === 'read' ? {} : { 'content-type': 'application/json' }),
    },
    ...(action === 'read' ? {} : { body: JSON.stringify({ ...options.payload, action }) }),
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || `스크랩 동기화에 실패했습니다. (${response.status})`);
  const returnedToken = data.token == null ? '' : normalizeSyncToken(data.token);
  if (data.token != null && !returnedToken) throw new Error('서버에서 받은 기기 연결키가 올바르지 않습니다.');
  return {
    ...data,
    ...(returnedToken ? { token: returnedToken } : {}),
    ...(data.pairingCode != null ? { pairingCode: normalizePairingCode(data.pairingCode) } : {}),
    savedSnapshots: normalizeSavedSnapshots(data.savedSnapshots),
  };
}
