import { normalizeDiscovery } from './discovery.js';

export const USER_STATE_VERSION = 2;
export const USER_STATE_STORAGE_KEY = 'nurse-user-state';
export const LEGACY_SAVED_STORAGE_KEY = 'nurse-saved';

export const APPLICATION_STATUS = Object.freeze({
  INTERESTED: 'interested',
  PREPARING: 'preparing',
  APPLIED: 'applied',
  INTERVIEW: 'interview',
  FINAL: 'final',
});

export const FINAL_RESULT = Object.freeze({
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
  CLOSED: 'closed',
});

const APPLICATION_STATUSES = new Set(Object.values(APPLICATION_STATUS));
const FINAL_RESULTS = new Set(Object.values(FINAL_RESULT));
const EXPERIENCE_DOMAINS = new Set(['clinical', 'health-manager', 'nursing-general', 'unspecified']);
const PROFILE_ARRAY_FIELDS = [
  'roleTags',
  'regionCodes',
  'employmentTypes',
  'experienceLevels',
  'workPatterns',
  'preferredKeywords',
  'excludedKeywords',
];

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const asString = (value, fallback = '') => typeof value === 'string' ? value.trim() : fallback;
const asNullableString = (value, fallback = null) => value == null || value === '' ? null : asString(value, fallback);
const uniqueStrings = (value) => Array.isArray(value)
  ? [...new Set(value.map((item) => asString(item)).filter(Boolean))]
  : [];

function asTimestamp(now = new Date()) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('유효한 날짜가 필요합니다.');
  return date.toISOString();
}

function jsonSafeCopy(value) {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(jsonSafeCopy).filter((item) => item !== undefined);
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
    .map(([key, item]) => [key, jsonSafeCopy(item)])
    .filter(([, item]) => item !== undefined));
}

function normalizeAlternateSources(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const source = typeof item === 'string'
      ? { source: '', url: asString(item) }
      : isRecord(item)
        ? {
            id: asString(item.id),
            source: asString(item.source || item.name),
            url: asString(item.url),
          }
        : null;
    if (!source?.url || seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
  }
  return result;
}

function normalizeExperienceEvidence(value) {
  if (!isRecord(value)) return null;
  const evidence = {
    field: asString(value.field),
    excerpt: asString(value.excerpt),
    strength: asString(value.strength),
  };
  return Object.values(evidence).some(Boolean) ? evidence : null;
}

function normalizeExperienceDomain(value) {
  const aliases = { 'clinical-nursing': 'clinical', nursing: 'nursing-general', 'occupational-health': 'health-manager' };
  const domain = aliases[asString(value)] || asString(value);
  return EXPERIENCE_DOMAINS.has(domain) ? domain : '';
}

function createProfile() {
  return {
    onboardingCompletedAt: null,
    roleTags: [],
    regionCodes: [],
    employmentTypes: [],
    experienceLevels: [],
    workPatterns: [],
    preferredKeywords: [],
    excludedKeywords: [],
  };
}

function normalizeProfile(value) {
  const profile = createProfile();
  if (!isRecord(value)) return profile;
  profile.onboardingCompletedAt = asNullableString(value.onboardingCompletedAt);
  for (const field of PROFILE_ARRAY_FIELDS) profile[field] = uniqueStrings(value[field]);
  if (Array.isArray(value.careerDomains)) profile.careerDomains = uniqueStrings(value.careerDomains);
  if (['all', 'pa', 'outpatient', 'health'].includes(value.preferredCareRole)) profile.preferredCareRole = value.preferredCareRole;
  return profile;
}

function normalizeSnapshot(value, fallbackKey, fallbackAt) {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const dedupeKey = asString(value.dedupeKey);
  const jobKey = asString(value.jobKey || dedupeKey || id || fallbackKey);
  if (!jobKey) return null;
  return {
    jobKey,
    id,
    dedupeKey,
    company: asString(value.company),
    title: asString(value.title),
    region: asString(value.region),
    regionCode: asString(value.regionCode),
    employmentType: asString(value.employmentType || value.employment),
    experienceLevel: asString(value.experienceLevel || value.experience),
    experience: asString(value.experience),
    experienceDomain: normalizeExperienceDomain(value.experienceDomain),
    experienceEvidence: normalizeExperienceEvidence(value.experienceEvidence),
    department: asString(value.department),
    workPattern: asString(value.workPattern),
    facilityType: asString(value.facilityType),
    education: asString(value.education),
    salary: asString(value.salary),
    location: asString(value.location),
    workHours: asString(value.workHours),
    workConditions: asString(value.workConditions),
    duties: asString(value.duties),
    qualifications: asString(value.qualifications),
    preferredQualifications: asString(value.preferredQualifications),
    recruitmentProcess: asString(value.recruitmentProcess),
    applicationMethod: asString(value.applicationMethod),
    otherInformation: asString(value.otherInformation),
    deadlineText: asString(value.deadlineText),
    headcount: asString(value.headcount),
    subway: asString(value.subway),
    welfare: uniqueStrings(value.welfare),
    description: asString(value.description),
    descriptionKind: asString(value.descriptionKind),
    detailBodyAvailable: typeof value.detailBodyAvailable === 'boolean' ? value.detailBodyAvailable : null,
    detailCheckedAt: asNullableString(value.detailCheckedAt),
    detailEnrichmentCheckedAt: asNullableString(value.detailEnrichmentCheckedAt),
    employmentCheckedAt: asNullableString(value.employmentCheckedAt),
    workPatternCheckedAt: asNullableString(value.workPatternCheckedAt),
    deadlineAt: asNullableString(value.deadlineAt),
    deadline: asString(value.deadline),
    postedAt: asNullableString(value.postedAt),
    publishedAt: asNullableString(value.publishedAt),
    firstSeenAt: asNullableString(value.firstSeenAt),
    lastSeenAt: asNullableString(value.lastSeenAt),
    url: asString(value.url),
    source: asString(value.source),
    roleTags: uniqueStrings(value.roleTags),
    alternateSources: normalizeAlternateSources(value.alternateSources),
    savedAt: asNullableString(value.savedAt, fallbackAt) || fallbackAt,
    hiddenAt: asNullableString(value.hiddenAt),
    snapshotUpdatedAt: asNullableString(value.snapshotUpdatedAt, fallbackAt) || fallbackAt,
    lastSeenAt: asNullableString(value.lastSeenAt),
  };
}

function normalizeApplication(value, fallbackKey, fallbackAt) {
  if (!isRecord(value)) return null;
  const jobKey = asString(value.jobKey || fallbackKey);
  if (!jobKey) return null;
  const requestedStatus = value.status === 'result' ? APPLICATION_STATUS.FINAL : value.status;
  const requestedResult = value.finalResult === 'expired' ? FINAL_RESULT.CLOSED : value.finalResult;
  const status = APPLICATION_STATUSES.has(requestedStatus) ? requestedStatus : APPLICATION_STATUS.INTERESTED;
  return {
    jobKey,
    status,
    finalResult: status === APPLICATION_STATUS.FINAL && FINAL_RESULTS.has(requestedResult) ? requestedResult : null,
    note: asString(value.note),
    nextAction: asString(value.nextAction),
    dueAt: asNullableString(value.dueAt),
    appliedAt: asNullableString(value.appliedAt),
    interviewAt: asNullableString(value.interviewAt),
    createdAt: asNullableString(value.createdAt, fallbackAt) || fallbackAt,
    updatedAt: asNullableString(value.updatedAt, fallbackAt) || fallbackAt,
  };
}

function normalizeNotification(value, fallbackAt, index = 0) {
  if (!isRecord(value)) return null;
  const type = asString(value.type);
  if (!type) return null;
  const jobKey = asNullableString(value.jobKey);
  const createdAt = asNullableString(value.createdAt, fallbackAt) || fallbackAt;
  const scheduledAt = asNullableString(value.scheduledAt);
  const id = asString(value.id) || `${type}:${jobKey || 'global'}:${scheduledAt || createdAt}:${index}`;
  return {
    id,
    type,
    title: asString(value.title),
    message: asString(value.message),
    jobKey,
    createdAt,
    scheduledAt,
    readAt: asNullableString(value.readAt),
    data: isRecord(value.data) ? jsonSafeCopy(value.data) : {},
  };
}

function normalizeMeta(value, fallbackAt) {
  const meta = isRecord(value) ? value : {};
  return {
    createdAt: asNullableString(meta.createdAt, fallbackAt) || fallbackAt,
    updatedAt: asNullableString(meta.updatedAt, fallbackAt) || fallbackAt,
    lastVisitedAt: asNullableString(meta.lastVisitedAt),
    importedAt: asNullableString(meta.importedAt),
    migratedFromV1At: asNullableString(meta.migratedFromV1At),
    pendingLegacySavedIds: uniqueStrings(meta.pendingLegacySavedIds),
  };
}

export function createUserState(now = new Date()) {
  const at = asTimestamp(now);
  return {
    version: USER_STATE_VERSION,
    profile: createProfile(),
    savedSnapshots: {},
    applications: {},
    notifications: [],
    recentFilters: {},
    meta: {
      createdAt: at,
      updatedAt: at,
      lastVisitedAt: null,
      importedAt: null,
      migratedFromV1At: null,
      pendingLegacySavedIds: [],
    },
  };
}

export function normalizeUserState(raw, now = new Date()) {
  const at = asTimestamp(now);
  if (Array.isArray(raw)) {
    const state = createUserState(at);
    state.meta.pendingLegacySavedIds = uniqueStrings(raw);
    state.meta.migratedFromV1At = at;
    return state;
  }
  if (!isRecord(raw)) return createUserState(at);

  const meta = normalizeMeta(raw.meta, at);
  const savedSnapshots = {};
  if (isRecord(raw.savedSnapshots)) {
    for (const [key, value] of Object.entries(raw.savedSnapshots)) {
      const snapshot = normalizeSnapshot(value, key, meta.createdAt);
      if (snapshot) savedSnapshots[snapshot.jobKey] = snapshot;
    }
  }

  const hiddenSnapshots = {};
  if (isRecord(raw.hiddenSnapshots)) {
    for (const [key, value] of Object.entries(raw.hiddenSnapshots)) {
      const snapshot = normalizeSnapshot(value, key, meta.createdAt);
      if (snapshot) hiddenSnapshots[snapshot.jobKey] = snapshot;
    }
  }

  const applications = {};
  if (isRecord(raw.applications)) {
    for (const [key, value] of Object.entries(raw.applications)) {
      const application = normalizeApplication(value, key, meta.createdAt);
      if (application) applications[application.jobKey] = application;
    }
  }

  const notifications = Array.isArray(raw.notifications)
    ? raw.notifications.map((value, index) => normalizeNotification(value, meta.createdAt, index)).filter(Boolean)
    : [];

  const normalized = {
    version: USER_STATE_VERSION,
    profile: normalizeProfile(raw.profile),
    savedSnapshots,
    applications,
    notifications,
    recentFilters: isRecord(raw.recentFilters) ? jsonSafeCopy(raw.recentFilters) : {},
    meta,
  };
  // Keep the new collection optional so existing v2 state remains compatible
  // until the user hides their first posting.
  if (hasOwn(raw, 'hiddenSnapshots')) normalized.hiddenSnapshots = hiddenSnapshots;
  if (hasOwn(raw, 'discovery')) normalized.discovery = normalizeDiscovery(raw.discovery);
  return normalized;
}

function withUpdatedMeta(state, at) {
  return { ...state, meta: { ...state.meta, updatedAt: at } };
}

function jobIdentity(job) {
  if (!isRecord(job)) return { id: '', dedupeKey: '', jobKey: '' };
  const id = asString(job.id);
  const dedupeKey = asString(job.dedupeKey);
  return { id, dedupeKey, jobKey: dedupeKey || id };
}

function findSnapshotKey(state, jobOrKey) {
  if (typeof jobOrKey === 'string') {
    const key = asString(jobOrKey);
    if (state.savedSnapshots[key]) return key;
    return Object.keys(state.savedSnapshots).find((candidate) => {
      const snapshot = state.savedSnapshots[candidate];
      return snapshot.id === key || snapshot.dedupeKey === key;
    }) || '';
  }
  const { id, dedupeKey, jobKey } = jobIdentity(jobOrKey);
  if (jobKey && state.savedSnapshots[jobKey]) return jobKey;
  return Object.keys(state.savedSnapshots).find((candidate) => {
    const snapshot = state.savedSnapshots[candidate];
    return (id && snapshot.id === id) || (dedupeKey && snapshot.dedupeKey === dedupeKey);
  }) || '';
}

function findHiddenSnapshotKey(state, jobOrKey) {
  const hiddenSnapshots = state.hiddenSnapshots || {};
  if (typeof jobOrKey === 'string') {
    const key = asString(jobOrKey);
    if (hiddenSnapshots[key]) return key;
    return Object.keys(hiddenSnapshots).find((candidate) => {
      const snapshot = hiddenSnapshots[candidate];
      return snapshot.id === key || snapshot.dedupeKey === key;
    }) || '';
  }
  const { id, dedupeKey, jobKey } = jobIdentity(jobOrKey);
  if (jobKey && hiddenSnapshots[jobKey]) return jobKey;
  return Object.keys(hiddenSnapshots).find((candidate) => {
    const snapshot = hiddenSnapshots[candidate];
    return (id && snapshot.id === id) || (dedupeKey && snapshot.dedupeKey === dedupeKey);
  }) || '';
}

function preferIncoming(incoming, existing = '') {
  return asString(incoming) || asString(existing);
}

function snapshotFromJob(job, existing, at) {
  if (!isRecord(job)) throw new TypeError('저장할 공고가 필요합니다.');
  const id = preferIncoming(job.id, existing?.id);
  const dedupeKey = preferIncoming(job.dedupeKey, existing?.dedupeKey);
  const jobKey = dedupeKey || id || asString(existing?.jobKey);
  if (!jobKey) throw new TypeError('공고 id 또는 dedupeKey가 필요합니다.');
  const incomingAlternates = normalizeAlternateSources(job.alternateSources);
  const incomingRoleTags = uniqueStrings(job.roleTags);
  const incomingWelfare = uniqueStrings(job.welfare);
  return {
    jobKey,
    id,
    dedupeKey,
    company: preferIncoming(job.company, existing?.company),
    title: preferIncoming(job.title, existing?.title),
    region: preferIncoming(job.region, existing?.region),
    regionCode: preferIncoming(job.regionCode, existing?.regionCode),
    employmentType: preferIncoming(job.employmentType || job.employment, existing?.employmentType),
    experienceLevel: preferIncoming(job.experienceLevel || job.experience, existing?.experienceLevel),
    experience: preferIncoming(job.experience, existing?.experience),
    experienceDomain: normalizeExperienceDomain(job.experienceDomain) || normalizeExperienceDomain(existing?.experienceDomain),
    experienceEvidence: normalizeExperienceEvidence(job.experienceEvidence)
      || normalizeExperienceEvidence(existing?.experienceEvidence),
    department: preferIncoming(job.department, existing?.department),
    workPattern: preferIncoming(job.workPattern, existing?.workPattern),
    facilityType: preferIncoming(job.facilityType, existing?.facilityType),
    education: preferIncoming(job.education, existing?.education),
    salary: preferIncoming(job.salary, existing?.salary),
    location: preferIncoming(job.location, existing?.location),
    workHours: preferIncoming(job.workHours, existing?.workHours),
    workConditions: preferIncoming(job.workConditions, existing?.workConditions),
    duties: preferIncoming(job.duties, existing?.duties),
    qualifications: preferIncoming(job.qualifications, existing?.qualifications),
    preferredQualifications: preferIncoming(job.preferredQualifications, existing?.preferredQualifications),
    recruitmentProcess: preferIncoming(job.recruitmentProcess, existing?.recruitmentProcess),
    applicationMethod: preferIncoming(job.applicationMethod, existing?.applicationMethod),
    otherInformation: preferIncoming(job.otherInformation, existing?.otherInformation),
    deadlineText: preferIncoming(job.deadlineText, existing?.deadlineText),
    headcount: preferIncoming(job.headcount, existing?.headcount),
    subway: preferIncoming(job.subway, existing?.subway),
    welfare: incomingWelfare.length ? incomingWelfare : uniqueStrings(existing?.welfare),
    description: preferIncoming(job.description, existing?.description),
    descriptionKind: preferIncoming(job.descriptionKind, existing?.descriptionKind),
    detailBodyAvailable: typeof job.detailBodyAvailable === 'boolean'
      ? job.detailBodyAvailable
      : typeof existing?.detailBodyAvailable === 'boolean' ? existing.detailBodyAvailable : null,
    detailCheckedAt: asNullableString(job.detailCheckedAt, existing?.detailCheckedAt ?? null),
    detailEnrichmentCheckedAt: asNullableString(job.detailEnrichmentCheckedAt, existing?.detailEnrichmentCheckedAt ?? null),
    employmentCheckedAt: asNullableString(job.employmentCheckedAt, existing?.employmentCheckedAt ?? null),
    workPatternCheckedAt: asNullableString(job.workPatternCheckedAt, existing?.workPatternCheckedAt ?? null),
    deadlineAt: asNullableString(job.deadlineAt, existing?.deadlineAt ?? null),
    deadline: preferIncoming(job.deadline, existing?.deadline),
    postedAt: asNullableString(job.postedAt, existing?.postedAt ?? null),
    publishedAt: asNullableString(job.publishedAt, existing?.publishedAt ?? null),
    firstSeenAt: asNullableString(job.firstSeenAt, existing?.firstSeenAt ?? null),
    url: preferIncoming(job.url, existing?.url),
    source: preferIncoming(job.source, existing?.source),
    roleTags: incomingRoleTags.length ? incomingRoleTags : uniqueStrings(existing?.roleTags),
    alternateSources: incomingAlternates.length ? incomingAlternates : normalizeAlternateSources(existing?.alternateSources),
    savedAt: asNullableString(existing?.savedAt || job.savedAt, at) || at,
    hiddenAt: asNullableString(existing?.hiddenAt || job.hiddenAt),
    snapshotUpdatedAt: at,
    lastSeenAt: asNullableString(job.lastSeenAt, existing?.lastSeenAt ?? null),
  };
}

function rekeyReferences(state, previousKey, nextKey) {
  if (!previousKey || previousKey === nextKey) return state;
  const applications = { ...state.applications };
  if (applications[previousKey]) {
    applications[nextKey] = { ...applications[previousKey], ...applications[nextKey], jobKey: nextKey };
    delete applications[previousKey];
  }
  const notifications = state.notifications.map((notification) => notification.jobKey === previousKey
    ? { ...notification, jobKey: nextKey }
    : notification);
  return { ...state, applications, notifications };
}

export function saveJobSnapshot(state, job, now = new Date()) {
  const at = asTimestamp(now);
  let next = normalizeUserState(state, at);
  const previousKey = findSnapshotKey(next, job);
  const existing = previousKey ? next.savedSnapshots[previousKey] : null;
  const snapshot = snapshotFromJob(job, existing, at);
  next = rekeyReferences(next, previousKey, snapshot.jobKey);
  const savedSnapshots = { ...next.savedSnapshots, [snapshot.jobKey]: snapshot };
  if (previousKey && previousKey !== snapshot.jobKey) delete savedSnapshots[previousKey];
  return withUpdatedMeta({ ...next, savedSnapshots }, at);
}

export function removeSavedSnapshot(state, jobOrKey, now = new Date(), { cascade = false } = {}) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  const jobKey = findSnapshotKey(next, jobOrKey);
  if (!jobKey) return next;
  if (next.applications[jobKey] && !cascade) {
    throw new Error('지원 관리 중인 공고입니다. 함께 삭제하려면 cascade 옵션이 필요합니다.');
  }
  const savedSnapshots = { ...next.savedSnapshots };
  delete savedSnapshots[jobKey];
  const applications = { ...next.applications };
  if (cascade) delete applications[jobKey];
  const notifications = cascade
    ? next.notifications.filter((notification) => notification.jobKey !== jobKey)
    : next.notifications;
  return withUpdatedMeta({ ...next, savedSnapshots, applications, notifications }, at);
}

export function hideJobSnapshot(state, job, now = new Date()) {
  const at = asTimestamp(now);
  let next = normalizeUserState(state, at);
  const previousKey = findHiddenSnapshotKey(next, job);
  const existing = previousKey ? next.hiddenSnapshots?.[previousKey] : null;
  const snapshot = snapshotFromJob(job, existing, at);
  const hiddenSnapshot = {
    ...snapshot,
    hiddenAt: asNullableString(existing?.hiddenAt || job.hiddenAt, at) || at,
  };
  const hiddenSnapshots = { ...(next.hiddenSnapshots || {}), [hiddenSnapshot.jobKey]: hiddenSnapshot };
  if (previousKey && previousKey !== hiddenSnapshot.jobKey) delete hiddenSnapshots[previousKey];
  next = { ...next, hiddenSnapshots };
  return withUpdatedMeta(next, at);
}

export function removeHiddenSnapshot(state, jobOrKey, now = new Date()) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  const hiddenKey = findHiddenSnapshotKey(next, jobOrKey);
  if (!hiddenKey) return next;
  const hiddenSnapshots = { ...(next.hiddenSnapshots || {}) };
  delete hiddenSnapshots[hiddenKey];
  return withUpdatedMeta({ ...next, hiddenSnapshots }, at);
}

export function isJobHidden(state, jobOrKey) {
  const normalized = normalizeUserState(state);
  return Boolean(findHiddenSnapshotKey(normalized, jobOrKey));
}

function jobsByIdentity(jobs) {
  const map = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const { id, dedupeKey } = jobIdentity(job);
    if (id) map.set(id, job);
    if (dedupeKey) map.set(dedupeKey, job);
  }
  return map;
}

export function hydrateSavedSnapshots(state, jobs = [], now = new Date()) {
  const at = asTimestamp(now);
  let next = normalizeUserState(state, at);
  const byIdentity = jobsByIdentity(jobs);

  for (const snapshot of Object.values(next.savedSnapshots)) {
    const currentJob = byIdentity.get(snapshot.dedupeKey) || byIdentity.get(snapshot.id);
    if (currentJob) next = saveJobSnapshot(next, currentJob, at);
  }

  const unresolved = [];
  for (const legacyId of next.meta.pendingLegacySavedIds) {
    const currentJob = byIdentity.get(legacyId);
    if (currentJob) next = saveJobSnapshot(next, currentJob, at);
    else if (!findSnapshotKey(next, legacyId)) unresolved.push(legacyId);
  }

  next = {
    ...next,
    meta: {
      ...next.meta,
      pendingLegacySavedIds: unresolved,
      updatedAt: at,
    },
  };
  return next;
}

export function hydrateHiddenSnapshots(state, jobs = [], now = new Date()) {
  const at = asTimestamp(now);
  let next = normalizeUserState(state, at);
  const byIdentity = jobsByIdentity(jobs);

  for (const snapshot of Object.values(next.hiddenSnapshots || {})) {
    const currentJob = byIdentity.get(snapshot.dedupeKey) || byIdentity.get(snapshot.id);
    if (currentJob) next = hideJobSnapshot(next, currentJob, at);
  }

  return {
    ...next,
    meta: {
      ...next.meta,
      updatedAt: at,
    },
  };
}

export function migrateLegacySavedIds(state, legacyIds, jobs = [], now = new Date()) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  const pending = uniqueStrings([
    ...next.meta.pendingLegacySavedIds,
    ...uniqueStrings(legacyIds),
  ]).filter((id) => !findSnapshotKey(next, id));
  const migrated = {
    ...next,
    meta: {
      ...next.meta,
      migratedFromV1At: next.meta.migratedFromV1At || (pending.length || uniqueStrings(legacyIds).length ? at : null),
      pendingLegacySavedIds: pending,
      updatedAt: at,
    },
  };
  return hydrateSavedSnapshots(migrated, jobs, at);
}

export function isJobSaved(state, jobOrKey) {
  const normalized = normalizeUserState(state);
  if (findSnapshotKey(normalized, jobOrKey)) return true;
  const id = typeof jobOrKey === 'string' ? asString(jobOrKey) : jobIdentity(jobOrKey).id;
  return Boolean(id && normalized.meta.pendingLegacySavedIds.includes(id));
}

export function updateProfile(state, patch, now = new Date()) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  const profile = normalizeProfile({ ...next.profile, ...(isRecord(patch) ? patch : {}) });
  return withUpdatedMeta({ ...next, profile }, at);
}

export function updateRecentFilters(state, patch, now = new Date()) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  const safePatch = isRecord(patch) ? jsonSafeCopy(patch) : {};
  return withUpdatedMeta({ ...next, recentFilters: { ...next.recentFilters, ...safePatch } }, at);
}

export function touchLastVisited(state, now = new Date()) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  return { ...next, meta: { ...next.meta, lastVisitedAt: at, updatedAt: at } };
}

export function upsertApplication(state, jobOrKey, patch = {}, now = new Date()) {
  const at = asTimestamp(now);
  let next = isRecord(jobOrKey) ? saveJobSnapshot(state, jobOrKey, at) : normalizeUserState(state, at);
  const jobKey = findSnapshotKey(next, jobOrKey);
  if (!jobKey) throw new Error('지원 상태를 기록하려면 공고 스냅샷이 필요합니다.');
  const current = next.applications[jobKey] || {
    jobKey,
    status: APPLICATION_STATUS.INTERESTED,
    finalResult: null,
    note: '',
    nextAction: '',
    dueAt: null,
    appliedAt: null,
    interviewAt: null,
    createdAt: at,
    updatedAt: at,
  };
  const changes = isRecord(patch) ? patch : {};
  const status = hasOwn(changes, 'status') ? changes.status : current.status;
  if (!APPLICATION_STATUSES.has(status)) throw new TypeError(`지원 상태가 올바르지 않습니다: ${status}`);
  const requestedFinalResult = hasOwn(changes, 'finalResult') ? changes.finalResult : current.finalResult;
  if (requestedFinalResult != null && !FINAL_RESULTS.has(requestedFinalResult)) {
    throw new TypeError(`최종 결과가 올바르지 않습니다: ${requestedFinalResult}`);
  }
  if (requestedFinalResult && status !== APPLICATION_STATUS.FINAL) {
    throw new TypeError('최종 결과는 final 상태에서만 기록할 수 있습니다.');
  }
  const application = {
    jobKey,
    status,
    finalResult: status === APPLICATION_STATUS.FINAL ? requestedFinalResult || null : null,
    note: hasOwn(changes, 'note') ? asString(changes.note) : current.note,
    nextAction: hasOwn(changes, 'nextAction') ? asString(changes.nextAction) : current.nextAction,
    dueAt: hasOwn(changes, 'dueAt') ? asNullableString(changes.dueAt) : current.dueAt,
    appliedAt: hasOwn(changes, 'appliedAt') ? asNullableString(changes.appliedAt) : current.appliedAt,
    interviewAt: hasOwn(changes, 'interviewAt') ? asNullableString(changes.interviewAt) : current.interviewAt,
    createdAt: current.createdAt || at,
    updatedAt: at,
  };
  next = { ...next, applications: { ...next.applications, [jobKey]: application } };
  return withUpdatedMeta(next, at);
}

export function removeApplication(state, jobOrKey, now = new Date()) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  const jobKey = findSnapshotKey(next, jobOrKey) || asString(jobOrKey);
  if (!jobKey || !next.applications[jobKey]) return next;
  const applications = { ...next.applications };
  delete applications[jobKey];
  const notifications = next.notifications.filter((notification) => notification.jobKey !== jobKey || notification.type !== 'schedule');
  return withUpdatedMeta({ ...next, applications, notifications }, at);
}

function notificationId(notification, at) {
  const type = asString(notification.type);
  const jobKey = asNullableString(notification.jobKey) || 'global';
  const scheduledAt = asNullableString(notification.scheduledAt);
  return asString(notification.id) || `${type}:${jobKey}:${scheduledAt || at}`;
}

export function upsertNotification(state, notification, now = new Date()) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  if (!isRecord(notification) || !asString(notification.type)) throw new TypeError('알림 type이 필요합니다.');
  const id = notificationId(notification, at);
  const baseNotifications = notification.type === 'schedule' && notification.jobKey
    ? next.notifications.filter((item) => item.id === id || item.type !== 'schedule' || item.jobKey !== notification.jobKey)
    : next.notifications;
  const index = baseNotifications.findIndex((item) => item.id === id);
  const current = index >= 0 ? baseNotifications[index] : null;
  const normalized = normalizeNotification({
    ...current,
    ...notification,
    id,
    createdAt: current?.createdAt || notification.createdAt || at,
    readAt: hasOwn(notification, 'readAt') ? notification.readAt : current?.readAt,
  }, at);
  const notifications = [...baseNotifications];
  if (index >= 0) notifications[index] = normalized;
  else notifications.unshift(normalized);
  return withUpdatedMeta({ ...next, notifications }, at);
}

export function markNotificationRead(state, notificationIdValue, now = new Date()) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  let changed = false;
  const notifications = next.notifications.map((notification) => {
    if (notification.id !== notificationIdValue || notification.readAt) return notification;
    changed = true;
    return { ...notification, readAt: at };
  });
  return changed ? withUpdatedMeta({ ...next, notifications }, at) : next;
}

export function markAllNotificationsRead(state, now = new Date()) {
  const at = asTimestamp(now);
  const next = normalizeUserState(state, at);
  const notifications = next.notifications.map((notification) => notification.readAt
    ? notification
    : { ...notification, readAt: at });
  return withUpdatedMeta({ ...next, notifications }, at);
}

export function getUnreadNotificationCount(state) {
  return normalizeUserState(state).notifications.filter((notification) => !notification.readAt).length;
}

function validateImportedState(value) {
  if (Array.isArray(value)) return;
  if (!isRecord(value)) throw new TypeError('백업 데이터는 객체여야 합니다.');
  if (value.version !== USER_STATE_VERSION) {
    throw new TypeError(`지원하지 않는 사용자 상태 버전입니다: ${value.version ?? '없음'}`);
  }
  const expectedRecords = ['profile', 'savedSnapshots', 'hiddenSnapshots', 'applications', 'recentFilters', 'meta'];
  for (const field of expectedRecords) {
    if (hasOwn(value, field) && !isRecord(value[field])) throw new TypeError(`${field} 형식이 올바르지 않습니다.`);
  }
  if (hasOwn(value, 'notifications') && !Array.isArray(value.notifications)) {
    throw new TypeError('notifications 형식이 올바르지 않습니다.');
  }
}

export function exportUserState(state, space = 2) {
  return JSON.stringify(normalizeUserState(state), null, space);
}

export function importUserState(payload, now = new Date()) {
  const at = asTimestamp(now);
  let value = payload;
  if (typeof payload === 'string') {
    try {
      value = JSON.parse(payload);
    } catch {
      throw new TypeError('백업 JSON을 읽을 수 없습니다.');
    }
  }
  validateImportedState(value);
  const state = Array.isArray(value)
    ? migrateLegacySavedIds(createUserState(at), value, [], at)
    : normalizeUserState(value, at);
  return {
    ...state,
    meta: {
      ...state.meta,
      importedAt: at,
      updatedAt: at,
    },
  };
}

function resolveStorage(storage) {
  const target = storage || globalThis.localStorage;
  if (!target || typeof target.getItem !== 'function' || typeof target.setItem !== 'function') {
    throw new TypeError('localStorage 호환 저장소가 필요합니다.');
  }
  return target;
}

function readJson(storage, key) {
  const raw = storage.getItem(key);
  if (raw == null) return { raw: null, value: null, valid: true };
  try {
    return { raw, value: JSON.parse(raw), valid: true };
  } catch {
    return { raw, value: null, valid: false };
  }
}

export function createLocalStorageAdapter(storage, options = {}) {
  const target = resolveStorage(storage);
  const key = options.key || USER_STATE_STORAGE_KEY;
  const legacyKey = options.legacyKey || LEGACY_SAVED_STORAGE_KEY;
  const currentNow = () => typeof options.now === 'function' ? options.now() : options.now || new Date();

  const adapter = {
    load(jobs = []) {
      const at = asTimestamp(currentNow());
      const current = readJson(target, key);
      let state = current.valid ? normalizeUserState(current.value, at) : createUserState(at);
      let shouldPersist = Array.isArray(current.value);

      const legacy = readJson(target, legacyKey);
      if (legacy.valid && Array.isArray(legacy.value) && legacy.value.length) {
        state = migrateLegacySavedIds(state, legacy.value, jobs, at);
        shouldPersist = true;
      } else if (jobs.length && state.meta.pendingLegacySavedIds.length) {
        state = hydrateSavedSnapshots(state, jobs, at);
        shouldPersist = true;
      }

      if (shouldPersist) {
        target.setItem(key, JSON.stringify(state));
        if (legacy.valid && Array.isArray(legacy.value)) target.removeItem(legacyKey);
      }
      return state;
    },

    save(state) {
      const at = asTimestamp(currentNow());
      const normalized = normalizeUserState(state, at);
      const saved = withUpdatedMeta(normalized, at);
      target.setItem(key, JSON.stringify(saved));
      return saved;
    },

    hydrate(state, jobs = []) {
      const at = currentNow();
      return adapter.save(hydrateHiddenSnapshots(hydrateSavedSnapshots(state, jobs, at), jobs, at));
    },

    exportJson(state) {
      return exportUserState(state || adapter.load());
    },

    importJson(payload) {
      const imported = importUserState(payload, currentNow());
      target.setItem(key, JSON.stringify(imported));
      return imported;
    },

    clear({ includeLegacy = true } = {}) {
      target.removeItem(key);
      if (includeLegacy) target.removeItem(legacyKey);
    },
  };

  return adapter;
}

export const createUserStateStorage = createLocalStorageAdapter;
