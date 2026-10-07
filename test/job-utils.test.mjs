import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_STATUS, FINAL_RESULT } from '../src/user-state.js';
import { APPLICATION_STAGES, LISTING_AGE_NEW_DAYS, LISTING_AGE_STALE_DAYS, RESULT_LABELS, applicationSchedule, cleanUnknown, deadlineInfo, departmentFor, experienceDisplay, jobMatchesFilters, listingAgeDaysFor, listingDateInfoFor, listingFreshnessFor, nextApplicationStatus, recommendationFor, sortJobs } from '../src/job-utils.js';
import { APPLICATION_TIER_RULE_VERSION, applicationTierFor, applicationTierGroupFor, applicationTierProfileKey, careRoleFor, isApplicationTopTierExcludedJob, nonShiftAssessmentFor, workPatternFor } from '../src/job-utils.js';
import { applyDetailEnrichment, rememberDetailEnrichment } from '../src/detail-enrichments.js';
import { jobPage } from '../lib/job-page.mjs';

const completeJob = {
  id: 'job-1',
  company: '한빛전자',
  title: '서울 사업장 보건관리자 간호사 채용',
  region: '서울',
  employmentType: '정규직',
  experienceLevel: '신입',
  workPattern: '상근·주간',
  roleTags: ['보건관리자', '간호사'],
};

test('transparent recommendation explains matching role, region, employment, and work preference', () => {
  const result = recommendationFor(completeJob, {
    roleTags: ['health-manager'],
    regionCodes: ['서울'],
    employmentTypes: ['정규직'],
    experienceLevels: ['신입·무관'],
    workPatterns: ['사업장', '3교대 제외'],
  });
  assert.equal(result.level, 'strong');
  assert.ok(result.reasons.includes('보건관리자'));
  assert.ok(result.reasons.includes('서울'));
  assert.ok(result.reasons.includes('3교대 제외'));
});

test('does not claim an avoided shift or keyword when the posting does not state it', () => {
  const result = recommendationFor({ ...completeJob, workPattern: null }, {
    roleTags: ['health-manager'],
    regionCodes: ['서울'],
    employmentTypes: ['정규직'],
    workPatterns: ['3교대 제외'],
    excludedKeywords: ['야간', '주차 당직'],
  });
  assert.ok(!result.reasons.includes('3교대 제외'));
  assert.ok(!result.reasons.includes('야간 제외'));
  assert.ok(!result.reasons.includes('주차 당직 제외'));
  assert.ok(result.cautions.includes('근무형태 확인 필요'));
  assert.ok(result.cautions.includes('제외 조건 여부 확인 필요'));
});

test('uses an explicitly stated day schedule as evidence that 3-shift work is excluded', () => {
  const result = recommendationFor(completeJob, {
    roleTags: ['health-manager'],
    workPatterns: ['3교대 제외'],
    excludedKeywords: ['야간'],
  });
  assert.ok(result.reasons.includes('3교대 제외'));
  assert.ok(result.reasons.includes('야간 제외'));
  assert.ok(!result.cautions.includes('근무형태 확인 필요'));
});

test('rejects a stated 3-shift schedule and understands an explicit no-shift statement', () => {
  const blocked = recommendationFor({ ...completeJob, workPattern: '3교대' }, {
    roleTags: ['health-manager'],
    workPatterns: ['3교대 제외'],
  });
  assert.equal(blocked.level, 'review');
  assert.ok(blocked.excluded.includes('3교대'));
  assert.ok(!blocked.reasons.includes('3교대 제외'));

  const explicitlyAvoided = recommendationFor({
    ...completeJob,
    title: '보건관리자 간호사 채용 (3교대 근무 없음)',
    workPattern: null,
  }, {
    roleTags: ['health-manager'],
    workPatterns: ['3교대 제외'],
  });
  assert.ok(explicitlyAvoided.reasons.includes('3교대 제외'));
  assert.ok(!explicitlyAvoided.excluded.includes('3교대'));
});

test('keeps clearly non-clinical nursing roles out of clinical recommendations', () => {
  for (const title of [
    '사업장 보건관리자 간호사 채용',
    '산업간호사 채용',
    '보험심사 간호사 채용',
  ]) {
    const result = recommendationFor({ ...completeJob, title, roleTags: ['간호사'] }, {
      roleTags: ['clinical-nurse'],
    });
    assert.equal(result.level, 'review');
    assert.ok(!result.reasons.includes('임상 간호사'));
    assert.ok(result.cautions.includes('선택한 임상 역할과 다름'));
  }

  const taggedHealthRole = recommendationFor({ ...completeJob, title: '간호사 채용', roleTags: ['health-manager', '간호사'] }, {
    roleTags: ['clinical-nurse'],
  });
  assert.equal(taggedHealthRole.level, 'review');

  const clinical = recommendationFor({ ...completeJob, title: '병동 간호사 채용', roleTags: ['임상간호사'] }, {
    roleTags: ['clinical-nurse'],
  });
  assert.notEqual(clinical.level, 'review');
  assert.ok(clinical.reasons.includes('임상 간호사'));
});

test('explicit region and employment mismatches require review and explain why', () => {
  const result = recommendationFor({ ...completeJob, region: '부산', employmentType: '계약직' }, {
    roleTags: ['health-manager'],
    regionCodes: ['서울'],
    employmentTypes: ['정규직'],
  });
  assert.equal(result.level, 'review');
  assert.ok(result.cautions.includes('지역 조건과 다름'));
  assert.ok(result.cautions.includes('고용형태 조건과 다름'));
});

test('missing job fields are presented as review instead of inferred values', () => {
  const result = recommendationFor({ ...completeJob, employmentType: null, experienceLevel: null }, {
    roleTags: ['health-manager'],
    regionCodes: ['서울'],
  });
  assert.equal(result.level, 'review');
});

test('unknown source placeholders are not treated as confirmed detail values', () => {
  for (const value of ['공고 확인', 'no requirements', 'Not specified', 'unknown', 'N/A', '-', '|']) assert.equal(cleanUnknown(value), '원문 확인');
  assert.equal(cleanUnknown('경력무관'), '경력무관');
});

test('does not mistake a website domain suffix for operating-room work', () => {
  assert.equal(departmentFor({ title: '외래간호사 채용', description: '홈페이지 http://hosp.ajoumc.or.kr' }), '외래');
  assert.equal(departmentFor({ title: '간호사 채용', description: 'OR 수술 간호 업무' }), '수술실');
  assert.equal(departmentFor({ title: '정규직 간호직(IRB지원팀) 채용', duties: '연구윤리 심의 지원' }), '연구·CRC');
});

test('new-or-open experience filter accepts normalized new and no-experience values', () => {
  assert.equal(jobMatchesFilters(completeJob, { experience: '신입·무관' }), true);
  assert.equal(jobMatchesFilters({ ...completeJob, experienceLevel: '경력무관' }, { experience: '신입·무관' }), true);
  assert.equal(jobMatchesFilters({ ...completeJob, experienceLevel: '경력' }, { experience: '신입·무관' }), false);
});

test('text search finds primary and alternate collection sources', () => {
  const mergedJob = {
    ...completeJob,
    source: '직행',
    alternateSources: [{ source: '널스잡', url: 'https://example.com/job' }],
  };
  assert.equal(jobMatchesFilters(mergedJob, { query: '직행' }), true);
  assert.equal(jobMatchesFilters(mergedJob, { query: '널스잡' }), true);
});

test('shows an experience domain only when the posting states it in the same field', () => {
  const generic = experienceDisplay({
    title: '보건관리자 채용',
    experienceLevel: '경력',
    experience: '경력 2년 이상',
  });
  assert.equal(generic.domain, 'unspecified');
  assert.equal(generic.label, '상세에서 경력 분야 확인 필요');

  const checkedGeneric = experienceDisplay({
    title: '보건관리자 채용',
    experienceLevel: '경력',
    experience: '경력 2년 이상',
  }, {}, { detailCheckedAt: '2026-07-13T03:00:00.000Z' });
  assert.equal(checkedGeneric.label, '상세 조회에서도 경력 분야 확인 필요');
  assert.match(checkedGeneric.explanation, /자동 상세 조회에서도/);

  const clinical = experienceDisplay({ title: '병원 간호사 채용', experienceLevel: '경력' }, {
    experience: '경력 3년 이상',
    qualifications: '임상 경력 3년 이상 필수',
  });
  assert.equal(clinical.domain, 'clinical');
  assert.equal(clinical.fieldLabel, '자격요건');

  const healthManager = experienceDisplay({ title: '산업간호사 채용', experienceLevel: '경력' }, {
    qualifications: '산업보건 실무 경력 1년 이상 우대',
  });
  assert.equal(healthManager.domain, 'health-manager');
  assert.match(healthManager.label, /보건관리/);
});

test('deadline labels roll over at KST midnight', () => {
  const job = { deadlineAt: '2027-01-01' };
  assert.equal(deadlineInfo(job, new Date('2026-12-31T14:30:00.000Z')).days, 1);
  assert.equal(deadlineInfo(job, new Date('2026-12-31T15:30:00.000Z')).label, '오늘 마감');
});

test('application UI stages and final labels match the persisted state contract', () => {
  assert.deepEqual(APPLICATION_STAGES.map((stage) => stage.id), Object.values(APPLICATION_STATUS));
  assert.deepEqual(Object.values(FINAL_RESULT).map((result) => RESULT_LABELS[result]), ['합격', '불합격', '지원 철회', '마감']);
  assert.equal(nextApplicationStatus(APPLICATION_STATUS.PREPARING), APPLICATION_STATUS.APPLIED);
  assert.equal(nextApplicationStatus(APPLICATION_STATUS.FINAL), null);
});

test('application schedule prioritizes an interview and exposes overdue work', () => {
  const interview = applicationSchedule({ status: APPLICATION_STATUS.INTERVIEW, dueAt: '2026-07-12T10:00:00+09:00', interviewAt: '2026-07-15T14:00:00+09:00', nextAction: '면접 질문 정리' }, new Date('2026-07-13T00:00:00+09:00'));
  assert.equal(interview.kind, 'interview');
  assert.equal(interview.at, '2026-07-15T14:00:00+09:00');
  const overdue = applicationSchedule({ status: APPLICATION_STATUS.PREPARING, dueAt: '2026-07-11T10:00:00+09:00', nextAction: '지원서 제출' }, new Date('2026-07-12T10:00:00+09:00'));
  assert.equal(overdue.timing, 'overdue');
});

test('listing age prefers the real posting date over the collection date', () => {
  const now = Date.parse('2026-09-15T00:00:00Z');
  assert.equal(listingAgeDaysFor({ publishedAt: '2026-09-05T00:00:00Z', firstSeenAt: '2026-09-14T00:00:00Z' }, now), 10);
  assert.equal(listingAgeDaysFor({ firstSeenAt: '2026-09-10T00:00:00Z' }, now), 5);
  assert.equal(listingAgeDaysFor({}, now), null);
  assert.equal(listingAgeDaysFor({ publishedAt: 'not-a-date', firstSeenAt: '2026-09-13T00:00:00Z' }, now), 2);
});

test('tier recency uses registration dates and falls back to first-seen time when missing', () => {
  assert.equal(listingDateInfoFor({ publishedAt: '2026-09-05T00:00:00Z', firstSeenAt: '2026-09-14T00:00:00Z' }).field, 'publishedAt');
  assert.equal(listingDateInfoFor({ postedAt: '2026-09-04T00:00:00Z' }).field, 'postedAt');
  assert.equal(listingDateInfoFor({ postedAt: '7/11 등록', firstSeenAt: '2026-09-14T00:00:00Z' }), null);

  const dated = {
    id: 'dated', title: '사업장 보건관리자 채용', company: '등록일 있음',
    applicationTierGroup: 'A', applicationTierGroupScore: 40,
    publishedAt: '2026-09-01T00:00:00Z', firstSeenAt: '2026-09-01T00:00:00Z',
  };
  const undated = {
    id: 'undated', title: '사업장 보건관리자 채용', company: '등록일 없음',
    applicationTierGroup: 'A', applicationTierGroupScore: 100,
    firstSeenAt: '2026-09-15T00:00:00Z',
  };
  assert.deepEqual(sortJobs([undated, dated], '워라벨 우선', {}, { tierLatest: true }).map((item) => item.id), ['undated', 'dated']);
  assert.deepEqual(sortJobs([undated, dated], '최신 등록순').map((item) => item.id), ['dated', 'undated']);
});

test('listing freshness buckets match the new/recent/stale display contract', () => {
  const now = Date.parse('2026-09-15T00:00:00Z');
  const at = (days) => ({ publishedAt: new Date(now - days * 86400000).toISOString() });
  assert.equal(listingFreshnessFor(at(LISTING_AGE_NEW_DAYS), now), 'new');
  assert.equal(listingFreshnessFor(at(LISTING_AGE_NEW_DAYS + 1), now), 'recent');
  assert.equal(listingFreshnessFor(at(LISTING_AGE_STALE_DAYS), now), 'recent');
  assert.equal(listingFreshnessFor(at(LISTING_AGE_STALE_DAYS + 1), now), 'stale');
  assert.equal(listingFreshnessFor({}, now), 'unknown');
});

test('work-life sort demotes aged listings inside the same application tier', () => {
  const now = Date.now();
  const job = (id, score, ageDays) => ({
    id, title: '보건관리자 채용', company: id,
    applicationTierGroup: 'A', applicationTierGroupScore: score,
    publishedAt: new Date(now - ageDays * 86400000).toISOString(),
  });
  const sorted = sortJobs([job('old-strong', 50, 20), job('fresh', 47, 0), job('recent', 49, 5)], '워라벨 우선');
  assert.deepEqual(sorted.map((item) => item.id), ['recent', 'fresh', 'old-strong']);
});

test('work-life sort keeps tier order ahead of freshness', () => {
  const now = Date.now();
  const staleS = { id: 'stale-s', title: '보건관리자', company: '가', applicationTierGroup: 'S', applicationTierGroupScore: 60, publishedAt: new Date(now - 40 * 86400000).toISOString() };
  const freshA = { id: 'fresh-a', title: '보건관리자', company: '나', applicationTierGroup: 'A', applicationTierGroupScore: 55, publishedAt: new Date(now).toISOString() };
  assert.equal(sortJobs([freshA, staleS], '워라벨 우선')[0].id, 'stale-s');
});

test('tier recommendation mode keeps tier order and sorts newest first inside each tier', () => {
  const now = Date.parse('2026-09-15T00:00:00.000Z');
  const job = (id, tier, score, ageDays) => ({
    id,
    title: '사업장 보건관리자 채용',
    company: id,
    applicationTierGroup: tier,
    applicationTierGroupScore: score,
    publishedAt: new Date(now - ageDays * 86400000).toISOString(),
  });
  const sorted = sortJobs([
    job('old-a', 'A', 100, 20),
    job('new-a', 'A', 40, 1),
    job('old-s', 'S', 100, 20),
    job('new-s', 'S', 40, 1),
  ], '워라벨 우선', {}, { tierLatest: true });
  assert.deepEqual(sorted.map((item) => item.id), ['new-s', 'old-s', 'new-a', 'old-a']);
});

const snubhPaJob = {
  id: 'snubh-pa',
  title: '간호직(전담) 채용',
  company: '분당서울대학교병원',
  source: '분당서울대병원',
  url: 'https://recruit.snubh.org/jobs/pa',
  officialSourceUrl: 'https://recruit.snubh.org/jobs/pa?signature=fixture',
  region: '경기',
  roleTags: ['간호사'],
  employmentType: '정규직',
  qualifications: '간호사 면허 소지자',
  deadlineAt: '2099-12-31',
};

test('care roles use advertised role evidence and recognize Korean PA synonyms', () => {
  for (const fields of [
    { title: '진료지원 간호사 채용' },
    { title: 'PA간호사 채용' },
    { title: 'pa nurse' },
    { title: 'Physician Assistant 모집' },
    { title: '신경외과 전담 간호사 모집' },
    { title: '간호직(전담) 채용' },
    { department: '진료지원팀' },
    { duties: ['수술환자 진료 지원 업무'] },
    { roleTags: ['전담간호사'] },
    { roleTags: ['간호사', '전담'] },
  ]) assert.equal(careRoleFor({ title: '간호직 채용', ...fields }), 'pa', JSON.stringify(fields));
  for (const fields of [{ title: '외래 간호사' }, { department: '외래' }, { duties: '외래 환자 간호' }, { roleTags: ['outpatient'] }]) {
    assert.equal(careRoleFor(fields), 'outpatient', JSON.stringify(fields));
  }
  for (const fields of [{ title: '산업간호사' }, { duties: '사업장 보건관리 업무' }, { roleTags: ['health-manager'] }, { roleTags: ['occupational-nurse'] }]) {
    assert.equal(careRoleFor(fields), 'health', JSON.stringify(fields));
  }
  assert.equal(careRoleFor(), 'other');
});

test('care roles never infer PA from an employer, generic nursing, experience, or unrelated dedicated work', () => {
  for (const title of [
    '간호직 채용', '간호사 모집', '병동 간호사', '중환자실 간호사',
    '감염관리 전담간호사', '환자안전(QPS)전담 간호사', '보험심사 전담 간호사',
    '교육전담 간호사', '야간전담 간호사', '주간 전담 간호사', '결핵 전담 간호사',
    '행정업무 전담 간호사', '간호조무사 전담 채용', '간호사 채용 및 민원 전담 직원 모집',
    '외래 임상시험 CRC 연구간호사',
  ]) assert.equal(careRoleFor({ ...snubhPaJob, title }), 'other', title);
  assert.equal(careRoleFor({
    title: '간호직 채용', company: 'PA 외래 병원', source: '진료지원센터',
    qualifications: 'PA·외래 경력 우대', requirements: '전담간호사 경력',
    description: '진료지원팀 소개',
  }), 'other');
  assert.equal(careRoleFor({ title: '사업장 보건관리자', qualifications: 'PA 경력 우대' }), 'health');
  assert.equal(careRoleFor({ title: 'Clinical Specialist / 간호사', duties: '외래 의료진 대상 제품 교육' }), 'other');
});

test('careRole filters compose with PA synonym search and existing fields without inferring a day schedule', () => {
  for (const title of ['간호직(전담) 채용', '전담간호사 채용', '진료지원 간호사 채용', 'PA 간호사 채용']) {
    const job = { ...snubhPaJob, title };
    assert.equal(jobMatchesFilters(job, { careRole: 'pa', query: ' PA ' }), true, title);
    assert.equal(jobMatchesFilters(job, { careRole: 'pa', query: '분당 PA', region: '경기', employment: '정규직' }), true, title);
    assert.equal(jobMatchesFilters(job, { query: '부산 PA' }), false, title);
    assert.equal(jobMatchesFilters(job, { careRole: 'outpatient' }), false, title);
    assert.equal(workPatternFor(job), '원문 확인', title);
    assert.notEqual(nonShiftAssessmentFor(job).status, 'confirmed', title);
  }
  const generic = { ...snubhPaJob, title: '간호직 채용' };
  assert.equal(jobMatchesFilters(generic, { careRole: 'all' }), true);
  assert.equal(jobMatchesFilters(generic, { careRole: 'pa' }), false);
  assert.equal(jobMatchesFilters({ ...generic, title: '감염관리 전담간호사' }, { query: 'PA' }), false);
  assert.equal(jobMatchesFilters({ ...generic, company: 'PA Hospital' }, { query: 'PA' }), false);
  assert.equal(jobMatchesFilters({ ...generic, roleTags: ['진료지원'] }, { query: 'PA' }), true);
  assert.equal(jobMatchesFilters({ ...generic, duties: '채혈 및 진료지원' }, { query: 'PA' }), true);
  assert.equal(jobMatchesFilters({ ...generic, qualifications: 'ACLS 자격 우대' }, { query: 'ACLS' }), true);
  assert.equal(jobMatchesFilters({ ...generic, roleTags: ['교육전담'] }, { query: '교육전담' }), true);
  assert.equal(jobMatchesFilters({ title: '외래 간호사' }, { careRole: 'outpatient' }), true);
  assert.equal(jobMatchesFilters(completeJob, { careRole: 'health' }), true);
});

test('verified role details participate in discovery while unverified detail does not', () => {
  const generic = { ...snubhPaJob, title: '간호직 채용' };
  for (const [duties, expected] of [['진료지원 전담 간호 업무', 'pa'], ['외래 환자 간호', 'outpatient']]) {
    const detail = { duties, qualifications: '간호사 면허 소지자', detailVerified: true };
    const enriched = applyDetailEnrichment(generic, rememberDetailEnrichment(null, generic, detail));
    assert.equal(careRoleFor(enriched), expected);
    assert.equal(jobMatchesFilters(enriched, { careRole: expected }), true);
    assert.equal(applicationTierFor(enriched).tier, 'B');
    const ignored = applyDetailEnrichment(generic, rememberDetailEnrichment(null, generic, { ...detail, detailVerified: false }));
    assert.equal(careRoleFor(ignored), 'other');
  }
});

test('signed official PA and outpatient jobs with unknown schedules remain B; proven regular daytime can reach A', () => {
  for (const title of ['간호직(전담) 채용', 'PA 간호사', '진료지원 간호사', '외래 간호사']) {
    const unknown = { ...snubhPaJob, title };
    assert.equal(isApplicationTopTierExcludedJob(unknown), false, title);
    assert.equal(applicationTierFor(unknown).tier, 'B', title);
    assert.equal(applicationTierFor({ ...unknown, detailVerified: true }).tier, 'B', title);
    const confirmed = { ...unknown, workHours: '평일 09:00~18:00' };
    assert.ok(['A', 'S'].includes(applicationTierFor(confirmed).tier), title);
    assert.ok(!applicationTierFor(confirmed).cautions.some((caution) => /S·A 추천 제외/.test(caution)));
  }
  assert.equal(applicationTierFor({ ...snubhPaJob, company: '한빛의원', source: '고용24', workHours: '평일 09:00~18:00' }).tier, 'A');
});

test('PA and outpatient interest preserves unknown employment, confidence, eligibility, and shift restrictions', () => {
  for (const title of ['진료지원 간호사', '외래 간호사']) {
    const confirmed = { ...snubhPaJob, title, workHours: '평일 09:00~18:00' };
    assert.equal(applicationTierFor({ ...confirmed, employmentType: null }).tier, 'B');
    const unknownEligibility = applicationTierFor({ ...confirmed, qualifications: null });
    assert.equal(unknownEligibility.tier, 'B');
    assert.equal(unknownEligibility.eligibility.status, 'needs-check');
    const low = applicationTierFor({ ...confirmed, workHours: null, employmentType: null, officialSourceUrl: null, qualifications: null });
    assert.equal(low.confidence, 'low');
    assert.equal(low.tier, 'B');
    for (const qualifications of ['간호사 면허 소지자 · 전문간호사 자격 필수', '간호사 면허 소지자 · 감염관리 실무 경력 3년 이상 필수']) {
      const assessment = applicationTierFor({ ...confirmed, qualifications });
      assert.equal(assessment.tier, 'B', qualifications);
      assert.equal(assessment.eligibility.status, 'needs-check');
    }
    for (const fields of [
      { workHours: '3교대 근무' }, { workHours: '2교대 근무' }, { workConditions: '야간 근무 있음' },
      { workConditions: '온콜 월 2회' }, { workConditions: '당직 근무 있음' },
      { employmentType: '계약직' }, { qualifications: '간호사 면허만으로는 지원 불가' },
    ]) assert.equal(applicationTierFor({ ...confirmed, ...fields }).tier, 'exclude', JSON.stringify(fields));
    assert.equal(applicationTierFor({ ...confirmed, employmentType: '계약직', workConditions: '정규직 전환 가능' }).tier, 'B');
  }
});

test('generic clinical and CRC roles retain their cap beside eligible PA and outpatient recommendations', () => {
  const good = { ...snubhPaJob, workHours: '평일 09:00~18:00', salary: '연봉 6,000만원' };
  for (const title of ['간호직 채용', '병동 간호사', '중환자실 간호사', '수술실 간호사', '내시경 간호사', '감염관리 전담간호사', 'CRC 연구간호사', '외래 CRC 전담 연구간호사']) {
    const job = { ...good, title };
    assert.equal(isApplicationTopTierExcludedJob(job), true, title);
    assert.equal(applicationTierFor(job).tier, 'B', title);
    assert.equal(applicationTierGroupFor({ ...job, applicationTierGroup: 'S' }), 'B', title);
  }
  const jobs = ['간호직 채용', '진료지원 간호사', '외래 간호사', 'CRC 연구간호사'].map((title, id) => ({ ...good, id, title }));
  assert.deepEqual(sortJobs(jobs).slice(0, 2).map(careRoleFor), ['pa', 'outpatient']);
});

test('rule version invalidates cached clinical caps and recalculates paginated production snapshots', () => {
  const legacyKey = JSON.stringify([['서울', '경기'], ['clinical', 'icu']]);
  assert.notEqual(applicationTierProfileKey(), legacyKey);
  assert.equal(JSON.parse(applicationTierProfileKey())[0], APPLICATION_TIER_RULE_VERSION);
  const fresh = { ...snubhPaJob, workHours: '평일 09:00~18:00' };
  assert.equal(applicationTierGroupFor({ ...fresh, applicationTierGroup: 'B' }), 'S');
  assert.equal(applicationTierGroupFor({ ...snubhPaJob, applicationTierGroup: 'S' }), 'B');
  const stale = {
    ...fresh,
    applicationTierGroup: 'B', applicationTierGroupScore: 94,
    presentation: { profileKey: legacyKey, applicationTier: { tier: 'B', score: 94, order: 2 } },
  };
  assert.equal(applicationTierFor(stale).tier, 'S');
  assert.equal(applicationTierGroupFor(stale), 'S');
  const page = JSON.parse(jobPage({ jobs: [stale] }, { filters: JSON.stringify({ careRole: 'pa', query: 'PA' }) }).body);
  assert.equal(page.jobs.length, 1);
  assert.equal(page.jobs[0].applicationTierGroup, 'S');
  assert.equal(page.jobs[0].presentation.profileKey, applicationTierProfileKey());
  const current = { ...fresh, presentation: { profileKey: applicationTierProfileKey(), applicationTier: applicationTierFor(fresh) } };
  assert.strictEqual(applicationTierFor(current), current.presentation.applicationTier);
});
