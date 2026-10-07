import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createBlobJsonStore } from './blob-json-store.mjs';
import { jobPage } from './job-page.mjs';
import { DEFAULT_FEED_FILTERS } from '../src/feed-defaults.js';
import { applicationTierProfileKey, listingPolicyDay } from '../src/job-utils.js';

const canonical = value => JSON.stringify(value, Object.keys(value).sort());
export function firstPageKey(query = {}) {
  try {
    if (Number(query.offset || 0) !== 0 || Number(query.limit || 24) !== 24 || query.ids != null || query.discovery != null) return null;
    const hidden = JSON.parse(query.hidden || '[]');
    const profile = JSON.parse(query.profile || '{}');
    if (!Array.isArray(hidden) || hidden.length || !profile || Array.isArray(profile)
      || Object.values(profile).some(v => !Array.isArray(v) || v.length)) return null;
    const filters = JSON.parse(query.filters || '{}');
    if (canonical(filters) === canonical({})) return 'all';
    if (canonical(filters) === canonical(DEFAULT_FEED_FILTERS)) return 'recommended';
  } catch {}
  return null;
}

export function createPublishedFeed({ token = process.env.BLOB_READ_WRITE_TOKEN,
  storeFactory = createBlobJsonStore, now = Date.now, ttlMs = 60_000 } = {}) {
  const makeStore = pathname => storeFactory({ pathname, token, seed: null,
    getBlob: async (path, options) => (await import('@vercel/blob')).get(path, {
      ...options, abortSignal: AbortSignal.timeout(4_000),
    }),
  });
  const snapshotStore = makeStore('nurse-board/published-feed-v1.json');
  const firstStore = makeStore('nurse-board/published-first-pages-v1.json');
  let publishedHash;
  let publishing = Promise.resolve();
  function publish(snapshot) {
    // Serialize publications so an older, slower upload cannot replace a newer one.
    const copy = structuredClone(snapshot);
    const operation = publishing.catch(() => {}).then(async () => {
      if (!Array.isArray(copy?.jobs) || !copy.jobs.length) throw new Error('Refusing to replace the feed with an empty snapshot');
      const hash = createHash('sha256').update(JSON.stringify(copy)).digest('hex');
      if (hash === publishedHash) return false;
      const firstPages = {
        all: JSON.parse(jobPage(copy).body),
        recommended: JSON.parse(jobPage(copy, { filters: JSON.stringify(DEFAULT_FEED_FILTERS) }).body),
      };
      await snapshotStore.write({ schema: 1, snapshot: copy });
      // The envelope also versions empty pages, which have no per-job tag.
      await firstStore.write({ schema: 1, profileKey: applicationTierProfileKey(), firstPages });
      publishedHash = hash;
      return true;
    });
    publishing = operation;
    return operation;
  }
  function cachedReader(store, validate) {
    let value, checkedAt = -Infinity, pending;
    return async () => {
      if (value && now() - checkedAt < ttlMs) return { value, stale: false };
      pending ||= (async () => {
        try {
          store.clearCache();
          const next = await store.read();
          if (next?.schema !== 1 || !validate(next)) throw new Error('Published feed is unavailable');
          value = next;
          checkedAt = now();
          return { value, stale: false };
        } catch (error) {
          if (!value) throw error;
          // Retain the last complete publication; retry on the next request.
          return { value, stale: true };
        }
      })().finally(() => { pending = undefined; });
      return pending;
    };
  }
  const readSnapshot = cachedReader(snapshotStore, v => Array.isArray(v.snapshot?.jobs) && v.snapshot.jobs.length > 0);
  const readFirst = cachedReader(firstStore, v => ['all', 'recommended'].every(key => Array.isArray(v.firstPages?.[key]?.jobs) && v.firstPages[key].pagination));
  async function page(query) {
    const key = firstPageKey(query);
    if (key) {
      try {
        const result = await readFirst();
        const prepared = result.value.firstPages[key];
        const profileKey = applicationTierProfileKey();
        if (prepared.listingPolicy?.version !== 1 || prepared.listingPolicy.day !== listingPolicyDay()
          || result.value.profileKey !== profileKey
          || !prepared.jobs.every(job => job?.presentation?.profileKey === profileKey)) {
          throw new Error('Published first page needs current listing and tier rules');
        }
        const body = JSON.stringify(prepared);
        return { body, gzip: gzipSync(body), stale: result.stale };
      } catch { /* Full published snapshot is a safe alternative, never the collector. */ }
    }
    const result = await readSnapshot();
    return { ...jobPage(result.value.snapshot, query), stale: result.stale };
  }
  return { publish, page, readSnapshot };
}

export function registerPublishedFeedRoutes(app, feed) {
  app.get('/api/jobs', async (req, res) => {
    const personalized = req.query.ids != null || req.query.hidden != null || req.query.profile != null || req.query.discovery != null;
    if (personalized) res.setHeader('Cache-Control', 'private, no-store');
    try {
      // Validate before storage access, including queries that use precomputed pages.
      jobPage({ jobs: [] }, req.query);
    } catch { return res.status(400).json({ error: '검색 조건이나 페이지 형식이 올바르지 않습니다.' }); }
    try {
      const payload = await feed.page(req.query);
      res.setHeader('Cache-Control', personalized ? 'private, no-store' : 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
      res.setHeader('x-nurse-board-api-origin', 'vercel-blob');
      if (payload.stale) res.setHeader('x-nurse-board-feed-stale', 'true');
      res.vary('Accept-Encoding');
      if (req.acceptsEncodings('gzip')) {
        res.setHeader('Content-Encoding', 'gzip');
        return res.type('application/json').send(payload.gzip);
      }
      return res.type('application/json').send(payload.body);
    } catch {
      res.setHeader('Cache-Control', personalized ? 'private, no-store' : 'no-store');
      return res.status(503).json({ error: '저장된 공고를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });
}
