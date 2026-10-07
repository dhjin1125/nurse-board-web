import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MATCH_OUTCOME,
  MATCH_STATUS,
  matchJobV2,
  parseSchedule,
} from '../src/job-v2.js';

const criteria = {
  required: {
    roleTags: ['health-manager'],
    qualifications: ['간호사 면허'],
    regions: ['서울'],
    weekdayDaytime: true,
  },
  preferred: {
    employmentTypes: ['정규직'],
    experienceLevels: [],
    keywords: [],
  },
  excluded: {
    workPatterns: ['야간', '3교대'],
    keywords: [],
  },
};

test('confirms a match only when the posting contains evidence for every required condition', () => {
  const match = matchJobV2({
    id: 'confirmed-health-manager',
    title: '서울 사업장 보건관리자 간호사 채용',
    roleTags: ['health-manager'],
    qualifications: '간호사 면허 소지자 필수',
    workHours: '월~금 09:00~18:00',
    workPattern: '상근·주간',
    location: '서울 영등포구',
    employmentType: '정규직',
    url: 'https://example.com/jobs/confirmed',
  }, criteria);

  assert.equal(match.overall, MATCH_OUTCOME.CONFIRMED);
  assert.equal(match.topRecommendation, true);
  assert.equal(match.conditions.required.qualification.status, MATCH_STATUS.MATCHED);
  assert.equal(match.conditions.required.weekdayDaytime.status, MATCH_STATUS.MATCHED);
  assert.equal(match.conditions.excluded.workPatterns.status, MATCH_STATUS.MATCHED);
  assert.equal(match.conditions.preferred.employment.status, MATCH_STATUS.MATCHED);
  assert.ok(match.conditions.required.qualification.evidence.length > 0);
});

test('keeps missing license and schedule information as review instead of inferring a match', () => {
  const match = matchJobV2({
    id: 'unknown-health-manager',
    title: '서울 사업장 보건관리자 채용',
    roleTags: ['health-manager'],
    region: '서울',
    employmentType: '정규직',
  }, criteria);

  assert.equal(match.overall, MATCH_OUTCOME.NEEDS_REVIEW);
  assert.equal(match.topRecommendation, false);
  assert.equal(match.conditions.required.qualification.status, MATCH_STATUS.UNKNOWN);
  assert.equal(match.conditions.required.weekdayDaytime.status, MATCH_STATUS.UNKNOWN);
  assert.equal(match.mismatchedCount, 0);
});

test('비정규직 표기를 정규직 일치로 잘못 해석하지 않는다', () => {
  const nonRegular = matchJobV2({
    id: 'non-regular-health-manager',
    title: '서울 사업장 보건관리자 간호사 채용',
    roleTags: ['health-manager'],
    qualifications: '간호사 면허 소지자 필수',
    workHours: '월~금 09:00~18:00',
    location: '서울 영등포구',
    employmentType: '비정규직',
  }, criteria);
  assert.equal(nonRegular.conditions.preferred.employment.status, MATCH_STATUS.UNKNOWN);

  const mixed = matchJobV2({
    id: 'mixed-regular-health-manager',
    title: '서울 사업장 보건관리자 간호사 채용',
    roleTags: ['health-manager'],
    qualifications: '간호사 면허 소지자 필수',
    workHours: '월~금 09:00~18:00',
    location: '서울 영등포구',
    employmentType: '비정규직, 정규직',
  }, criteria);
  assert.equal(mixed.conditions.preferred.employment.status, MATCH_STATUS.MATCHED);
});

test('rejects safety-only eligibility and an explicitly excluded shift', () => {
  const match = matchJobV2({
    id: 'safety-shift',
    title: '서울 사업장 보건관리자 채용',
    roleTags: ['health-manager'],
    qualifications: '산업안전기사 필수',
    workHours: '3교대 근무',
    region: '서울',
    employmentType: '정규직',
  }, criteria);

  assert.equal(match.overall, MATCH_OUTCOME.MISMATCHED);
  assert.equal(match.conditions.required.qualification.status, MATCH_STATUS.MISMATCHED);
  assert.equal(match.conditions.excluded.workPatterns.status, MATCH_STATUS.MISMATCHED);
  assert.ok(match.cautions.some((message) => message.includes('지원 불가')));
  assert.ok(match.cautions.some((message) => message.includes('3교대')));
});

test('normalizes Korean morning and afternoon clock notation', () => {
  const morning = parseSchedule({ workHours: '평일 오전 9시~오후 6시' });
  assert.equal(morning.startTime, '09:00');
  assert.equal(morning.endTime, '18:00');
  assert.equal(morning.weekdayDaytimeStatus, 'confirmed');

  const afternoon = parseSchedule({ workHours: '평일 오후 1시~오후 6시' });
  assert.equal(afternoon.startTime, '13:00');
  assert.equal(afternoon.endTime, '18:00');
});

test('keeps mixed shift and after-hours wording conservative', () => {
  const mixedShift = parseSchedule({ workHours: '3교대 없음, 2교대 운영' });
  assert.equal(mixedShift.kind, 'two_shift');
  assert.equal(mixedShift.shift, true);

  const afterHours = parseSchedule({ workHours: '월~금 09:00~18:00, 야간 당직 월 2회' });
  assert.equal(afterHours.weekdayDaytimeStatus, 'mismatched');
  assert.equal(afterHours.night, true);
  assert.equal(afterHours.onCall, true);

  const weekendsOff = parseSchedule({ workHours: '월~금 09:00~18:00, 주말 근무 없음' });
  assert.equal(weekendsOff.weekdayDaytimeStatus, 'confirmed');
  assert.equal(weekendsOff.weekend, false);
});

test('uses checked detail text for preferred and excluded keywords', () => {
  const match = matchJobV2({
    id: 'keyword-health-manager',
    title: '서울 사업장 보건관리자 간호사 채용',
    roleTags: ['health-manager'],
    qualifications: '간호사 면허 소지자 필수',
    workHours: '월~금 09:00~18:00',
    description: '임직원 건강검진 운영과 건강상담을 담당합니다.',
    location: '서울 영등포구',
    employmentType: '정규직',
    detailCheckedAt: '2026-08-18T06:00:00.000Z',
  }, {
    ...criteria,
    preferred: { ...criteria.preferred, keywords: ['건강검진'] },
    excluded: { ...criteria.excluded, keywords: ['요양병원'] },
  });

  assert.equal(match.conditions.preferred.keywords.status, MATCH_STATUS.MATCHED);
  assert.equal(match.conditions.excluded.keywords.status, MATCH_STATUS.MATCHED);
  assert.equal(match.overall, MATCH_OUTCOME.CONFIRMED);
});
