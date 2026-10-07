import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readDetailCache(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: {} };
    throw error;
  }
}

export async function writeDetailCache(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function detailCacheKey(value) {
  const url = new URL(value);
  url.hash = '';
  url.searchParams.sort();
  return url.href;
}

// Reading never starts collection. Only the server's worker or an explicit
// retry can fetch an original; all visitors share the persisted results.
export function createJobDetailService({
  readCache = async () => ({ version: 1, entries: {} }),
  writeCache = async () => {},
  collect,
  now = Date.now,
  ttlMs = 6 * 60 * 60 * 1000,
  retryMs = 30 * 60 * 1000,
  maxEntries = 3000,
  concurrency = 3,
  onUpdated = async () => {},
  onError = () => {},
} = {}) {
  const entries = new Map();
  const flights = new Map();
  let initialization;
  let writeFlight = Promise.resolve();
  let warming;
  const queued = new Map();

  async function initialize() {
    initialization ||= (async () => {
      const cache = await readCache();
      if (cache?.version === 1) {
        for (const [key, entry] of Object.entries(cache.entries || {}).slice(-maxEntries)) {
          if (entry && Number.isFinite(entry.checkedAt)) entries.set(key, entry);
        }
      }
    })().catch((error) => { initialization = undefined; throw error; });
    return initialization;
  }

  function peek(url) {
    const entry = entries.get(detailCacheKey(url));
    if (!entry?.detail) return null;
    return {
      ...entry.detail,
      detailCheckedAt: new Date(entry.checkedAt).toISOString(),
      detailStale: now() - entry.checkedAt > ttlMs,
    };
  }

  async function read(url) {
    await initialize();
    return peek(url);
  }

  function persist() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    // Serialize writes so a slower earlier write cannot replace a newer cache.
    const value = { version: 1, entries: Object.fromEntries(entries) };
    const flight = writeFlight.catch(() => {}).then(() => writeCache(value));
    writeFlight = flight;
    return flight;
  }

  async function refresh(job, { persistResult = true } = {}) {
    await initialize();
    const key = detailCacheKey(job.url);
    if (flights.has(key)) return flights.get(key);
    const flight = (async () => {
      const previous = entries.get(key);
      try {
        const detail = await collect(job);
        entries.delete(key);
        entries.set(key, {
          checkedAt: detail?.detailVerified ? now() : previous?.checkedAt || now(),
          attemptedAt: now(),
          detail: detail?.detailVerified ? detail : previous?.detail || null,
        });
        return peek(key) || detail;
      } catch (error) {
        entries.set(key, { ...previous, checkedAt: previous?.checkedAt || now(), attemptedAt: now() });
        if (previous?.detail) return peek(key);
        throw error;
      } finally {
        if (persistResult) await persist().catch(onError);
      }
    })();
    flights.set(key, flight);
    try { return await flight; }
    finally { if (flights.get(key) === flight) flights.delete(key); }
  }

  function warm(jobs) {
    for (const job of jobs) if (job?.url) queued.set(detailCacheKey(job.url), job);
    if (warming) return warming;
    warming = (async () => {
      await initialize();
      let pendingWrites = 0;
      while (queued.size) {
        const batch = [...queued.entries()].slice(0, Math.max(1, concurrency));
        batch.forEach(([key]) => queued.delete(key));
        let changed = false;
        await Promise.all(batch.map(async ([key, job]) => {
          const previous = entries.get(key);
          if (previous?.detail && now() - previous.checkedAt <= ttlMs) return;
          if (previous?.attemptedAt && now() - previous.attemptedAt <= retryMs) return;
          changed = true;
          await refresh(job, { persistResult: false }).catch(onError);
        }));
        if (changed) pendingWrites += batch.length;
        if (pendingWrites && (pendingWrites >= 24 || !queued.size)) {
          await persist().catch(onError);
          await onUpdated().catch(onError);
          pendingWrites = 0;
        }
      }
    })().finally(() => { warming = null; });
    return warming;
  }

  return { initialize, read, peek, refresh, warm };
}
