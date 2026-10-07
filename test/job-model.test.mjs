import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createDedupeKey,
  deadlineState,
  mergeDuplicateJobs,
  normalizeCompanyName,
  normalizeJob,
  parseDeadline,
  parsePublishedDate,
  partitionJobs,
} from '../lib/job-model.mjs';

const observedAt = '2026-07-11T00:00:00.000Z';

test('normalizes company and title differences into one dedupe key with alternate sources', () => {
  const saramin = normalizeJob({
    id: 'saramin-54417354', source: '사람인', company: '(주)농심',
    title: '(주)농심 보건관리자 채용(계약직)', region: '서울', deadline: '~ 07/21(화)',
    employment: '계약직', category: 'health', url: 'https://saramin.example/job/1',
  }, { seenAt: observedAt });
  const jobkorea = normalizeJob({
    id: 'jobkorea-49546762', source: '잡코리아', company: '㈜농심',
    title: '농심 보건관리자 모집 (계약직)', region: '서울', deadline: 'D-10',
    category: 'health', url: 'https://jobkorea.example/job/2',
  }, { seenAt: observedAt });

  assert.equal(createDedupeKey(saramin), createDedupeKey(jobkorea));
  const merged = mergeDuplicateJobs([saramin, jobkorea], new Date(observedAt));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sourceIds.sort(), ['jobkorea-49546762', 'saramin-54417354']);
  assert.equal(merged[0].alternateSources.length, 1);
  assert.equal(merged[0].duplicateCount, 1);
  assert.equal(merged[0].sourceCount, 2);
  assert.equal(merged[0].employmentType, '계약직');
  assert.equal(merged[0].deadlineAt, '2026-07-21');
});

test('merges cross-source duplicates when company word order differs', () => {
  const zighang = normalizeJob({
    id: 'zighang-f075', source: '직행', company: '카리스 재활 요양 병원',
    title: '감염관리 간호사 모집', region: '경기', deadline: '채용시까지',
    category: 'clinical', url: 'https://zighang.example/job/1',
  }, { seenAt: observedAt });
  const nurscape = normalizeJob({
    id: 'nurscape-595733', source: '너스케입', company: '카리스 요양 재활 병원',
    title: '감염 관리 간호사 모집', region: '경기', deadline: '채용시까지',
    category: 'clinical', url: 'https://recruit.nurscape.net/Jobs/Details/595733',
  }, { seenAt: observedAt });

  assert.equal(createDedupeKey(zighang), createDedupeKey(nurscape));
  const merged = mergeDuplicateJobs([zighang, nurscape], new Date(observedAt));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].alternateSources.length, 1);
  assert.deepEqual(merged[0].sourceIds.sort(), ['nurscape-595733', 'zighang-f075']);
});

test('normalizes legal-form prefixes when comparing company names', () => {
  const listed = normalizeJob({
    id: 'saramin-1', source: '사람인', company: '의료법인 한빛의료재단 한빛병원',
    title: '보건관리자 채용', category: 'health', url: 'https://saramin.example/job/9',
  }, { seenAt: observedAt });
  const plain = normalizeJob({
    id: 'catch-1', source: '캐치', company: '한빛병원 의료법인',
    title: '보건관리자 모집', category: 'health', url: 'https://catch.example/job/3',
  }, { seenAt: observedAt });

  // 재단 명칭이 추가된 법인 풀네임은 병원명과 토큰 구성이 달라 별개로 유지한다.
  assert.notEqual(normalizeCompanyName(listed.company), normalizeCompanyName(plain.company));
  assert.equal(normalizeCompanyName('의료법인 한빛병원'), normalizeCompanyName('한빛병원'));
  assert.equal(normalizeCompanyName('(주)한빛메디컬'), normalizeCompanyName('주식회사 한빛메디컬'));
});

test('merges spacing variants of one company through the compact key', () => {
  const spaced = normalizeJob({
    id: 'zig-9', source: '직행', company: '(주)한빛 메디컬',
    title: '보건관리자 채용', category: 'health', url: 'https://zig.example/9',
  }, { seenAt: observedAt });
  const tight = normalizeJob({
    id: 'nurscape-9', source: '너스케입', company: '한빛메디컬',
    title: '보건관리자 모집', category: 'health', url: 'https://recruit.nurscape.net/Jobs/Details/9',
  }, { seenAt: observedAt });

  const merged = mergeDuplicateJobs([spaced, tight], new Date(observedAt));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].alternateSources.length, 1);
});

test('keeps different employers with similar names separate', () => {
  const jobs = [
    normalizeJob({ id: 'a-1', source: '직행', company: '카리스 재활 요양 병원', title: '간호사 모집', category: 'clinical', url: 'https://a.example/1' }, { seenAt: observedAt }),
    normalizeJob({ id: 'b-1', source: '너스케입', company: '카리스 요양원', title: '간호사 모집', category: 'clinical', url: 'https://b.example/2' }, { seenAt: observedAt }),
  ];
  assert.notEqual(createDedupeKey(jobs[0]), createDedupeKey(jobs[1]));
  assert.equal(mergeDuplicateJobs(jobs, new Date(observedAt)).length, 2);
});

test('merges the current cross-source duplicate fixture into one row per posting', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/dedupe-jobs.json', import.meta.url), 'utf8'));
  const merged = mergeDuplicateJobs(fixture.map((job) => normalizeJob(job, { seenAt: observedAt })), new Date(observedAt));
  assert.equal(merged.length, 2);
  assert.ok(merged.every((job) => job.alternateSources.length === 1));
  assert.deepEqual(merged.flatMap((job) => job.sourceIds).sort(), fixture.map((job) => job.id).sort());
});

test('general-site jobs without visible nursing role evidence go to needs review', () => {
  const unrelated = normalizeJob({
    id: 'jobkorea-1', source: '잡코리아', company: '테스트', title: 'IT 인프라·보안 직무 채용', category: 'health',
  }, { seenAt: observedAt });
  const relevant = normalizeJob({
    id: 'jobkorea-2', source: '잡코리아', company: '테스트', title: '산업간호사 보건관리자 채용', category: 'health',
  }, { seenAt: observedAt });
  const partitioned = partitionJobs([unrelated, relevant]);

  assert.equal(unrelated.needsReview, true);
  assert.match(unrelated.confidenceReasons.join(' '), /직무 정보 부족/);
  assert.equal(relevant.needsReview, false);
  assert.deepEqual(partitioned.jobs.map((job) => job.id), ['jobkorea-2']);
  assert.deepEqual(partitioned.needsReviewJobs.map((job) => job.id), ['jobkorea-1']);
});

test('does not infer employment or experience from a title', () => {
  const job = normalizeJob({
    id: 'nursejob-1', source: '널스잡', company: '테스트병원', title: '정규직 경력 간호사 채용', category: 'clinical',
  }, { seenAt: observedAt });
  assert.equal(job.employmentType, null);
  assert.equal(job.experienceLevel, null);
});

test('keeps distinct entry-level and experienced postings from one source separate', () => {
  const base = { source: '사람인', company: '테스트기업', region: '서울', category: 'health' };
  const jobs = [
    normalizeJob({ ...base, id: 'saramin-new', title: '보건관리자 신입 채용' }, { seenAt: observedAt }),
    normalizeJob({ ...base, id: 'saramin-career', title: '보건관리자 경력 채용' }, { seenAt: observedAt }),
  ];
  assert.equal(mergeDuplicateJobs(jobs, new Date(observedAt)).length, 2);
});

test('does not collapse recurring postings with different ids from the same source', () => {
  const base = {
    source: '사람인', company: '테스트병원', title: '병동 간호사 채용', region: '서울',
    deadline: '07/20', category: 'clinical',
  };
  const jobs = [
    normalizeJob({ ...base, id: 'saramin-old' }, { seenAt: observedAt }),
    normalizeJob({ ...base, id: 'saramin-new' }, { seenAt: observedAt }),
  ];

  assert.equal(jobs[0].dedupeKey, jobs[1].dedupeKey);
  assert.equal(mergeDuplicateJobs(jobs, new Date(observedAt)).length, 2);
});

test('normalizes KST deadlines including D-day and year boundaries', () => {
  assert.deepEqual(parseDeadline('D-3', '2026-07-11T14:59:00.000Z'), { deadlineAt: '2026-07-14', deadlineKind: 'fixed' });
  assert.deepEqual(parseDeadline('오늘 마감', '2026-07-11T15:01:00.000Z'), { deadlineAt: '2026-07-12', deadlineKind: 'fixed' });
  assert.deepEqual(parseDeadline('01/02', '2026-12-31T00:00:00.000Z'), { deadlineAt: '2027-01-02', deadlineKind: 'fixed' });
  assert.deepEqual(parseDeadline('12/31', '2027-01-02T00:00:00.000Z'), { deadlineAt: '2026-12-31', deadlineKind: 'fixed' });
  assert.deepEqual(parseDeadline('26/08/31', observedAt), { deadlineAt: '2026-08-31', deadlineKind: 'fixed' });
  assert.deepEqual(parseDeadline('2026.12.31', observedAt), { deadlineAt: '2026-12-31', deadlineKind: 'fixed' });
  assert.deepEqual(parseDeadline('상시채용', observedAt), { deadlineAt: null, deadlineKind: 'always' });
});

test('normalizes source publication dates without presenting collection time as publication time', () => {
  assert.deepEqual(parsePublishedDate('등록일 07/10', observedAt), { publishedAt: '2026-07-10', publishedKind: 'explicit' });
  assert.deepEqual(parsePublishedDate('어제 등록', observedAt), { publishedAt: '2026-07-10', publishedKind: 'relative' });
  assert.deepEqual(parsePublishedDate('3시간 전', observedAt), { publishedAt: '2026-07-11', publishedKind: 'relative' });
  assert.deepEqual(parsePublishedDate('12/31', '2026-01-03T00:00:00.000Z'), { publishedAt: '2025-12-31', publishedKind: 'explicit' });
  assert.deepEqual(parsePublishedDate('원문 확인', observedAt), { publishedAt: null, publishedKind: 'unknown' });

  const job = normalizeJob({
    id: 'saramin-date', source: '사람인', company: '테스트', title: '보건관리자 채용',
    postedAt: '등록일 07/10', deadline: '07/20', category: 'health',
  }, { seenAt: observedAt });
  assert.equal(job.publishedAt, '2026-07-10');
  assert.equal(job.collectedAt, observedAt);
  assert.deepEqual(job.dates, {
    publishedAt: '2026-07-10',
    firstCollectedAt: observedAt,
    lastCollectedAt: observedAt,
    deadlineAt: '2026-07-20',
    deadlineKind: 'fixed',
    deadlineStatus: 'upcoming',
  });
});

test('recalculates deadline state from a fixed date without mutating it', () => {
  assert.deepEqual(deadlineState('2026-07-10', 'fixed', '2026-07-11T00:00:00.000Z'), { deadlineStatus: 'expired', daysRemaining: -1 });
  assert.deepEqual(deadlineState('2026-07-11', 'fixed', '2026-07-11T00:00:00.000Z'), { deadlineStatus: 'today', daysRemaining: 0 });
  assert.deepEqual(deadlineState('2026-07-14', 'fixed', '2026-07-11T00:00:00.000Z'), { deadlineStatus: 'closing-soon', daysRemaining: 3 });
  assert.deepEqual(deadlineState(null, 'until-filled', observedAt), { deadlineStatus: 'open', daysRemaining: null });
});
