import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DETAIL_ENRICHMENT_CACHE_VERSION,
  DETAIL_ENRICHMENT_MAX_ENTRIES,
  DETAIL_ENRICHMENT_STORAGE_KEY,
  DETAIL_ENRICHMENT_TTL_MS,
  applyDetailEnrichment,
  readDetailEnrichmentCache,
  rememberDetailEnrichment,
  writeDetailEnrichmentCache,
} from '../src/detail-enrichments.js';

const NOW = new Date('2026-07-13T03:00:00.000Z');
const EMPTY_CACHE = { version: DETAIL_ENRICHMENT_CACHE_VERSION, entries: [] };
const job = {
  id: 'saramin-101',
  sourceIds: ['saramin-101', 'work24-202'],
  url: 'https://www.saramin.co.kr/job/101',
  alternateSources: [{ source: '고용24', url: 'https://www.work24.go.kr/job/202' }],
  title: '보건관리자 채용',
  experience: '경력 2년 이상',
};
const healthDetail = {
  detailVerified: true,
  experience: '보건관리자 경력 2년 이상',
  experienceDomain: 'health-manager',
  experienceEvidence: {
    field: 'qualifications',
    excerpt: '보건관리자 경력 2년 이상 우대',
    strength: 'explicit-detail',
  },
};

class MemoryStorage {
  items = new Map();

  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }

  setItem(key, value) {
    this.items.set(key, String(value));
  }
}

test('상세 확인 결과를 별도 v1 저장소에 안전하게 저장하고 다시 읽는다', () => {
  const storage = new MemoryStorage();
  const remembered = rememberDetailEnrichment(EMPTY_CACHE, job, healthDetail, NOW);
  const written = writeDetailEnrichmentCache(storage, remembered, NOW);
  const restored = readDetailEnrichmentCache(storage, NOW);

  assert.equal(written.entries.length, 1);
  assert.equal(restored.version, 1);
  assert.equal(restored.entries[0].checkedAt, NOW.toISOString());
  assert.equal(restored.entries[0].experienceDomain, 'health-manager');
  assert.deepEqual(restored.entries[0].ids, ['saramin-101', 'work24-202']);
  assert.ok(storage.getItem(DETAIL_ENRICHMENT_STORAGE_KEY));
});

test('exact id, sourceIds 또는 exact URL로만 상세 정보를 적용한다', () => {
  const cache = rememberDetailEnrichment(EMPTY_CACHE, job, healthDetail, NOW);

  const byId = applyDetailEnrichment({ ...job, sourceIds: [], url: 'https://different.example/job' }, cache, NOW);
  assert.equal(byId.experienceDomain, 'health-manager');

  const bySourceId = applyDetailEnrichment({ id: 'merged-primary', sourceIds: ['work24-202'], url: 'https://different.example/job' }, cache, NOW);
  assert.equal(bySourceId.experienceDomain, 'health-manager');

  const byUrl = applyDetailEnrichment({ id: 'different-id', url: job.url, experience: '경력 2년' }, cache, NOW);
  assert.equal(byUrl.experienceDomain, 'health-manager');

  const unmatched = { id: 'different-id', sourceIds: ['other-source'], url: 'https://example.com/another-job' };
  assert.strictEqual(applyDetailEnrichment(unmatched, cache, NOW), unmatched);
});

test('상세 확인 시각은 분야를 못 찾아도 보존하고, 구체 domain과 근거가 함께 있을 때만 overlay한다', () => {
  const checkedOnly = rememberDetailEnrichment(EMPTY_CACHE, job, {
    detailVerified: true,
    experience: '경력 2년 이상',
    experienceDomain: 'unspecified',
    experienceEvidence: null,
  }, NOW);
  const checkedJob = applyDetailEnrichment(job, checkedOnly, NOW);
  assert.equal(checkedJob.detailCheckedAt, NOW.toISOString());
  assert.equal(checkedJob.workPatternCheckedAt, NOW.toISOString());
  assert.equal(checkedJob.employmentCheckedAt, NOW.toISOString());
  assert.equal(checkedJob.detailEnrichmentCheckedAt, NOW.toISOString());
  assert.equal(checkedJob.experienceDomain, undefined);

  const missingEvidence = rememberDetailEnrichment(EMPTY_CACHE, job, {
    detailVerified: true,
    experienceDomain: 'clinical',
  }, NOW);
  assert.equal(applyDetailEnrichment(job, missingEvidence, NOW).experienceDomain, undefined);

  const invalidEvidence = rememberDetailEnrichment(EMPTY_CACHE, job, {
    detailVerified: true,
    experienceDomain: 'clinical',
    experienceEvidence: { field: 'qualifications', excerpt: '임상 경력', strength: 'untrusted' },
  }, NOW);
  assert.equal(applyDetailEnrichment(job, invalidEvidence, NOW).experienceDomain, undefined);
});

test('상세 원문의 근무시간을 목록 카드용 근무형태로 저장하고 기존 명시값은 덮지 않는다', () => {
  const detail = {
    detailVerified: true,
    workHours: '월~금 09:00~18:00',
    workConditions: '주 5일 근무 · 야간근무 없음',
    description: '[근무시간] 평일 09:00~18:00',
  };
  const cache = rememberDetailEnrichment(EMPTY_CACHE, job, detail, NOW);
  assert.equal(cache.entries[0].workPattern, '상근·주간');
  assert.equal(cache.entries[0].workHours, detail.workHours);
  assert.equal(cache.entries[0].workPatternCheckedAt, NOW.toISOString());

  const enriched = applyDetailEnrichment(job, cache, NOW);
  assert.equal(enriched.workPattern, '상근·주간');
  assert.equal(enriched.workHours, detail.workHours);
  assert.equal(enriched.workConditions, detail.workConditions);

  const explicitShift = applyDetailEnrichment({ ...job, workPattern: '3교대' }, cache, NOW);
  assert.equal(explicitShift.workPattern, '3교대');
});

test('상세 원문의 핵심 채용정보를 함께 저장하고 목록의 미표기 값만 보완한다', () => {
  const detail = {
    detailVerified: true,
    detailBodyAvailable: true,
    employment: '정규직 · 계약직',
    experience: '경력 3년 이상',
    education: '전문대졸 이상',
    salary: '연봉 3,800만원 이상',
    location: '서울 송파구',
    workHours: '월~금 09:00~18:00',
    workConditions: '주 5일 근무 · 야간근무 없음',
    duties: '건강상담 및 건강검진 운영',
    qualifications: '간호사 면허 필수',
    preferredQualifications: '산업보건 경력 우대',
    recruitmentProcess: '서류전형 → 면접',
    applicationMethod: '채용 홈페이지 지원',
    otherInformation: '입사 전 증빙서류 제출',
    deadlineText: '2026년 9월 11일까지',
    headcount: '2명',
    subway: '잠실역 도보 5분',
    welfare: ['중식 제공', '건강검진 지원'],
    description: '임직원 건강관리와 사업장 보건업무를 담당합니다.',
    descriptionKind: 'jobPosting',
  };
  const cache = rememberDetailEnrichment(EMPTY_CACHE, job, detail, NOW);
  const entry = cache.entries[0];
  assert.equal(entry.employment, detail.employment);
  assert.equal(entry.salary, detail.salary);
  assert.equal(entry.department, '산업보건');
  assert.equal(entry.facilityType, '기업·사업장');
  assert.deepEqual(entry.welfare, detail.welfare);
  assert.equal(entry.employmentCheckedAt, NOW.toISOString());
  assert.equal(entry.detailEnrichmentCheckedAt, NOW.toISOString());

  const enriched = applyDetailEnrichment({
    ...job,
    experience: null,
    employmentType: '고용형태 미표기',
    employment: null,
    education: '학력 미표기',
    salary: null,
  }, cache, NOW);
  assert.equal(enriched.employmentType, detail.employment);
  assert.equal(enriched.employment, detail.employment);
  assert.equal(enriched.experience, detail.experience);
  assert.equal(enriched.education, detail.education);
  assert.equal(enriched.salary, detail.salary);
  assert.equal(enriched.location, detail.location);
  assert.equal(enriched.duties, detail.duties);
  assert.equal(enriched.qualifications, detail.qualifications);
  assert.deepEqual(enriched.welfare, detail.welfare);
  assert.equal(enriched.descriptionKind, 'jobPosting');
  assert.equal(enriched.detailBodyAvailable, true);

  const explicit = applyDetailEnrichment({
    ...job,
    employmentType: '정규직',
    education: '대졸 이상',
    salary: '연봉 4,500만원',
  }, cache, NOW);
  assert.equal(explicit.employmentType, '정규직');
  assert.equal(explicit.education, '대졸 이상');
  assert.equal(explicit.salary, '연봉 4,500만원');
});

test('새로 확인한 상세에서 사라진 예전 필드는 cache에 남기지 않는다', () => {
  const stale = rememberDetailEnrichment(EMPTY_CACHE, job, {
    detailVerified: true,
    headcount: '0명',
    workConditions: '모집인원: 0명',
    recruitmentProcess: '· 복리후생\n마감일 및 지원방법',
  }, NOW);
  const refreshedAt = new Date(NOW.getTime() + 1_000);
  const refreshed = rememberDetailEnrichment(stale, job, {
    detailVerified: true,
    detailBodyAvailable: true,
    salary: '면접시 협의',
  }, refreshedAt);

  assert.equal(refreshed.entries[0].headcount, undefined);
  assert.equal(refreshed.entries[0].workConditions, undefined);
  assert.equal(refreshed.entries[0].recruitmentProcess, undefined);
  assert.equal(refreshed.entries[0].salary, '면접시 협의');
  assert.deepEqual(refreshed.entries[0].ids, ['saramin-101', 'work24-202']);
});

test('원문 확인에 실패한 feed fallback 응답은 상세 확인 cache로 저장하지 않는다', () => {
  const fallback = rememberDetailEnrichment(EMPTY_CACHE, job, {
    detailVerified: false,
    detailOrigin: 'feed-fallback',
    experience: '경력 2년 이상',
    experienceDomain: 'health-manager',
    experienceEvidence: healthDetail.experienceEvidence,
  }, NOW);
  assert.deepEqual(fallback, EMPTY_CACHE);
  assert.strictEqual(applyDetailEnrichment(job, fallback, NOW), job);
});

test('기존 feed의 더 강하거나 충돌하는 구체 분야를 상세 cache가 덮지 않는다', () => {
  const cache = rememberDetailEnrichment(EMPTY_CACHE, job, healthDetail, NOW);
  const conflicting = applyDetailEnrichment({
    ...job,
    experienceDomain: 'clinical',
    experienceEvidence: { field: 'qualifications', excerpt: '임상 경력 3년', strength: 'title-context' },
  }, cache, NOW);
  assert.equal(conflicting.experienceDomain, 'clinical');
  assert.equal(conflicting.experienceEvidence.excerpt, '임상 경력 3년');

  const stronger = applyDetailEnrichment({
    ...job,
    experienceDomain: 'health-manager',
    experienceEvidence: { field: 'qualifications', excerpt: '산업보건 경력 3년', strength: 'explicit-detail' },
  }, rememberDetailEnrichment(EMPTY_CACHE, job, {
    ...healthDetail,
    experienceEvidence: { ...healthDetail.experienceEvidence, strength: 'title-context' },
  }, NOW), NOW);
  assert.equal(stronger.experienceEvidence.excerpt, '산업보건 경력 3년');

  const upgraded = applyDetailEnrichment({
    ...job,
    experienceDomain: 'nursing-general',
    experienceEvidence: { field: 'experience', excerpt: '간호 경력 2년', strength: 'explicit-detail' },
  }, cache, NOW);
  assert.equal(upgraded.experienceDomain, 'health-manager');
});

test('7일이 지난 상세 정보는 읽기와 적용에서 제외한다', () => {
  const cache = rememberDetailEnrichment(EMPTY_CACHE, job, healthDetail, NOW);
  const withinTtl = new Date(NOW.getTime() + DETAIL_ENRICHMENT_TTL_MS - 1);
  const expiredAt = new Date(NOW.getTime() + DETAIL_ENRICHMENT_TTL_MS + 1);
  assert.equal(applyDetailEnrichment(job, cache, withinTtl).experienceDomain, 'health-manager');
  assert.strictEqual(applyDetailEnrichment(job, cache, expiredAt), job);

  const storage = new MemoryStorage();
  storage.setItem(DETAIL_ENRICHMENT_STORAGE_KEY, JSON.stringify(cache));
  assert.equal(readDetailEnrichmentCache(storage, expiredAt).entries.length, 0);
});

test('cache는 최신 500건만 보존한다', () => {
  const storage = new MemoryStorage();
  const entries = Array.from({ length: DETAIL_ENRICHMENT_MAX_ENTRIES + 1 }, (_, index) => ({
    ids: [`job-${index}`],
    urls: [`https://example.com/jobs/${index}`],
    checkedAt: new Date(NOW.getTime() + index).toISOString(),
    experienceDomain: healthDetail.experienceDomain,
    experienceEvidence: healthDetail.experienceEvidence,
  }));
  const cache = writeDetailEnrichmentCache(storage, { version: 1, entries }, new Date(NOW.getTime() + entries.length));
  assert.equal(cache.entries.length, DETAIL_ENRICHMENT_MAX_ENTRIES);
  assert.equal(cache.entries.some((entry) => entry.ids.includes('job-0')), false);
  assert.equal(cache.entries.some((entry) => entry.ids.includes(`job-${DETAIL_ENRICHMENT_MAX_ENTRIES}`)), true);
});

test('손상·과대·허용되지 않은 cache 입력은 예외 없이 무시한다', () => {
  const storage = new MemoryStorage();
  storage.setItem(DETAIL_ENRICHMENT_STORAGE_KEY, '{not-json');
  assert.deepEqual(readDetailEnrichmentCache(storage, NOW), EMPTY_CACHE);

  storage.setItem(DETAIL_ENRICHMENT_STORAGE_KEY, JSON.stringify({ version: 99, entries: [] }));
  assert.deepEqual(readDetailEnrichmentCache(storage, NOW), EMPTY_CACHE);

  storage.setItem(DETAIL_ENRICHMENT_STORAGE_KEY, JSON.stringify({
    version: 1,
    entries: [{
      ids: ['x'.repeat(241)],
      urls: ['javascript:alert(1)'],
      checkedAt: NOW.toISOString(),
      experienceDomain: 'administrator',
      experienceEvidence: { field: 'qualifications', excerpt: 'x', strength: 'explicit-detail' },
    }],
  }));
  assert.deepEqual(readDetailEnrichmentCache(storage, NOW), EMPTY_CACHE);

  const throwingStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(readDetailEnrichmentCache(throwingStorage, NOW), EMPTY_CACHE);
  assert.doesNotThrow(() => writeDetailEnrichmentCache(throwingStorage, EMPTY_CACHE, NOW));
});
