import { emptyJobCache, readJobCache, writeJobCacheAtomic } from './job-cache.mjs';
import { mergeDuplicateJobs, normalizeJob, partitionJobs } from './job-model.mjs';
import { gzipSync } from 'node:zlib';

export const DEFAULT_REFRESH_SCHEDULE = Object.freeze([
  Object.freeze({ hour: 9, minute: 0 }),
  Object.freeze({ hour: 12, minute: 0 }),
  Object.freeze({ hour: 18, minute: 0 }),
]);
export const DEFAULT_REFRESH_TIME_ZONE = 'Asia/Seoul';
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const EXTERNAL_SOURCE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const KOREA_OFFSET_MS = 9 * 60 * 60 * 1000;

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function normalizeSchedule(schedule) {
  const slots = (Array.isArray(schedule) ? schedule : []).map((slot) => ({
    hour: Number(slot?.hour),
    minute: Number(slot?.minute || 0),
  }));
  if (!slots.length || slots.some(({ hour, minute }) => !Number.isInteger(hour)
    || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59)) {
    throw new TypeError('refreshSchedule must contain valid hour/minute entries');
  }
  return [...new Map(slots
    .sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute))
    .map((slot) => [`${slot.hour}:${slot.minute}`, slot])).values()];
}

export function nextKoreaScheduledRun(value = new Date(), schedule = DEFAULT_REFRESH_SCHEDULE) {
  const current = asDate(value);
  if (Number.isNaN(current.getTime())) throw new TypeError('now must be a valid date');
  const slots = normalizeSchedule(schedule);
  const koreaDate = new Date(current.getTime() + KOREA_OFFSET_MS);
  const year = koreaDate.getUTCFullYear();
  const month = koreaDate.getUTCMonth();
  const day = koreaDate.getUTCDate();
  const todayStart = Date.UTC(year, month, day) - KOREA_OFFSET_MS;
  for (const { hour, minute } of slots) {
    const candidate = todayStart + ((hour * 60 + minute) * 60 * 1000);
    if (candidate > current.getTime()) return new Date(candidate);
  }
  const first = slots[0];
  return new Date(todayStart + (24 * 60 * 60 * 1000) + ((first.hour * 60 + first.minute) * 60 * 1000));
}

function isoOrNull(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function latestIso(values) {
  return values.map(isoOrNull).filter(Boolean).sort().at(-1) || null;
}

function errorMessage(error) {
  return String(error?.message || error || '알 수 없는 수집 오류').slice(0, 500);
}

function sourceStatus(entry, nowMs, staleAfterMs, { fresh = false, external = false } = {}) {
  const lastAttemptAt = isoOrNull(entry.lastAttemptAt);
  const lastSuccessAt = isoOrNull(entry.lastSuccessAt);
  const successMs = Date.parse(lastSuccessAt || '');
  const hasJobs = Boolean(entry.jobs?.length);
  const effectiveStaleAfterMs = external
    ? Math.max(staleAfterMs, EXTERNAL_SOURCE_STALE_AFTER_MS)
    : staleAfterMs;
  const ageStale = Number.isFinite(successMs) ? nowMs - successMs > effectiveStaleAfterMs : false;
  const missingFreshness = hasJobs && !Number.isFinite(successMs);
  const fallback = hasJobs && (entry.status === 'error' || entry.status === 'needs_review');
  const stale = ageStale || missingFreshness || entry.status === 'error' || entry.status === 'needs_review';
  const collectionStatus = entry.status;
  let status = collectionStatus;
  if (status === 'success') status = 'auto';
  if (status === 'error' && hasJobs) status = 'stale';
  if (status === 'idle') status = 'pending';
  const dataOrigin = fallback
    ? 'fallback-cache'
    : external
      ? entry.dataOrigin || 'imported-cache'
      : fresh && (collectionStatus === 'success' || collectionStatus === 'empty')
        ? 'live'
        : hasJobs || lastSuccessAt
          ? 'cache'
          : 'none';
  const freshness = fallback
    ? 'fallback'
    : stale
      ? 'stale'
      : dataOrigin === 'live'
        ? 'fresh'
        : dataOrigin === 'cache' || dataOrigin === 'imported-cache'
          ? 'cached'
          : 'unavailable';
  return {
    id: entry.id,
    name: entry.name,
    status,
    collectionStatus,
    count: entry.jobs?.length || 0,
    lastAttemptAt,
    lastSuccessAt,
    lastCollectedAt: lastSuccessAt,
    stale,
    freshness,
    dataOrigin,
    servedFromCache: hasJobs && dataOrigin !== 'live',
    isFallback: fallback,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function decorateJobTrust(job, statusBySourceId) {
  const sourceEntryIds = job.sourceEntryIds?.length
    ? job.sourceEntryIds
    : job.sourceEntryId ? [job.sourceEntryId] : [];
  const sources = sourceEntryIds.map((id) => statusBySourceId.get(id)).filter(Boolean);
  const hasFresh = sources.some((source) => source.freshness === 'fresh');
  const hasFallback = sources.some((source) => source.isFallback);
  const hasStale = sources.some((source) => source.stale);
  const servedFromCache = sources.some((source) => source.servedFromCache);
  const state = hasFresh
    ? hasFallback || hasStale || servedFromCache ? 'mixed' : 'fresh'
    : hasFallback ? 'fallback'
      : hasStale ? 'stale'
        : servedFromCache ? 'cached'
          : 'unknown';
  return {
    ...job,
    dataTrust: {
      state,
      servedFromCache,
      isFallback: hasFallback,
      stale: !hasFresh && hasStale,
      hasStaleSource: hasStale,
      lastCollectedAt: latestIso(sources.map((source) => source.lastCollectedAt)),
      sources: sources.map((source) => ({
        id: source.id,
        freshness: source.freshness,
        dataOrigin: source.dataOrigin,
        lastCollectedAt: source.lastCollectedAt,
      })),
    },
  };
}

function blankSource(definition) {
  return {
    id: definition.id,
    name: definition.name,
    url: definition.url,
    status: 'idle',
    jobs: [],
    seen: {},
    lastAttemptAt: null,
    lastSuccessAt: null,
    error: null,
  };
}

export function createJobService({
  sources,
  cacheFile,
  now = () => new Date(),
  refreshSchedule = DEFAULT_REFRESH_SCHEDULE,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  readCache = readJobCache,
  writeCache = writeJobCacheAtomic,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  prepareJob = (job) => job,
  onRefreshed = () => {},
} = {}) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');
  if (!cacheFile) throw new TypeError('cacheFile is required');

  const normalizedRefreshSchedule = normalizeSchedule(refreshSchedule);
  const scheduleLabels = normalizedRefreshSchedule.map(({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);

  let cache = emptyJobCache();
  let initialized = false;
  let initializePromise = null;
  let refreshPromise = null;
  let timer = null;
  let running = false;
  let scheduledFor = null;
  const freshSourceIds = new Set();
  let refresh = { inProgress: false, reason: null, startedAt: null, completedAt: null, error: null };
  let latestExtraSources = [];
  let snapshotCache = null;
  let snapshotJsonCache = null;
  let snapshotGzipCache = null;
  let snapshotDay = null;

  const nowDate = () => asDate(now());
  const nowIso = () => nowDate().toISOString();
  const koreaDay = () => new Date(nowDate().getTime() + KOREA_OFFSET_MS).toISOString().slice(0, 10);

  const collectionSchedule = () => ({
    mode: 'daily',
    schedule: scheduleLabels,
    timeZone: DEFAULT_REFRESH_TIME_ZONE,
    nextRunAt: (scheduledFor || nextKoreaScheduledRun(nowDate(), normalizedRefreshSchedule)).toISOString(),
    staleAfterMs,
    automaticSourceCount: sources.length,
  });

  function invalidateSnapshot() {
    snapshotCache = null;
    snapshotJsonCache = null;
    snapshotGzipCache = null;
  }

  function cacheSnapshot(snapshot) {
    snapshotCache = snapshot;
    snapshotJsonCache = JSON.stringify(snapshot);
    snapshotGzipCache = gzipSync(snapshotJsonCache);
    snapshotDay = koreaDay();
    return snapshot;
  }

  function updateCachedRefreshState() {
    if (!snapshotCache) return;
    const hasJobs = snapshotCache.jobs.length > 0 || snapshotCache.needsReviewJobs.length > 0;
    snapshotCache = {
      ...snapshotCache,
      dataTrust: {
        ...snapshotCache.dataTrust,
        ...(!hasJobs ? { state: refresh.inProgress ? 'collecting' : snapshotCache.dataTrust.state } : {}),
      },
      refresh: { ...refresh },
      refreshInProgress: refresh.inProgress,
      refreshing: refresh.inProgress,
      ...(!hasJobs ? { emptyReason: refresh.inProgress ? 'collecting' : snapshotCache.emptyReason } : {}),
    };
    snapshotJsonCache = JSON.stringify(snapshotCache);
    snapshotGzipCache = gzipSync(snapshotJsonCache);
  }

  function applyLoadedCache(loaded) {
    cache = loaded;
    cache.sources ||= {};
    for (const definition of sources) {
      const saved = cache.sources[definition.id];
      cache.sources[definition.id] = saved
        ? { ...blankSource(definition), ...saved, id: definition.id, name: definition.name, url: definition.url, jobs: Array.isArray(saved.jobs) ? saved.jobs : [], seen: saved.seen || {} }
        : blankSource(definition);
    }
    invalidateSnapshot();
  }

  async function initialize() {
    if (initialized) return;
    if (!initializePromise) {
      initializePromise = (async () => {
        applyLoadedCache(await readCache(cacheFile));
        initialized = true;
      })();
    }
    await initializePromise;
  }

  async function reload() {
    await initialize();
    if (refreshPromise) return false;
    const freshSuccessStamps = new Map([...freshSourceIds].map((id) => [
      id,
      isoOrNull(cache.sources[id]?.lastSuccessAt),
    ]));
    applyLoadedCache(await readCache(cacheFile));
    for (const id of [...freshSourceIds]) {
      const entry = cache.sources[id];
      const stillSameSuccessfulCollection = entry
        && ['success', 'empty'].includes(entry.status)
        && isoOrNull(entry.lastSuccessAt) === freshSuccessStamps.get(id);
      if (!stillSameSuccessfulCollection) freshSourceIds.delete(id);
    }
    return true;
  }

  function normalizeCollectedJobs(rawJobs, definition, previous, observedAt) {
    const byId = new Map();
    for (const raw of rawJobs) {
      const id = String(raw?.id || '').trim();
      if (!id || !String(raw?.title || '').trim()) continue;
      byId.set(id, { ...raw, id, source: raw.source || definition.name });
    }
    const seen = { ...(previous.seen || {}) };
    const jobs = [...byId.values()].map((job) => {
      const previousJob = previous.jobs?.find((item) => item.id === job.id);
      const normalized = normalizeJob(job, {
        seenAt: observedAt,
        previousSeen: seen[job.id] || (previousJob ? { firstSeenAt: previousJob.firstSeenAt, lastSeenAt: previousJob.lastSeenAt } : undefined),
      });
      seen[job.id] = { firstSeenAt: normalized.firstSeenAt, lastSeenAt: normalized.lastSeenAt };
      return normalized;
    });
    return { jobs, seen };
  }

  async function collectSource(definition, observedAt) {
    const previous = cache.sources[definition.id] || blankSource(definition);
    try {
      const rawJobs = await definition.collect({ previousJobs: previous.jobs || [] });
      if (!Array.isArray(rawJobs)) throw new TypeError(`${definition.name} collector did not return an array`);
      const succeededAt = nowIso();
      if (!rawJobs.length && previous.jobs?.length) {
        return {
          ...previous,
          id: definition.id,
          name: definition.name,
          url: definition.url,
          status: 'needs_review',
          lastAttemptAt: observedAt,
          error: '이전에는 공고가 있었지만 이번 수집 결과가 0건이어서 기존 데이터를 유지했습니다.',
        };
      }
      const normalized = normalizeCollectedJobs(rawJobs, definition, previous, succeededAt);
      return {
        ...previous,
        ...normalized,
        id: definition.id,
        name: definition.name,
        url: definition.url,
        status: normalized.jobs.length ? 'success' : 'empty',
        lastAttemptAt: observedAt,
        lastSuccessAt: succeededAt,
        error: null,
      };
    } catch (error) {
      return {
        ...previous,
        id: definition.id,
        name: definition.name,
        url: definition.url,
        status: 'error',
        lastAttemptAt: observedAt,
        error: errorMessage(error),
      };
    }
  }

  async function runRefresh(reason, startedAt) {
    await initialize();
    const entries = await Promise.all(sources.map((definition) => collectSource(definition, startedAt)));
    for (const entry of entries) {
      cache.sources[entry.id] = entry;
      if (entry.status === 'success' || entry.status === 'empty') freshSourceIds.add(entry.id);
      else freshSourceIds.delete(entry.id);
    }
    const previousSavedAt = cache.savedAt;
    cache.savedAt = nowIso();
    try {
      await writeCache(cacheFile, cache);
      refresh = { ...refresh, inProgress: false, completedAt: nowIso(), error: null };
    } catch (error) {
      cache.savedAt = previousSavedAt;
      refresh = { ...refresh, inProgress: false, completedAt: nowIso(), error: errorMessage(error) };
    }
    invalidateSnapshot();
    const snapshot = await getSnapshot();
    Promise.resolve().then(() => onRefreshed(snapshot)).catch(() => {});
    return snapshot;
  }

  function triggerRefresh(reason = 'manual') {
    if (refreshPromise) return { started: false, promise: refreshPromise };
    const startedAt = nowIso();
    refresh = { inProgress: true, reason, startedAt, completedAt: refresh.completedAt, error: null };
    updateCachedRefreshState();
    refreshPromise = runRefresh(reason, startedAt).finally(() => { refreshPromise = null; });
    return { started: true, promise: refreshPromise };
  }

  function normalizeExtraSource(extra, observedAt) {
    const seenAt = extra.lastSuccessAt || extra.updatedAt || observedAt;
    return {
      id: extra.id,
      name: extra.name,
      url: extra.url,
      status: extra.status || (extra.jobs?.length ? 'success' : 'empty'),
      jobs: (extra.jobs || []).map((job) => normalizeJob({ ...job, source: job.source || extra.name }, { seenAt })),
      lastAttemptAt: extra.lastAttemptAt || extra.updatedAt || null,
      lastSuccessAt: extra.lastSuccessAt || extra.updatedAt || null,
      dataOrigin: extra.dataOrigin || 'imported-cache',
      error: extra.error || null,
    };
  }

  async function getSnapshot(options = {}) {
    await initialize();
    if (Object.prototype.hasOwnProperty.call(options, 'extraSources')) {
      if (!Array.isArray(options.extraSources)) throw new TypeError('extraSources must be an array');
      if (JSON.stringify(latestExtraSources) !== JSON.stringify(options.extraSources)) {
        latestExtraSources = options.extraSources;
        invalidateSnapshot();
      }
    }
    if (snapshotCache && snapshotDay === koreaDay()) return snapshotCache;
    const observed = nowDate();
    const observedAt = observed.toISOString();
    const storedEntries = sources.map((definition) => cache.sources[definition.id] || blankSource(definition));
    const extras = latestExtraSources.map((entry) => normalizeExtraSource(entry, observedAt));
    const entries = [...storedEntries, ...extras];
    const statuses = entries.map((entry, index) => sourceStatus(entry, observed.getTime(), staleAfterMs, {
      fresh: freshSourceIds.has(entry.id),
      external: index >= storedEntries.length,
    }));
    const statusBySourceId = new Map(statuses.map((entry) => [entry.id, entry]));
    const rawJobs = entries.flatMap((entry) => (entry.jobs || []).map((job) => ({ ...job, sourceEntryId: entry.id })));
    const merged = mergeDuplicateJobs(rawJobs, observed)
      .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')) || String(a.deadlineAt || '9999').localeCompare(String(b.deadlineAt || '9999')));
    const trustedMerged = merged.map((job) => prepareJob(decorateJobTrust(job, statusBySourceId)));
    const { jobs, needsReviewJobs } = partitionJobs(trustedMerged);
    const lastAttemptAt = latestIso(statuses.map((entry) => entry.lastAttemptAt));
    const lastSuccessAt = latestIso(statuses.map((entry) => entry.lastSuccessAt));
    const validRawJobCount = rawJobs.filter((job) => job?.id && job?.title).length;
    const freshSourceCount = statuses.filter((entry) => entry.freshness === 'fresh').length;
    const cachedSourceCount = statuses.filter((entry) => entry.dataOrigin === 'cache' || entry.dataOrigin === 'imported-cache').length;
    const fallbackSourceCount = statuses.filter((entry) => entry.isFallback).length;
    const staleSourceCount = statuses.filter((entry) => entry.stale).length;
    const failedSourceCount = statuses.filter((entry) => entry.collectionStatus === 'error').length;
    const unavailableSourceCount = statuses.filter((entry) => entry.dataOrigin === 'none').length;
    const currentSourceCount = statuses.filter((entry) => entry.dataOrigin !== 'none' && !entry.stale && !entry.isFallback).length;
    const servedFromCache = statuses.some((entry) => entry.servedFromCache);
    const hasFallbackData = fallbackSourceCount > 0;
    const hasJobs = trustedMerged.length > 0;
    const trustState = !hasJobs
      ? failedSourceCount ? 'unavailable' : refresh.inProgress ? 'collecting' : 'empty'
      : hasFallbackData || failedSourceCount || refresh.error
        ? 'partial'
        : staleSourceCount && !currentSourceCount
          ? 'stale'
          : staleSourceCount || (freshSourceCount && servedFromCache)
            ? 'mixed'
            : freshSourceCount
              ? 'fresh'
              : servedFromCache ? 'cached' : 'unknown';
    const emptyReason = jobs.length || needsReviewJobs.length
      ? null
      : refresh.inProgress ? 'collecting' : lastSuccessAt ? 'no_results' : 'no_cache';
    return cacheSnapshot({
      jobs,
      needsReviewJobs,
      reviewJobs: needsReviewJobs,
      counts: {
        health: jobs.filter((job) => job.category === 'health').length,
        clinical: jobs.filter((job) => job.category === 'clinical').length,
        review: needsReviewJobs.length,
        total: jobs.length,
      },
      sourceStatus: statuses,
      lastAttemptAt,
      lastSuccessAt,
      updatedAt: lastSuccessAt,
      stale: statuses.some((entry) => entry.stale),
      dataTrust: {
        state: trustState,
        generatedAt: observedAt,
        cacheSavedAt: isoOrNull(cache.savedAt),
        lastCollectedAt: lastSuccessAt,
        servedFromCache,
        hasFallbackData,
        cacheWriteFailed: Boolean(refresh.error),
        sources: {
          total: statuses.length,
          fresh: freshSourceCount,
          cached: cachedSourceCount,
          fallback: fallbackSourceCount,
          stale: staleSourceCount,
          failed: failedSourceCount,
          unavailable: unavailableSourceCount,
        },
        jobs: {
          raw: validRawJobCount,
          merged: trustedMerged.length,
          duplicatesRemoved: Math.max(0, validRawJobCount - trustedMerged.length),
          visible: jobs.length,
          needsReview: needsReviewJobs.length,
        },
      },
      refresh: { ...refresh },
      refreshInProgress: refresh.inProgress,
      refreshing: refresh.inProgress,
      emptyReason,
      collection: collectionSchedule(),
      sources: sources.map(({ id, name, url }) => ({ id, name, url })),
    });
  }

  async function getSnapshotPayload(options = {}) {
    const snapshot = await getSnapshot(options);
    return { snapshot, body: snapshotJsonCache, gzip: snapshotGzipCache };
  }

  async function getHealth() {
    await initialize();
    const entries = sources.map((definition) => cache.sources[definition.id] || blankSource(definition));
    return {
      status: 'ok',
      ready: true,
      cacheLoaded: true,
      cachedJobCount: entries.reduce((count, entry) => count + (entry.jobs?.length || 0), 0),
      cacheSavedAt: isoOrNull(cache.savedAt),
      lastSuccessAt: latestIso(entries.map((entry) => entry.lastSuccessAt)),
      refresh: { ...refresh },
      collection: collectionSchedule(),
    };
  }

  function scheduleNextRefresh() {
    if (!running) return;
    if (timer) clearTimeoutImpl(timer);
    const current = nowDate();
    scheduledFor = nextKoreaScheduledRun(current, normalizedRefreshSchedule);
    const delay = Math.max(0, scheduledFor.getTime() - current.getTime());
    timer = setTimeoutImpl(() => {
      timer = null;
      scheduledFor = null;
      const scheduledRefresh = triggerRefresh('schedule');
      Promise.resolve(scheduledRefresh.promise)
        .catch(() => {})
        .finally(() => scheduleNextRefresh());
    }, delay);
    timer?.unref?.();
  }

  async function start({ immediate = false } = {}) {
    await initialize();
    if (!running) {
      running = true;
      scheduleNextRefresh();
    }
    if (immediate) triggerRefresh('startup');
  }

  function stop() {
    running = false;
    if (timer) clearTimeoutImpl(timer);
    timer = null;
    scheduledFor = null;
  }

  return {
    initialize,
    reload,
    triggerRefresh,
    refresh: async (reason = 'test') => triggerRefresh(reason).promise,
    getSnapshot,
    getSnapshotPayload,
    getHealth,
    getRefreshState: () => ({ ...refresh }),
    invalidateSnapshot,
    start,
    stop,
  };
}
