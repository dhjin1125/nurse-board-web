import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationTierFor, applicationTierGroupFor, careRoleFor, hiddenOpportunityFor, isApplicationTopTierExcludedJob, isHospitalClinicalJob, sortJobs } from '../src/job-utils.js';

const attractiveJob = {
  company: '삼성서울병원',
  source: '삼성서울병원',
  title: '간호사 채용',
  region: '서울',
  employmentType: '정규직',
  workHours: '평일 09:00~18:00',
  salary: '연봉 6,000만원',
  qualifications: '간호사 면허 소지자',
  roleTags: ['간호사'],
  detailVerified: true,
  deadlineAt: '2099-12-31',
};

test('전체공고의 놓치기 아까운 후보는 B/C 등급의 명시적 직무·근무 근거만 사용한다', () => {
  const pa = { title: '분당서울대병원 PA 간호사 채용', company: '분당서울대학교병원', deadlineAt: '2099-12-31' };
  const paEvidence = hiddenOpportunityFor(pa);
  assert.ok(paEvidence);
  assert.equal(paEvidence.tier, 'B');
  assert.ok(paEvidence.reasons.includes('PA·전담 직무 명시'));
  assert.ok(paEvidence.cautions.includes('근무표·교대 여부 원문 확인'));

  const weekdayClinical = { ...attractiveJob, title: '병동 간호사 모집' };
  const weekdayEvidence = hiddenOpportunityFor(weekdayClinical);
  assert.ok(weekdayEvidence);
  assert.ok(weekdayEvidence.reasons.includes('상근·주간 확인'));

  assert.equal(hiddenOpportunityFor({ ...pa, deadlineAt: '2000-01-01' }), null, '마감 공고 제외');
  assert.equal(hiddenOpportunityFor({ title: '간호사 채용', deadlineAt: '2099-12-31' }), null, '긍정 근거가 없으면 제외');
});

test('일반 병원 임상직과 PA가 아닌 전문부서 전담은 상근·고연봉이어도 B 이하로 유지한다', () => {
  for (const title of [
    '간호사 채용', '정규직 간호직 채용',
    '교육전담 간호사 채용', '환자안전(QPS)전담 간호사 모십니다.',
    '감염관리 전담간호사 채용', '보험심사 전담 간호사 모집',
    'CRC 전담 연구간호사 채용', 'QPS 전담 선생님',
    '병동 간호사 모집', '중환자실 간호사',
    '수술실 간호사', '응급실 간호사', '내시경 간호사', '건강검진센터 간호사',
    '인공신장실 투석 간호사', 'Registered Nurse',
  ]) {
    const job = { ...attractiveJob, title };
    const assessment = applicationTierFor(job);
    assert.equal(isHospitalClinicalJob(job), true, title);
    assert.ok(assessment.score >= 70, `상위 점수인 테스트 공고: ${title}`);
    assert.equal(assessment.tier, 'B', title);
    assert.ok(
      assessment.cautions.some((caution) => /S·A 추천 제외/.test(caution)),
      title,
    );
    assert.equal(assessment.eligibility.status, 'eligible', '추천 등급 제한이 지원 자격을 바꾸지 않는다');
  }
});

test('명시된 PA·전담·진료지원·외래는 임상직이어도 주간 정규직 근거가 있으면 S/A 후보가 된다', () => {
  for (const [title, role] of [
    ['전담간호사 채용', 'pa'], ['전담 간호사 모집', 'pa'],
    ['간호직(전담) 채용', 'pa'], ['신경외과 외래 전담 간호사 모집', 'pa'],
    ['진료지원 간호사(PA) 모집', 'pa'], ['PA 간호사 채용', 'pa'],
    ['외래 간호사 채용', 'outpatient'],
  ]) {
    const job = { ...attractiveJob, title };
    assert.equal(careRoleFor(job), role, title);
    assert.equal(isHospitalClinicalJob(job), true, title);
    assert.equal(isApplicationTopTierExcludedJob(job), false, title);
    const assessment = applicationTierFor(job);
    assert.ok(['S', 'A'].includes(assessment.tier), title);
    assert.equal(assessment.eligibility.status, 'eligible', title);
    assert.ok(!assessment.cautions.some((caution) => /S·A 추천 제외/.test(caution)), title);
    assert.equal(applicationTierFor({ ...job, workHours: null }).tier, 'B', `${title}: 근무시간 미확인`);
    assert.equal(applicationTierFor({ ...job, employmentType: null }).tier, 'B', `${title}: 고용형태 미확인`);
    assert.equal(applicationTierFor({ ...job, workConditions: '온콜 당직 있음' }).tier, 'exclude', `${title}: 당직 제한 유지`);
  }
});

test('모집 직무·담당업무를 보고 임상직을 판별하며 임상 경력 우대로 비임상직을 제외하지 않는다', () => {
  assert.equal(isHospitalClinicalJob({ title: '간호직 채용', company: '채용대행사', duties: '외래 환자 상담과 채혈 업무' }), true);
  assert.equal(isHospitalClinicalJob({ title: '전담간호사 채용', department: '연구·CRC' }), true, '명확한 임상 제목을 오래된 부서 분류가 덮지 않는다');
  assert.equal(isHospitalClinicalJob({ title: '직원 채용', company: '의료법인 새봄재단', department: '간호부' }), true);
  assert.equal(isHospitalClinicalJob({ title: '간호사 채용', company: '국립암센터' }), true, '병원이라는 단어가 없는 의료기관도 인식한다');
  assert.equal(isHospitalClinicalJob({ title: '간호직 채용', source: '국립암센터' }), true);
  assert.equal(isHospitalClinicalJob({ title: '정규직 간호사 모집', company: '서초맑은이비인후과' }), true);
  assert.equal(isHospitalClinicalJob({ title: '간호사 채용', roleTags: ['clinical-nurse'] }), true);
  assert.equal(isHospitalClinicalJob({ title: '보건관리자 채용', company: '한빛전자', qualifications: '병동·중환자실 간호사 경력 3년 이상', department: '산업보건' }), false);
  assert.equal(isHospitalClinicalJob({ title: '행정직 채용', company: '삼성서울병원', qualifications: '간호사 면허 우대' }), false);
  assert.equal(isHospitalClinicalJob({ title: '간호직 채용', company: '삼성서울병원', department: '보험심사' }), false);
});

test('보건관리·산업간호와 CRC 외 비임상 전문직은 S/A 후보로 유지한다', () => {
  for (const title of [
    '보건관리자(간호사) 채용', '산업간호사 채용', '사업장 건강관리실 간호사',
    '감염관리 간호사 채용', '환자안전(QPS) 간호사', '보험심사 간호사 모집',
    'IRB지원팀 간호직 채용',
  ]) {
    const job = { ...attractiveJob, title, qualifications: '간호사 면허 소지자 · 중환자실 경력 우대' };
    assert.equal(isHospitalClinicalJob(job), false, title);
    assert.ok(['S', 'A'].includes(applicationTierFor(job).tier), title);
  }
  assert.equal(isHospitalClinicalJob({ ...attractiveJob, company: '의료기기기업', title: 'Clinical Specialist / 간호사', duties: '외래 의료진 대상 제품 교육' }), false);
});

test('환자안전 전담은 PA로 오인하지 않고 저장된 상위 그룹도 B 이하로 제한한다', () => {
  const job = {
    ...attractiveJob,
    company: '하워드 힐병원',
    source: '직행',
    title: '환자안전(QPS)전담 간호사 모십니다.',
    workHours: '평일 08:30~17:30',
    workConditions: '주5일 · 평일 08:30~17:30 · 전일제',
    applicationTierGroup: 'S',
    applicationTierGroupScore: 91,
  };
  assert.equal(careRoleFor(job), 'other');
  assert.equal(isHospitalClinicalJob(job), true);
  assert.equal(isApplicationTopTierExcludedJob(job), true);
  assert.equal(applicationTierFor(job).tier, 'B');
  assert.equal(applicationTierGroupFor(job), 'B');
});

test('CRC·연구간호사는 소속 기관과 점수에 관계없이 S/A에서 제외한다', () => {
  for (const title of ['임상시험 CRC 연구간호사 채용', 'CRC 모집', '임상시험 연구코디네이터 채용', 'Clinical Research Nurse', '외래 CRC 전담 연구간호사']) {
    const job = { ...attractiveJob, company: '유한회사 액트케이', source: '고용24', title };
    const assessment = applicationTierFor(job);
    assert.equal(isApplicationTopTierExcludedJob(job), true, title);
    assert.equal(assessment.tier, 'B', title);
    assert.ok(assessment.cautions.includes('CRC·연구간호사 · S·A 추천 제외'), title);
  }
});

test('임상직의 기존 후순위·제외 등급은 상향하지 않는다', () => {
  const low = applicationTierFor({ title: '요양병원 간호사', company: '늘편한요양병원' });
  assert.equal(low.tier, 'C');
  const excluded = applicationTierFor({ ...attractiveJob, title: '병동 3교대 간호사', workHours: '3교대 근무' });
  assert.equal(excluded.tier, 'exclude');
  assert.equal(excluded.eligibility.status, 'ineligible');
});

test('저장된 S/A 그룹도 임상직 제한을 적용하고 정렬과 그룹이 같은 결과를 쓴다', () => {
  for (const tier of ['S', 'A', 'B', 'C', 'exclude']) {
    const expected = ['S', 'A'].includes(tier) ? 'B' : tier;
    assert.equal(applicationTierGroupFor({ ...attractiveJob, applicationTierGroup: tier, applicationTierGroupScore: 100 }), expected);
  }
  const clinical = { ...attractiveJob, id: 'clinical', applicationTierGroup: 'S', applicationTierGroupScore: 100 };
  const occupational = { ...attractiveJob, id: 'occupational', title: '산업간호사 채용', applicationTierGroup: 'A', applicationTierGroupScore: 71 };
  assert.deepEqual(sortJobs([clinical, occupational]).map((job) => job.id), ['occupational', 'clinical']);
  assert.equal(applicationTierGroupFor({ ...occupational, applicationTierGroup: 'B' }), 'B', '비임상 공고의 기존 세션 그룹을 유지한다');
  assert.equal(applicationTierGroupFor({ ...occupational, title: '임상시험 CRC 연구간호사', applicationTierGroup: 'S' }), 'B', '저장된 CRC 상위 그룹도 제한한다');
  assert.equal(applicationTierGroupFor({ ...attractiveJob, applicationTierGroup: 'invalid' }), 'B');
});
