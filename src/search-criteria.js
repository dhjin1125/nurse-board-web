export const SEARCH_CRITERIA_VERSION = 2;

export const DEFAULT_QUALIFICATION = '간호사 면허';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const uniqueStrings = (value) => Array.isArray(value)
  ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  : [];

const ROLE_ALIASES = Object.freeze({
  health_manager: 'health-manager',
  occupational_nurse: 'occupational-nurse',
  clinical_nurse: 'clinical-nurse',
  보건관리자: 'health-manager',
  산업간호사: 'occupational-nurse',
  '임상 간호사': 'clinical-nurse',
});

const EMPLOYMENT_ALIASES = Object.freeze({
  regular: '정규직',
  contract: '계약직',
  part_time: '시간제',
});

const ROLE_LABELS = Object.freeze({
  'health-manager': '보건관리자',
  'occupational-nurse': '산업간호사',
  'clinical-nurse': '임상 간호사',
});

export function createSearchCriteria(overrides = {}) {
  const value = isRecord(overrides) ? overrides : {};
  return normalizeSearchCriteria({
    version: SEARCH_CRITERIA_VERSION,
    query: '',
    required: {
      roleTags: [],
      qualifications: [DEFAULT_QUALIFICATION],
      regions: [],
      weekdayDaytime: true,
    },
    preferred: {
      employmentTypes: [],
      experienceLevels: [],
      salaryMinimum: null,
      keywords: [],
    },
    excluded: {
      workPatterns: ['교대', '야간'],
      keywords: [],
    },
    ...value,
  });
}

function normalizeRole(value) {
  const role = String(value || '').trim();
  return ROLE_ALIASES[role] || role;
}

function finiteNumberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizeSearchCriteria(value = {}) {
  const input = isRecord(value) ? value : {};
  const required = isRecord(input.required) ? input.required : {};
  const preferred = isRecord(input.preferred) ? input.preferred : {};
  const excluded = isRecord(input.excluded) ? input.excluded : {};
  const roleTags = uniqueStrings(required.roleTags ?? input.roleTags).map(normalizeRole);
  const qualifications = uniqueStrings(required.qualifications ?? input.qualifications);
  const regions = uniqueStrings(required.regions ?? input.regions ?? input.regionCodes);
  return {
    version: SEARCH_CRITERIA_VERSION,
    query: String(input.query || '').trim().slice(0, 300),
    required: {
      roleTags,
      qualifications: qualifications.length ? qualifications : [DEFAULT_QUALIFICATION],
      regions,
      weekdayDaytime: required.weekdayDaytime !== false,
    },
    preferred: {
      employmentTypes: uniqueStrings(preferred.employmentTypes ?? input.employmentTypes)
        .map((item) => EMPLOYMENT_ALIASES[item] || item),
      experienceLevels: uniqueStrings(preferred.experienceLevels ?? input.experienceLevels),
      salaryMinimum: finiteNumberOrNull(preferred.salaryMinimum),
      keywords: uniqueStrings(preferred.keywords ?? input.preferredKeywords),
    },
    excluded: {
      workPatterns: uniqueStrings(excluded.workPatterns ?? input.excludedWorkPatterns),
      keywords: uniqueStrings(excluded.keywords ?? input.excludedKeywords),
    },
  };
}

export function profileToSearchCriteria(profile = {}) {
  const hasExplicitWeekdayPreference = Object.prototype.hasOwnProperty.call(profile, 'requiredWeekdayDaytime');
  const workPatterns = uniqueStrings(profile.workPatterns);
  const excludedWorkPatterns = uniqueStrings(profile.excludedWorkPatterns);
  if (workPatterns.includes('3교대 제외')) excludedWorkPatterns.push('3교대');
  if (workPatterns.includes('2교대 제외')) excludedWorkPatterns.push('2교대');
  for (const keyword of uniqueStrings(profile.excludedKeywords)) {
    if (/야간|나이트|night/i.test(keyword)) excludedWorkPatterns.push('야간');
    if (/교대/.test(keyword)) excludedWorkPatterns.push(keyword.replace(/\s*제외$/, ''));
  }
  return normalizeSearchCriteria({
    required: {
      roleTags: profile.roleTags,
      qualifications: profile.qualifications,
      regions: profile.regionCodes,
      weekdayDaytime: hasExplicitWeekdayPreference
        ? profile.requiredWeekdayDaytime !== false
        : workPatterns.includes('상근·주간'),
    },
    preferred: {
      employmentTypes: profile.employmentTypes,
      experienceLevels: profile.experienceLevels,
      salaryMinimum: profile.salaryMinimum,
      keywords: profile.preferredKeywords,
    },
    excluded: {
      workPatterns: excludedWorkPatterns,
      keywords: uniqueStrings(profile.excludedKeywords)
        .filter((keyword) => !/야간|나이트|night|교대/i.test(keyword)),
    },
  });
}

export function searchCriteriaToProfile(criteria, current = {}) {
  const normalized = normalizeSearchCriteria(criteria);
  return {
    ...current,
    roleTags: normalized.required.roleTags,
    qualifications: normalized.required.qualifications,
    regionCodes: normalized.required.regions,
    requiredWeekdayDaytime: normalized.required.weekdayDaytime,
    employmentTypes: normalized.preferred.employmentTypes,
    experienceLevels: normalized.preferred.experienceLevels,
    preferredKeywords: normalized.preferred.keywords,
    excludedWorkPatterns: normalized.excluded.workPatterns,
    excludedKeywords: normalized.excluded.keywords,
    workPatterns: normalized.required.weekdayDaytime ? ['상근·주간'] : [],
  };
}

export function intentToSearchCriteria(intent = {}, current) {
  const base = normalizeSearchCriteria(current || {});
  const workPatterns = [...base.excluded.workPatterns];
  const excludedKeywords = [];
  for (const keyword of uniqueStrings(intent.excludeKeywords)) {
    if (/3\s*교대|삼교대/.test(keyword)) workPatterns.push('3교대');
    else if (/2\s*교대|이교대/.test(keyword)) workPatterns.push('2교대');
    else if (/야간|나이트|night/i.test(keyword)) workPatterns.push('야간');
    else if (/당직|온\s*콜|on[ -]?call/i.test(keyword)) workPatterns.push('당직·온콜');
    else excludedKeywords.push(keyword);
  }
  const experience = String(intent.experienceLevel || 'any');
  return normalizeSearchCriteria({
    ...base,
    query: intent.query || base.query,
    required: {
      ...base.required,
      roleTags: uniqueStrings(intent.roleTags).length ? intent.roleTags : base.required.roleTags,
      regions: uniqueStrings(intent.regions).length ? intent.regions : base.required.regions,
      weekdayDaytime: /주간|상근|월\s*[~\-–—]\s*금|주\s*5\s*일/.test(`${intent.summary || ''} ${uniqueStrings(intent.includeKeywords).join(' ')}`)
        ? true
        : base.required.weekdayDaytime,
    },
    preferred: {
      ...base.preferred,
      employmentTypes: uniqueStrings(intent.employmentTypes).length ? intent.employmentTypes : base.preferred.employmentTypes,
      experienceLevels: experience === 'entry' ? ['신입·무관'] : experience === 'experienced' ? ['경력'] : base.preferred.experienceLevels,
      keywords: [...base.preferred.keywords, ...uniqueStrings(intent.includeKeywords)],
    },
    excluded: {
      workPatterns: [...new Set(workPatterns)],
      keywords: [...base.excluded.keywords, ...excludedKeywords],
    },
  });
}

export function criteriaToLegacyFilters(criteria, current = {}) {
  const normalized = normalizeSearchCriteria(criteria);
  return {
    ...current,
    query: normalized.query || current.query || '',
    region: normalized.required.regions.length === 1 ? normalized.required.regions[0] : '전체',
    employment: normalized.preferred.employmentTypes.length === 1 ? normalized.preferred.employmentTypes[0] : '전체',
    experience: normalized.preferred.experienceLevels.length === 1 ? normalized.preferred.experienceLevels[0] : '전체',
    workPattern: normalized.required.weekdayDaytime ? '주중·주간 확인' : '전체',
  };
}

export function criteriaChips(criteria) {
  const value = normalizeSearchCriteria(criteria);
  const chips = [];
  const add = (group, field, raw, label, required = false) => chips.push({ id: `${group}.${field}:${raw}`, group, field, value: raw, label, required });
  value.required.roleTags.forEach((role) => add('required', 'roleTags', role, ROLE_LABELS[role] || role, true));
  value.required.qualifications.forEach((qualification) => add('required', 'qualifications', qualification, qualification, true));
  value.required.regions.forEach((region) => add('required', 'regions', region, region, true));
  if (value.required.weekdayDaytime) add('required', 'weekdayDaytime', 'true', '월–금 주간 확인', true);
  value.preferred.employmentTypes.forEach((item) => add('preferred', 'employmentTypes', item, item));
  value.preferred.experienceLevels.forEach((item) => add('preferred', 'experienceLevels', item, item));
  if (value.preferred.salaryMinimum != null) add('preferred', 'salaryMinimum', String(value.preferred.salaryMinimum), `급여 ${value.preferred.salaryMinimum.toLocaleString('ko-KR')}원 이상`);
  value.preferred.keywords.forEach((item) => add('preferred', 'keywords', item, item));
  value.excluded.workPatterns.forEach((item) => add('excluded', 'workPatterns', item, `${item} 제외`));
  value.excluded.keywords.forEach((item) => add('excluded', 'keywords', item, `${item} 제외`));
  return chips;
}

export function removeCriteriaChip(criteria, chipId) {
  const normalized = normalizeSearchCriteria(criteria);
  const chip = criteriaChips(normalized).find((item) => item.id === chipId);
  if (!chip) return normalized;
  if (chip.field === 'weekdayDaytime') return normalizeSearchCriteria({ ...normalized, required: { ...normalized.required, weekdayDaytime: false } });
  if (chip.field === 'salaryMinimum') return normalizeSearchCriteria({ ...normalized, preferred: { ...normalized.preferred, salaryMinimum: null } });
  const group = { ...normalized[chip.group] };
  group[chip.field] = group[chip.field].filter((item) => item !== chip.value);
  return normalizeSearchCriteria({ ...normalized, [chip.group]: group });
}
