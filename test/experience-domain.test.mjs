import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPERIENCE_DOMAIN, classifyExperienceDomain } from '../lib/experience-domain.mjs';

test('exports the stable experience-domain values', () => {
  assert.deepEqual(EXPERIENCE_DOMAIN, {
    CLINICAL: 'clinical',
    HEALTH_MANAGER: 'health-manager',
    NURSING_GENERAL: 'nursing-general',
    UNSPECIFIED: 'unspecified',
  });
});

test('classifies explicit clinical experience from detail fields', () => {
  for (const fields of [
    { qualifications: '간호사 면허 소지자, 임상 경력 2년 이상' },
    { experience: '병동 간호 경력 3년 이상' },
    { description: '<p>우대사항: 중환자실 근무경력 1년 이상</p>' },
    { duties: ['기본 간호', '수술실 경험 필수'] },
  ]) {
    const result = classifyExperienceDomain(fields);
    assert.equal(result.domain, EXPERIENCE_DOMAIN.CLINICAL);
    assert.equal(result.evidence.strength, 'explicit-detail');
    assert.match(result.evidence.excerpt, /임상|병동|중환자실|수술실/);
  }
});

test('classifies explicit occupational-health experience from detail fields', () => {
  for (const fields of [
    { qualifications: '산업보건 실무경력 2년 이상 우대' },
    { experienceRequirements: '보건관리자 경력 3년' },
    { requirements: '사업장 간호 경험이 있는 분' },
    { preferredQualifications: '건강관리실 근무경력 우대' },
  ]) {
    const result = classifyExperienceDomain(fields);
    assert.equal(result.domain, EXPERIENCE_DOMAIN.HEALTH_MANAGER);
    assert.equal(result.evidence.strength, 'explicit-detail');
    assert.match(result.evidence.excerpt, /산업보건|보건관리자|사업장 간호|건강관리실/);
  }
});

test('classifies nursing experience without an asserted specialty as nursing-general', () => {
  for (const fields of [
    { experience: '간호사 경력 3년 이상' },
    { qualifications: '간호업무 실무경력 우대' },
    { requirements: '경력 간호사 지원 가능' },
  ]) {
    const result = classifyExperienceDomain(fields);
    assert.equal(result.domain, EXPERIENCE_DOMAIN.NURSING_GENERAL);
    assert.equal(result.evidence.strength, 'explicit-detail');
    assert.match(result.evidence.excerpt, /간호/);
  }
});

test('uses title-context only when the title itself directly binds role and career wording', () => {
  const health = classifyExperienceDomain({ title: '제조업 보건관리자 경력직 채용' });
  assert.deepEqual(health, {
    domain: EXPERIENCE_DOMAIN.HEALTH_MANAGER,
    evidence: {
      field: 'title',
      excerpt: '제조업 보건관리자 경력직 채용',
      strength: 'title-context',
    },
  });

  const clinical = classifyExperienceDomain({ title: '병동 경력 간호사 모집' });
  assert.equal(clinical.domain, EXPERIENCE_DOMAIN.CLINICAL);
  assert.equal(clinical.evidence.strength, 'title-context');
});

test('never combines a target role in one field with generic career metadata in another', () => {
  for (const fields of [
    { title: '보건관리자 채용', experience: '경력 2년 이상' },
    { roleTags: ['보건관리자'], experience: '경력 3년' },
    { duties: '사업장 보건관리 업무 담당', experience: '경력직' },
    { title: '병동 간호사 채용', experienceLevel: '경력' },
  ]) {
    assert.deepEqual(classifyExperienceDomain(fields), {
      domain: EXPERIENCE_DOMAIN.UNSPECIFIED,
      evidence: null,
    });
  }
});

test('does not bridge separate clauses inside the same field', () => {
  for (const description of [
    '담당업무: 보건관리. 지원자격: 경력 2년 이상.',
    '병동 간호 업무를 담당합니다.\n경력 3년 이상 우대',
    '<p>산업보건 업무 담당</p><p>경력 1년 이상</p>',
  ]) {
    assert.equal(classifyExperienceDomain({ description }).domain, EXPERIENCE_DOMAIN.UNSPECIFIED);
  }
});

test('does not treat a license next to generic years as nursing experience evidence', () => {
  const result = classifyExperienceDomain({ qualifications: '간호사 면허 소지자, 경력 2년 이상' });
  assert.deepEqual(result, { domain: EXPERIENCE_DOMAIN.UNSPECIFIED, evidence: null });
});

test('returns unspecified when explicit clinical and health-manager requirements conflict', () => {
  for (const fields of [
    { qualifications: '임상 경력 2년 또는 산업보건 경력 1년 이상' },
    { experience: '병동 경력 3년', preferredQualifications: '보건관리자 경력 우대' },
  ]) {
    assert.deepEqual(classifyExperienceDomain(fields), {
      domain: EXPERIENCE_DOMAIN.UNSPECIFIED,
      evidence: null,
    });
  }
});

test('explicit detail evidence takes precedence over weaker title context', () => {
  const result = classifyExperienceDomain({
    title: '보건관리자 경력직 채용',
    qualifications: '임상 경력 2년 이상 필수',
  });
  assert.equal(result.domain, EXPERIENCE_DOMAIN.CLINICAL);
  assert.equal(result.evidence.field, 'qualifications');
  assert.equal(result.evidence.strength, 'explicit-detail');
});

test('specific detail evidence wins over generic nursing evidence', () => {
  const result = classifyExperienceDomain({
    experience: '임상 경력 3년',
    qualifications: '간호사 경력자 우대',
  });
  assert.equal(result.domain, EXPERIENCE_DOMAIN.CLINICAL);
  assert.equal(result.evidence.field, 'experience');
});

test('returns unspecified for empty, malformed, and generic-only inputs', () => {
  for (const fields of [undefined, null, [], {}, { experience: '경력무관' }, { experience: '경력 5년 이상' }]) {
    assert.deepEqual(classifyExperienceDomain(fields), {
      domain: EXPERIENCE_DOMAIN.UNSPECIFIED,
      evidence: null,
    });
  }
});

test('keeps long evidence excerpts bounded while retaining the matched phrase', () => {
  const result = classifyExperienceDomain({
    description: `${'안내 '.repeat(50)}산업간호사 경력 2년 이상${' 우대'.repeat(50)}`,
  });
  assert.equal(result.domain, EXPERIENCE_DOMAIN.HEALTH_MANAGER);
  assert.ok(result.evidence.excerpt.length <= 142);
  assert.match(result.evidence.excerpt, /산업간호사 경력/);
});
