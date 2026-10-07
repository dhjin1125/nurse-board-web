const MAX_VIEWED = 200;
const MAX_QUERY_IDS = 2000;
const MODES = new Set(['new', 'unseen', 'all']);
const APPLIED_STATUSES = new Set(['applied', 'interview', 'final']);
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && value.trim()
  && !['__proto__', 'constructor', 'prototype'].includes(value.trim()) ? value.trim() : '';
const uniqueIds = values => [...new Set(values.map(safeId).filter(Boolean))];

// Only calendar-valid ISO dates or zoned ISO timestamps are accepted. In
// particular, Date.parse's locale dates, years and relative text are not dates.
function iso(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return null;
  const day = Date.parse(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) return null;
  if (match[2] && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59)) return null;
  if (match[5] && match[5] !== 'Z'
    && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4)) > 59)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function clockTime(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : NaN;
  const at = iso(value);
  return at === null ? NaN : Date.parse(at);
}

/** Normalize the optional state.discovery collection without changing user state. */
export function normalizeDiscovery(raw) {
  const discovery = isRecord(raw) ? raw : {};
  const viewed = new Map();
  for (const [key, value] of Object.entries(isRecord(discovery.viewed) ? discovery.viewed : {})) {
    const id = safeId(key), at = iso(value);
    if (id && at && (!viewed.has(id) || at > viewed.get(id))) viewed.set(id, at);
  }
  return {
    lastCheckedAt: iso(discovery.lastCheckedAt),
    viewed: Object.fromEntries([...viewed].sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, MAX_VIEWED)),
  };
}

/** Primary ID first, then source aliases; long dedupe keys are only a fallback. */
export function discoveryJobIds(job) {
  if (!isRecord(job)) return [];
  const id = safeId(job.id);
  return uniqueIds([id, ...(Array.isArray(job.sourceIds) ? job.sourceIds : []),
    ...(!id ? [job.dedupeKey, job.jobKey] : [])]);
}

function matchingIds(job) {
  return isRecord(job) ? uniqueIds([job.id, job.dedupeKey, job.jobKey,
    ...(Array.isArray(job.sourceIds) ? job.sourceIds : [])]) : [];
}

/** Record one primary ID per viewed job, preserving every other state field. */
export function markJobViewed(state, job, now = Date.now()) {
  const id = discoveryJobIds(job)[0], time = clockTime(now);
  if (!id || !Number.isFinite(time)) return state;
  const discovery = normalizeDiscovery(state?.discovery);
  const previous = discovery.viewed[id];
  const at = new Date(previous ? Math.max(time, Date.parse(previous)) : time).toISOString();
  const others = Object.fromEntries(Object.entries(discovery.viewed).filter(([key]) => key !== id));
  return { ...state, discovery: normalizeDiscovery({ ...discovery, viewed: { [id]: at, ...others } }) };
}

export function discoverySeenIds(state) {
  return Object.keys(normalizeDiscovery(state?.discovery).viewed);
}

/** Resolve application keys through saved snapshots, including merged sources. */
export function appliedJobIds(state) {
  const snapshots = new Map();
  for (const [key, snapshot] of Object.entries(isRecord(state?.savedSnapshots) ? state.savedSnapshots : {})) {
    const ids = uniqueIds([key, ...matchingIds(snapshot)]);
    for (const id of ids) {
      if (!snapshots.has(id)) snapshots.set(id, new Set());
      for (const alias of ids) snapshots.get(id).add(alias);
    }
  }
  const applied = new Set();
  for (const [key, application] of Object.entries(isRecord(state?.applications) ? state.applications : {})) {
    if (!APPLIED_STATUSES.has(application?.status)) continue;
    for (const id of uniqueIds([key, ...matchingIds(application)])) {
      applied.add(id);
      for (const alias of snapshots.get(id) || []) applied.add(alias);
    }
  }
  return [...applied];
}

/** Epoch milliseconds, or null when no reliable discovery/publication date exists. */
export function discoveryTimestamp(job) {
  for (const value of [job?.firstSeenAt, job?.publishedAt, job?.postedAt]) {
    const at = iso(value);
    if (at !== null) return Date.parse(at);
  }
  return null;
}

/** Strict request validation, unlike tolerant local-storage normalization. */
export function normalizeDiscoveryQuery(raw) {
  if (!isRecord(raw) || !MODES.has(raw.mode)) throw new TypeError('잘못된 탐색 조건입니다.');
  const since = raw.since == null ? null : iso(raw.since);
  if (raw.since != null && since === null) throw new TypeError('잘못된 탐색 기준일입니다.');
  const ids = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_QUERY_IDS
      || value.some(id => typeof id !== 'string' || !safeId(id) || id.length > 512)) {
      throw new TypeError('잘못된 탐색 공고 목록입니다.');
    }
    return uniqueIds(value).sort();
  };
  return { mode: raw.mode, since, seen: ids(raw.seen), applied: ids(raw.applied) };
}

/** Input already has ordinary filters/hidden exclusions and the existing sort. */
export function filterDiscoveryJobs(jobs, query) {
  if (query == null) return { jobs, meta: null };
  const { mode, since, seen, applied } = normalizeDiscoveryQuery(query);
  const seenSet = new Set(seen), appliedSet = new Set(applied);
  const sinceTime = since === null ? null : Date.parse(since);
  const meta = { mode, since, firstVisit: since === null, newCount: 0, unseenCount: 0, allCount: jobs.length, appliedCount: 0 };
  const selected = [];
  for (const job of jobs) {
    const ids = matchingIds(job);
    const isApplied = ids.some(id => appliedSet.has(id));
    const unseen = !isApplied && !ids.some(id => seenSet.has(id));
    const timestamp = discoveryTimestamp(job);
    // On a first visit, "new" explicitly means all unseen jobs, even undated ones.
    const isNew = unseen && (sinceTime === null || (timestamp !== null && timestamp > sinceTime));
    if (isApplied) meta.appliedCount++;
    if (unseen) meta.unseenCount++;
    if (isNew) meta.newCount++;
    if (mode === 'all' || (mode === 'unseen' ? unseen : isNew)) {
      selected.push(job);
    }
  }
  // Filtering preserves the caller's rank order; discovery time determines
  // eligibility, not presentation priority.
  return { jobs: selected, meta };
}

/** Candidate checkpoint from the served collection, never its render/load time. */
export function discoveryCheckpoint(response, now = Date.now()) {
  const at = iso(response?.lastSuccessAt) || iso(response?.dataTrust?.lastCollectedAt);
  const time = clockTime(now);
  return at && Number.isFinite(time) ? new Date(Math.min(Date.parse(at), time)).toISOString() : null;
}

/** Call with a successfully loaded page; failed/unusable pages are no-ops. */
export function advanceDiscoveryCheckpoint(state, response, now = Date.now()) {
  if (!Array.isArray(response?.jobs) || response.error || response.ok === false || response.refresh?.inProgress
    || response.refresh?.error || response.dataTrust?.cacheWriteFailed) return state;
  const candidate = discoveryCheckpoint(response, now);
  if (candidate === null) return state;
  const discovery = normalizeDiscovery(state?.discovery);
  if (discovery.lastCheckedAt && Date.parse(discovery.lastCheckedAt) >= Date.parse(candidate)) return state;
  return { ...state, discovery: { ...discovery, lastCheckedAt: candidate } };
}
