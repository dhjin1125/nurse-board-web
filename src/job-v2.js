import { DEFAULT_QUALIFICATION, normalizeSearchCriteria } from './search-criteria.js';

export const NORMALIZED_JOB_SCHEMA_VERSION = 2;
export const MATCH_RESULT_SCHEMA_VERSION = 2;

export const MATCH_STATUS = Object.freeze({
  MATCHED: 'matched',
  UNKNOWN: 'unknown',
  MISMATCHED: 'mismatched',
});

export const MATCH_OUTCOME = Object.freeze({
  CONFIRMED: 'confirmed',
  NEEDS_REVIEW: 'needs_review',
  MISMATCHED: 'mismatched',
});

const UNKNOWN_TEXT = /^(?:|[-·]|(?:원문|공고|정보|상세)\s*(?:확인|미표기|없음|필요)|미표기|미확인|unknown|not\s+specified|n\/?a)$/i;
const ROLE_PATTERNS = Object.freeze({
  'health-manager': /보건\s*관리(?:자|직|담당)?|health[ -]?manager/i,
  'occupational-nurse': /산업\s*(?:간호|보건)|사업장\s*간호|occupational[ -]?(?:health|nurse)/i,
  'clinical-nurse': /병동|외래|수술실|중환자실|응급실|임상\s*간호|clinical[ -]?nurse/i,
});
const ROLE_LABELS = Object.freeze({
  'health-manager': '보건관리자',
  'occupational-nurse': '산업간호사',
  'clinical-nurse': '임상 간호사',
});
const REGION_NAMES = ['서울', '경기', '인천', '부산', '대구', '대전', '광주', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const known = (value) => {
  const text = clean(value);
  return text && !UNKNOWN_TEXT.test(text) ? text : '';
};
const unique = (values) => [...new Set(values.filter(Boolean))];

function evidence(field, raw, job, checkedAt) {
  const excerpt = known(raw);
  if (!excerpt) return null;
  return {
    field,
    excerpt: excerpt.slice(0, 500),
    sourceUrl: known(job?.url) || null,
    checkedAt: checkedAt || job?.detailCheckedAt || job?.lastSeenAt || null,
  };
}

function sourceText(job) {
  const fields = [
    ['title', job?.title],
    ['qualifications', job?.qualifications],
    ['requirements', job?.requirements],
    ['preferredQualifications', job?.preferredQualifications],
    ['workConditions', job?.workConditions],
    ['workHours', job?.workHours],
    ['schedule', typeof job?.schedule === 'string' ? job.schedule : ''],
    ['description', job?.description],
    ['duties', job?.duties],
  ];
  return { fields, text: fields.map(([, value]) => known(value)).filter(Boolean).join(' · ') };
}

function firstEvidence(job, matcher, preferredFields = []) {
  const { fields } = sourceText(job);
  const ordered = [...preferredFields.flatMap((name) => fields.filter(([field]) => field === name)), ...fields.filter(([field]) => !preferredFields.includes(field))];
  const found = ordered.find(([, value]) => matcher.test(known(value)));
  return found ? evidence(found[0], found[1], job) : null;
}

function parseClock(hourValue, minuteValue = '0') {
  const hour = Number(hourValue);
  const minute = Number(minuteValue || 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 24 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseClockWithPeriod(period, hourValue, minuteValue = '0') {
  let hour = Number(hourValue);
  if (period === '오후' && hour < 12) hour += 12;
  if (period === '오전' && hour === 12) hour = 0;
  return parseClock(hour, minuteValue);
}

function minutes(clock) {
  const [hour, minute] = String(clock || '').split(':').map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

export function parseSchedule(job = {}) {
  if (isRecord(job.schedule) && job.schedule.version === 2) return job.schedule;
  const { fields, text: raw } = sourceText(job);
  const text = `${known(job.workPattern)} ${raw}`.trim();
  const weekdayPattern = /(?:월\s*(?:~|〜|∼|-|–|—|부터)\s*금)|(?:주\s*5\s*일)|(?:평일\s*(?:근무)?)/i;
  const negativeEnding = '(?:없(?:음|습니다|다)?|제외|미실시|하지\\s*않(?:음|습니다|는다)?|안\\s*(?:함|합니다)|아님|[xX])';
  const particle = '(?:은|는|이|가|을|를)?';
  const noRotationAndNightPattern = new RegExp(`(?:교대(?:\\s*근무)?\\s*(?:및|[·,/&+])\\s*야간|야간\\s*(?:및|[·,/&+])\\s*교대(?:\\s*근무)?)\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noThreeShiftPattern = new RegExp(`(?:3\\s*교대|삼교대)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noTwoShiftPattern = new RegExp(`(?:2\\s*교대|이교대)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noRotationPattern = new RegExp(`(?:교대\\s*근무|교대근무|교대제|교대)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noNightPattern = new RegExp(`(?:야간|나이트|night)(?:\\s*(?:전담|근무|당직))?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noOnCallPattern = new RegExp(`(?:당직|온\\s*콜|on[ -]?call)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noWeekendPattern = new RegExp(`(?:(?:주말|토(?:요일)?(?:\\s*(?:및|[·,/&])\\s*일(?:요일)?)?)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}|(?:주말|토(?:요일)?\\s*(?:및|[·,/&])\\s*일(?:요일)?)\\s*(?:휴무|off))`, 'i');
  const nonRotationTermPattern = /비\s*교대(?:\s*근무)?/i;
  const scrubbed = text
    .replace(new RegExp(noRotationAndNightPattern.source, 'gi'), ' ')
    .replace(new RegExp(noThreeShiftPattern.source, 'gi'), ' ')
    .replace(new RegExp(noTwoShiftPattern.source, 'gi'), ' ')
    .replace(new RegExp(noRotationPattern.source, 'gi'), ' ')
    .replace(new RegExp(noNightPattern.source, 'gi'), ' ')
    .replace(new RegExp(noOnCallPattern.source, 'gi'), ' ')
    .replace(new RegExp(noWeekendPattern.source, 'gi'), ' ')
    .replace(new RegExp(nonRotationTermPattern.source, 'gi'), ' ');
  const weekendPattern = /주말\s*(?:및\s*)?(?:포함|근무)|(?:월\s*\d+\s*회|격주)\s*토(?:요일)?|토(?:요일)?\s*(?:월\s*\d+\s*회|격주|근무|포함)|(?:^|[\s,·])일(?:요일)?\s*(?:근무|포함)/i;
  const threeShiftPattern = /(?:3\s*교대|삼교대|D\s*[\/·,+]\s*E\s*[\/·,+]\s*N|데이\s*[\/·,+]\s*이브닝\s*[\/·,+]\s*나이트)/i;
  const twoShiftPattern = /(?:2\s*교대|이교대|D\s*[\/·,+]\s*E)(?!\s*[\/·,+]\s*N)|E\s*[\/·,+]\s*N/i;
  const nightPattern = /(?:N[-_ ]?KEEP|나이트\s*(?:전담|근무|당직|포함)|야간(?:\s*(?:전담|근무|당직|포함|있음|발생)|\s*(?:월|주)\s*\d+\s*회)|night\s*(?:only|shift|work)|(?:^|\s)N\s*근무|22\s*:\s*\d{2}\s*(?:~|-|–|—)\s*(?:익일\s*)?0?[5-9]\s*:\s*\d{2}|주주야야비비)/i;
  const onCallPattern = /당직|온\s*콜|on[ -]?call/i;

  const timePattern = /(?:(오전|오후)\s*)?(\d{1,2})(?:\s*[:시]\s*(\d{2})?\s*분?)?\s*(?:~|〜|∼|-|–|—|부터)\s*(?:(오전|오후)\s*)?(\d{1,2})(?:\s*[:시]\s*(\d{2})?\s*분?)?/i;
  const timeMatch = text.match(timePattern);
  let startTime = '';
  let endTime = '';
  if (timeMatch) {
    startTime = parseClockWithPeriod(timeMatch[1], timeMatch[2], timeMatch[3]);
    endTime = parseClockWithPeriod(timeMatch[4], timeMatch[5], timeMatch[6]);
  }
  const startMinutes = minutes(startTime);
  const endMinutes = minutes(endTime);
  const daytimeRange = startMinutes != null && endMinutes != null
    && startMinutes >= 6 * 60 && startMinutes <= 10 * 60 + 30
    && endMinutes >= 15 * 60 && endMinutes <= 20 * 60
    && endMinutes > startMinutes;
  const hasWeekdays = weekdayPattern.test(text);
  const weekendRequired = weekendPattern.test(scrubbed);
  const threeShift = threeShiftPattern.test(scrubbed);
  const twoShift = twoShiftPattern.test(scrubbed);
  const night = nightPattern.test(scrubbed);
  const onCall = onCallPattern.test(scrubbed);
  const shift = threeShift || twoShift || /(?:^|[^비])교대(?:\s*근무|근무|제|근무제)?/i.test(scrubbed)
    || /주주야야비비|주야비|주야\s*교대/i.test(scrubbed);
  const combinedNoRotation = noRotationAndNightPattern.test(text);
  const explicitlyNoRotation = nonRotationTermPattern.test(text) || combinedNoRotation
    || noRotationPattern.test(text) && !noThreeShiftPattern.test(text) && !noTwoShiftPattern.test(text);
  const explicitlyNoNight = combinedNoRotation || noNightPattern.test(text);
  const explicitlyNoOnCall = noOnCallPattern.test(text);
  const explicitlyNoWeekend = noWeekendPattern.test(text);
  const weekdayStatus = weekendRequired ? 'mismatched' : hasWeekdays ? 'confirmed' : 'unknown';
  const daytimeStatus = shift || night || onCall ? 'mismatched' : daytimeRange ? 'confirmed' : 'unknown';
  const weekdayDaytimeStatus = weekdayStatus === 'mismatched' || daytimeStatus === 'mismatched'
    ? 'mismatched'
    : weekdayStatus === 'confirmed' && daytimeStatus === 'confirmed' ? 'confirmed' : 'unknown';
  const strictDaySchedule = weekdayStatus === 'confirmed' && daytimeStatus === 'confirmed';
  const scheduleEvidence = fields
    .filter(([, value]) => weekdayPattern.test(known(value)) || timePattern.test(known(value)) || threeShiftPattern.test(known(value)) || twoShiftPattern.test(known(value)) || nightPattern.test(known(value)) || onCallPattern.test(known(value)) || weekendPattern.test(known(value)) || noRotationPattern.test(known(value)) || noRotationAndNightPattern.test(known(value)) || nonRotationTermPattern.test(known(value)))
    .map(([field, value]) => evidence(field, value, job))
    .filter(Boolean)
    .slice(0, 5);
  return {
    version: 2,
    days: hasWeekdays && !weekendRequired ? ['월', '화', '수', '목', '금'] : [],
    startTime: startTime || null,
    endTime: endTime || null,
    weekdayStatus,
    daytimeStatus,
    weekdayDaytimeStatus,
    shift: shift ? true : explicitlyNoRotation || strictDaySchedule ? false : null,
    night: night || threeShift ? true : explicitlyNoNight || strictDaySchedule ? false : null,
    onCall: onCall ? true : explicitlyNoOnCall ? false : null,
    weekend: weekendRequired ? true : explicitlyNoWeekend ? false : null,
    kind: threeShift ? 'three_shift' : twoShift ? 'two_shift' : night ? 'night' : weekdayDaytimeStatus === 'confirmed' ? 'weekday_daytime' : known(job.workPattern) || null,
    raw: scheduleEvidence.map((item) => item.excerpt).join(' · ').slice(0, 1000) || null,
    evidence: scheduleEvidence,
  };
}

function normalizeQualification(value) {
  return clean(value).replace(/\s+/g, '').replace(/자격증|면허증|면허/g, '').toLowerCase();
}

function qualificationCandidates(text) {
  const candidates = [];
  const patterns = [
    [/간호사\s*(?:면허|자격증?)/i, '간호사 면허'],
    [/산업위생관리기사/i, '산업위생관리기사'],
    [/산업안전기사/i, '산업안전기사'],
    [/인간공학기사/i, '인간공학기사'],
    [/대기환경기사/i, '대기환경기사'],
  ];
  for (const [pattern, label] of patterns) if (pattern.test(text)) candidates.push(label);
  return candidates;
}

export function parseEligibility(job = {}) {
  if (Array.isArray(job.eligibleQualifications) && ['eligible', 'unknown', 'ineligible'].includes(job.eligibilityStatus)) {
    return { eligibleQualifications: job.eligibleQualifications, eligibilityStatus: job.eligibilityStatus, compositeSafetyHealth: Boolean(job.compositeSafetyHealth) };
  }
  const { fields, text } = sourceText(job);
  const qualificationText = fields
    .filter(([field]) => ['qualifications', 'requirements', 'preferredQualifications', 'description'].includes(field))
    .map(([, value]) => known(value)).filter(Boolean).join(' · ');
  const nurseEvidencePattern = /간호사\s*(?:면허|면허증|자격증?)\s*(?:소지자|소지|필수|보유|가능)?|간호사\s*면허로\s*지원/i;
  const explicitNurse = nurseEvidencePattern.test(qualificationText);
  const explicitNurseBlocked = /간호사\s*(?:면허|자격)(?:만으로는)?\s*(?:지원\s*)?(?:불가|제외|인정하지\s*않)/i.test(qualificationText);
  const safetyQualification = /산업(?:안전(?:관리)?|위생관리)기사|건설안전기사|인간공학기사/i.test(qualificationText);
  const safetyOnlyRequired = safetyQualification && /(?:필수|소지자만|자격요건)/i.test(qualificationText) && !explicitNurse;
  const compositeSafetyHealth = /안전\s*[·ㆍ/&+]\s*보건|보건\s*[·ㆍ/&+]\s*안전|안전보건/i.test(`${job.title || ''} ${job.duties || ''}`)
    && safetyQualification && !explicitNurse;
  const candidates = qualificationCandidates(qualificationText || text);
  const eligibleQualifications = candidates.map((qualification) => {
    const itemEvidence = firstEvidence(job, new RegExp(qualification.replace(/\s/g, '\\s*'), 'i'), ['qualifications', 'requirements', 'preferredQualifications']);
    return { qualification, status: qualification === DEFAULT_QUALIFICATION && explicitNurse ? 'eligible' : 'listed', evidence: itemEvidence };
  });
  let eligibilityStatus = 'unknown';
  if (explicitNurseBlocked || safetyOnlyRequired && !compositeSafetyHealth) eligibilityStatus = 'ineligible';
  else if (explicitNurse) eligibilityStatus = 'eligible';
  return { eligibleQualifications, eligibilityStatus, compositeSafetyHealth };
}

function normalizeEmploymentTypes(job) {
  const supplied = Array.isArray(job.employmentTypes) ? job.employmentTypes : [];
  const text = `${supplied.join(' ')} ${known(job.employmentType || job.employment)}`;
  const regularText = text.replace(/비정규직/g, '');
  return unique([
    /정규직/.test(regularText) ? '정규직' : '',
    /계약직/.test(text) ? '계약직' : '',
    /기간제/.test(text) ? '기간제' : '',
    /시간제|파트\s*타임/.test(text) ? '시간제' : '',
    ...supplied.map(clean),
  ]);
}

function normalizeSalary(job) {
  if (isRecord(job.salary) && ('raw' in job.salary || 'minimum' in job.salary)) return job.salary;
  const raw = known(job.salary);
  if (!raw) return { raw: null, minimum: null, maximum: null, unit: null, evidence: null };
  const numbers = [...raw.matchAll(/([\d,]+(?:\.\d+)?)\s*(만)?\s*원?/g)]
    .map((match) => Number(match[1].replace(/,/g, '')) * (match[2] ? 10_000 : 1))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    raw,
    minimum: numbers[0] || null,
    maximum: numbers.length > 1 ? numbers[1] : numbers[0] || null,
    unit: /연봉|연\s*/.test(raw) ? 'year' : /월급|월\s*/.test(raw) ? 'month' : /시급|시간/.test(raw) ? 'hour' : null,
    evidence: evidence('salary', raw, job),
  };
}

function normalizeLocation(job) {
  if (isRecord(job.location) && ('text' in job.location || 'region' in job.location)) return job.location;
  const raw = known(job.location || job.region);
  const region = REGION_NAMES.find((name) => raw.includes(name)) || known(job.regionCode) || null;
  const district = raw.match(/(?:서울|부산|대구|인천|광주|대전|울산)\s*([가-힣]+(?:구|군))|(?:경기|강원|충북|충남|전북|전남|경북|경남|제주)\s*([가-힣]+(?:시|군))/)?.slice(1).find(Boolean) || null;
  return { text: raw || null, region, district, evidence: raw ? evidence('location', raw, job) : null };
}

export function normalizeJobV2(job = {}, options = {}) {
  const checkedAt = options.detailCheckedAt || job.detailCheckedAt || null;
  const schedule = parseSchedule(job);
  const eligibility = parseEligibility(job);
  const employmentTypes = normalizeEmploymentTypes(job);
  const location = normalizeLocation(job);
  const roleEvidence = Object.fromEntries(Object.entries(ROLE_PATTERNS).map(([role, pattern]) => [role, firstEvidence(job, pattern, ['title', 'duties'])]).filter(([, value]) => value));
  const evidenceMap = {
    ...(isRecord(job.evidence) ? job.evidence : {}),
    role: roleEvidence,
    eligibility: eligibility.eligibleQualifications.map((item) => item.evidence).filter(Boolean),
    schedule: schedule.evidence,
    location: location.evidence,
    employment: evidence('employment', job.employmentType || job.employment, job, checkedAt),
    experience: evidence('experience', job.experienceLevel || job.experience, job, checkedAt),
    deadline: evidence('deadline', job.deadlineAt || job.deadline, job, checkedAt),
  };
  return {
    ...job,
    schemaVersion: NORMALIZED_JOB_SCHEMA_VERSION,
    eligibleQualifications: eligibility.eligibleQualifications,
    eligibilityStatus: eligibility.eligibilityStatus,
    compositeSafetyHealth: eligibility.compositeSafetyHealth,
    schedule,
    employmentTypes,
    salary: normalizeSalary(job),
    location,
    evidence: evidenceMap,
    detailCheckedAt: checkedAt,
  };
}

function result(status, label, evidenceValue = [], detail = '') {
  const list = Array.isArray(evidenceValue) ? evidenceValue.filter(Boolean) : evidenceValue ? [evidenceValue] : [];
  return { status, label, evidence: list, detail };
}

function roleCriterion(job, roles) {
  if (!roles.length) return null;
  const { text } = sourceText(job);
  const tags = unique([...(job.roleTags || []), ...Object.keys(ROLE_PATTERNS).filter((role) => ROLE_PATTERNS[role].test(text))]);
  const match = roles.find((role) => tags.includes(role) || ROLE_PATTERNS[role]?.test(text));
  if (match) return result(MATCH_STATUS.MATCHED, ROLE_LABELS[match] || match, job.evidence?.role?.[match]);
  if (!tags.length) return result(MATCH_STATUS.UNKNOWN, '역할 확인 필요');
  return result(MATCH_STATUS.MISMATCHED, '찾는 역할과 다름', Object.values(job.evidence?.role || {}));
}

function qualificationCriterion(job, qualifications) {
  if (!qualifications.length) return null;
  if (job.eligibilityStatus === 'ineligible') return result(MATCH_STATUS.MISMATCHED, '보유 자격으로 지원 불가', job.evidence?.eligibility);
  const requested = qualifications.map(normalizeQualification);
  const listed = (job.eligibleQualifications || []).map((item) => ({ ...item, normalized: normalizeQualification(item.qualification) }));
  const intersection = listed.find((item) => requested.includes(item.normalized));
  if (intersection && (intersection.status === 'eligible' || intersection.qualification !== DEFAULT_QUALIFICATION)) {
    return result(MATCH_STATUS.MATCHED, `${intersection.qualification} 지원 가능`, intersection.evidence);
  }
  if (job.eligibilityStatus === 'eligible' && requested.includes(normalizeQualification(DEFAULT_QUALIFICATION))) {
    return result(MATCH_STATUS.MATCHED, `${DEFAULT_QUALIFICATION} 지원 가능`, job.evidence?.eligibility);
  }
  return result(MATCH_STATUS.UNKNOWN, '지원 가능 자격 확인 필요', job.evidence?.eligibility);
}

function regionCriterion(job, regions) {
  if (!regions.length) return null;
  const text = known(job.location?.text || job.region);
  if (!text) return result(MATCH_STATUS.UNKNOWN, '지역 확인 필요');
  const match = regions.find((region) => text.includes(region) || String(job.regionCode || '') === String(region));
  return match
    ? result(MATCH_STATUS.MATCHED, `${match} 근무`, job.location?.evidence)
    : result(MATCH_STATUS.MISMATCHED, '희망 지역과 다름', job.location?.evidence);
}

function scheduleCriterion(job, required) {
  if (!required) return null;
  const status = job.schedule?.weekdayDaytimeStatus;
  return status === 'confirmed'
    ? result(MATCH_STATUS.MATCHED, '주중·주간 확인', job.schedule.evidence, `${job.schedule.startTime}–${job.schedule.endTime}`)
    : status === 'mismatched'
      ? result(MATCH_STATUS.MISMATCHED, '주중·주간 조건과 다름', job.schedule.evidence)
      : result(MATCH_STATUS.UNKNOWN, '근무요일·시간 확인 필요', job.schedule?.evidence);
}

function exclusionCriterion(job, patterns) {
  if (!patterns.length) return null;
  const checks = [];
  for (const pattern of patterns) {
    if (/3\s*교대/.test(pattern)) checks.push(['3교대', job.schedule?.kind === 'three_shift', job.schedule?.shift === false]);
    else if (/2\s*교대/.test(pattern)) checks.push(['2교대', job.schedule?.kind === 'two_shift', job.schedule?.shift === false]);
    else if (/야간|나이트|night/i.test(pattern)) checks.push(['야간', job.schedule?.night === true, job.schedule?.night === false]);
    else if (/당직|온\s*콜|on[ -]?call/i.test(pattern)) checks.push(['당직·온콜', job.schedule?.onCall === true, job.schedule?.onCall === false]);
    else if (/교대/.test(pattern)) checks.push(['교대', job.schedule?.shift === true, job.schedule?.shift === false]);
  }
  const mismatchPriority = { '3교대': 0, '2교대': 1, '야간': 2, '당직·온콜': 3, '교대': 4 };
  const mismatch = checks.filter(([, present]) => present)
    .sort((left, right) => mismatchPriority[left[0]] - mismatchPriority[right[0]])[0];
  if (mismatch) return result(MATCH_STATUS.MISMATCHED, `${mismatch[0]} 근무 포함`, job.schedule?.evidence);
  if (checks.length && checks.every(([, , absent]) => absent)) return result(MATCH_STATUS.MATCHED, `${checks.map(([label]) => label).join('·')} 없음 확인`, job.schedule?.evidence);
  return result(MATCH_STATUS.UNKNOWN, `${checks.map(([label]) => label).join('·') || '제외 근무'} 여부 확인 필요`, job.schedule?.evidence);
}

/**
 * MatchResultV2. Every decision includes the original evidence used to make it.
 */
export function matchJobV2(rawJob, rawCriteria, options = {}) {
  const job = rawJob?.schemaVersion === NORMALIZED_JOB_SCHEMA_VERSION ? rawJob : normalizeJobV2(rawJob, options);
  const criteria = normalizeSearchCriteria(rawCriteria);
  const required = {
    role: roleCriterion(job, criteria.required.roleTags),
    qualification: qualificationCriterion(job, criteria.required.qualifications),
    region: regionCriterion(job, criteria.required.regions),
    weekdayDaytime: scheduleCriterion(job, criteria.required.weekdayDaytime),
  };
  const excluded = {
    workPatterns: exclusionCriterion(job, criteria.excluded.workPatterns),
  };
  const searchable = `${sourceText(job).text} ${job.company || ''}`.toLowerCase();
  if (criteria.excluded.keywords.length) {
    const blocked = criteria.excluded.keywords.find((keyword) => searchable.includes(keyword.toLowerCase()));
    excluded.keywords = blocked
      ? result(MATCH_STATUS.MISMATCHED, `${blocked} 포함`, firstEvidence(job, new RegExp(blocked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')))
      : job.detailCheckedAt
        ? result(MATCH_STATUS.MATCHED, '제외 키워드 없음 확인')
        : result(MATCH_STATUS.UNKNOWN, '제외 키워드 여부 확인 필요');
  }
  const preferred = {};
  if (criteria.preferred.employmentTypes.length) {
    const match = criteria.preferred.employmentTypes.find((item) => job.employmentTypes.includes(item));
    preferred.employment = match
      ? result(MATCH_STATUS.MATCHED, match, job.evidence?.employment)
      : job.employmentTypes.length ? result(MATCH_STATUS.MISMATCHED, '선호 고용형태와 다름', job.evidence?.employment) : result(MATCH_STATUS.UNKNOWN, '고용형태 확인 필요');
  }
  if (criteria.preferred.experienceLevels.length) {
    const value = known(job.experienceLevel || job.experience);
    const matches = criteria.preferred.experienceLevels.some((item) => item === '신입·무관' ? /신입|무관/.test(value) : value.includes(item));
    preferred.experience = matches ? result(MATCH_STATUS.MATCHED, value, job.evidence?.experience)
      : value ? result(MATCH_STATUS.MISMATCHED, '선호 경력과 다름', job.evidence?.experience) : result(MATCH_STATUS.UNKNOWN, '경력 확인 필요');
  }
  if (criteria.preferred.salaryMinimum != null) {
    preferred.salary = job.salary?.minimum == null ? result(MATCH_STATUS.UNKNOWN, '급여 확인 필요')
      : job.salary.minimum >= criteria.preferred.salaryMinimum ? result(MATCH_STATUS.MATCHED, '희망 급여 이상', job.salary.evidence)
        : result(MATCH_STATUS.MISMATCHED, '희망 급여보다 낮음', job.salary.evidence);
  }
  if (criteria.preferred.keywords.length) {
    const found = criteria.preferred.keywords.filter((keyword) => searchable.includes(keyword.toLowerCase()));
    preferred.keywords = found.length
      ? result(MATCH_STATUS.MATCHED, `${found.slice(0, 2).join('·')} 포함`, found.map((keyword) => firstEvidence(job, new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))))
      : job.detailCheckedAt
        ? result(MATCH_STATUS.MISMATCHED, '선호 키워드 없음')
        : result(MATCH_STATUS.UNKNOWN, '선호 키워드 확인 필요');
  }

  const requiredValues = Object.values(required).filter(Boolean);
  const excludedValues = Object.values(excluded).filter(Boolean);
  const decisive = [...requiredValues, ...excludedValues];
  const hasMismatch = decisive.some((item) => item.status === MATCH_STATUS.MISMATCHED);
  const hasUnknown = decisive.some((item) => item.status === MATCH_STATUS.UNKNOWN);
  const overall = hasMismatch ? MATCH_OUTCOME.MISMATCHED : hasUnknown ? MATCH_OUTCOME.NEEDS_REVIEW : MATCH_OUTCOME.CONFIRMED;
  const sourceStale = Boolean(job.sourceStale || job.stale || job.dataTrust?.stale || job.sourceTrust?.stale);
  const topRecommendation = overall === MATCH_OUTCOME.CONFIRMED && !sourceStale && !job.compositeSafetyHealth;
  const allValues = [...decisive, ...Object.values(preferred).filter(Boolean)];
  const confirmedCount = allValues.filter((item) => item.status === MATCH_STATUS.MATCHED).length;
  const unknownCount = allValues.filter((item) => item.status === MATCH_STATUS.UNKNOWN).length;
  const mismatchedCount = allValues.filter((item) => item.status === MATCH_STATUS.MISMATCHED).length;
  return {
    version: MATCH_RESULT_SCHEMA_VERSION,
    job,
    criteria,
    overall,
    label: overall === MATCH_OUTCOME.CONFIRMED ? '지원 조건 확인됨' : overall === MATCH_OUTCOME.MISMATCHED ? '조건 다름' : '확인 필요',
    topRecommendation,
    conditions: { required, preferred, excluded },
    confirmedCount,
    unknownCount,
    mismatchedCount,
    summary: `확인된 조건 ${confirmedCount}개${unknownCount ? ` · 확인 필요 ${unknownCount}개` : ''}${mismatchedCount ? ` · 조건 다름 ${mismatchedCount}개` : ''}`,
    cautions: unique([
      sourceStale ? '수집원 최신 상태 확인 필요' : '',
      job.compositeSafetyHealth ? '안전·보건 복합 직무 자격 확인 필요' : '',
      ...decisive.filter((item) => item.status !== MATCH_STATUS.MATCHED).map((item) => item.label),
    ]),
  };
}

export function rankJobsV2(jobs, criteria) {
  const outcomes = { [MATCH_OUTCOME.CONFIRMED]: 0, [MATCH_OUTCOME.NEEDS_REVIEW]: 1, [MATCH_OUTCOME.MISMATCHED]: 2 };
  return (Array.isArray(jobs) ? jobs : []).map((job, index) => ({ ...matchJobV2(job, criteria), index }))
    .sort((left, right) => Number(right.topRecommendation) - Number(left.topRecommendation)
      || outcomes[left.overall] - outcomes[right.overall]
      || right.confirmedCount - left.confirmedCount
      || left.unknownCount - right.unknownCount
      || String(right.job.publishedAt || right.job.firstSeenAt || '').localeCompare(String(left.job.publishedAt || left.job.firstSeenAt || ''))
      || left.index - right.index);
}
