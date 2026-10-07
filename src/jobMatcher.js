export const REGION_NAMES = [
  '서울', '경기', '인천', '부산', '대구', '대전', '광주', '울산', '세종',
  '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '해외',
];

export const ROLE_TAGS = [
  'nurse', 'health_manager', 'occupational_nurse', 'clinical_nurse', 'checkup',
  'outpatient', 'ward', 'operating_room', 'intensive_care', 'emergency',
  'dialysis', 'infection_control', 'insurance_review', 'research', 'school_nurse',
];

export const EMPLOYMENT_TYPES = ['regular', 'contract', 'part_time'];
export const EXPERIENCE_LEVELS = ['any', 'entry', 'experienced'];
export const REQUIRED_FIELDS = ['role', 'region', 'employment', 'experience', 'deadline'];

export const ROLE_LABELS = {
  nurse: '간호사',
  health_manager: '보건관리자',
  occupational_nurse: '산업간호사',
  clinical_nurse: '임상 간호',
  checkup: '검진센터',
  outpatient: '외래',
  ward: '병동',
  operating_room: '수술실',
  intensive_care: '중환자실',
  emergency: '응급실',
  dialysis: '인공신장실',
  infection_control: '감염관리',
  insurance_review: '보험심사',
  research: '연구간호',
  school_nurse: '보건교사',
};

export const EMPLOYMENT_LABELS = {
  regular: '정규직',
  contract: '계약직',
  part_time: '시간제',
};

const ROLE_RULES = {
  health_manager: /보건\s*관리|안전\s*보건|산업\s*보건|EHS|SHE/i,
  occupational_nurse: /산업\s*간호|사업장\s*간호|직업\s*건강/i,
  checkup: /검진|건강검진|건강진단/i,
  outpatient: /외래|상담\s*간호/i,
  ward: /병동|입원\s*간호/i,
  operating_room: /수술실|스크럽|마취|회복실|\bOR\b/i,
  intensive_care: /중환자|\bICU\b/i,
  emergency: /응급실|\bER\b/i,
  dialysis: /인공\s*신장|투석/i,
  infection_control: /감염\s*관리|감염\s*전담/i,
  insurance_review: /보험\s*심사|심사\s*간호/i,
  research: /연구\s*간호|임상\s*시험|\bCRC\b|\bCRA\b/i,
  school_nurse: /보건\s*교사|학교\s*간호/i,
  clinical_nurse: /임상\s*간호|병원\s*간호/i,
  nurse: /간호사|간호직|간호\s*채용/i,
};

const STOP_WORDS = new Set([
  '구해줘', '찾아줘', '추천해줘', '추천', '공고', '채용', '일자리', '위주', '정도',
  '상관없어', '상관없이', '괜찮아', '좋겠어', '원해', '하고싶어', '가능한', '가능', '없는', '곳',
  '서울에서', '경기에서', '인천에서', '부산에서', '간호사', '직무', '일', '근무',
]);

const dedupe = (values) => [...new Set(values.filter(Boolean))];
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function normalizedTokens(query) {
  return dedupe(clean(query)
    .replace(/[()[\]{}.,!?/\\:;"']/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/(?:에서|으로|부터|까지|이면|이고|이나|거나|하고|위주로|정도로)$/g, ''))
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token) && !REGION_NAMES.includes(token))
    .filter((token) => !Object.values(ROLE_LABELS).some((label) => token.includes(label.replace(/\s/g, ''))))
    .filter((token) => !/정규직|계약직|기간제|시간제|파트|신입|경력|무관|야간|나이트|교대/.test(token))
  ).slice(0, 8);
}

function buildSummary(intent) {
  const parts = [
    intent.regions.length ? intent.regions.join('·') : '',
    intent.roleTags.length ? intent.roleTags.map((tag) => ROLE_LABELS[tag]).filter(Boolean).join('·') : '',
    intent.employmentTypes.length ? intent.employmentTypes.map((type) => EMPLOYMENT_LABELS[type]).join('·') : '',
    intent.experienceLevel === 'entry' ? '신입·경력무관' : intent.experienceLevel === 'experienced' ? '경력직' : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} 조건으로 추천` : '입력한 문장과 가까운 공고 추천';
}

export function parseLocalIntent(rawQuery) {
  const query = clean(rawQuery).slice(0, 400);
  const compact = query.replace(/\s/g, '');
  const regions = REGION_NAMES.filter((region) => query.includes(region));
  const roleTags = ROLE_TAGS.filter((tag) => ROLE_RULES[tag]?.test(query));

  if (roleTags.some((tag) => !['nurse', 'clinical_nurse'].includes(tag))) {
    const genericIndex = roleTags.indexOf('clinical_nurse');
    if (genericIndex >= 0 && !/임상\s*간호|병원\s*간호/.test(query)) roleTags.splice(genericIndex, 1);
  }

  const employmentTypes = [];
  if (/정규직|공무직/.test(query)) employmentTypes.push('regular');
  if (/계약직|기간제|촉탁직/.test(query) && !/(계약직|기간제).{0,5}(싫|제외|말고|빼)/.test(query)) employmentTypes.push('contract');
  if (/시간제|파트타임|파트\s*간호|아르바이트/.test(query)) employmentTypes.push('part_time');

  let experienceLevel = 'any';
  if (/신입|경력\s*무관|무경력|경력\s*(없|상관)|졸업\s*예정/.test(query)) experienceLevel = 'entry';
  else if (/경력직|경력\s*\d+|\d+년\s*이상|경력\s*간호/.test(query)) experienceLevel = 'experienced';

  const includeKeywords = [];
  const excludeKeywords = [];
  const unresolvedCriteria = [];

  const noShift = /(야간|나이트|밤근무|3교대|교대).{0,8}(없|제외|싫|말고|안\s*하|피하)|주간\s*근무|데이\s*근무|데이만|상근만/.test(query);
  if (noShift) excludeKeywords.push('야간', '나이트', 'N-KEEP', '3교대', '교대근무');
  if (/주간|데이\s*근무|상근/.test(query)) includeKeywords.push(/상근/.test(query) ? '상근' : '주간');
  if (/(계약직|기간제).{0,5}(싫|제외|말고|빼)/.test(query)) excludeKeywords.push('계약직', '기간제');

  const workTerms = ['검진센터', '외래', '병동', '수술실', '중환자실', '응급실', '인공신장실', '감염관리', '보험심사', '연구간호', '보건교사'];
  for (const term of workTerms) if (compact.includes(term.replace(/\s/g, ''))) includeKeywords.push(term);

  if (/연봉|월급|급여|만원/.test(query)) unresolvedCriteria.push('급여는 목록 정보가 부족해 원문 확인이 필요해요');
  if (/출퇴근|통근|분\s*이내|가까운|거리/.test(query)) unresolvedCriteria.push('통근 시간은 주소를 원문에서 확인해 주세요');

  const deadlineMatch = query.match(/(\d+)\s*일\s*이내/);
  const deadlineWithinDays = deadlineMatch ? Math.min(90, Number(deadlineMatch[1])) : /이번\s*주|일주일/.test(query) ? 7 : /마감\s*임박/.test(query) ? 3 : null;
  const requiredFields = [];
  if (/(보건\s*관리자|산업\s*간호사|간호사).{0,4}(만|꼭|필수|무조건|반드시)/.test(query)) requiredFields.push('role');
  if (new RegExp(`(${REGION_NAMES.join('|')}).{0,4}(만|꼭|무조건|반드시)`).test(query)) requiredFields.push('region');
  if (/(정규직|계약직|기간제|시간제).{0,4}(만|꼭|필수|무조건|반드시)/.test(query)) requiredFields.push('employment');
  if (/(신입|경력직|경력\s*무관).{0,4}(만|꼭|필수|무조건|반드시)/.test(query)) requiredFields.push('experience');
  if (/(오늘|\d+\s*일\s*이내|이번\s*주).{0,4}(만|꼭|무조건|반드시)/.test(query)) requiredFields.push('deadline');

  const intent = normalizeIntent({
    summary: '',
    regions,
    roleTags,
    employmentTypes,
    experienceLevel,
    includeKeywords: dedupe([...includeKeywords, ...normalizedTokens(query)]),
    excludeKeywords: dedupe(excludeKeywords),
    deadlineWithinDays,
    unresolvedCriteria,
    requiredFields,
  });
  intent.summary = buildSummary(intent);
  return intent;
}

export function normalizeIntent(value = {}) {
  const regions = dedupe(Array.isArray(value.regions) ? value.regions.filter((region) => REGION_NAMES.includes(region)) : []);
  const roleTags = dedupe(Array.isArray(value.roleTags) ? value.roleTags.filter((role) => ROLE_TAGS.includes(role)) : []);
  const employmentTypes = dedupe(Array.isArray(value.employmentTypes) ? value.employmentTypes.filter((type) => EMPLOYMENT_TYPES.includes(type)) : []);
  const experienceLevel = EXPERIENCE_LEVELS.includes(value.experienceLevel) ? value.experienceLevel : 'any';
  const deadline = value.deadlineWithinDays === null || value.deadlineWithinDays === undefined || value.deadlineWithinDays === '' ? Number.NaN : Number(value.deadlineWithinDays);
  const normalized = {
    summary: clean(value.summary).slice(0, 160),
    regions,
    roleTags,
    employmentTypes,
    experienceLevel,
    includeKeywords: dedupe(Array.isArray(value.includeKeywords) ? value.includeKeywords.map(clean).filter(Boolean).slice(0, 10) : []),
    excludeKeywords: dedupe(Array.isArray(value.excludeKeywords) ? value.excludeKeywords.map(clean).filter(Boolean).slice(0, 10) : []),
    deadlineWithinDays: Number.isFinite(deadline) ? Math.max(0, Math.min(90, Math.round(deadline))) : null,
    unresolvedCriteria: dedupe(Array.isArray(value.unresolvedCriteria) ? value.unresolvedCriteria.map(clean).filter(Boolean).slice(0, 5) : []),
    requiredFields: dedupe(Array.isArray(value.requiredFields) ? value.requiredFields.filter((field) => REQUIRED_FIELDS.includes(field)) : []),
  };
  if (!normalized.summary) normalized.summary = buildSummary(normalized);
  return normalized;
}

function employmentsOf(job) {
  const text = `${job.employmentType || ''} ${job.employment || ''} ${job.title || ''}`;
  const regularText = text.replace(/비정규직/g, '');
  const values = [];
  if (/정규직|공무직/.test(regularText)) values.push('regular');
  if (/계약직|기간제|촉탁직|파견직/.test(text)) values.push('contract');
  if (/시간제|파트타임|아르바이트/.test(text)) values.push('part_time');
  return dedupe(values);
}

function experienceOf(job) {
  const title = String(job.title || '');
  // 수집된 메타데이터와 제목이 충돌하면 사용자가 직접 보는 제목의 명시 조건을 우선한다.
  if (/신입|경력\s*무관|신입\s*[·/&]\s*경력/.test(title)) return 'entry';
  if (/경력\s*(직|사원|직원|자|간호)|경력\s*\d+|\d+년\s*이상|\d+년↑/.test(title)) return 'experienced';
  const text = `${job.experienceLevel || ''} ${job.experience || ''}`;
  if (/신입|경력\s*무관|무관|졸업\s*예정/.test(text)) return 'entry';
  if (/경력|\d+년\s*이상|\d+년↑/.test(text)) return 'experienced';
  return null;
}

function deadlineDays(job) {
  const text = String(job.deadline || '');
  const dDay = text.match(/D-(\d+)/i);
  if (dDay) return Number(dDay[1]);
  if (/오늘\s*마감/.test(text)) return 0;
  if (job.deadlineAt) {
    const deadline = new Date(job.deadlineAt);
    if (!Number.isNaN(deadline.getTime())) return Math.ceil((deadline.getTime() - Date.now()) / 86_400_000);
  }
  return null;
}

function roleMatchQuality(job, role) {
  const directText = `${job.title || ''} ${job.role || ''}`;
  const sectorText = (job.sectors || []).join(' ');
  const tags = new Set(job.roleTags || []);
  const tagAliases = {
    nurse: ['간호사'], health_manager: ['health-manager', '보건관리자', '보건직'],
    occupational_nurse: ['occupational-nurse', '산업간호사'], clinical_nurse: ['clinical-nurse', '임상간호'],
    school_nurse: ['school-nurse', '보건교사'],
  };
  const tagged = tags.has(role) || tagAliases[role]?.some((tag) => tags.has(tag));

  // 제목/직무에 직접 드러난 역할을 우선하고, 채용 사이트의 모집분야 태그는
  // 여러 직군이 한 공고에 섞일 수 있으므로 약한 근거로만 사용한다.
  if (role === 'clinical_nurse') {
    if (/간호사|간호직|임상\s*간호|병원\s*간호/i.test(directText)) return 2;
    return job.category === 'clinical' || tagged || /간호사|간호직|임상\s*간호/i.test(sectorText) ? 1 : 0;
  }
  if (role === 'nurse') {
    if (/간호사|간호직|간호\s*채용|산업\s*간호/i.test(directText)) return 2;
    return tagged || /간호사|간호직|산업\s*간호/i.test(sectorText) ? 1 : 0;
  }
  if (ROLE_RULES[role]?.test(directText)) return 2;
  return tagged || ROLE_RULES[role]?.test(sectorText) ? 1 : 0;
}

export function scoreJob(job, rawIntent) {
  const intent = normalizeIntent(rawIntent);
  const haystack = clean(`${job.title || ''} ${job.company || ''} ${job.role || ''} ${(job.sectors || []).join(' ')} ${job.source || ''}`);
  const compactHaystack = haystack.replace(/\s/g, '').toLowerCase();
  let score = 10;
  let hardMismatch = false;
  const reasons = [];
  const cautions = [];

  if (intent.regions.length) {
    const matchedRegion = intent.regions.find((region) => String(job.region || '').includes(region));
    if (matchedRegion) { score += 24; reasons.push(`${matchedRegion} 근무`); }
    else { score -= 28; cautions.push('희망 지역과 다름'); if (intent.requiredFields.includes('region')) hardMismatch = true; }
  }

  if (intent.roleTags.length) {
    const roleMatches = intent.roleTags
      .map((role) => ({ role, quality: roleMatchQuality(job, role) }))
      .filter(({ quality }) => quality > 0);
    const matchedRoles = roleMatches.map(({ role }) => role);
    if (matchedRoles.length) {
      const strongestRoleEvidence = Math.max(...roleMatches.map(({ quality }) => quality));
      score += Math.min(38, (strongestRoleEvidence === 2 ? 32 : 18) + (matchedRoles.length - 1) * 3);
      reasons.push(...matchedRoles.slice(0, 2).map((role) => ROLE_LABELS[role]));
      if (strongestRoleEvidence === 1) cautions.push('모집분야에 포함 · 상세 역할 원문 확인');
    } else { score -= 32; cautions.push('희망 직무와 다름'); if (intent.requiredFields.includes('role')) hardMismatch = true; }
  }

  if (intent.employmentTypes.length) {
    const employments = employmentsOf(job);
    const employment = employments.find((type) => intent.employmentTypes.includes(type));
    if (employment) { score += 15; reasons.push(EMPLOYMENT_LABELS[employment]); }
    else if (employments.length) { score -= 14; cautions.push('고용형태 조건과 다름'); if (intent.requiredFields.includes('employment')) hardMismatch = true; }
    else cautions.push('고용형태 원문 확인');
  }

  if (intent.experienceLevel !== 'any') {
    const experience = experienceOf(job);
    if (experience === intent.experienceLevel || (intent.experienceLevel === 'entry' && experience === null)) {
      score += 9;
      if (experience) reasons.push(experience === 'entry' ? '신입·경력무관' : '경력직');
    } else if (experience) { score -= 8; cautions.push('경력 조건과 다름'); if (intent.requiredFields.includes('experience')) hardMismatch = true; }
    else cautions.push('경력조건 원문 확인');
  }

  let keywordMatches = 0;
  for (const keyword of intent.includeKeywords) {
    const normalized = keyword.replace(/\s/g, '').toLowerCase();
    if (normalized.length >= 2 && compactHaystack.includes(normalized)) {
      keywordMatches += 1;
      if (reasons.length < 4) reasons.push(keyword);
    }
  }
  score += Math.min(18, keywordMatches * 6);

  const blocked = intent.excludeKeywords.filter((keyword) => compactHaystack.includes(keyword.replace(/\s/g, '').toLowerCase()));
  if (blocked.length) {
    score -= 70;
    cautions.push(`제외 조건 포함: ${blocked.slice(0, 2).join('·')}`);
  } else if (intent.excludeKeywords.length) {
    cautions.push('제외 조건 여부 원문 확인');
  }

  if (intent.deadlineWithinDays !== null) {
    const days = deadlineDays(job);
    if (days !== null && days <= intent.deadlineWithinDays) { score += 8; reasons.push(`마감 D-${days}`); }
    else if (days !== null) { score -= 8; if (intent.requiredFields.includes('deadline')) hardMismatch = true; }
    else cautions.push('마감일 원문 확인');
  }

  const finalScore = Math.max(0, Math.min(100, score));
  return {
    job,
    score: finalScore,
    reasons: dedupe(reasons).slice(0, 4),
    cautions: dedupe(cautions).slice(0, 3),
    matched: !blocked.length && !hardMismatch && finalScore >= 22,
  };
}

export function rankJobs(jobs, intent) {
  return jobs.map((job, index) => ({ ...scoreJob(job, intent), index }))
    .filter((result) => result.matched)
    .sort((a, b) => b.score - a.score || (deadlineDays(a.job) ?? 999) - (deadlineDays(b.job) ?? 999) || a.index - b.index);
}

export const JOB_INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'regions', 'roleTags', 'employmentTypes', 'experienceLevel', 'includeKeywords', 'excludeKeywords', 'deadlineWithinDays', 'unresolvedCriteria', 'requiredFields'],
  properties: {
    summary: { type: 'string', description: '사용자가 이해하기 쉬운 한 문장 검색 조건 요약' },
    regions: { type: 'array', items: { type: 'string', enum: REGION_NAMES } },
    roleTags: { type: 'array', items: { type: 'string', enum: ROLE_TAGS } },
    employmentTypes: { type: 'array', items: { type: 'string', enum: EMPLOYMENT_TYPES } },
    experienceLevel: { type: 'string', enum: EXPERIENCE_LEVELS },
    includeKeywords: { type: 'array', items: { type: 'string' } },
    excludeKeywords: { type: 'array', items: { type: 'string' } },
    deadlineWithinDays: { type: ['integer', 'null'], minimum: 0, maximum: 90 },
    unresolvedCriteria: { type: 'array', items: { type: 'string' } },
    requiredFields: { type: 'array', items: { type: 'string', enum: REQUIRED_FIELDS } },
  },
};
