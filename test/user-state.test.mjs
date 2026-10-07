import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLICATION_STATUS,
  FINAL_RESULT,
  LEGACY_SAVED_STORAGE_KEY,
  USER_STATE_STORAGE_KEY,
  USER_STATE_VERSION,
  createLocalStorageAdapter,
  createUserState,
  exportUserState,
  getUnreadNotificationCount,
  hydrateSavedSnapshots,
  importUserState,
  markAllNotificationsRead,
  markNotificationRead,
  removeApplication,
  removeSavedSnapshot,
  saveJobSnapshot,
  updateProfile,
  updateRecentFilters,
  upsertApplication,
  upsertNotification,
} from '../src/user-state.js';

const NOW = '2026-07-11T03:00:00.000Z';
const LATER = '2026-07-12T03:00:00.000Z';

const job = {
  id: 'saramin-101',
  dedupeKey: 'acme-health-manager',
  company: '테스트기업',
  title: '서울 보건관리자 채용',
  region: '서울',
  regionCode: 'SEOUL',
  employmentType: '정규직',
  experienceLevel: '경력무관',
  department: '산업보건',
  workPattern: '상근·주간',
  facilityType: '기업·사업장',
  publishedAt: '2026-07-10',
  firstSeenAt: NOW,
  deadlineAt: '2026-07-20T14:59:59.999Z',
  deadline: 'D-9',
  source: '사람인',
  url: 'https://www.saramin.co.kr/job/101',
  roleTags: ['보건관리자'],
  alternateSources: [{ source: '고용24', url: 'https://www.work24.go.kr/job/101' }],
  lastSeenAt: NOW,
};

class MemoryStorage {
  #items = new Map();

  getItem(key) {
    return this.#items.has(key) ? this.#items.get(key) : null;
  }

  setItem(key, value) {
    this.#items.set(key, String(value));
  }

  removeItem(key) {
    this.#items.delete(key);
  }
}

test('creates the complete v2 user-state shape', () => {
  const state = createUserState(NOW);
  assert.equal(state.version, USER_STATE_VERSION);
  assert.deepEqual(Object.keys(state), [
    'version',
    'profile',
    'savedSnapshots',
    'applications',
    'notifications',
    'recentFilters',
    'meta',
  ]);
  assert.deepEqual(state.profile.roleTags, []);
  assert.deepEqual(state.meta.pendingLegacySavedIds, []);
  assert.equal(state.meta.createdAt, NOW);
});

test('updates onboarding profile and recent filters without mutating the original', () => {
  const original = createUserState(NOW);
  const profiled = updateProfile(original, {
    onboardingCompletedAt: NOW,
    roleTags: ['보건관리자', '보건관리자'],
    regionCodes: ['SEOUL'],
    preferredKeywords: ['주간'],
    excludedKeywords: ['3교대'],
  }, LATER);
  const filtered = updateRecentFilters(profiled, {
    regionCode: 'SEOUL',
    employmentType: '정규직',
  }, LATER);

  assert.deepEqual(original.profile.roleTags, []);
  assert.deepEqual(profiled.profile.roleTags, ['보건관리자']);
  assert.deepEqual(profiled.profile.excludedKeywords, ['3교대']);
  assert.deepEqual(filtered.recentFilters, { regionCode: 'SEOUL', employmentType: '정규직' });
  assert.equal(filtered.meta.updatedAt, LATER);
});

test('migrates legacy nurse-saved ids and keeps unresolved ids pending', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_SAVED_STORAGE_KEY, JSON.stringify(['saramin-101', 'missing-9', 'saramin-101']));
  const adapter = createLocalStorageAdapter(storage, { now: () => NOW });
  const state = adapter.load([job]);

  assert.equal(state.savedSnapshots[job.dedupeKey].title, job.title);
  assert.equal(state.savedSnapshots[job.dedupeKey].url, job.url);
  assert.deepEqual(state.meta.pendingLegacySavedIds, ['missing-9']);
  assert.equal(state.meta.migratedFromV1At, NOW);
  assert.equal(storage.getItem(LEGACY_SAVED_STORAGE_KEY), null);
  assert.ok(storage.getItem(USER_STATE_STORAGE_KEY));
});

test('can hydrate v1 ids after jobs load and preserves snapshots when a job disappears', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_SAVED_STORAGE_KEY, JSON.stringify(['saramin-101']));
  const adapter = createLocalStorageAdapter(storage, { now: () => NOW });
  const pending = adapter.load();
  assert.deepEqual(pending.meta.pendingLegacySavedIds, ['saramin-101']);

  const hydrated = adapter.hydrate(pending, [job]);
  assert.deepEqual(hydrated.meta.pendingLegacySavedIds, []);
  assert.equal(hydrated.savedSnapshots[job.dedupeKey].company, '테스트기업');

  const afterEmptyFeed = hydrateSavedSnapshots(hydrated, [], LATER);
  assert.equal(afterEmptyFeed.savedSnapshots[job.dedupeKey].title, job.title);
  assert.equal(afterEmptyFeed.savedSnapshots[job.dedupeKey].savedAt, NOW);
});

test('refreshes and rekeys a saved snapshot without losing its saved time', () => {
  const first = saveJobSnapshot(createUserState(NOW), { ...job, dedupeKey: '' }, NOW);
  assert.ok(first.savedSnapshots[job.id]);

  const rekeyed = saveJobSnapshot(first, { ...job, title: '서울 보건관리자 공개채용' }, LATER);
  assert.equal(rekeyed.savedSnapshots[job.id], undefined);
  assert.equal(rekeyed.savedSnapshots[job.dedupeKey].title, '서울 보건관리자 공개채용');
  assert.equal(rekeyed.savedSnapshots[job.dedupeKey].savedAt, NOW);
  assert.equal(rekeyed.savedSnapshots[job.dedupeKey].snapshotUpdatedAt, LATER);
  assert.equal(rekeyed.savedSnapshots[job.dedupeKey].department, '산업보건');
  assert.equal(rekeyed.savedSnapshots[job.dedupeKey].workPattern, '상근·주간');
  assert.equal(rekeyed.savedSnapshots[job.dedupeKey].facilityType, '기업·사업장');
  assert.equal(rekeyed.savedSnapshots[job.dedupeKey].publishedAt, '2026-07-10');
});

test('round-trips raw experience domain and safe evidence in saved snapshots', () => {
  const experienceJob = {
    ...job,
    experienceLevel: '경력',
    experience: '경력 2년 이상',
    experienceDomain: 'health-manager',
    experienceEvidence: {
      field: 'qualifications',
      excerpt: '보건관리자 경력 2년 이상',
      strength: 'explicit',
      ignored: '저장하지 않음',
      callback() {},
    },
  };
  const saved = saveJobSnapshot(createUserState(NOW), experienceJob, NOW);
  const snapshot = saved.savedSnapshots[job.dedupeKey];

  assert.equal(snapshot.experienceLevel, '경력');
  assert.equal(snapshot.experience, '경력 2년 이상');
  assert.equal(snapshot.experienceDomain, 'health-manager');
  assert.deepEqual(snapshot.experienceEvidence, {
    field: 'qualifications',
    excerpt: '보건관리자 경력 2년 이상',
    strength: 'explicit',
  });

  const restored = importUserState(exportUserState(saved), LATER);
  const restoredSnapshot = restored.savedSnapshots[job.dedupeKey];
  assert.equal(restoredSnapshot.experienceLevel, '경력');
  assert.equal(restoredSnapshot.experience, '경력 2년 이상');
  assert.equal(restoredSnapshot.experienceDomain, 'health-manager');
  assert.deepEqual(restoredSnapshot.experienceEvidence, snapshot.experienceEvidence);

  const afterEmptyFeed = hydrateSavedSnapshots(restored, [], LATER);
  assert.deepEqual(afterEmptyFeed.savedSnapshots[job.dedupeKey].experienceEvidence, snapshot.experienceEvidence);
});

test('상세에서 보완한 핵심 채용정보를 저장 공고에도 보존한다', () => {
  const checkedAt = '2026-07-11T04:00:00.000Z';
  const enrichedJob = {
    ...job,
    education: '전문대졸 이상',
    salary: '연봉 3,800만원 이상',
    location: '서울 송파구',
    workHours: '월~금 09:00~18:00',
    workConditions: '주 5일 근무',
    duties: '임직원 건강상담',
    qualifications: '간호사 면허 필수',
    preferredQualifications: '산업보건 경력 우대',
    recruitmentProcess: '서류전형 → 면접',
    applicationMethod: '채용 홈페이지 지원',
    otherInformation: '증빙서류 제출',
    deadlineText: '2026년 7월 20일까지',
    headcount: '1명',
    subway: '잠실역 도보 5분',
    welfare: ['중식 제공', '건강검진 지원'],
    description: '상세 공고 본문',
    descriptionKind: 'jobPosting',
    detailBodyAvailable: true,
    detailCheckedAt: checkedAt,
    detailEnrichmentCheckedAt: checkedAt,
    employmentCheckedAt: checkedAt,
    workPatternCheckedAt: checkedAt,
  };
  const saved = saveJobSnapshot(createUserState(NOW), enrichedJob, NOW);
  const restored = importUserState(exportUserState(saved), LATER);
  const snapshot = restored.savedSnapshots[job.dedupeKey];

  for (const field of [
    'education', 'salary', 'location', 'workHours', 'workConditions', 'duties', 'qualifications',
    'preferredQualifications', 'recruitmentProcess', 'applicationMethod', 'otherInformation',
    'deadlineText', 'headcount', 'subway', 'description', 'descriptionKind',
  ]) assert.equal(snapshot[field], enrichedJob[field], `${field} 정보가 저장되어야 합니다.`);
  assert.deepEqual(snapshot.welfare, enrichedJob.welfare);
  assert.equal(snapshot.detailBodyAvailable, true);
  assert.equal(snapshot.detailEnrichmentCheckedAt, checkedAt);
  assert.equal(snapshot.employmentCheckedAt, checkedAt);
  assert.equal(snapshot.workPatternCheckedAt, checkedAt);
});

test('records application stages, notes, next actions, and dates', () => {
  let state = upsertApplication(createUserState(NOW), job, {
    status: APPLICATION_STATUS.PREPARING,
    note: '자기소개서 문장 다듬기',
    nextAction: '경력증명서 발급',
    dueAt: '2026-07-14',
  }, NOW);
  state = upsertApplication(state, job.id, {
    status: APPLICATION_STATUS.APPLIED,
    appliedAt: '2026-07-15',
  }, LATER);

  const application = state.applications[job.dedupeKey];
  assert.equal(application.note, '자기소개서 문장 다듬기');
  assert.equal(application.nextAction, '경력증명서 발급');
  assert.equal(application.appliedAt, '2026-07-15');
  assert.equal(application.status, APPLICATION_STATUS.APPLIED);

  assert.throws(() => upsertApplication(state, job.id, {
    status: APPLICATION_STATUS.APPLIED,
    finalResult: FINAL_RESULT.ACCEPTED,
  }, LATER), /final 상태/);

  state = upsertApplication(state, job.id, {
    status: APPLICATION_STATUS.FINAL,
    finalResult: FINAL_RESULT.ACCEPTED,
  }, LATER);
  assert.equal(state.applications[job.dedupeKey].finalResult, FINAL_RESULT.ACCEPTED);
  assert.throws(() => removeSavedSnapshot(state, job.id, LATER), /지원 관리 중/);
});

test('keeps legacy UI aliases when normalizing existing v2 application data', () => {
  const raw = createUserState(NOW);
  raw.savedSnapshots[job.dedupeKey] = { ...job, jobKey: job.dedupeKey, savedAt: NOW, snapshotUpdatedAt: NOW };
  raw.applications[job.dedupeKey] = { jobKey: job.dedupeKey, status: 'result', finalResult: 'expired', note: '기존 기록', createdAt: NOW, updatedAt: NOW };
  const restored = importUserState(JSON.stringify(raw), LATER);
  assert.equal(restored.applications[job.dedupeKey].status, APPLICATION_STATUS.FINAL);
  assert.equal(restored.applications[job.dedupeKey].finalResult, FINAL_RESULT.CLOSED);
  assert.equal(restored.applications[job.dedupeKey].note, '기존 기록');
});

test('deduplicates notifications and records read state', () => {
  let state = upsertNotification(createUserState(NOW), {
    id: 'deadline:101:d3',
    type: 'deadline-d3',
    jobKey: job.dedupeKey,
    title: '마감 3일 전',
    message: job.title,
    scheduledAt: '2026-07-17T00:00:00.000Z',
  }, NOW);
  state = upsertNotification(state, {
    id: 'deadline:101:d3',
    type: 'deadline-d3',
    jobKey: job.dedupeKey,
    title: '마감 임박',
  }, LATER);

  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].title, '마감 임박');
  assert.equal(state.notifications[0].createdAt, NOW);
  assert.equal(getUnreadNotificationCount(state), 1);

  state = markNotificationRead(state, 'deadline:101:d3', LATER);
  assert.equal(state.notifications[0].readAt, LATER);
  assert.equal(getUnreadNotificationCount(state), 0);

  state = upsertNotification(state, { id: 'bridge', type: 'bridge-disconnected', title: '너스케입 연결 확인' }, LATER);
  state = markAllNotificationsRead(state, LATER);
  assert.equal(getUnreadNotificationCount(state), 0);
});

test('replaces an application schedule notification and removes it with tracking', () => {
  let state = upsertApplication(createUserState(NOW), job, { status: APPLICATION_STATUS.PREPARING, dueAt: '2026-07-14' }, NOW);
  state = upsertNotification(state, { id: 'application:first', type: 'schedule', jobKey: job.dedupeKey, scheduledAt: '2026-07-14', title: '첫 일정' }, NOW);
  state = upsertNotification(state, { id: 'application:second', type: 'schedule', jobKey: job.dedupeKey, scheduledAt: '2026-07-15', title: '바뀐 일정' }, LATER);
  assert.equal(state.notifications.filter((item) => item.type === 'schedule' && item.jobKey === job.dedupeKey).length, 1);
  state = removeApplication(state, job, LATER);
  assert.equal(state.applications[job.dedupeKey], undefined);
  assert.equal(state.notifications.some((item) => item.type === 'schedule' && item.jobKey === job.dedupeKey), false);
  assert.ok(state.savedSnapshots[job.dedupeKey]);
});

test('exports and imports validated JSON backups', () => {
  const state = upsertApplication(createUserState(NOW), job, {
    status: APPLICATION_STATUS.INTERVIEW,
    interviewAt: '2026-07-21T01:00:00.000Z',
  }, NOW);
  const json = exportUserState(state);
  const restored = importUserState(json, LATER);

  assert.equal(restored.version, USER_STATE_VERSION);
  assert.equal(restored.savedSnapshots[job.dedupeKey].title, job.title);
  assert.equal(restored.applications[job.dedupeKey].interviewAt, '2026-07-21T01:00:00.000Z');
  assert.equal(restored.meta.importedAt, LATER);
  assert.throws(() => importUserState('{broken', LATER), /JSON/);
  assert.throws(() => importUserState({ version: 9 }, LATER), /지원하지 않는/);
  assert.throws(() => importUserState({ version: 2, notifications: {} }, LATER), /notifications/);
});

test('adapter import/export round-trips through localStorage', () => {
  const storage = new MemoryStorage();
  const adapter = createLocalStorageAdapter(storage, { now: () => LATER });
  const state = saveJobSnapshot(createUserState(NOW), job, NOW);
  adapter.save(state);
  const backup = adapter.exportJson();
  adapter.clear();
  assert.equal(storage.getItem(USER_STATE_STORAGE_KEY), null);

  const restored = adapter.importJson(backup);
  assert.equal(restored.savedSnapshots[job.dedupeKey].company, job.company);
  assert.ok(storage.getItem(USER_STATE_STORAGE_KEY));
});
