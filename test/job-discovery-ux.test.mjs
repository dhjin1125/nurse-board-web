import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applicationTierFor, careerTransitionAssessmentFor, jobMatchesFilters, nonShiftAssessmentFor, sortJobs, workLifeBalanceFor, workPatternFor } from '../src/job-utils.js';
import { SOURCES } from '../src/sources.js';
import { DEFAULT_FEED_FILTERS } from '../src/feed-defaults.js';

const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

const outpatientDayJob = {
  id: 'ux-outpatient',
  company: '새봄종합병원',
  title: '외래 주간근무 간호사 채용',
  region: '서울',
  employmentType: '정규직',
  experienceLevel: '신입',
  deadlineAt: '2099-07-14',
  roleTags: ['임상간호사'],
};

test('간호 현장에서 중요한 부서·근무 형태·기관 유형으로 공고를 좁힌다', () => {
  assert.equal(jobMatchesFilters(outpatientDayJob, {
    department: '외래',
    workPattern: '상근·주간',
    facilityType: '병원·의료원',
  }), true);

  for (const filters of [
    { department: '중환자실' },
    { workPattern: '3교대' },
    { facilityType: '기업·사업장' },
  ]) {
    assert.equal(jobMatchesFilters(outpatientDayJob, filters), false);
  }
});

test('탐색 화면의 기본 필터 계약에 간호 직무 조건과 정렬이 포함된다', () => {
  const defaults = DEFAULT_FEED_FILTERS;
  assert.match(appSource, /const DEFAULT_FILTERS = DEFAULT_FEED_FILTERS/);
  for (const key of ['department', 'workPattern', 'facilityType', 'availability', 'sort']) {
    assert.ok(key in defaults);
  }
  assert.equal(defaults.region, '서울·경기');
  assert.equal(defaults.availability, '진행 중');
  assert.equal(defaults.sort, '워라벨 우선');

  for (const label of ['부서', '근무 형태', '고용 형태', '경력', '마감', '정렬']) {
    assert.ok(appSource.includes(`'${label}'`) || appSource.includes(`>${label}<`), `${label} 필터가 사용자에게 보여야 합니다.`);
  }
  for (const option of ['서울만', '서울·경기만', '전체 지역 보기', '전체', '추천순', '최신 등록순', '마감 임박순']) {
    assert.ok(appSource.includes(`'${option}'`) || appSource.includes(`>${option}<`), `${option} 선택지가 있어야 합니다.`);
  }
});

test('서울과 경기 공고만 기본 노출하고 전체 지역은 명시적으로 선택할 때만 연다', () => {
  const seoul = { ...outpatientDayJob, id: 'seoul', region: '서울특별시' };
  const gyeonggi = { ...outpatientDayJob, id: 'gyeonggi', region: '경기도 수원시' };
  const busan = { ...outpatientDayJob, id: 'busan', region: '부산광역시' };
  const seoulCodeOnly = { ...outpatientDayJob, id: 'seoul-code', region: '', regionCode: '11' };
  for (const job of [seoul, gyeonggi]) assert.equal(jobMatchesFilters(job, { region: '서울·경기' }), true);
  assert.equal(jobMatchesFilters(busan, { region: '서울·경기' }), false);
  assert.equal(jobMatchesFilters(seoul, { region: '서울' }), true);
  assert.equal(jobMatchesFilters(seoulCodeOnly, { region: '서울' }), true);
  assert.equal(jobMatchesFilters(gyeonggi, { region: '서울' }), false);
  assert.equal(jobMatchesFilters(busan, { region: '서울' }), false);
  assert.equal(jobMatchesFilters(busan, { region: '전체' }), true);
});

test('복수 고용형태도 정규직·계약직·기간제 필터에서 각각 찾는다', () => {
  const mixed = { ...outpatientDayJob, employmentType: '정규직 · 계약직 · 기간제' };
  assert.equal(jobMatchesFilters(mixed, { employment: '정규직' }), true);
  assert.equal(jobMatchesFilters(mixed, { employment: '계약직' }), true);
  assert.equal(jobMatchesFilters(mixed, { employment: '기간제' }), true);
  assert.equal(jobMatchesFilters(mixed, { employment: '시간제' }), false);
  assert.equal(jobMatchesFilters({ ...mixed, employmentType: '고용형태 미표기' }, { employment: '원문 확인' }), true);
  assert.equal(jobMatchesFilters({ ...mixed, employmentType: '비정규직' }, { employment: '정규직' }), false);
  assert.equal(jobMatchesFilters({ ...mixed, employmentType: '비정규직, 정규직' }, { employment: '정규직' }), true);
});

test('추천 공고는 안정 고용 중심으로 유지하고 전체 공고는 모든 고용형태를 기본으로 연다', () => {
  const regular = { ...outpatientDayJob, id: 'regular', employmentType: '정규직' };
  const unknown = { ...outpatientDayJob, id: 'unknown', employmentType: '고용형태 미표기' };
  const contract = { ...outpatientDayJob, id: 'contract', employmentType: '계약직' };
  const recommendedEmployment = ['정규직', '원문 확인'];
  const allJobsEmployment = ['전체'];

  assert.equal(jobMatchesFilters(regular, { employment: recommendedEmployment }), true);
  assert.equal(jobMatchesFilters(unknown, { employment: recommendedEmployment }), true);
  assert.equal(jobMatchesFilters(contract, { employment: recommendedEmployment }), false);
  assert.equal(jobMatchesFilters(regular, { employment: allJobsEmployment }), true);
  assert.equal(jobMatchesFilters(unknown, { employment: allJobsEmployment }), true);
  assert.equal(jobMatchesFilters(contract, { employment: allJobsEmployment }), true);
  assert.equal(jobMatchesFilters(contract, { employment: ['정규직'] }), false);
  assert.deepEqual(DEFAULT_FEED_FILTERS.employment, ['정규직', '원문 확인']);
  assert.match(appSource, /const ALL_JOBS_EMPLOYMENT_FILTERS = \[['"]전체['"]\]/);
  assert.match(appSource, /region: ['"]전체['"]/);
  assert.match(appSource, /sort: ['"]최신 등록순['"]/);
  assert.ok(appSource.includes('type="checkbox"'));
  assert.ok(appSource.includes("label: '확인 불가'"));
});

test('기본 공고 상태는 마감된 공고를 제외하고 필요할 때 다시 볼 수 있다', () => {
  const open = { ...outpatientDayJob, deadlineAt: '2099-07-14' };
  const closed = { ...outpatientDayJob, deadlineAt: '2000-01-01' };
  assert.equal(jobMatchesFilters(open, { availability: '진행 중' }), true);
  assert.equal(jobMatchesFilters(closed, { availability: '진행 중' }), false);
  assert.equal(jobMatchesFilters(closed, { availability: '전체' }), true);
  assert.equal(jobMatchesFilters(closed, { availability: '마감됨' }), true);
  assert.equal(jobMatchesFilters(open, { availability: '마감됨' }), false);
});

test('최신 등록순과 마감 임박순은 원본 목록을 바꾸지 않고 정렬한다', () => {
  const jobs = [
    { ...outpatientDayJob, id: 'later-deadline', publishedAt: '2026-07-10', firstSeenAt: '2026-07-10T00:00:00.000Z', deadlineAt: '2099-08-01' },
    { ...outpatientDayJob, id: 'newest', publishedAt: '2026-07-12', firstSeenAt: '2026-07-09T00:00:00.000Z', deadlineAt: '2099-09-01' },
    { ...outpatientDayJob, id: 'closing-first', publishedAt: '원문 확인', firstSeenAt: '2026-07-11T00:00:00.000Z', deadlineAt: '2099-07-20' },
  ];
  assert.equal(sortJobs(jobs, '최신 등록순')[0].id, 'newest');
  assert.equal(sortJobs(jobs, '마감 임박순')[0].id, 'closing-first');
  assert.deepEqual(jobs.map((job) => job.id), ['later-deadline', 'newest', 'closing-first']);
});

test('주간 외래는 자격 근거가 있으면 S/A로 정렬하고 CRC는 B 제한을 유지한다', () => {
  const jobs = [
    { ...outpatientDayJob, id: 'outpatient', firstSeenAt: '2026-07-10T00:00:00.000Z' },
    { ...outpatientDayJob, id: 'research', title: '대학병원 임상시험 연구간호사 채용', firstSeenAt: '2026-07-11T00:00:00.000Z' },
    { ...outpatientDayJob, id: 'major-outpatient', company: '삼성서울병원', source: '삼성서울병원', qualifications: '간호사 면허 소지자', firstSeenAt: '2026-07-12T00:00:00.000Z' },
    { ...outpatientDayJob, id: 'generic-health', title: '건설현장 안전보건관리자 채용', roleTags: ['보건관리자'], firstSeenAt: '2026-07-13T00:00:00.000Z' },
  ];
  const sorted = sortJobs(jobs, '워라벨 우선');
  assert.equal(sorted[0].id, 'major-outpatient');
  assert.equal(applicationTierFor(jobs[1]).tier, 'B');
  assert.ok(['S', 'A'].includes(applicationTierFor(jobs[2]).tier));
  assert.equal(applicationTierFor({ ...jobs[2], qualifications: null }).tier, 'B', '자격 미확인 외래는 B 제한을 유지한다');
  assert.equal(careerTransitionAssessmentFor(jobs[0]).priority, false);
  assert.equal(careerTransitionAssessmentFor(jobs[1]).priority, true);
  assert.equal(careerTransitionAssessmentFor(jobs[2]).priority, true);
  assert.ok(sorted.findIndex((job) => job.id === 'research') < sorted.findIndex((job) => job.id === 'generic-health'));
  assert.ok(sorted.findIndex((job) => job.id === 'major-outpatient') < sorted.findIndex((job) => job.id === 'outpatient'));
  assert.equal(workLifeBalanceFor(jobs.at(-1)).genericHealthManager, true);
  assert.deepEqual(jobs.map((job) => job.id), ['outpatient', 'research', 'major-outpatient', 'generic-health']);
});

test('공고 매력도와 필수 조건을 분리해 S·A·B·C·제외 티어를 매긴다', () => {
  const topPriority = applicationTierFor({
    ...outpatientDayJob,
    company: '삼성전자',
    source: '고용24',
    title: '사업장 보건관리자(산업간호사) 채용',
    workHours: '월~금 09:00~18:00',
    qualifications: '간호사 면허 소지자',
  });
  const attractiveContract = applicationTierFor({
    ...outpatientDayJob,
    company: '서울대학교병원',
    source: '서울대병원',
    title: '임상시험 CRC 연구간호사 · 월~금 09:00~18:00',
    employmentType: '계약직',
    qualifications: '간호사 면허 소지자',
  });
  const conversionContract = applicationTierFor({
    ...outpatientDayJob,
    company: '서울대학교병원',
    source: '서울대병원',
    title: '임상시험 CRC 연구간호사 · 월~금 09:00~18:00',
    employmentType: '계약직',
    qualifications: '간호사 면허 소지자',
    workConditions: '1년 근무 평가 후 정규직 전환 가능',
  });
  const titleOnlyContract = applicationTierFor({
    ...outpatientDayJob,
    company: '세브란스병원',
    source: '세브란스병원',
    title: '보험심사간호사(계약직) 채용',
    employmentType: null,
    qualifications: '간호사 면허 소지자',
  });
  const specialtyCheck = applicationTierFor({
    ...outpatientDayJob,
    company: '국립암센터',
    source: 'JOB-ALIO',
    title: '정규직 간호직 IRB지원팀 채용',
    qualifications: 'HRPP 관련 실무 경력 1년 이상 필수 · 간호사 면허 소지자',
  });
  const fallback = applicationTierFor({
    ...outpatientDayJob,
    company: '늘편한요양병원',
    title: '상근 간호사 채용',
    qualifications: '간호사 면허 소지자',
  });
  const excluded = applicationTierFor({
    ...outpatientDayJob,
    company: '삼성서울병원',
    source: '삼성서울병원',
    title: '중환자실 3교대 간호사 채용',
    qualifications: '간호사 면허 소지자',
  });
  const preferredSpecialtyOnly = applicationTierFor({
    ...outpatientDayJob,
    company: '한빛전자',
    title: '건강관리실 보건관리자 채용',
    employmentType: '정규직',
    workHours: '월~금 09:00~18:00',
    qualifications: '간호사 면허 필수 · 보건관리자 경력 2년 이상 우대',
    preferredQualifications: '산업보건 업무 경험자',
  });
  const temporaryReplacement = applicationTierFor({
    ...outpatientDayJob,
    company: '고려대학교병원',
    title: '심사평가팀 계약직 직원 모집(육아휴직 대체인력)',
    employmentType: '계약직',
    workHours: '월~금 09:00~18:00',
    qualifications: '간호사 면허 소지자',
  });

  assert.equal(topPriority.tier, 'S');
  assert.equal(topPriority.eligibility.status, 'eligible');
  assert.equal(attractiveContract.tier, 'exclude');
  assert.equal(attractiveContract.eligibility.label, '지원 제외 권장');
  assert.match(attractiveContract.cautions.join(' '), /계약·기간제/);
  assert.equal(conversionContract.tier, 'B');
  assert.equal(conversionContract.eligibility.label, '정규직 전환 확인');
  assert.equal(titleOnlyContract.tier, 'exclude');
  assert.match(titleOnlyContract.cautions.join(' '), /계약·기간제/);
  assert.equal(specialtyCheck.tier, 'B');
  assert.equal(specialtyCheck.eligibility.status, 'needs-check');
  assert.match(specialtyCheck.cautions.join(' '), /HRPP/);
  assert.equal(fallback.tier, 'C');
  assert.equal(excluded.tier, 'exclude');
  assert.equal(excluded.eligibility.label, '지원 제외 권장');
  assert.ok(excluded.cautions.includes('3교대 명시'));
  assert.equal(preferredSpecialtyOnly.eligibility.status, 'eligible');
  assert.ok(!preferredSpecialtyOnly.cautions.some((caution) => /필수 경력/.test(caution)));
  assert.equal(temporaryReplacement.tier, 'exclude');
  assert.ok(temporaryReplacement.cautions.includes('대체인력·한시 채용'));
});

test('추천 정렬은 지원 티어를 먼저 보고 같은 티어 안에서 점수를 비교한다', () => {
  const jobs = [
    { ...outpatientDayJob, id: 'excluded', title: '중환자실 3교대 간호사 채용' },
    { ...outpatientDayJob, id: 'fallback', company: '늘편한요양병원', title: '상근 간호사 채용' },
    { ...outpatientDayJob, id: 'top', company: '삼성서울병원', source: '삼성서울병원', workHours: '월~금 09:00~18:00', qualifications: '간호사 면허 소지자' },
    { ...outpatientDayJob, id: 'review', company: '국립암센터', source: 'JOB-ALIO', title: '정규직 간호직 IRB지원팀 채용', qualifications: 'HRPP 관련 실무 경력 1년 이상 필수' },
  ];

  assert.deepEqual(sortJobs(jobs, '워라벨 우선').map((job) => job.id), ['top', 'review', 'fallback', 'excluded']);
});

test('교대·요양·조무 중심 공고는 기관이나 직무 이름이 좋아도 상위 추천에서 제외한다', () => {
  const majorDay = careerTransitionAssessmentFor({
    ...outpatientDayJob,
    company: '삼성서울병원',
    source: '삼성서울병원',
  });
  const patientSafety = careerTransitionAssessmentFor({
    ...outpatientDayJob,
    company: '한빛병원',
    title: '환자안전팀 상근 간호사 채용',
  });
  const shift = careerTransitionAssessmentFor({
    ...outpatientDayJob,
    company: '삼성서울병원',
    source: '삼성서울병원',
    title: '중환자실 3교대 간호사 채용',
  });
  const rehab = careerTransitionAssessmentFor({
    ...outpatientDayJob,
    company: '늘편한요양병원',
    title: '감염관리 상근 간호사 채용',
  });
  const mixedAssistant = careerTransitionAssessmentFor({
    ...outpatientDayJob,
    company: '삼성서울병원',
    source: '삼성서울병원',
    title: '외래 상근 간호사·간호조무사 채용',
  });

  assert.equal(majorDay.priority, true);
  assert.deepEqual(majorDay.reasons, ['대학·대형병원', '정규직']);
  assert.equal(patientSafety.priority, true);
  assert.ok(patientSafety.reasons.includes('전문부서 전환 직무'));
  assert.equal(shift.priority, false);
  assert.equal(rehab.priority, false);
  assert.equal(mixedAssistant.priority, false);
});

test('비교대 표시는 확인·후보·교대·충돌·미확인을 과장 없이 구분한다', () => {
  const confirmed = nonShiftAssessmentFor({ title: '외래 상근 간호사 채용' });
  const likely = nonShiftAssessmentFor({ title: '외래 간호사 채용' });
  const shift = nonShiftAssessmentFor({ title: '외래 간호사 3교대 채용' });
  const noShift = nonShiftAssessmentFor({ title: '간호사 채용 · 교대근무 없음' });
  const conflict = nonShiftAssessmentFor({ title: 'CRC 연구간호사 · 월~금 09:00~18:00 · 야간 당직 월 2회' });
  const unknown = nonShiftAssessmentFor({ title: '병동 간호사', workHours: '주 5일 근무' });
  const weekendsOff = nonShiftAssessmentFor({ title: '외래 간호사', workHours: '월~금 09:00~18:00 · 주말 근무 없음' });
  const particleNegation = nonShiftAssessmentFor({ title: '간호사 채용 · 교대근무를 하지 않습니다' });
  const mixedShift = nonShiftAssessmentFor({ title: '간호사 채용 · 3교대 없음, 2교대 운영' });

  assert.equal(confirmed.status, 'confirmed');
  assert.equal(likely.status, 'likely');
  assert.equal(shift.status, 'shift');
  assert.equal(noShift.status, 'confirmed');
  assert.equal(conflict.status, 'conflict');
  assert.equal(unknown.status, 'unknown');
  assert.equal(weekendsOff.status, 'confirmed');
  assert.equal(particleNegation.status, 'confirmed');
  assert.equal(mixedShift.status, 'shift');
  assert.equal(workPatternFor({ title: '간호사 채용 · 3교대 없음, 2교대 운영' }), '2교대');
  assert.equal(workPatternFor({ title: '병동 간호사', workHours: '주 5일 근무' }), '원문 확인');
});

test('상근·비교대 후보만 보기는 명시 교대와 미확인 공고를 제외한다', () => {
  assert.equal(jobMatchesFilters({ ...outpatientDayJob, title: '외래 간호사 채용' }, { nonShiftOnly: true }), true);
  assert.equal(jobMatchesFilters({ ...outpatientDayJob, title: '외래 간호사 3교대 채용' }, { nonShiftOnly: true }), false);
  assert.equal(jobMatchesFilters({ ...outpatientDayJob, title: '병동 간호사 채용' }, { nonShiftOnly: true }), false);
});

test('비교대 표현과 부정·혼합 근무 문구를 보수적으로 판정한다', () => {
  for (const title of ['비교대 간호사', '교대근무 아님', '교대근무 X', '교대·야간 없음']) {
    assert.equal(nonShiftAssessmentFor({ title }).status, 'confirmed', title);
  }
  for (const title of ['상근 아님', '비상근 간호사', '주간근무 없음', '야간근무 X']) {
    assert.equal(nonShiftAssessmentFor({ title }).status, 'unknown', title);
  }
  for (const title of ['야간 월 2회', '야간 보건관리자 채용', '간호사 22:00~익일 07:00', '간호사 E/N 근무', '간호사 주주야야비비']) {
    assert.equal(nonShiftAssessmentFor({ title }).status, 'shift', title);
  }

  const weekend = nonShiftAssessmentFor({ title: '상근 간호사 · 토요일 월 1회 근무' });
  assert.equal(weekend.status, 'confirmed');
  assert.equal(weekend.candidate, true);
  assert.match(weekend.detail, /주말근무/);

  assert.equal(nonShiftAssessmentFor({ title: '교대근무 없음 · 야간 있음' }).status, 'conflict');
  assert.equal(nonShiftAssessmentFor({ title: '외래 간호사', description: '3교대 병동 경력자 우대' }).status, 'likely');
  assert.equal(nonShiftAssessmentFor({ title: '간호사 day 근무' }).status, 'confirmed');
});

test('구조화된 근무표의 교대·당직 값도 비교대 배지에 반영한다', () => {
  const shift = nonShiftAssessmentFor({
    title: '간호사 채용',
    schedule: { version: 2, kind: 'three_shift', shift: true, night: true, raw: null },
  });
  const onCall = nonShiftAssessmentFor({
    title: '간호사 채용',
    schedule: { version: 2, kind: 'weekday_daytime', shift: false, night: false, onCall: true, weekdayDaytimeStatus: 'confirmed', raw: '월~금 09:00~18:00' },
  });
  assert.equal(shift.status, 'shift');
  assert.equal(onCall.status, 'conflict');
});

test('공고 목록 상단에서 워라벨·최신·마감 정렬을 바로 바꿀 수 있다', () => {
  assert.ok(appSource.includes("testId: 'sort-work-life'"));
  assert.ok(appSource.includes("testId: 'sort-latest'"));
  assert.ok(appSource.includes("testId: 'sort-deadline'"));
  assert.ok(appSource.includes('aria-label="공고 정렬"'));
});

test('공고 카드에는 지원 판단에 필요한 날짜와 확인된 상세 정보만 보인다', async () => {
  for (const label of ['등록', '공고 확인']) {
    assert.ok(appSource.includes(label), `${label} 정보를 공고 카드에서 확인할 수 있어야 합니다.`);
  }
  // 확인되지 않은 값은 카드 팩트에 반복 표시하지 않고 상세 보완 단계에서만 안내한다.
  const utilsSource = await readFile(new URL('../src/job-utils.js', import.meta.url), 'utf8');
  for (const label of ['근무형태 확인 필요']) {
    assert.ok(!appSource.includes(`'${label}'`), `${label} 같은 미확인 문구를 카드에서 반복 노출하지 않아야 합니다.`);
    assert.ok(utilsSource.includes(label), `${label} 안내는 상세 보완 로직에 남아 있어야 합니다.`);
  }
  for (const expression of [
    'departmentFor(job)', 'workPatternFor(job)', 'facilityTypeFor(job)',
    'employmentDisplay(job)', 'experienceDisplay(job)', 'job.salary', 'job.education',
  ]) {
    assert.ok(appSource.includes(expression), `${expression}의 알려진 값을 카드에 표시해야 합니다.`);
  }
});

test('첫 화면은 홈 대시보드 없이 추천·전체·저장 공고에 집중한다', () => {
  assert.match(appSource, /const VIEW_PATHS = \{ all: ['"]\/['"], full: ['"]\/all-jobs['"], saved: ['"]\/saved['"] \}/);
  const focusedRender = appSource.slice(appSource.indexOf('return <div className="app-shell jobs-focus-shell"'));
  assert.equal((focusedRender.match(/<AllJobsView/g) || []).length, 2, '추천 공고와 전체 공고 목록을 각각 렌더링해야 합니다.');
  assert.ok(focusedRender.includes('mode="full"'), '전체 공고는 별도 탐색 모드로 렌더링해야 합니다.');
  assert.ok(focusedRender.includes('<SavedView'), '저장한 채용 공고는 계속 볼 수 있어야 합니다.');
  for (const removed of ['<HomeView', '<ApplicationsView', '<SourcesView', '<Onboarding', '<NotificationsPanel', '<SettingsPanel', '<ApplyReturnBar']) {
    assert.ok(!focusedRender.includes(removed), `${removed} 부가 기능은 집중 화면에서 렌더링하지 않아야 합니다.`);
  }
});

test('자동 수집 채널과 원문 바로가기 채널을 데이터에서 명확히 구분한다', () => {
  const automatic = SOURCES.filter((source) => source.collection === 'auto');
  const links = SOURCES.filter((source) => source.collection === 'link');
  assert.ok(automatic.length > 0, '자동 수집 채널이 있어야 합니다.');
  assert.ok(links.length > 0, '원문 바로가기 전용 채널이 있어야 합니다.');
  for (const source of links) {
    assert.match(source.url, /^https?:\/\//);
    assert.ok(source.name && source.note && source.scope);
  }
});

test('Indeed 원문 채널은 고정 공고가 아닌 최근 검색 주소만 보존한다', () => {
  const indeed = SOURCES.find((source) => source.id === 'indeed');
  assert.equal(indeed?.collection, 'link');
  const url = new URL(indeed.url);
  assert.equal(url.hostname, 'kr.indeed.com');
  assert.equal(url.searchParams.get('q'), '상근직 간호사');
  assert.equal(url.searchParams.get('fromage'), '14');
  assert.equal(url.searchParams.get('sort'), 'date');
  assert.equal(url.searchParams.get('vjk'), null);
});
