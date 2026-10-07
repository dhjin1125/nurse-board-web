import {
  DEPARTMENT_OPTIONS, FACILITY_TYPE_OPTIONS, cleanUnknown, departmentFor, facilityTypeFor, workPatternFor,
} from './job-utils.js';

export const DETAIL_ENRICHMENT_STORAGE_KEY = 'nurse-detail-enrichments-v1';
export const DETAIL_ENRICHMENT_CACHE_VERSION = 1;
export const DETAIL_ENRICHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DETAIL_ENRICHMENT_MAX_ENTRIES = 500;

const MAX_SERIALIZED_LENGTH = 2_000_000;
const MAX_IDS_PER_ENTRY = 12;
const MAX_URLS_PER_ENTRY = 4;
const MAX_ID_LENGTH = 240;
const MAX_URL_LENGTH = 2_048;
const MAX_EXPERIENCE_LENGTH = 300;
const MAX_WORK_HOURS_LENGTH = 700;
const MAX_WORK_CONDITIONS_LENGTH = 1_600;
const MAX_EVIDENCE_FIELD_LENGTH = 64;
const MAX_EVIDENCE_EXCERPT_LENGTH = 400;
const MAX_WELFARE_ITEMS = 40;
const MAX_WELFARE_ITEM_LENGTH = 300;

const DETAIL_TEXT_FIELD_LIMITS = Object.freeze({
  employment: 300,
  education: 300,
  salary: 300,
  location: 500,
  duties: 1_600,
  qualifications: 1_600,
  preferredQualifications: 1_600,
  recruitmentProcess: 1_600,
  applicationMethod: 1_200,
  otherInformation: 2_200,
  deadlineText: 500,
  headcount: 100,
  subway: 300,
  description: 4_000,
});
const UNKNOWN_AWARE_DETAIL_FIELDS = new Set(['employment', 'education', 'salary', 'location', 'deadlineText', 'headcount', 'subway']);
const DESCRIPTION_KINDS = new Set(['content', 'jobPosting', 'meta', 'fallback']);

const EXPERIENCE_DOMAINS = new Set(['clinical', 'health-manager', 'nursing-general']);
const SPECIFIC_EXPERIENCE_DOMAINS = new Set(['clinical', 'health-manager']);
const EVIDENCE_FIELDS = new Set([
  'title',
  'experience',
  'experienceRequirements',
  'qualifications',
  'requirements',
  'preferredQualifications',
  'description',
  'duties',
]);
const EVIDENCE_STRENGTHS = new Set(['title-context', 'explicit', 'explicit-detail']);
const WORK_PATTERNS = new Set(['상근·주간', '3교대', '2교대', '야간전담']);
const DEPARTMENTS = new Set(DEPARTMENT_OPTIONS);
const FACILITY_TYPES = new Set(FACILITY_TYPE_OPTIONS);
const UNKNOWN_EXPERIENCE = /^(?:|[-·]|(?:경력\s*)?미표기|원문\s*확인|정보\s*확인|확인\s*필요)$/;
const UNKNOWN_DETAIL = /^(?:|[-·]|(?:(?:근무\s*(?:시간|조건)|고용\s*형태|학력|급여)\s*)?미표기|원문\s*확인|정보\s*확인|확인\s*필요)$/;

const emptyCache = () => ({ version: DETAIL_ENRICHMENT_CACHE_VERSION, entries: [] });
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function stringWithin(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text && text.length <= maxLength ? text : '';
}

function detailStringWithin(value, field, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim().slice(0, maxLength);
  if (!text) return '';
  return UNKNOWN_AWARE_DETAIL_FIELDS.has(field) && cleanUnknown(text) === '원문 확인' ? '' : text;
}

function normalizedDetailTextFields(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(DETAIL_TEXT_FIELD_LIMITS)
    .map(([field, maxLength]) => [field, detailStringWithin(value[field], field, maxLength)])
    .filter(([, text]) => Boolean(text)));
}

function uniqueStrings(value, maxItems, maxLength, validator = () => true) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    const text = stringWithin(item, maxLength);
    if (!text || !validator(text) || result.includes(text)) continue;
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

function currentMs(now = new Date()) {
  const value = typeof now === 'function' ? now() : now;
  const milliseconds = timestampMs(value);
  return Number.isFinite(milliseconds) ? milliseconds : Date.now();
}

function normalizeEvidence(value) {
  if (!isRecord(value)) return null;
  const field = stringWithin(value.field, MAX_EVIDENCE_FIELD_LENGTH);
  const excerpt = stringWithin(value.excerpt, MAX_EVIDENCE_EXCERPT_LENGTH);
  const strength = stringWithin(value.strength, 32);
  if (!EVIDENCE_FIELDS.has(field) || !excerpt || !EVIDENCE_STRENGTHS.has(strength)) return null;
  return { field, excerpt, strength };
}

function normalizeDomainWithEvidence(domainValue, evidenceValue) {
  const experienceDomain = stringWithin(domainValue, 32);
  const experienceEvidence = normalizeEvidence(evidenceValue);
  if (!EXPERIENCE_DOMAINS.has(experienceDomain) || !experienceEvidence) {
    return { experienceDomain: '', experienceEvidence: null };
  }
  return { experienceDomain, experienceEvidence };
}

function jobIdentity(job) {
  if (!isRecord(job)) return { ids: [], urls: [] };
  const alternateUrls = Array.isArray(job.alternateSources)
    ? job.alternateSources.map((source) => typeof source === 'string' ? source : source?.url)
    : [];
  return {
    ids: uniqueStrings([job.id, ...(Array.isArray(job.sourceIds) ? job.sourceIds : [])], MAX_IDS_PER_ENTRY, MAX_ID_LENGTH),
    urls: uniqueStrings([job.url, ...alternateUrls], MAX_URLS_PER_ENTRY, MAX_URL_LENGTH, validHttpUrl),
  };
}

function identitiesMatch(left, right, kind) {
  const candidates = new Set(right[kind]);
  return left[kind].some((value) => candidates.has(value));
}

function findMatchingEntry(entries, identity) {
  if (identity.ids.length) {
    const byId = entries.find((entry) => identitiesMatch(entry, identity, 'ids'));
    if (byId) return byId;
  }
  if (identity.urls.length) return entries.find((entry) => identitiesMatch(entry, identity, 'urls')) || null;
  return null;
}

function isFresh(checkedAt, nowMs) {
  const checkedMs = Date.parse(checkedAt);
  return Number.isFinite(checkedMs)
    && checkedMs <= nowMs + 5 * 60 * 1000
    && nowMs - checkedMs <= DETAIL_ENRICHMENT_TTL_MS;
}

function normalizeEntry(value, nowMs) {
  if (!isRecord(value)) return null;
  const checkedAt = stringWithin(value.checkedAt, 40);
  if (!isFresh(checkedAt, nowMs)) return null;
  const ids = uniqueStrings(value.ids, MAX_IDS_PER_ENTRY, MAX_ID_LENGTH);
  const urls = uniqueStrings(value.urls, MAX_URLS_PER_ENTRY, MAX_URL_LENGTH, validHttpUrl);
  if (!ids.length && !urls.length) return null;
  const experience = stringWithin(value.experience, MAX_EXPERIENCE_LENGTH);
  const workHours = stringWithin(value.workHours, MAX_WORK_HOURS_LENGTH);
  const workConditions = stringWithin(value.workConditions, MAX_WORK_CONDITIONS_LENGTH);
  const workPattern = stringWithin(value.workPattern, 32);
  const workPatternCheckedAt = stringWithin(value.workPatternCheckedAt, 40);
  const employmentCheckedAt = stringWithin(value.employmentCheckedAt, 40);
  const detailEnrichmentCheckedAt = stringWithin(value.detailEnrichmentCheckedAt, 40);
  const detailTextFields = normalizedDetailTextFields(value);
  const welfare = uniqueStrings(value.welfare, MAX_WELFARE_ITEMS, MAX_WELFARE_ITEM_LENGTH);
  const department = stringWithin(value.department, 64);
  const facilityType = stringWithin(value.facilityType, 64);
  const descriptionKind = stringWithin(value.descriptionKind, 32);
  const domain = normalizeDomainWithEvidence(value.experienceDomain, value.experienceEvidence);
  return {
    ids,
    urls,
    checkedAt: new Date(checkedAt).toISOString(),
    ...(isFresh(workPatternCheckedAt, nowMs) ? { workPatternCheckedAt: new Date(workPatternCheckedAt).toISOString() } : {}),
    ...(isFresh(employmentCheckedAt, nowMs) ? { employmentCheckedAt: new Date(employmentCheckedAt).toISOString() } : {}),
    ...(isFresh(detailEnrichmentCheckedAt, nowMs) ? { detailEnrichmentCheckedAt: new Date(detailEnrichmentCheckedAt).toISOString() } : {}),
    ...(experience && !UNKNOWN_EXPERIENCE.test(experience) ? { experience } : {}),
    ...(workHours && !UNKNOWN_DETAIL.test(workHours) ? { workHours } : {}),
    ...(workConditions && !UNKNOWN_DETAIL.test(workConditions) ? { workConditions } : {}),
    ...(WORK_PATTERNS.has(workPattern) ? { workPattern } : {}),
    ...(DEPARTMENTS.has(department) ? { department } : {}),
    ...(FACILITY_TYPES.has(facilityType) ? { facilityType } : {}),
    ...(DESCRIPTION_KINDS.has(descriptionKind) ? { descriptionKind } : {}),
    ...(typeof value.detailBodyAvailable === 'boolean' ? { detailBodyAvailable: value.detailBodyAvailable } : {}),
    ...detailTextFields,
    ...(welfare.length ? { welfare } : {}),
    ...(domain.experienceDomain ? domain : {}),
  };
}

function normalizeCache(cache, now = new Date()) {
  const nowMs = currentMs(now);
  if (!isRecord(cache) || cache.version !== DETAIL_ENRICHMENT_CACHE_VERSION || !Array.isArray(cache.entries)) return emptyCache();
  const entries = cache.entries
    .map((entry) => normalizeEntry(entry, nowMs))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt));
  const deduplicated = [];
  for (const entry of entries) {
    if (findMatchingEntry(deduplicated, entry)) continue;
    deduplicated.push(entry);
    if (deduplicated.length >= DETAIL_ENRICHMENT_MAX_ENTRIES) break;
  }
  return { version: DETAIL_ENRICHMENT_CACHE_VERSION, entries: deduplicated };
}

function storageTarget(storage) {
  const target = storage || globalThis.localStorage;
  return target && typeof target.getItem === 'function' && typeof target.setItem === 'function' ? target : null;
}

export function readDetailEnrichmentCache(storage, now = new Date()) {
  const target = storageTarget(storage);
  if (!target) return emptyCache();
  try {
    const raw = target.getItem(DETAIL_ENRICHMENT_STORAGE_KEY);
    if (!raw || raw.length > MAX_SERIALIZED_LENGTH) return emptyCache();
    return normalizeCache(JSON.parse(raw), now);
  } catch {
    return emptyCache();
  }
}

export function writeDetailEnrichmentCache(storage, cache, now = new Date()) {
  const normalized = normalizeCache(cache, now);
  const target = storageTarget(storage);
  if (!target) return normalized;
  try {
    let entries = normalized.entries;
    let payload = JSON.stringify({ ...normalized, entries });
    while (payload.length > MAX_SERIALIZED_LENGTH && entries.length) {
      entries = entries.slice(0, -1);
      payload = JSON.stringify({ version: DETAIL_ENRICHMENT_CACHE_VERSION, entries });
    }
    target.setItem(DETAIL_ENRICHMENT_STORAGE_KEY, payload);
    return { version: DETAIL_ENRICHMENT_CACHE_VERSION, entries };
  } catch {
    return normalized;
  }
}

export function rememberDetailEnrichment(cache, job, detail, now = new Date()) {
  const nowMs = currentMs(now);
  const current = normalizeCache(cache, nowMs);
  const identity = jobIdentity(job);
  if ((!identity.ids.length && !identity.urls.length) || !isRecord(detail) || detail.error || detail.detailVerified !== true) return current;

  const existing = findMatchingEntry(current.entries, identity);
  const domain = normalizeDomainWithEvidence(detail.experienceDomain, detail.experienceEvidence);
  const experience = stringWithin(detail.experience, MAX_EXPERIENCE_LENGTH);
  const workHours = stringWithin(detail.workHours, MAX_WORK_HOURS_LENGTH);
  const workConditions = stringWithin(detail.workConditions, MAX_WORK_CONDITIONS_LENGTH);
  const detailTextFields = normalizedDetailTextFields(detail);
  const welfare = uniqueStrings(detail.welfare, MAX_WELFARE_ITEMS, MAX_WELFARE_ITEM_LENGTH);
  const enrichedDetail = { ...job, ...detail, ...detailTextFields, workHours, workConditions };
  const workPattern = workPatternFor(enrichedDetail);
  const department = departmentFor(enrichedDetail);
  const facilityType = facilityTypeFor(enrichedDetail);
  const descriptionKind = stringWithin(detail.descriptionKind, 32);
  const entry = {
    ids: uniqueStrings([...identity.ids, ...(existing?.ids || [])], MAX_IDS_PER_ENTRY, MAX_ID_LENGTH),
    urls: uniqueStrings([...identity.urls, ...(existing?.urls || [])], MAX_URLS_PER_ENTRY, MAX_URL_LENGTH, validHttpUrl),
    checkedAt: new Date(nowMs).toISOString(),
    workPatternCheckedAt: new Date(nowMs).toISOString(),
    employmentCheckedAt: new Date(nowMs).toISOString(),
    detailEnrichmentCheckedAt: new Date(nowMs).toISOString(),
    ...(experience && !UNKNOWN_EXPERIENCE.test(experience) ? { experience } : {}),
    ...(workHours && !UNKNOWN_DETAIL.test(workHours) ? { workHours } : {}),
    ...(workConditions && !UNKNOWN_DETAIL.test(workConditions) ? { workConditions } : {}),
    ...(WORK_PATTERNS.has(workPattern) ? { workPattern } : {}),
    ...(DEPARTMENTS.has(department) ? { department } : {}),
    ...(FACILITY_TYPES.has(facilityType) ? { facilityType } : {}),
    ...(DESCRIPTION_KINDS.has(descriptionKind) ? { descriptionKind } : {}),
    ...(typeof detail.detailBodyAvailable === 'boolean' ? { detailBodyAvailable: detail.detailBodyAvailable } : {}),
    ...detailTextFields,
    ...(welfare.length ? { welfare } : {}),
    ...(domain.experienceDomain ? domain : {}),
  };
  const entries = current.entries.filter((candidate) => candidate !== existing);
  return normalizeCache({ version: DETAIL_ENRICHMENT_CACHE_VERSION, entries: [entry, ...entries] }, nowMs);
}

function domainRank(domain) {
  if (SPECIFIC_EXPERIENCE_DOMAINS.has(domain)) return 2;
  if (domain === 'nursing-general') return 1;
  return 0;
}

function evidenceRank(evidence) {
  return { 'title-context': 1, explicit: 2, 'explicit-detail': 3 }[evidence?.strength] || 0;
}

function shouldOverlayDomain(job, entry) {
  if (!entry.experienceDomain || !entry.experienceEvidence) return false;
  const currentDomain = EXPERIENCE_DOMAINS.has(job.experienceDomain) ? job.experienceDomain : '';
  const currentRank = domainRank(currentDomain);
  const incomingRank = domainRank(entry.experienceDomain);
  if (!currentRank) return true;
  if (currentRank > incomingRank) return false;
  if (currentRank === 2 && incomingRank === 2 && currentDomain !== entry.experienceDomain) return false;
  if (currentDomain === entry.experienceDomain) {
    return evidenceRank(entry.experienceEvidence) > evidenceRank(job.experienceEvidence);
  }
  return incomingRank > currentRank;
}

function hasCurrentDetailValue(value, field, maxLength) {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) {
    if (field === 'salary') return Boolean(detailStringWithin(value.raw, field, maxLength))
      || Number.isFinite(value.minimum) || Number.isFinite(value.maximum);
    if (field === 'location') return Boolean(detailStringWithin(value.text || value.region || value.district, field, maxLength));
    return Object.keys(value).length > 0;
  }
  return Boolean(detailStringWithin(value, field, maxLength));
}

export function applyDetailEnrichment(job, cache, now = new Date()) {
  if (!isRecord(job)) return job;
  const current = normalizeCache(cache, now);
  const entry = findMatchingEntry(current.entries, jobIdentity(job));
  if (!entry) return job;
  const overlayDomain = shouldOverlayDomain(job, entry);
  const currentExperience = stringWithin(job.experience, MAX_EXPERIENCE_LENGTH);
  const hasCurrentExperience = currentExperience && !UNKNOWN_EXPERIENCE.test(currentExperience);
  const currentWorkHours = stringWithin(job.workHours, MAX_WORK_HOURS_LENGTH);
  const currentWorkConditions = stringWithin(job.workConditions, MAX_WORK_CONDITIONS_LENGTH);
  const currentWorkPattern = workPatternFor(job);
  const hasCurrentEmployment = [job.employmentType, job.employment]
    .some((value) => cleanUnknown(value) !== '원문 확인');
  const detailFieldPatch = Object.fromEntries(Object.entries(DETAIL_TEXT_FIELD_LIMITS)
    .filter(([field, maxLength]) => field !== 'employment'
      && entry[field]
      && !hasCurrentDetailValue(job[field], field, maxLength))
    .map(([field]) => [field, entry[field]]));
  const hasCurrentWelfare = Array.isArray(job.welfare) && job.welfare.length > 0;
  return {
    ...job,
    presentation: undefined,
    detailCheckedAt: entry.checkedAt,
    ...(entry.workPatternCheckedAt ? { workPatternCheckedAt: entry.workPatternCheckedAt } : {}),
    ...(entry.employmentCheckedAt ? { employmentCheckedAt: entry.employmentCheckedAt } : {}),
    ...(entry.detailEnrichmentCheckedAt ? { detailEnrichmentCheckedAt: entry.detailEnrichmentCheckedAt } : {}),
    ...(!hasCurrentExperience && entry.experience ? { experience: entry.experience } : {}),
    ...((!currentWorkHours || UNKNOWN_DETAIL.test(currentWorkHours)) && entry.workHours ? { workHours: entry.workHours } : {}),
    ...((!currentWorkConditions || UNKNOWN_DETAIL.test(currentWorkConditions)) && entry.workConditions ? { workConditions: entry.workConditions } : {}),
    ...(!hasCurrentEmployment && entry.employment ? { employment: entry.employment, employmentType: entry.employment } : {}),
    ...(currentWorkPattern === '원문 확인' && entry.workPattern ? { workPattern: entry.workPattern } : {}),
    ...(departmentFor(job) === '원문 확인' && entry.department ? { department: entry.department } : {}),
    ...(facilityTypeFor(job) === '원문 확인' && entry.facilityType ? { facilityType: entry.facilityType } : {}),
    ...(!hasCurrentWelfare && entry.welfare?.length ? { welfare: entry.welfare } : {}),
    ...(entry.descriptionKind && !job.descriptionKind ? { descriptionKind: entry.descriptionKind } : {}),
    ...(typeof entry.detailBodyAvailable === 'boolean' && typeof job.detailBodyAvailable !== 'boolean'
      ? { detailBodyAvailable: entry.detailBodyAvailable }
      : {}),
    ...detailFieldPatch,
    ...(overlayDomain ? {
      experienceDomain: entry.experienceDomain,
      experienceEvidence: entry.experienceEvidence,
    } : {}),
  };
}
