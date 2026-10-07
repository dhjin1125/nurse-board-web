import { gzipSync } from 'node:zlib';
import { applicationTierFor, applicationTierProfileKey, jobMatchesFilters, sortJobs, listingPolicyDay } from '../src/job-utils.js';
import { filterDiscoveryJobs, normalizeDiscoveryQuery } from '../src/discovery.js';

const pages = new WeakMap();
function parse(value, fallback, maxLength = 24000) {
  if (value == null) return fallback;
  if (typeof value !== 'string' || value.length > maxLength) throw new Error('잘못된 검색 조건입니다.');
  return JSON.parse(value);
}

export function jobPage(snapshot, query = {}) {
  const filters = parse(query.filters, {});
  const profile = parse(query.profile, {});
  const hidden = parse(query.hidden, []);
  const ids = parse(query.ids, null);
  const discovery = query.discovery == null ? null : normalizeDiscoveryQuery(parse(query.discovery, null, 256000));
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)
    || !profile || typeof profile !== 'object' || Array.isArray(profile)
    || !Array.isArray(hidden) || (ids !== null && !Array.isArray(ids))) throw new Error('잘못된 검색 조건입니다.');
  const offset = Math.max(0, Math.trunc(Number(query.offset) || 0));
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(query.limit) || 24)));
  if (!Number.isFinite(offset) || !Number.isFinite(limit)) throw new Error('잘못된 페이지입니다.');
  const policyDay = listingPolicyDay();
  const key = JSON.stringify([filters, profile, hidden, ids, discovery, policyDay]);
  let cache = pages.get(snapshot);
  if (!cache) { cache = new Map(); pages.set(snapshot, cache); }
  let result = cache.get(key);
  if (!result) {
    const excluded = new Set(hidden);
    const included = ids && new Set(ids);
    const matches = (set, job) => [job.id, job.dedupeKey, job.jobKey, ...(job.sourceIds || [])].some(id => set.has(id));
    const profileKey = applicationTierProfileKey(profile);
    const filtered = snapshot.jobs.filter(job => !matches(excluded, job)
      && (!included || matches(included, job)) && jobMatchesFilters(job, filters)).map(job => {
      if (job.presentation?.profileKey === profileKey) return job;
      const assessment = applicationTierFor(job, profile);
      return { ...job, applicationTierGroup: assessment.tier, applicationTierGroupScore: assessment.score,
        presentation: { applicationTier: assessment, profileKey } };
    });
    const sort = filters.sort || '워라벨 우선';
    const sorted = sortJobs(filtered, sort, profile, { tierLatest: sort === '워라벨 우선' && (!discovery || discovery.mode === 'all') });
    const scoped = discovery && filterDiscoveryJobs(sorted, discovery);
    const jobs = scoped ? scoped.jobs : sorted;
    const tiers = {};
    for (const job of jobs) tiers[job.applicationTierGroup] = (tiers[job.applicationTierGroup] || 0) + 1;
    result = { jobs, tiers, discovery: scoped?.meta, payloads: new Map() };
    if (cache.size >= 16) cache.delete(cache.keys().next().value);
    cache.set(key, result);
  }
  const snapshotVersion = snapshot.dataTrust?.generatedAt || snapshot.updatedAt || snapshot.lastSuccessAt || '';
  const version = filters.availability === '진행 중' ? `${snapshotVersion}:age30:${policyDay}` : snapshotVersion;
  const start = query.version && query.version !== version ? 0 : offset;
  const payloadKey = `${start}:${limit}`;
  let payload = result.payloads.get(payloadKey);
  if (!payload) {
    const { jobs: _jobs, needsReviewJobs: _needs, reviewJobs: _review, ...meta } = snapshot;
    const jobs = result.jobs.slice(start, start + limit);
    const body = JSON.stringify({ ...meta, jobs, needsReviewJobs: [], reviewJobs: [], listingPolicy: { version: 1, day: policyDay },
      ...(result.discovery ? { discovery: result.discovery } : {}),
      pagination: { offset: start, limit, total: result.jobs.length, hasMore: start + jobs.length < result.jobs.length,
        nextOffset: start + jobs.length, version, tiers: result.tiers } });
    payload = { body, gzip: gzipSync(body) };
    if (result.payloads.size >= 8) result.payloads.delete(result.payloads.keys().next().value);
    result.payloads.set(payloadKey, payload);
  }
  return payload;
}
