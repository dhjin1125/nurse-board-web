import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalIntent, rankJobs, scoreJob } from '../src/jobMatcher.js';

test('parses a natural Korean nursing job request into visible criteria', () => {
  const intent = parseLocalIntent('서울이나 경기에서 신입도 가능하고 야간근무 없는 보건관리자 정규직 찾아줘');
  assert.deepEqual(intent.regions, ['서울', '경기']);
  assert.deepEqual(intent.roleTags, ['health_manager']);
  assert.deepEqual(intent.employmentTypes, ['regular']);
  assert.equal(intent.experienceLevel, 'entry');
  assert.equal(intent.deadlineWithinDays, null);
  assert.ok(intent.excludeKeywords.includes('야간'));
  assert.ok(intent.excludeKeywords.includes('3교대'));
  assert.match(intent.summary, /서울·경기/);
});

test('does not treat a requested shift as an exclusion', () => {
  const wanted = parseLocalIntent('부산이나 경남에서 병동 3교대 경력직 간호사');
  assert.deepEqual(wanted.regions, ['부산', '경남']);
  assert.equal(wanted.experienceLevel, 'experienced');
  assert.ok(wanted.roleTags.includes('ward'));
  assert.equal(wanted.excludeKeywords.length, 0);

  const avoided = parseLocalIntent('3교대는 싫고 외래 데이근무만 하고 싶어');
  assert.ok(avoided.excludeKeywords.includes('3교대'));
  assert.ok(avoided.roleTags.includes('outpatient'));
});

test('ranks exact matches first and removes explicit exclusions or required mismatches', () => {
  const intent = parseLocalIntent('서울 정규직만 보건관리자, 3교대 제외');
  const jobs = [
    { id: 'exact', title: '서울 사업장 보건관리자 신입 채용', company: '정확기업', region: '서울', category: 'health', employmentType: '정규직', roleTags: ['보건관리자'] },
    { id: 'contract', title: '서울 보건관리자 계약직 채용', company: '계약기업', region: '서울', category: 'health', employmentType: '계약직', roleTags: ['보건관리자'] },
    { id: 'shift', title: '서울 병동 3교대 간호사', company: '교대병원', region: '서울', category: 'clinical', employmentType: '정규직', roleTags: ['간호사'] },
    { id: 'unknown', title: '서울 사업장 보건관리자 모집', company: '확인기업', region: '서울', category: 'health', roleTags: ['보건관리자'] },
  ];
  const ranked = rankJobs(jobs, intent);
  assert.equal(ranked[0].job.id, 'exact');
  assert.deepEqual(ranked.map((item) => item.job.id), ['exact', 'unknown']);
  assert.ok(ranked[1].cautions.includes('고용형태 원문 확인'));
  assert.ok(ranked[1].cautions.includes('제외 조건 여부 원문 확인'));
  assert.ok(!ranked[1].reasons.some((reason) => /3교대.*제외/.test(reason)));
});

test('keeps unsupported salary and commute criteria transparent', () => {
  const intent = parseLocalIntent('수원에서 출퇴근 30분 이내, 연봉 4천 이상인 간호사');
  assert.equal(intent.unresolvedCriteria.length, 2);
  const result = scoreJob({ id: 'one', title: '간호사 채용', company: '병원', region: '경기', category: 'clinical', roleTags: ['간호사'] }, intent);
  assert.equal(typeof result.score, 'number');
});

test('prioritizes a role stated in the title over a broad multi-position sector tag', () => {
  const intent = parseLocalIntent('서울 신입 보건관리자 정규직');
  const ranked = rankJobs([
    { id: 'broad', title: '영업·마케팅 및 IT 각 부문 채용', company: '종합기업', region: '서울', employmentType: '정규직', experienceLevel: '경력무관', category: 'health', sectors: ['보건관리자', '데이터분석가'], roleTags: ['보건관리자'] },
    { id: 'direct', title: '인사총무팀 보건관리자 신입 채용', company: '정확기업', region: '서울', employmentType: '정규직', experienceLevel: '신입', category: 'health', sectors: ['보건관리자'], roleTags: ['보건관리자'] },
  ], intent);

  assert.equal(ranked[0].job.id, 'direct');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[1].cautions.includes('모집분야에 포함 · 상세 역할 원문 확인'));
});

test('trusts an explicit experienced-only title over conflicting entry metadata', () => {
  const intent = parseLocalIntent('서울 신입 보건관리자');
  const result = scoreJob({
    id: 'conflict',
    title: '건설현장 보건관리자 경력직원 모집',
    region: '서울',
    experienceLevel: '경력무관',
    sectors: ['보건관리자'],
    roleTags: ['보건관리자'],
  }, intent);

  assert.ok(result.cautions.includes('경력 조건과 다름'));
  assert.ok(!result.reasons.includes('신입·경력무관'));
});
