import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_QUALIFICATION,
  criteriaChips,
  profileToSearchCriteria,
  removeCriteriaChip,
} from '../src/search-criteria.js';

test('turns the simple profile into explicit required, preferred, and excluded criteria', () => {
  const criteria = profileToSearchCriteria({
    roleTags: ['health-manager'],
    regionCodes: ['서울'],
    employmentTypes: ['정규직'],
    experienceLevels: ['신입·무관'],
    workPatterns: ['상근·주간', '3교대 제외'],
    preferredKeywords: ['건강검진'],
    excludedKeywords: ['야간', '요양병원'],
  });

  assert.deepEqual(criteria.required.roleTags, ['health-manager']);
  assert.deepEqual(criteria.required.qualifications, [DEFAULT_QUALIFICATION]);
  assert.deepEqual(criteria.required.regions, ['서울']);
  assert.equal(criteria.required.weekdayDaytime, true);
  assert.deepEqual(criteria.preferred.employmentTypes, ['정규직']);
  assert.deepEqual(criteria.preferred.experienceLevels, ['신입·무관']);
  assert.deepEqual(criteria.preferred.keywords, ['건강검진']);
  assert.deepEqual(criteria.excluded.workPatterns, ['3교대', '야간']);
  assert.deepEqual(criteria.excluded.keywords, ['요양병원']);
});

test('creates plain-language chips and removes exactly the selected criterion', () => {
  const criteria = profileToSearchCriteria({
    roleTags: ['health-manager'],
    regionCodes: ['서울', '경기'],
    workPatterns: ['상근·주간'],
    excludedKeywords: ['3교대'],
  });
  const chips = criteriaChips(criteria);

  assert.ok(chips.some((chip) => chip.label === '보건관리자' && chip.required));
  assert.ok(chips.some((chip) => chip.label === DEFAULT_QUALIFICATION && chip.required));
  assert.ok(chips.some((chip) => chip.label === '월–금 주간 확인' && chip.required));
  assert.ok(chips.some((chip) => chip.label === '3교대 제외' && chip.group === 'excluded'));

  const seoul = chips.find((chip) => chip.label === '서울');
  const next = removeCriteriaChip(criteria, seoul.id);
  assert.deepEqual(next.required.regions, ['경기']);
  assert.deepEqual(criteria.required.regions, ['서울', '경기']);
});
