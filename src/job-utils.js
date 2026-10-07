import { APPLICATION_STATUS, FINAL_RESULT } from './user-state.js';
import { EXPERIENCE_DOMAIN, classifyExperienceDomain } from '../lib/experience-domain.mjs';
import { parseEligibility, parseSchedule } from './job-v2.js';

const REGION_LABELS = ['서울', '경기', '인천', '부산', '대구', '대전', '광주', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];

export const APPLICATION_STAGES = [
  { id: APPLICATION_STATUS.INTERESTED, label: '검토 중' },
  { id: APPLICATION_STATUS.PREPARING, label: '지원 준비' },
  { id: APPLICATION_STATUS.APPLIED, label: '지원 완료' },
  { id: APPLICATION_STATUS.INTERVIEW, label: '면접' },
  { id: APPLICATION_STATUS.FINAL, label: '결과' },
];

export const RESULT_LABELS = {
  [FINAL_RESULT.ACCEPTED]: '합격',
  [FINAL_RESULT.REJECTED]: '불합격',
  [FINAL_RESULT.WITHDRAWN]: '지원 철회',
  [FINAL_RESULT.CLOSED]: '마감',
  expired: '마감',
};

export function nextApplicationStatus(status) {
  return {
    [APPLICATION_STATUS.INTERESTED]: APPLICATION_STATUS.PREPARING,
    [APPLICATION_STATUS.PREPARING]: APPLICATION_STATUS.APPLIED,
    [APPLICATION_STATUS.APPLIED]: APPLICATION_STATUS.INTERVIEW,
    [APPLICATION_STATUS.INTERVIEW]: APPLICATION_STATUS.FINAL,
  }[status] || null;
}

export function applicationSchedule(application, now = new Date()) {
  if (!application) return { at: null, kind: 'none', label: '일정 없음', timing: 'none' };
  let at = application.dueAt;
  let kind = 'task';
  let label = application.nextAction || '다음 할 일';
  if (application.status === APPLICATION_STATUS.INTERVIEW && application.interviewAt) {
    at = application.interviewAt; kind = 'interview'; label = '면접';
  } else if (!at && application.status === APPLICATION_STATUS.APPLIED && application.appliedAt) {
    at = application.appliedAt; kind = 'applied'; label = '지원일';
  } else if (!at && application.interviewAt) {
    at = application.interviewAt; kind = 'interview'; label = '면접';
  }
  if (!at) return { at: null, kind: 'none', label, timing: 'none' };
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return { at, kind, label, timing: 'none' };
  const day = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  const timing = day(date) < day(now) && application.status !== APPLICATION_STATUS.FINAL ? 'overdue' : day(date) === day(now) ? 'today' : 'upcoming';
  return { at, kind, label, timing };
}

export const ROLE_OPTIONS = [
  { id: 'health-manager', label: '보건관리자' },
  { id: 'occupational-nurse', label: '산업간호사' },
  { id: 'clinical-nurse', label: '임상 간호사' },
];

export const REGION_OPTIONS = REGION_LABELS;

export const DEPARTMENT_OPTIONS = ['병동', '중환자실', '응급실', '수술실', '외래', '검진·내시경', '연구·CRC', '산업보건'];
export const WORK_PATTERN_OPTIONS = ['상근·주간', '3교대', '2교대', '야간전담'];
export const FACILITY_TYPE_OPTIONS = ['병원·의료원', '의원·검진센터', '요양·재활', '기업·사업장', '공공기관'];
const WORK_PATTERN_MATCHERS = {
  '상근·주간': /상근|주간근무|주간 전담|데이 전담|d[-_ ]?keep|day 근무/i,
  '2교대': /2\s*교대|이교대/,
  '3교대': /3\s*교대|삼교대/,
  야간전담: /야간전담|나이트전담|night only/,
};

const WORK_PATTERN_NEGATION_MATCHERS = {
  '2교대': /(?:2\s*교대|이교대)(?:\s*근무)?\s*(?:없|제외|안\s*함|하지\s*않)/,
  '3교대': /(?:3\s*교대|삼교대)(?:\s*근무)?\s*(?:없|제외|안\s*함|하지\s*않)/,
  야간: /(?:야간|나이트|night)(?:\s*(?:전담|근무))?\s*(?:없|제외|안\s*함|하지\s*않)/,
  교대: /(?:교대근무|교대)(?:\s*근무)?\s*(?:없|제외|안\s*함|하지\s*않)/,
};

export function cleanUnknown(value) {
  const text = String(value || '').trim();
  if (!text || /미표기|정보 없음|확인 필요|공고 확인/.test(text) || /^(?:no\s+requirements?|not\s+specified|unknown|n\/?a|none|null|[-|｜¦‖]+)$/i.test(text)) return '원문 확인';
  return text;
}

export function employmentDisplay(job = {}) {
  const values = [
    job?.employmentType,
    job?.employment,
    ...(Array.isArray(job?.employmentTypes) ? job.employmentTypes : []),
  ].map((value) => cleanUnknown(value)).filter((value) => value !== '원문 확인');
  const unique = [...new Set(values)];
  const tokens = (value) => String(value).split(/\s*[·,/|]\s*/).filter(Boolean);
  const mostSpecific = unique.filter((value) => !unique.some((candidate) => candidate !== value && tokens(candidate).includes(value)));
  return mostSpecific.join(' · ') || '원문 확인';
}

export function employmentMatches(job, expected) {
  const employment = employmentDisplay(job);
  if (expected === '원문 확인') return employment === '원문 확인';
  if (!expected || expected === '전체' || employment === '원문 확인') return expected === '전체';
  if (expected === '정규직') return /(?:^|[\s·,/|])정규직(?:$|[\s·,/|])/.test(employment.replace(/비정규직/g, ''));
  return employment.includes(expected);
}

const EXPERIENCE_DOMAIN_LABELS = {
  [EXPERIENCE_DOMAIN.CLINICAL]: '임상 경력으로 명시',
  [EXPERIENCE_DOMAIN.HEALTH_MANAGER]: '보건관리·산업보건 경력으로 명시',
  [EXPERIENCE_DOMAIN.NURSING_GENERAL]: '간호 경력은 명시 · 분야는 미표기',
  [EXPERIENCE_DOMAIN.UNSPECIFIED]: '상세에서 경력 분야 확인 필요',
};

const EXPERIENCE_FIELD_LABELS = {
  title: '공고 제목',
  experience: '경력 조건',
  experienceRequirements: '경력 조건',
  qualifications: '자격요건',
  requirements: '지원 자격',
  preferredQualifications: '우대사항',
  description: '공고 상세',
  duties: '담당업무',
};

export function experienceDisplay(job = {}, detail = {}, options = {}) {
  const rawValues = [detail?.experience, job?.experience, job?.experienceLevel]
    .map((value) => cleanUnknown(value))
    .filter((value) => value !== '원문 확인');
  const value = rawValues[0] || '원문 확인';
  const classified = classifyExperienceDomain({
    title: job?.title,
    experience: detail?.experience || job?.experience,
    qualifications: detail?.qualifications || job?.qualifications,
    requirements: detail?.requirements || job?.requirements,
    preferredQualifications: detail?.preferredQualifications || job?.preferredQualifications,
    description: detail?.description || job?.description,
    duties: detail?.duties || job?.duties,
  });
  const allowedDomains = new Set(Object.values(EXPERIENCE_DOMAIN));
  const supplied = [detail, job].find((source) => allowedDomains.has(source?.experienceDomain));
  const domain = supplied?.experienceDomain || classified.domain;
  const evidence = supplied?.experienceEvidence || classified.evidence;
  const openToEntry = /경력\s*무관|신입\s*[·/&]?\s*경력|신입|졸업\s*예정/.test(value);
  const careerText = `${value} ${evidence?.excerpt || ''}`;
  const isExperienced = !openToEntry && /경력|경험|근무\s*이력|\d+\s*년/.test(careerText);
  const detailCheckedAt = options?.detailCheckedAt || detail?.detailCheckedAt || job?.detailCheckedAt || null;
  const label = isExperienced && domain === EXPERIENCE_DOMAIN.UNSPECIFIED && detailCheckedAt
    ? '상세 조회에서도 경력 분야 확인 필요'
    : EXPERIENCE_DOMAIN_LABELS[isExperienced ? domain : EXPERIENCE_DOMAIN.UNSPECIFIED];
  const fieldLabel = EXPERIENCE_FIELD_LABELS[evidence?.field] || evidence?.field || '';
  let explanation = '';
  if (isExperienced && domain === EXPERIENCE_DOMAIN.UNSPECIFIED && detailCheckedAt) explanation = '자동 상세 조회에서도 구분 근거를 찾지 못했어요. 지원 전 원문에서 다시 확인해 주세요.';
  else if (isExperienced && domain === EXPERIENCE_DOMAIN.UNSPECIFIED) explanation = '목록 정보에는 경력 여부나 연차만 있어요. 상세 원문에서 임상 경력인지 보건관리자 경력인지 확인해 주세요.';
  else if (isExperienced && domain === EXPERIENCE_DOMAIN.NURSING_GENERAL) explanation = '간호 경력은 적혀 있지만 임상인지 보건관리·산업보건인지까지는 구분되어 있지 않아요.';
  else if (isExperienced && evidence?.strength === 'title-context') explanation = '공고 제목의 표현을 기준으로 구분했습니다. 상세 자격요건에서 다시 확인해 주세요.';
  else if (isExperienced) explanation = `${fieldLabel || '공고 원문'}에 경력 분야가 직접 적혀 있어요.`;
  return { value, isExperienced, domain: isExperienced ? domain : EXPERIENCE_DOMAIN.UNSPECIFIED, label, explanation, evidence, fieldLabel, detailCheckedAt };
}

const koreaCalendarDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

export function deadlineInfo(job, now = new Date()) {
  if (!job?.deadlineAt) {
    const raw = String(job?.deadline || '');
    if (/상시|채용시/.test(raw)) return { status: 'rolling', label: '상시채용', days: null };
    return { status: 'unknown', label: cleanUnknown(raw), days: null };
  }
  const deadlineParts = String(job.deadlineAt).slice(0, 10).split('-').map(Number);
  const kstParts = koreaCalendarDate.formatToParts(now);
  const part = (type) => Number(kstParts.find((item) => item.type === type)?.value);
  const days = Math.round((Date.UTC(deadlineParts[0], deadlineParts[1] - 1, deadlineParts[2]) - Date.UTC(part('year'), part('month') - 1, part('day'))) / 86400000);
  if (days < 0) return { status: 'closed', label: '마감됨', days };
  if (days === 0) return { status: 'today', label: '오늘 마감', days };
  if (days <= 3) return { status: 'soon', label: `D-${days}`, days };
  return { status: 'open', label: `D-${days}`, days };
}

function normalizedText(job) {
  const values = [
    job?.company, job?.title, job?.roleTags, job?.sectors, job?.department, job?.workPattern,
    job?.facilityType, job?.location, job?.duties, job?.qualifications, job?.requirements,
    job?.preferredQualifications, job?.workConditions, job?.workHours, job?.description,
  ];
  return values.flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ').toLowerCase();
}

function searchableText(job) {
  const alternateSources = Array.isArray(job?.alternateSources)
    ? job.alternateSources.map((item) => typeof item === 'string' ? item : item?.source)
    : [];
  return [normalizedText(job), job?.source, ...alternateSources].filter(Boolean).join(' ').toLowerCase();
}

export function departmentFor(job) {
  if (DEPARTMENT_OPTIONS.includes(job?.department)) return job.department;
  const text = normalizedText(job);
  if (/중환자실|icu/.test(text)) return '중환자실';
  if (/응급실|응급의료|응급센터|\ber\b/.test(text)) return '응급실';
  if (/수술실|수술간호|마취회복|회복실|(?:^|[\s(),/])or(?:$|[\s(),/])/.test(text)) return '수술실';
  if (/산업간호|보건관리|산업보건|사업장 간호|건강관리실/.test(text)) return '산업보건';
  if (/건강검진|검진센터|내시경/.test(text)) return '검진·내시경';
  if (/연구간호|임상시험|crc|\birb\b|hrpp|연구윤리|clinical research/.test(text)) return '연구·CRC';
  if (/외래|클리닉/.test(text)) return '외래';
  if (/병동|입원간호/.test(text)) return '병동';
  return '원문 확인';
}

export function workPatternFor(job) {
  if (WORK_PATTERN_OPTIONS.includes(job?.workPattern)) return job.workPattern;
  const schedule = parseSchedule(scheduleAssessmentJob(job));
  const scheduleKind = {
    three_shift: '3교대',
    two_shift: '2교대',
    night: '야간전담',
    weekday_daytime: '상근·주간',
  }[schedule.kind];
  if (scheduleKind) return scheduleKind;
  if (schedule.daytimeStatus === 'confirmed' && schedule.shift !== true && schedule.night !== true) return '상근·주간';
  const text = scheduleAssessmentText(job);
  if (/야간전담|나이트전담|night only/.test(text)) return '야간전담';
  if (/3\s*교대|삼교대/.test(text) && !WORK_PATTERN_NEGATION_MATCHERS['3교대'].test(text)) return '3교대';
  if (/2\s*교대|이교대/.test(text) && !WORK_PATTERN_NEGATION_MATCHERS['2교대'].test(text)) return '2교대';
  if (nonShiftAssessmentFor(job).status === 'confirmed') return '상근·주간';
  return '원문 확인';
}

function scheduleAssessmentJob(job = {}) {
  return {
    title: job?.title,
    workPattern: job?.workPattern,
    workHours: job?.workHours,
    workConditions: job?.workConditions,
    schedule: job?.schedule,
  };
}

function scheduleAssessmentText(job) {
  const schedule = typeof job?.schedule === 'string' ? job.schedule : job?.schedule?.raw;
  return [job?.workPattern, job?.title, job?.workHours, job?.workConditions, schedule]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function nonShiftRoleSignal(job) {
  const text = [job?.company, job?.title, job?.department, job?.duties]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter(Boolean).join(' ').toLowerCase();
  const signals = [
    [/건강\s*검진|검진\s*센터|내시경/, '검진·내시경'],
    [/연구\s*간호|임상\s*시험|\bcrc\b|\birb\b|clinical research/, '연구·CRC'],
    [/외래|클리닉|주사실|채혈/, '외래'],
    [/산업\s*간호|보건\s*관리|산업\s*보건|사업장\s*간호|건강\s*관리실/, '산업보건'],
    [/보험\s*심사|심사\s*평가|심사\s*간호|적정\s*진료|상담\s*간호|교육\s*간호|감염\s*관리|환자\s*안전|의료\s*질|질\s*향상|성과\s*가치|\bqps?\b|\bqi\b/, '전문직무'],
  ];
  return signals.find(([pattern]) => pattern.test(text))?.[1] || '';
}

export function nonShiftAssessmentFor(job = {}) {
  const text = scheduleAssessmentText(job);
  const negativeEnding = '(?:없(?:음|습니다|다)?|제외|미실시|하지\\s*않(?:음|습니다|는다)?|안\\s*(?:함|합니다)|아님|[xX])';
  const particle = '(?:은|는|이|가|을|를)?';
  const noRotationAndNight = new RegExp(`(?:교대(?:\\s*근무)?\\s*(?:및|[·,/&+])\\s*야간|야간\\s*(?:및|[·,/&+])\\s*교대(?:\\s*근무)?)\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noThreeShift = new RegExp(`(?:3\\s*교대|삼교대)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noTwoShift = new RegExp(`(?:2\\s*교대|이교대)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noRotation = new RegExp(`(?:교대\\s*근무|교대근무|교대제|교대)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noNight = new RegExp(`(?:야간|나이트|night)(?:\\s*(?:전담|근무|당직))?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noOnCall = new RegExp(`(?:당직|온\\s*콜|on[ -]?call)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}`, 'i');
  const noWeekend = new RegExp(`(?:(?:주말|토(?:요일)?(?:\\s*(?:및|[·,/&])\\s*일(?:요일)?)?)(?:\\s*근무)?\\s*${particle}\\s*${negativeEnding}|(?:주말|토(?:요일)?\\s*(?:및|[·,/&])\\s*일(?:요일)?)\\s*(?:휴무|off))`, 'i');
  const nonRotationTerm = /비\s*교대(?:\s*근무)?/i;
  const noFixedDay = new RegExp(`(?:비\\s*상근|(?:상근(?:직)?|주간(?:\\s*(?:고정|전담|근무제?))?|주간근무|day\\s*(?:only|shift|근무))\\s*${particle}\\s*(?:${negativeEnding}|불가))`, 'i');
  const scrubbed = text
    .replace(new RegExp(noRotationAndNight.source, 'gi'), ' ')
    .replace(new RegExp(noThreeShift.source, 'gi'), ' ')
    .replace(new RegExp(noTwoShift.source, 'gi'), ' ')
    .replace(new RegExp(noRotation.source, 'gi'), ' ')
    .replace(new RegExp(noNight.source, 'gi'), ' ')
    .replace(new RegExp(noOnCall.source, 'gi'), ' ')
    .replace(new RegExp(noWeekend.source, 'gi'), ' ')
    .replace(new RegExp(nonRotationTerm.source, 'gi'), ' ')
    .replace(new RegExp(noFixedDay.source, 'gi'), ' ');

  const parsed = parseSchedule(scheduleAssessmentJob(job));
  const threeShift = parsed.kind === 'three_shift'
    || /(?:3\s*교대|삼교대|4조\s*3교대|d\s*[\/·,+]\s*e\s*[\/·,+]\s*n|데이\s*[\/·,+]\s*이브닝\s*[\/·,+]\s*나이트)/i.test(scrubbed);
  const twoShift = parsed.kind === 'two_shift'
    || /(?:2\s*교대|이교대|주야\s*2교대|d\s*[\/·,+]\s*n|d\s*[\/·,+]\s*e(?!\s*[\/·,+]\s*n)|e\s*[\/·,+]\s*n)/i.test(scrubbed);
  const otherRotation = parsed.shift === true || /(?:^|[^비])교대(?:\s*근무|제|근무제)?/i.test(scrubbed)
    || /주주야야비비|주야비|주야\s*교대/i.test(scrubbed);
  const night = parsed.night === true
    || /(?:야간|나이트|night)(?:\s*(?:전담|근무|당직|포함|있음|발생)|\s*(?:월|주)\s*\d+\s*회|\s*only)|야간\s+(?:간호|보건|상담|전용|고정)|n[-_ ]?keep|(?:^|\s)n\s*근무|22\s*:\s*\d{2}\s*(?:~|-|–|—)\s*(?:익일\s*)?0?[5-9]\s*:\s*\d{2}|e\s*[\/·,+]\s*n|주주야야비비/i.test(scrubbed);
  const onCall = parsed.onCall === true || /당직|온\s*콜|on[ -]?call/i.test(scrubbed);
  const weekend = parsed.weekend === true
    || /주말\s*(?:및\s*)?(?:포함|근무)|(?:월\s*\d+\s*회|격주)\s*토(?:요일)?|토(?:요일)?\s*(?:월\s*\d+\s*회|격주|근무|포함)/i.test(scrubbed);
  const rotation = threeShift || twoShift || otherRotation;
  const fixedDay = parsed.kind === 'weekday_daytime' || parsed.weekdayDaytimeStatus === 'confirmed'
    || parsed.days?.length === 5 && parsed.startTime && parsed.endTime
    || /상근(?:직)?|주간\s*(?:고정|전담|근무제?)|주간근무|데이\s*전담|d[-_ ]?keep|day\s*(?:only|shift|근무)/i.test(scrubbed);
  const combinedNoRotation = noRotationAndNight.test(text);
  const explicitlyNoRotation = nonRotationTerm.test(text) || combinedNoRotation
    || noRotation.test(text) && !noThreeShift.test(text) && !noTwoShift.test(text);
  const structuredNoRotation = parsed.shift === false && !fixedDay;
  const hasBurden = rotation || night || onCall;

  let burdenLabel = '';
  if (threeShift) burdenLabel = '3교대 명시';
  else if (twoShift) burdenLabel = '2교대 명시';
  else if (otherRotation) burdenLabel = '교대근무 명시';
  else if (night) burdenLabel = '야간근무 명시';
  else if (onCall) burdenLabel = '당직·온콜 명시';

  if (hasBurden && (fixedDay || explicitlyNoRotation || structuredNoRotation)) return {
    status: 'conflict', rank: 3, candidate: false, label: '근무조건 충돌', detail: `${burdenLabel} · 원문 확인 필요`, signal: burdenLabel,
  };
  if (hasBurden) return {
    status: 'shift', rank: 4, candidate: false, label: burdenLabel, detail: '교대·야간 부담이 표시된 공고', signal: burdenLabel,
  };
  if (fixedDay || explicitlyNoRotation || structuredNoRotation) return {
    status: 'confirmed', rank: 0, candidate: true,
    label: explicitlyNoRotation || structuredNoRotation ? '교대 없음 명시' : '상근·주간 확인',
    detail: `${explicitlyNoRotation || structuredNoRotation ? '공고에 교대근무 없음이 표시됨' : '공고에 고정 주간근무 단서가 표시됨'}${weekend ? ' · 주말근무 단서는 별도 확인 필요' : ''}`,
    signal: explicitlyNoRotation || structuredNoRotation ? '교대 없음' : '상근·주간',
  };
  const roleSignal = nonShiftRoleSignal(job);
  if (roleSignal) return {
    status: 'likely', rank: 1, candidate: true, label: `${roleSignal} · 상근 후보`,
    detail: `직무 특성상 가능성이 있지만 실제 근무표는 원문 확인 필요${weekend ? ' · 주말근무 단서 있음' : ''}`, signal: roleSignal,
  };
  return {
    status: 'unknown', rank: 2, candidate: false,
    label: weekend ? '주말근무 · 형태 확인' : '근무형태 확인 필요',
    detail: weekend ? '주말근무 단서는 있지만 교대 여부는 원문 확인 필요' : '원문에 근무표가 표시됐는지 확인해 주세요',
    signal: weekend ? '주말근무' : '',
  };
}

export function facilityTypeFor(job) {
  if (FACILITY_TYPE_OPTIONS.includes(job?.facilityType)) return job.facilityType;
  const identityText = [job?.company, job?.title, job?.facilityType].filter(Boolean).join(' ').toLowerCase();
  const text = normalizedText(job);
  if (/요양병원|요양원|재활병원|재활센터/.test(identityText)) return '요양·재활';
  if (/의원|클리닉|검진센터/.test(identityText)) return '의원·검진센터';
  if (/공단|공사|공공기관|보건소|시청|군청|구청|의료원/.test(identityText) && !/주식회사|\(주\)/.test(identityText)) return '공공기관';
  if (/병원|의료센터|메디컬센터/.test(identityText)) return '병원·의료원';
  if (/보건관리|산업간호|산업보건|사업장|공장|건설|주식회사|\(주\)/.test(identityText)) return '기업·사업장';
  if (/요양병원|요양원|재활병원|재활센터/.test(text)) return '요양·재활';
  if (/의원|클리닉|검진센터/.test(text)) return '의원·검진센터';
  if (/공단|공사|공공기관|보건소|시청|군청|구청|의료원/.test(text) && !/주식회사|\(주\)/.test(text)) return '공공기관';
  if (/병원|의료센터|메디컬센터/.test(text)) return '병원·의료원';
  if (/보건관리|산업간호|산업보건|사업장|공장|건설|주식회사|\(주\)/.test(text)) return '기업·사업장';
  return '원문 확인';
}

function roleLabel(role) {
  return ROLE_OPTIONS.find((option) => option.id === role)?.label || role;
}

const ROLE_PATTERNS = {
  'health-manager': /보건\s*관리|보건직|보건·산업/,
  'occupational-nurse': /산업\s*간호|사업장\s*간호|보건·산업/,
  'clinical-nurse': /임상\s*간호|간호사|간호직/,
};

const CLEARLY_NON_CLINICAL_PATTERN = /보건\s*관리(?:자|직|담당)?|산업\s*(?:간호|보건)|사업장\s*간호|건강\s*관리실|보험\s*심사|심사\s*(?:평가\s*)?간호|적정\s*진료|손해\s*사정|health[-_ ]manager|occupational[-_ ]nurse|insurance[-_ ](?:review|claims)/i;

function workConstraint(value) {
  const text = String(value || '').toLowerCase();
  if (/3\s*교대|삼교대/.test(text)) return '3교대';
  if (/2\s*교대|이교대/.test(text)) return '2교대';
  if (/야간|나이트|night/.test(text)) return '야간';
  if (/교대/.test(text)) return '교대';
  return '';
}

function workConstraintConflicts(constraint, knownPattern, text) {
  if (constraint === '3교대') return knownPattern === '3교대' || WORK_PATTERN_MATCHERS['3교대'].test(text);
  if (constraint === '2교대') return knownPattern === '2교대' || WORK_PATTERN_MATCHERS['2교대'].test(text);
  if (constraint === '야간') return ['3교대', '야간전담'].includes(knownPattern) || /(?:야간|나이트|night)/.test(text);
  if (constraint === '교대') return ['2교대', '3교대', '야간전담'].includes(knownPattern) || /(?:2|3)\s*교대|이교대|삼교대|야간전담/.test(text);
  return false;
}

function workConstraintExplicitlyExcluded(constraint, text) {
  return Boolean(WORK_PATTERN_NEGATION_MATCHERS[constraint]?.test(text));
}

function workConstraintAvoidedByPattern(constraint, knownPattern) {
  if (knownPattern === '원문 확인') return false;
  if (constraint === '3교대') return knownPattern !== '3교대';
  if (constraint === '2교대') return knownPattern !== '2교대';
  if (['야간', '교대'].includes(constraint)) return knownPattern === '상근·주간';
  return false;
}

export function recommendationFor(job, profile = {}) {
  const reasons = [];
  const missing = [];
  const cautions = [];
  const text = normalizedText(job);
  const roles = profile.roleTags || profile.roles || [];
  const tags = job?.roleTags || [];
  const roleEvidence = `${tags.join(' ')} ${text}`;
  const clearlyNonClinical = CLEARLY_NON_CLINICAL_PATTERN.test(roleEvidence);
  const roleMatches = roles.filter((role) => {
    if (role === 'clinical-nurse' && clearlyNonClinical) return false;
    return tags.includes(role) || ROLE_PATTERNS[role]?.test(roleEvidence) || text.includes(roleLabel(role).toLowerCase());
  });
  if (roleMatches.length) reasons.push(roleLabel(roleMatches[0]));
  else if (roles.length) {
    missing.push('역할');
    if (roles.includes('clinical-nurse') && clearlyNonClinical) cautions.push('선택한 임상 역할과 다름');
  }

  const regions = profile.regionCodes || profile.regions || [];
  const regionMatch = regions.find((region) => String(job?.region || '').includes(region) || String(job?.regionCode || '') === String(region));
  if (regionMatch) reasons.push(regionMatch);
  const regionMismatch = regions.length > 0 && !regionMatch && cleanUnknown(job?.region) !== '원문 확인';
  if (regionMismatch) {
    missing.push('지역');
    cautions.push('지역 조건과 다름');
  }

  const employments = profile.employmentTypes || [];
  const employment = employmentDisplay(job);
  const employmentMatch = employments.find((value) => employmentMatches(job, value));
  if (employmentMatch) reasons.push(employmentMatch);
  const employmentMismatch = employments.length > 0 && !employmentMatch && employment !== '원문 확인';
  if (employmentMismatch) {
    missing.push('고용형태');
    cautions.push('고용형태 조건과 다름');
  }

  const experienceLevels = profile.experienceLevels || [];
  const experience = experienceDisplay(job).value;
  const experienceMatch = experienceLevels.find((value) => experience.includes(value) || (value === '신입·무관' && /신입|무관/.test(experience)));
  if (experienceMatch) reasons.push(experienceMatch);

  const preferred = (profile.preferredKeywords || []).filter((keyword) => keyword && text.includes(keyword.toLowerCase()));
  reasons.push(...preferred.slice(0, 2));
  const excluded = [];
  const knownWorkPattern = workPatternFor(job);
  const workText = `${job?.workPattern || ''} ${text}`.toLowerCase();
  const workPatterns = profile.workPatterns || [];
  for (const pattern of workPatterns) {
    if (pattern.endsWith('제외')) {
      const blocked = pattern.replace(/\s*제외$/, '').toLowerCase();
      const constraint = workConstraint(blocked);
      if (!constraint) continue;
      if (workConstraintExplicitlyExcluded(constraint, workText)) reasons.push(pattern);
      else if (workConstraintConflicts(constraint, knownWorkPattern, workText)) excluded.push(blocked);
      else if (workConstraintAvoidedByPattern(constraint, knownWorkPattern)) reasons.push(pattern);
      else cautions.push('근무형태 확인 필요');
    } else if (WORK_PATTERN_MATCHERS[pattern]?.test(workText) || knownWorkPattern === pattern) reasons.push(pattern);
    else if (WORK_PATTERN_OPTIONS.includes(pattern) && knownWorkPattern === '원문 확인') cautions.push('근무형태 확인 필요');
  }
  for (const keyword of profile.excludedKeywords || []) {
    if (!keyword) continue;
    const constraint = workConstraint(keyword);
    if (constraint) {
      if (workConstraintExplicitlyExcluded(constraint, workText)) reasons.push(`${keyword} 제외`);
      else if (workConstraintConflicts(constraint, knownWorkPattern, workText)) excluded.push(keyword);
      else if (workConstraintAvoidedByPattern(constraint, knownWorkPattern)) reasons.push(`${keyword} 제외`);
      else cautions.push('근무형태 확인 필요');
    } else if (text.includes(keyword.toLowerCase())) excluded.push(keyword);
    else cautions.push('제외 조건 여부 확인 필요');
  }

  const fieldPoor = [job?.region, employmentDisplay(job), experienceDisplay(job).value]
    .filter((value) => cleanUnknown(value) !== '원문 확인').length < 2;
  const needsReview = job?.relevance === 'review' || job?.needsReview || !tags.length || fieldPoor;

  let level = 'partial';
  if (needsReview || regionMismatch || employmentMismatch) level = 'review';
  else if (roleMatches.length && (regionMatch || !regions.length) && reasons.length >= 2 && !excluded.length) level = 'strong';
  else if (!roleMatches.length || excluded.length) level = 'review';

  const uniqueReasons = [...new Set(reasons)];
  const visibleReasons = [
    ...uniqueReasons.filter((reason) => reason.endsWith('제외')),
    ...uniqueReasons.filter((reason) => !reason.endsWith('제외')),
  ];
  return {
    level,
    label: level === 'strong' ? '조건에 잘 맞음' : level === 'partial' ? '일부 조건 일치' : '확인 필요',
    reasons: visibleReasons.slice(0, 4),
    missing,
    excluded: [...new Set(excluded)],
    cautions: [...new Set(cautions)],
  };
}

export const ACTIVE_LISTING_MAX_AGE_DAYS = 30;

export function listingPolicyDay(now = new Date()) {
  return koreaCalendarDate.format(now);
}

export function exceedsListingAgeLimit(job, now = new Date()) {
  const timestamp = listingDateInfoFor(job)?.timestamp ?? listingTimestampFor(job?.firstSeenAt);
  if (timestamp == null) return false;
  const age = (Date.parse(listingPolicyDay(now)) - Date.parse(listingPolicyDay(new Date(timestamp)))) / 86400000;
  return age > ACTIVE_LISTING_MAX_AGE_DAYS;
}

export function jobMatchesFilters(job, filters = {}, now = new Date()) {
  const query = String(filters.query || '').trim().toLowerCase();
  const haystack = searchableText(job);
  const queryTerms = query.split(/\s+/);
  const queryMatches = queryTerms.includes('pa')
    ? queryTerms.every((term) => term === 'pa' ? careRoleFor(job) === 'pa' : haystack.includes(term))
    : haystack.includes(query);
  if (query && !queryMatches) return false;
  if (filters.careRole && filters.careRole !== 'all' && careRoleFor(job) !== filters.careRole) return false;
  if (filters.region && filters.region !== '전체') {
    const regionText = `${job.region || ''} ${job.location || ''}`;
    const regionCode = String(job.regionCode || '');
    const regionMatches = filters.region === '서울·경기'
      ? /서울|경기/.test(regionText) || ['11', '41'].includes(regionCode)
      : filters.region === '서울'
        ? regionText.includes('서울') || regionCode === '11'
        : regionText.includes(filters.region) || regionCode === String(filters.region);
    if (!regionMatches) return false;
  }
  const employmentFilters = (Array.isArray(filters.employment) ? filters.employment : [filters.employment]).filter(Boolean);
  if (employmentFilters.length && !employmentFilters.includes('전체')) {
    if (!employmentFilters.some((employment) => employmentMatches(job, employment))) return false;
  }
  if (filters.experience && filters.experience !== '전체') {
    const experience = experienceDisplay(job).value;
    if (filters.experience === '신입·무관' ? !/신입|무관/.test(experience) : experience !== filters.experience) return false;
  }
  if (filters.source && filters.source !== '전체' && job.source !== filters.source) return false;
  if (filters.department && filters.department !== '전체' && departmentFor(job) !== filters.department) return false;
  if (filters.workPattern && filters.workPattern !== '전체' && workPatternFor(job) !== filters.workPattern) return false;
  if (filters.nonShiftOnly && !nonShiftAssessmentFor(job).candidate) return false;
  if (filters.facilityType && filters.facilityType !== '전체' && facilityTypeFor(job) !== filters.facilityType) return false;
  if (filters.availability && filters.availability !== '전체') {
    const status = deadlineInfo(job, now).status;
    if (filters.availability === '진행 중' && (status === 'closed' || exceedsListingAgeLimit(job, now))) return false;
    if (filters.availability === '마감됨' && status !== 'closed') return false;
  }
  if (filters.deadline && filters.deadline !== '전체') {
    const info = deadlineInfo(job);
    const matches = {
      '오늘 마감': info.status === 'today',
      '3일 이내': info.days != null && info.days >= 0 && info.days <= 3,
      '7일 이내': info.days != null && info.days >= 0 && info.days <= 7,
      상시채용: info.status === 'rolling',
      마감됨: info.status === 'closed',
      '원문 확인': info.status === 'unknown',
    };
    if (!matches[filters.deadline]) return false;
  }
  return true;
}

export function workLifeBalanceFor(job) {
  const title = String(job?.title || '').toLowerCase();
  const qualificationText = `${job?.qualifications || ''} ${job?.requirements || ''}`.toLowerCase();
  const tagText = (job?.roleTags || []).join(' ').toLowerCase();
  const directText = `${title} ${qualificationText}`;
  const workPattern = workPatternFor(job);
  const nonShift = nonShiftAssessmentFor(job);
  const reasons = [];
  let score = 0;
  const add = (points, reason) => {
    score += points;
    if (reason) reasons.push(reason);
  };

  const strongNurseEvidence = /간호(?!조무)사|간호직|임상\s*간호|산업\s*간호|사내\s*간호|연구\s*간호|보건\s*교사|nurse|\brn\b/i.test(directText);
  const taggedNurseEvidence = /(?:^|\s)(?:간호사|간호직|임상간호사?|산업간호사)(?:\s|$)/i.test(tagText);
  const nurseEvidence = strongNurseEvidence || taggedNurseEvidence;
  const healthManager = /보건\s*관리|안전\s*[·/]?\s*보건|산업\s*보건/i.test(title) || /(?:^|\s)보건관리자(?:\s|$)/i.test(tagText);
  const assistantOnly = /간호\s*조무사/i.test(title) && !strongNurseEvidence;

  if (nonShift.status === 'confirmed') add(36, nonShift.label);
  else if (nonShift.status === 'likely') add(10, '워라벨 추천');
  if (/평일|주말\s*(?:근무)?\s*(?:없|x)|토(?:요일)?\s*(?:근무)?\s*(?:없|x)|야간\s*(?:근무)?\s*(?:없|제외)|교대\s*(?:근무)?\s*(?:없|제외)/i.test(title)) add(16, '평일·비교대 단서');

  if (/외래|클리닉|건강\s*검진|검진\s*센터|내시경|채혈|혈액원|예방\s*접종|주사실|영상의학|심장검사|핵의학/i.test(title)) add(28, '외래·검진 업무');
  if (/연구\s*간호|임상\s*시험|\bcrc\b|\birb\b|보험\s*심사|심사\s*간호|상담실|감염\s*관리|교육\s*간호|코디네이터|전담\s*간호/i.test(title)) add(26, '연구·상담 업무');
  if (/학교.*간호|보건\s*교사|학교\s*보건|방문\s*간호|보건소|정신건강복지센터|사내\s*간호|산업\s*간호|건강관리실|건강\s*증진/i.test(title)) add(20, '학교·지역·사업장 간호');
  if (/병동|중환자실|응급실|응급센터/i.test(title)) add(-20);

  if (workPattern === '2교대') add(-38);
  if (workPattern === '3교대') add(-70);
  if (workPattern === '야간전담') add(-90);
  if (nonShift.status === 'conflict') add(-75, '근무조건 충돌');
  else if (nonShift.status === 'shift' && workPattern === '원문 확인') add(-55, nonShift.label);
  if (/\bn\s*\/\s*k\b|나이트\s*전담|night\s*only/i.test(title)) add(-24);

  if (healthManager && strongNurseEvidence) add(8, '간호사 지원 단서');
  else if (healthManager) add(-45, '일반 보건관리 공고');
  else if (strongNurseEvidence) add(4);
  else if (taggedNurseEvidence) add(2);
  if (assistantOnly) add(-60, '간호조무사 중심 공고');

  return {
    score,
    reasons: [...new Set(reasons)].slice(0, 3),
    nurseEvidence,
    genericHealthManager: healthManager && !strongNurseEvidence,
  };
}

const MAJOR_MEDICAL_SOURCE_PATTERN = /^(?:서울대병원|분당서울대병원|서울아산병원|삼성서울병원|국립암센터|가톨릭의료원|연세의료원|이화의료원|경희의료원|건국대병원|고려대의료원)$/;
const MAJOR_MEDICAL_EMPLOYER_PATTERN = /(?:서울대학교병원|분당서울대학교병원|서울아산병원|삼성서울병원|강북삼성병원|국립암센터|국립중앙의료원|세브란스병원|연세대학교\s*(?:의료원|.*병원)|가톨릭대학교\s*.*병원|(?:서울|여의도|은평|부천|의정부)성모병원|성빈센트병원|고려대학교\s*(?:의료원|.*병원)|경희대학교병원|경희의료원|이화여자대학교\s*.*병원|이대(?:서울|목동)병원|한양대학교병원|중앙대학교(?:의료원|.*병원)|아주대학교병원|인하대학교병원|순천향대학교\s*.*병원|인제대학교\s*.*백병원|한림대학교\s*.*병원|건국대학교병원|가천대\s*길병원|대학교(?:\s*부속)?\s*(?:의료원|병원)|대학병원)/i;
const PUBLIC_OR_LARGE_EMPLOYER_PATTERN = /(?:국립|국가|보건소|한국보훈복지의료공단|근로복지공단|국민건강보험공단|건강보험심사평가원|한국전력공사|한국수력원자력|삼성전자|삼성전기|삼성디스플레이|현대자동차|기아(?:자동차)?|에스케이하이닉스|sk\s*하이닉스|lg\s*(?:전자|디스플레이|화학)|포스코|한화에어로스페이스|대한항공)/i;
const OUTSOURCED_EMPLOYER_PATTERN = /(?:커리어넷|아이피시|아웃소싱|파견|도급)/i;

const CAREER_ROLE_SIGNALS = [
  { pattern: /연구\s*간호|임상\s*시험|\bcrc\b|\birb\b|연구\s*코디|clinical research/i, reason: '임상연구·CRC 직무', points: 42 },
  { pattern: /감염\s*관리|환자\s*안전|의료\s*질|질\s*향상|적정\s*진료|심사\s*평가|보험\s*심사|성과\s*가치|\bqps?\b|\bqi\b/i, reason: '전문부서 전환 직무', points: 40 },
  { pattern: /교육\s*전담|교육\s*간호|전담\s*간호|진료\s*지원|결핵\s*전담|장기\s*이식|이식\s*코디|케이스\s*매니저|case manager/i, reason: '임상경력 활용 직무', points: 36 },
  { pattern: /clinical specialist|임상\s*전문|의료기기.{0,16}(?:임상|교육|지원)|학술\s*간호/i, reason: '임상전문 직무', points: 38 },
  { pattern: /산업\s*간호|사업장\s*간호|건강\s*관리실|보건\s*관리|산업\s*보건/i, reason: '산업간호 전환 직무', points: 32 },
];

export function careerTransitionAssessmentFor(job = {}) {
  const title = String(job?.title || '');
  const employer = String(job?.company || '');
  const source = String(job?.source || '');
  const roleTagText = (job?.roleTags || []).join(' ');
  const roleText = [title, job?.department, job?.duties, roleTagText].filter(Boolean).join(' ');
  const nurseEvidenceText = [title, job?.qualifications, job?.requirements, job?.duties, roleTagText].filter(Boolean).join(' ');
  const experienceEvidenceText = [title, job?.qualifications, job?.requirements, job?.preferredQualifications].filter(Boolean).join(' ');
  const nurseEvidence = /간호(?!\s*조무)사|간호직|산업\s*간호|연구\s*간호|\bnurse\b|\brn\b/i.test(nurseEvidenceText);
  const assistantMentioned = /간호\s*조무사/i.test(title);
  const detachedFromNamedInstitution = /채용과\s*무관|소속\s*아님/i.test(title) || OUTSOURCED_EMPLOYER_PATTERN.test(employer);
  const majorMedical = !detachedFromNamedInstitution
    && (MAJOR_MEDICAL_SOURCE_PATTERN.test(source) || MAJOR_MEDICAL_EMPLOYER_PATTERN.test(employer));
  const publicOrLargeEmployer = !detachedFromNamedInstitution
    && (source === 'JOB-ALIO' || PUBLIC_OR_LARGE_EMPLOYER_PATTERN.test(employer));
  const organizationReason = majorMedical ? '대학·대형병원' : publicOrLargeEmployer ? '공공·대형 기관' : '';
  const roleSignal = CAREER_ROLE_SIGNALS.find(({ pattern }) => pattern.test(roleText));
  const nonShift = nonShiftAssessmentFor(job);
  const employment = employmentDisplay(job);
  const stableEmployment = /(?:^|[\s·,/|])정규직(?:$|[\s·,/|])|무기\s*계약|공무직/.test(employment.replace(/비정규직/g, ''))
    && !/계약직|기간제|시간제|임시직|프리랜서|파견|촉탁/.test(employment);
  const facility = facilityTypeFor(job);
  const lowerFitIdentity = `${employer} ${title} ${job?.facilityType || ''}`;
  const lowerFitFacility = /요양\s*(?:병원|원)|재활\s*(?:병원|센터)/i.test(lowerFitIdentity)
    || facility === '요양·재활' || facility === '의원·검진센터' && !majorMedical;
  const hasShiftBurden = ['shift', 'conflict'].includes(nonShift.status);
  const icuExperienceSignal = /중환자실|중증\s*환자|\bicu\b/i.test(experienceEvidenceText);
  const normalCandidate = nonShift.candidate && Boolean(roleSignal || organizationReason);
  const exceptionalButUnverified = nonShift.status === 'unknown' && Boolean(roleSignal && organizationReason);
  const priority = nurseEvidence && !assistantMentioned && !lowerFitFacility && !hasShiftBurden
    && (normalCandidate || exceptionalButUnverified);

  let score = 0;
  if (nonShift.status === 'confirmed') score += 38;
  else if (nonShift.status === 'likely') score += 20;
  else if (nonShift.status === 'unknown') score -= 8;
  if (roleSignal) score += roleSignal.points;
  if (majorMedical) score += 32;
  else if (publicOrLargeEmployer) score += 27;
  if (stableEmployment) score += 16;
  if (icuExperienceSignal) score += 12;
  if (/계약직|기간제|시간제|임시직|프리랜서|파견|촉탁/.test(employment)) score -= 7;
  if (lowerFitFacility) score -= 45;
  if (assistantMentioned) score -= 55;
  if (hasShiftBurden) score -= 90;

  const reasons = [
    icuExperienceSignal ? '중환자실 경력 활용' : roleSignal?.reason,
    organizationReason,
    stableEmployment ? (/공무직|무기\s*계약/.test(employment) ? '안정 고용' : '정규직') : '',
  ].filter(Boolean);

  return {
    priority,
    score,
    reasons: [...new Set(reasons)].slice(0, 3),
    role: roleSignal?.reason || '',
    organization: organizationReason,
    stableEmployment,
    scheduleNeedsCheck: nonShift.status === 'unknown',
  };
}

export const APPLICATION_TIER_META = Object.freeze({
  S: { order: 0, grade: 'S', label: '최우선 지원', shortLabel: '최우선', description: '기관·직무·상근 조건이 모두 좋은 공고' },
  A: { order: 1, grade: 'A', label: '적극 검토', shortLabel: '적극 검토', description: '커리어 이동 가치가 높고 확인할 조건이 적은 공고' },
  B: { order: 2, grade: 'B', label: '조건 확인', shortLabel: '조건 확인', description: '가능성은 있지만 근무시간·자격·고용 조건을 더 봐야 하는 공고' },
  C: { order: 3, grade: 'C', label: '후순위', shortLabel: '후순위', description: '상근 장점보다 경력·기관·안정성이 아쉬운 공고' },
  exclude: { order: 4, grade: '제외', label: '제외 권장', shortLabel: '제외', description: '교대·야간, 계약·기간제 또는 지원 조건이 현재 전환 방향과 맞지 않는 공고' },
});

export const APPLICATION_TIER_ORDER = Object.freeze(['S', 'A', 'B', 'C', 'exclude']);

const APPLICATION_CAREER_SIGNALS = [
  { pattern: /감염\s*관리|환자\s*안전|의료\s*질|질\s*향상|적정\s*진료|심사\s*평가|보험\s*심사|성과\s*가치|\bqps?\b|\bqi\b/i, points: 30, reason: '전문부서로 경력 확장' },
  { pattern: /교육\s*전담|교육\s*간호|전담\s*간호|진료\s*지원|장기\s*이식|이식\s*코디|케이스\s*매니저|case manager/i, points: 29, reason: '임상경력 활용 직무' },
  { pattern: /연구\s*간호|임상\s*시험|\bcrc\b|\birb\b|hrpp|연구\s*코디|clinical research/i, points: 28, reason: '임상연구 커리어' },
  { pattern: /clinical specialist|임상\s*전문|의료기기.{0,16}(?:임상|교육|지원)|학술\s*간호/i, points: 28, reason: '임상전문 직무' },
  { pattern: /산업\s*간호|사업장\s*간호|건강\s*관리실|보건\s*관리|산업\s*보건/i, points: 24, reason: '산업간호 전환 직무' },
];

const NON_CLINICAL_NURSING_ROLE_PATTERN = /보건\s*관리|산업\s*(?:간호|보건)|(?:사내|사업장|기업)\s*간호|건강\s*관리실|보건\s*교사|학교\s*보건|연구\s*간호|임상\s*시험|\bcrc\b|\birb\b|hrpp|연구\s*코디|clinical research|감염\s*관리|환자\s*안전|의료\s*질|질\s*향상|적정\s*진료|보험\s*심사|심사\s*(?:간호|평가)|성과\s*가치|\bqps?\b|\bqi\b|clinical specialist|의료기기.{0,16}(?:임상|교육|지원)|학술\s*간호/i;
const DIRECT_CLINICAL_ROLE_PATTERN = /병동|중환자실|응급실|응급\s*(?:센터|의료)|수술실|수술\s*간호|마취\s*회복|회복실|입원\s*간호|외래|내시경|건강\s*검진|검진\s*센터|투석|인공\s*신장|주사실|채혈|분만실|신생아실|진료\s*지원|전담\s*간호|전문\s*간호|\b(?:icu|nicu|picu|ccu|pa)\b/i;
const MEDICAL_WORKPLACE_PATTERN = /병원|의료원|의원|클리닉|검진\s*센터|의료\s*(?:재단|법인)|내과|외과|산부인과|소아청소년과|이비인후과|피부과|비뇨의학과|마취통증의학과|\bhospital\b|\bclinic\b|medical\s*cent(?:er|re)/i;
const CRC_ROLE_PATTERN = /연구\s*간호|임상\s*시험|\bcrc\b|연구\s*코디|clinical research/i;

function careRoleText(job = {}) {
  // Verified detail enrichment merges duties into these role fields. Employer,
  // qualifications, and free-form descriptions are not advertised-role evidence.
  return [job?.title, job?.department, job?.duties, job?.roleTags]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string').join('\n');
}

/** Discovery interest only: a care role never proves a daytime schedule. */
export function careRoleFor(job = {}) {
  const text = careRoleText(job);
  if (CRC_ROLE_PATTERN.test(text)) return 'other';
  if (/\bpa\b|physician\s+assistant|진료\s*지원/i.test(text)) return 'pa';
  if (/보건\s*관리|산업\s*(?:간호|보건)|(?:사내|사업장|기업)\s*간호|건강\s*관리실|보건\s*교사|학교\s*보건|\b(?:health-manager|occupational-nurse)\b/i.test(text)) return 'health';
  // "전담" also describes specialist departments and shift assignments; those
  // are not PA synonyms, even when a generic nursing tag accompanies them.
  if (NON_CLINICAL_NURSING_ROLE_PATTERN.test(text)
    || /교육\s*(?:전담|간호)|결핵\s*전담|(?:상담|행정(?:업무)?)\s*전담/i.test(text)) return 'other';
  const dedicated = text.replace(/(?:야간|주간|나이트|데이|night|day|[23]\s*교대)\s*전담/gi, '');
  if (/전담\s*간호(?!\s*조무)|간호(?:사|직)?\s*[([（·:/-]*\s*전담/i.test(dedicated)
    || /(?:^|\n)\s*전담\s*(?:\n|$)/.test(dedicated) && /간호(?!\s*조무)|\bnurs(?:e|ing)\b|\brn\b/i.test(dedicated)) return 'pa';
  if (/외래|\boutpatient\b/i.test(text)) return 'outpatient';
  return 'other';
}

/**
 * Finds explainable B/C-tier postings that may be overlooked in the full catalog.
 * Each returned reason is grounded in the advertised role or explicit schedule;
 * missing schedule details are deliberately not treated as a positive signal.
 */
export function hiddenOpportunityFor(job = {}, profile = {}, now = new Date()) {
  const tier = applicationTierGroupFor(job, profile);
  if (!['B', 'C'].includes(tier) || deadlineInfo(job, now).status === 'closed') return null;

  const reasons = [];
  const role = careRoleFor(job);
  const roleLabels = { pa: 'PA·전담 직무 명시', outpatient: '외래 직무 명시', health: '보건·산업간호 직무 명시' };
  if (roleLabels[role]) reasons.push(roleLabels[role]);

  const schedule = nonShiftAssessmentFor(job);
  if (schedule.status === 'confirmed' && isHospitalClinicalJob(job)) {
    reasons.push(schedule.label);
  } else if (!reasons.length && schedule.status === 'likely' && schedule.signal) {
    reasons.push(schedule.signal === '전문직무' ? '전문 간호업무 단서 확인' : `${schedule.signal} 직무`);
  }

  if (!reasons.length) return null;
  const cautions = [];
  if (schedule.status !== 'confirmed') cautions.push('근무표·교대 여부 원문 확인');
  if (employmentDisplay(job) === '원문 확인') cautions.push('고용형태 확인');
  if (deadlineInfo(job, now).status === 'unknown') cautions.push('지원 마감일 확인');
  return { tier, reasons: [...new Set(reasons)], cautions };
}

function isDedicatedNurseJob(job = {}) {
  const title = String(job?.title || '');
  const roleTags = Array.isArray(job?.roleTags) ? job.roleTags : [job?.roleTags].filter(Boolean);
  const advertisedRole = [title, ...roleTags].filter(Boolean).join(' ');
  return /전담/i.test(title) && /간호|\bnurs(?:e|ing)\b|\brn\b/i.test(advertisedRole);
}

export function isHospitalClinicalJob(job = {}) {
  const title = String(job?.title || '');
  const department = String(job?.department || '');
  // Identify the advertised role, not the applicant's past clinical experience
  // or a nursing license mentioned in qualifications for a non-clinical job.
  // Dedicated nurse roles always take precedence over specialty-department exceptions.
  if (isDedicatedNurseJob(job)) return true;
  if (NON_CLINICAL_NURSING_ROLE_PATTERN.test(title)) return false;
  if (DIRECT_CLINICAL_ROLE_PATTERN.test(title)) return true;
  if (NON_CLINICAL_NURSING_ROLE_PATTERN.test(department)) return false;

  const roleTags = Array.isArray(job?.roleTags) ? job.roleTags : [job?.roleTags].filter(Boolean);
  const roleText = [title, department, job?.duties, ...roleTags].filter(Boolean).join(' ');
  const nursingRole = /간호\s*(?:사|직|본부|부|팀)|\bnurs(?:e|ing)\b|\brn\b/i.test(roleText);
  if (!nursingRole) return false;
  const workplace = [job?.company, title, job?.facilityType, job?.source].filter(Boolean).join(' ');
  return MEDICAL_WORKPLACE_PATTERN.test(workplace)
    || MAJOR_MEDICAL_EMPLOYER_PATTERN.test(String(job?.company || ''))
    || MAJOR_MEDICAL_SOURCE_PATTERN.test(String(job?.source || ''))
    || DIRECT_CLINICAL_ROLE_PATTERN.test(roleText)
    || /임상\s*간호|clinical[ -]?nurse/i.test(roleTags.join(' '));
}

export function isApplicationTopTierExcludedJob(job = {}) {
  if (CRC_ROLE_PATTERN.test(careRoleText(job))) return true;
  if (['pa', 'outpatient'].includes(careRoleFor(job))) return false;
  return isHospitalClinicalJob(job);
}

const SPECIALTY_REQUIREMENT_SIGNALS = [
  { id: 'hrpp', label: 'HRPP·IRB 실무 경력', pattern: /hrpp|\birb\b|연구\s*윤리|임상\s*시험/i },
  { id: 'infection-control', label: '감염관리 실무 경력', pattern: /감염\s*관리/i },
  { id: 'quality-safety', label: '환자안전·QI 실무 경력', pattern: /환자\s*안전|의료\s*질|질\s*향상|적정\s*진료|\bqps?\b|\bqi\b/i },
  { id: 'occupational-health', label: '보건관리·산업보건 경력', pattern: /보건\s*관리|산업\s*보건|산업\s*간호/i },
  { id: 'insurance-review', label: '보험심사 실무 경력', pattern: /보험\s*심사|심사\s*간호|심사\s*평가/i },
];

function annualSalaryWonFor(job = {}) {
  const rawSalary = job?.salary && typeof job.salary === 'object' ? job.salary.raw || job.salary.text : job?.salary;
  const text = [rawSalary, job?.workConditions].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  if (!text) return null;
  const number = (value) => Number(String(value || '').replace(/,/g, ''));
  const tenThousand = text.match(/(?:연봉\s*)?(\d[\d,]*(?:\.\d+)?)\s*만\s*원/i);
  if (tenThousand) {
    const amount = number(tenThousand[1]);
    if (amount >= 100 && amount <= 30000) return Math.round(amount * 10000);
  }
  const annualWon = text.match(/연봉[^\d]{0,8}(\d[\d,]{5,})\s*원/i) || text.match(/(\d[\d,]{6,})\s*원[^\n]{0,12}(?:연봉|연간)/i);
  if (annualWon) return number(annualWon[1]);
  const monthly = text.match(/(?:월급|월\s*급여)[^\d]{0,8}(\d[\d,]*(?:\.\d+)?)\s*만\s*원/i);
  if (monthly) return Math.round(number(monthly[1]) * 10000 * 12);
  return null;
}

function requiredSpecialtyFor(job = {}, profile = {}) {
  const requiredText = [job?.experienceRequirements, job?.experience, job?.qualifications, job?.requirements]
    .filter(Boolean).join('\n');
  if (!requiredText) return null;
  const clauses = requiredText.split(/\n+|[.!?。；;·ㆍ•●▪]/).map((clause) => clause.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const knownDomains = new Set(Array.isArray(profile?.careerDomains) ? profile.careerDomains : ['clinical', 'icu']);
  for (const signal of SPECIALTY_REQUIREMENT_SIGNALS) {
    const clause = clauses.find((item) => signal.pattern.test(item)
      && /경력|경험|실무|근무\s*이력/i.test(item)
      && /\d+\s*년|\d+\s*개월|이상|필수|지원\s*자격|자격\s*요건/i.test(item)
      && !(/우대|선호/.test(item) && !/필수/.test(item)));
    if (clause && !knownDomains.has(signal.id)) return { ...signal, evidence: clause.slice(0, 120) };
  }
  return null;
}

function tierForScore(score) {
  if (score >= 82) return 'S';
  if (score >= 70) return 'A';
  if (score >= 55) return 'B';
  return 'C';
}

function capApplicationTier(tier, cap) {
  return APPLICATION_TIER_META[tier].order < APPLICATION_TIER_META[cap].order ? cap : tier;
}

/**
 * Rates application priority for an experienced tertiary-hospital ICU nurse
 * moving toward a worthwhile daytime role. AI may extract posting facts, but
 * this final decision remains deterministic and explainable.
 */
export const APPLICATION_TIER_RULE_VERSION = 'care-role-v2';

export function applicationTierProfileKey(profile = {}) {
  return JSON.stringify([
    APPLICATION_TIER_RULE_VERSION,
    profile.regionCodes?.length ? profile.regionCodes : ['서울', '경기'],
    Array.isArray(profile.careerDomains) ? profile.careerDomains : ['clinical', 'icu'],
  ]);
}

export function applicationTierFor(job = {}, profile = {}) {
  if (job.presentation?.profileKey === applicationTierProfileKey(profile)
    && job.presentation.applicationTier
    && deadlineInfo(job).status !== 'closed') return job.presentation.applicationTier;
  const title = String(job?.title || '');
  const employer = String(job?.company || '');
  const roleTags = Array.isArray(job?.roleTags) ? job.roleTags : [job?.roleTags].filter(Boolean);
  const roleText = [title, job?.department, job?.duties, ...roleTags].filter(Boolean).join(' ');
  const careRole = careRoleFor(job);
  const requirementText = [job?.experienceRequirements, job?.experience, job?.qualifications, job?.requirements].filter(Boolean).join(' ');
  const allText = normalizedText(job);
  const nonShift = nonShiftAssessmentFor(job);
  const transition = careerTransitionAssessmentFor(job);
  const workLife = workLifeBalanceFor(job);
  const parsedEligibility = parseEligibility(job);
  const employment = employmentDisplay(job);
  const employmentUnknown = employment === '원문 확인';
  const employmentEvidenceText = `${title} ${employment} ${allText}`;
  const contractTitle = /계약직|기간제|파견|도급/i.test(title);
  const contractEmployment = contractTitle || /계약직|기간제|파견|도급/i.test(employment);
  const regularEmploymentOption = /(?:^|[\s·,/|])정규직(?:$|[\s·,/|])/.test(employment.replace(/비정규직/g, ''));
  const indefiniteEmployment = /무기\s*계약직?|기간의\s*정함이\s*없는/i.test(employmentEvidenceText);
  const regularConversionEmployment = /(?:정규직|무기\s*계약직?)\s*(?:으로\s*)?전환|전환\s*(?:후\s*)?(?:정규직|무기\s*계약직?)/i.test(employmentEvidenceText);
  const mixedRegularContractEmployment = contractEmployment && regularEmploymentOption && !contractTitle;
  const contractException = indefiniteEmployment || regularConversionEmployment || mixedRegularContractEmployment;
  const replacementEmployment = /대체\s*인력|대체\s*근무|휴직.{0,12}대체|한시\s*(?:채용|근무|계약)/i.test(employmentEvidenceText);
  const facility = facilityTypeFor(job);
  const specialtyRequirement = requiredSpecialtyFor(job, profile);
  const assistantMentioned = /간호\s*조무사/i.test(title);
  const nurseRole = /간호(?!\s*조무)사|간호직|산업\s*간호|연구\s*간호|\bnurse\b|\brn\b/i.test(`${roleText} ${requirementText}`);
  const outsourced = OUTSOURCED_EMPLOYER_PATTERN.test(employer) || /파견|도급|아웃소싱/i.test(employment);
  const deadline = deadlineInfo(job);
  const exclusions = [];
  const reasons = [];
  const cautions = [];

  if (deadline.status === 'closed') exclusions.push('이미 마감된 공고');
  if (['shift', 'conflict'].includes(nonShift.status)) exclusions.push(nonShift.label);
  if (assistantMentioned) exclusions.push('간호조무사 포함 공고');
  if (parsedEligibility.eligibilityStatus === 'ineligible') exclusions.push('간호사 면허만으로 지원 불가');
  if (workLife.genericHealthManager && !nurseRole) exclusions.push('간호사 지원 근거 없음');
  if (replacementEmployment) exclusions.push('대체인력·한시 고용');
  else if (contractEmployment && !contractException) exclusions.push('계약·기간제 고용');

  let career = 10;
  let careerReason = '간호 경력 연계 여부 확인';
  const careerSignal = careRole === 'pa'
    ? { points: 29, reason: '임상경력 활용 직무' }
    : APPLICATION_CAREER_SIGNALS.find(({ pattern }) => pattern.test(roleText));
  if (careerSignal) {
    career = careerSignal.points;
    careerReason = careerSignal.reason;
  } else if (/외래|건강\s*검진|검진\s*센터|내시경|주사실|채혈/i.test(roleText)) {
    career = transition.organization === '대학·대형병원' ? 22 : 12;
    careerReason = transition.organization === '대학·대형병원' ? '대형병원 외래·검진 직무' : '외래·검진 전환 직무';
  } else if (/중환자실|응급실|병동|수술실|입원\s*간호|\bicu\b/i.test(roleText)) {
    career = 6;
    careerReason = '현재 임상경력과 유사';
  } else if (transition.organization === '대학·대형병원' && nurseRole) {
    career = 18;
    careerReason = '대형병원 간호 경력 유지';
  }
  if (/중환자실|중증\s*환자|\bicu\b/i.test(requirementText) && careerSignal) {
    career = 30;
    careerReason = '중환자실 경력 직접 활용';
  }
  if (facility === '요양·재활') {
    career = Math.min(career, 5);
    careerReason = '요양·재활 중심 직무';
  }
  reasons.push(careerReason);

  let organization = 7;
  if (transition.organization === '대학·대형병원') {
    organization = 20;
    reasons.push('대학·대형병원');
  } else if (transition.organization === '공공·대형 기관') {
    organization = 18;
    reasons.push('공공·대형 기관');
  } else if (facility === '병원·의료원') organization = 12;
  else if (facility === '기업·사업장') organization = 10;
  else if (facility === '의원·검진센터') organization = 5;
  else if (facility === '요양·재활') organization = 2;
  if (outsourced) {
    organization = Math.min(organization, 4);
    cautions.push('직접고용 여부 확인');
  }

  const schedule = nonShift.status === 'confirmed' ? 20 : nonShift.status === 'likely' ? 12 : 5;
  if (nonShift.status === 'confirmed') reasons.push('상근·주간 확인');
  else if (nonShift.status === 'likely') cautions.push('실제 근무시간 확인');
  else if (nonShift.status === 'unknown') cautions.push('근무형태 확인 필요');

  const regularEmployment = transition.stableEmployment;
  const shortOrFlexible = /시간제|단시간|임시직|일용직|프리랜서|촉탁/i.test(employment);
  let stability = 6;
  if (replacementEmployment) {
    stability = 3;
    cautions.push('대체인력·한시 채용');
  } else if (regularEmployment) {
    stability = 15;
    reasons.push('정규직·안정 고용');
  } else if (indefiniteEmployment) {
    stability = 13;
    reasons.push('무기계약·장기고용');
    cautions.push('무기계약 고용조건 확인');
  } else if (regularConversionEmployment) {
    stability = 9;
    reasons.push('정규직 전환 경로');
    cautions.push('정규직 전환 조건 확인');
  } else if (shortOrFlexible) {
    stability = 3;
    cautions.push('단기·시간제 고용');
  } else if (contractEmployment) {
    stability = 3;
    cautions.push(mixedRegularContractEmployment ? '정규직 채용 여부 확인' : '계약·기간제 고용');
  } else if (employmentUnknown) cautions.push('고용형태 확인 필요');

  const annualSalary = annualSalaryWonFor(job);
  let compensation = annualSalary == null ? 5 : annualSalary >= 50000000 ? 10 : annualSalary >= 42000000 ? 9 : annualSalary >= 36000000 ? 8 : annualSalary >= 30000000 ? 7 : 4;
  if (/복지\s*포인트|성과급|퇴직금|기숙사|의료비\s*지원|4대\s*보험/i.test(allText)) compensation = Math.min(10, compensation + 1);
  if (annualSalary == null) cautions.push('급여 확인 필요');

  const preferredRegions = Array.isArray(profile?.regionCodes) && profile.regionCodes.length ? profile.regionCodes : ['서울', '경기'];
  const region = cleanUnknown(job?.region || job?.location);
  const regionKnown = region !== '원문 확인';
  const regionMatched = regionKnown && preferredRegions.some((item) => region.includes(item));
  let feasibility = regionMatched ? 5 : regionKnown ? 1 : 3;
  if (regionKnown && !regionMatched) cautions.push('희망 지역 밖');
  else if (!regionKnown) cautions.push('근무지 확인 필요');
  if (deadline.days != null && deadline.days >= 0 && deadline.days <= 3) {
    feasibility = Math.max(0, feasibility - 1);
    cautions.push('마감 임박');
  }

  const dimensions = { career, organization, schedule, stability, compensation, feasibility };
  const score = Object.values(dimensions).reduce((total, points) => total + points, 0);
  let tier = tierForScore(score);
  let eligibilityStatus = 'eligible';
  let eligibilityLabel = '지원 검토 가능';

  if (specialtyRequirement) {
    eligibilityStatus = 'needs-check';
    eligibilityLabel = '필수 경력 확인';
    cautions.unshift(`${specialtyRequirement.label} 확인`);
    tier = capApplicationTier(tier, 'B');
  }
  if (/석사\s*(?:학위)?\s*이상|박사\s*(?:학위)?|전문\s*간호사\s*(?:자격|면허).{0,12}(?:필수|소지)/i.test(requirementText)) {
    eligibilityStatus = 'needs-check';
    eligibilityLabel = '필수 자격 확인';
    cautions.unshift('학위·전문자격 확인');
    tier = capApplicationTier(tier, 'B');
  }

  let evidencePoints = 0;
  if (job?.detailVerified === true || job?.officialSourceUrl || job?.sourceImages?.length || job?.attachments?.length) evidencePoints += 3;
  else if (job?.detailEnrichmentCheckedAt || job?.detailCheckedAt) evidencePoints += 2;
  if (nonShift.status !== 'unknown') evidencePoints += 2;
  if (!employmentUnknown) evidencePoints += 2;
  if (requirementText) evidencePoints += 2;
  if (annualSalary != null) evidencePoints += 1;
  const confidence = evidencePoints >= 7 ? 'high' : evidencePoints >= 4 ? 'medium' : 'low';
  if (nonShift.status === 'likely') tier = capApplicationTier(tier, 'A');
  if (nonShift.status === 'unknown' || employmentUnknown || confidence === 'low') tier = capApplicationTier(tier, 'B');
  if (['pa', 'outpatient'].includes(careRole) && nonShift.status !== 'confirmed') tier = capApplicationTier(tier, 'B');
  if (['pa', 'outpatient'].includes(careRole) && parsedEligibility.eligibilityStatus === 'unknown') {
    tier = capApplicationTier(tier, 'B');
    if (eligibilityStatus === 'eligible') {
      eligibilityStatus = 'needs-check';
      eligibilityLabel = '지원 자격 확인';
      cautions.unshift('간호사 지원 자격 확인');
    }
  }
  if (contractEmployment && contractException) {
    tier = capApplicationTier(tier, 'B');
    if (eligibilityStatus === 'eligible') {
      eligibilityStatus = 'needs-check';
      eligibilityLabel = mixedRegularContractEmployment ? '정규직 여부 확인' : indefiniteEmployment ? '고용 안정성 확인' : '정규직 전환 확인';
    }
  }

  if (isApplicationTopTierExcludedJob(job)) {
    tier = capApplicationTier(tier, 'B');
    cautions.unshift(CRC_ROLE_PATTERN.test(roleText) ? 'CRC·연구간호사 · S·A 추천 제외' : '병원 임상직 · S·A 추천 제외');
  }

  if (exclusions.length) {
    tier = 'exclude';
    eligibilityStatus = 'ineligible';
    eligibilityLabel = '지원 제외 권장';
  }

  return {
    tier,
    ...APPLICATION_TIER_META[tier],
    score,
    dimensions,
    eligibility: { status: eligibilityStatus, label: eligibilityLabel },
    confidence,
    reasons: [...new Set(reasons)].slice(0, 3),
    cautions: [...new Set([...exclusions, ...cautions])].slice(0, 3),
    specialtyRequirement,
  };
}

export function applicationTierGroupFor(job = {}, profile = {}) {
  if (job?.presentation && job.presentation.profileKey !== applicationTierProfileKey(profile)) return applicationTierFor(job, profile).tier;
  if (!APPLICATION_TIER_META[job?.applicationTierGroup]) return applicationTierFor(job, profile).tier;
  // Newly verified PA/outpatient duties can release an earlier blanket B cap;
  // their current schedule and eligibility must still agree with the card tier.
  if (['pa', 'outpatient'].includes(careRoleFor(job))) return applicationTierFor(job, profile).tier;
  // Session grouping stays stable, but it must still honor the clinical-role cap
  // when newly loaded detail identifies a hospital role in an earlier S/A group.
  return isApplicationTopTierExcludedJob(job) ? capApplicationTier(job.applicationTierGroup, 'B') : job.applicationTierGroup;
}

const LISTING_DAY_MS = 86400000;
export const LISTING_AGE_NEW_DAYS = 3;
export const LISTING_AGE_STALE_DAYS = 14;

function listingTimestampFor(value) {
  if (value == null || value === '') return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function listingDateInfoFor(job = {}) {
  for (const [field, value] of [['publishedAt', job?.publishedAt], ['postedAt', job?.postedAt]]) {
    const timestamp = listingTimestampFor(value);
    if (timestamp != null) return { field, value, timestamp };
  }
  return null;
}

export function listingAgeDaysFor(job = {}, now = Date.now()) {
  const seen = listingDateInfoFor(job)?.timestamp ?? listingTimestampFor(job?.firstSeenAt);
  if (seen == null) return null;
  return Math.max(0, Math.floor((now - seen) / LISTING_DAY_MS));
}

export function listingFreshnessFor(job = {}, now = Date.now()) {
  const days = listingAgeDaysFor(job, now);
  if (days == null) return 'unknown';
  if (days <= LISTING_AGE_NEW_DAYS) return 'new';
  if (days <= LISTING_AGE_STALE_DAYS) return 'recent';
  return 'stale';
}

function listingAgePenaltyFor(job = {}, now = Date.now()) {
  const days = listingAgeDaysFor(job, now);
  if (days == null || days <= 7) return 0;
  if (days <= LISTING_AGE_STALE_DAYS) return 2;
  if (days <= 28) return 5;
  return 9;
}

export function sortJobs(jobs, sort = '워라벨 우선', profile = {}, options = {}) {
  const result = [...jobs];
  const tierLatest = options?.tierLatest === true;
  const time = (...values) => {
    for (const value of values) {
      if (!value) continue;
      const parsed = new Date(value).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  };
  if (sort === '워라벨 우선') {
    const tieBreaks = new Map();
    const tieBreakFor = (job) => {
      if (!tieBreaks.has(job)) tieBreaks.set(job, {
        shiftRank: nonShiftAssessmentFor(job).rank,
        workLifeScore: workLifeBalanceFor(job).score,
      });
      return tieBreaks.get(job);
    };
    const applicationFit = new Map(result.map((job) => {
      const fit = APPLICATION_TIER_META[job?.applicationTierGroup] && Number.isFinite(job?.applicationTierGroupScore)
        ? { order: APPLICATION_TIER_META[applicationTierGroupFor(job, profile)].order, score: job.applicationTierGroupScore }
        : applicationTierFor(job, profile);
      return [job, { ...fit, score: fit.score - listingAgePenaltyFor(job) }];
    }));
    const tierOrder = (a, b) => applicationFit.get(a).order - applicationFit.get(b).order;
    const latestOrder = (a, b) => {
      const aListing = listingDateInfoFor(a)?.timestamp ?? time(a.firstSeenAt);
      const bListing = listingDateInfoFor(b)?.timestamp ?? time(b.firstSeenAt);
      return bListing - aListing || time(b.firstSeenAt) - time(a.firstSeenAt);
    };
    if (tierLatest) {
      return result.sort((a, b) => tierOrder(a, b)
        || latestOrder(a, b)
        || applicationFit.get(b).score - applicationFit.get(a).score
        || tieBreakFor(a).shiftRank - tieBreakFor(b).shiftRank
        || tieBreakFor(b).workLifeScore - tieBreakFor(a).workLifeScore
        || String(a.title || '').localeCompare(String(b.title || ''), 'ko'));
    }
    return result.sort((a, b) => tierOrder(a, b)
    || applicationFit.get(b).score - applicationFit.get(a).score
    || tieBreakFor(a).shiftRank - tieBreakFor(b).shiftRank
    || tieBreakFor(b).workLifeScore - tieBreakFor(a).workLifeScore
    || latestOrder(a, b)
    || String(a.title || '').localeCompare(String(b.title || ''), 'ko'));
  }
  if (sort === '최신 등록순') return result.sort((a, b) => {
    const aListing = listingDateInfoFor(a)?.timestamp;
    const bListing = listingDateInfoFor(b)?.timestamp;
    if (aListing == null && bListing == null) return time(b.firstSeenAt) - time(a.firstSeenAt);
    if (aListing == null) return 1;
    if (bListing == null) return -1;
    return bListing - aListing || time(b.firstSeenAt) - time(a.firstSeenAt);
  });
  if (sort === '마감 임박순') return result.sort((a, b) => {
    const aInfo = deadlineInfo(a), bInfo = deadlineInfo(b);
    const aDays = aInfo.days != null && aInfo.days >= 0 ? aInfo.days : Number.POSITIVE_INFINITY;
    const bDays = bInfo.days != null && bInfo.days >= 0 ? bInfo.days : Number.POSITIVE_INFINITY;
    return aDays - bDays || time(b.firstSeenAt) - time(a.firstSeenAt);
  });
  const level = { strong: 0, partial: 1, review: 2 };
  return result.sort((a, b) => level[recommendationFor(a, profile).level] - level[recommendationFor(b, profile).level]
    || time(b.firstSeenAt) - time(a.firstSeenAt));
}

export function snapshotFromJob(job) {
  return {
    id: job.id,
    dedupeKey: job.dedupeKey || job.id,
    company: job.company,
    title: job.title,
    region: cleanUnknown(job.region),
    department: departmentFor(job),
    workPattern: workPatternFor(job),
    facilityType: facilityTypeFor(job),
    employmentType: employmentDisplay(job),
    experienceLevel: experienceDisplay(job).value,
    experience: job.experience || null,
    experienceDomain: job.experienceDomain || null,
    experienceEvidence: job.experienceEvidence || null,
    deadline: cleanUnknown(job.deadline),
    deadlineAt: job.deadlineAt || null,
    postedAt: job.postedAt || null,
    publishedAt: job.publishedAt || null,
    firstSeenAt: job.firstSeenAt || null,
    lastSeenAt: job.lastSeenAt || null,
    source: job.source,
    url: job.url,
    alternateSources: job.alternateSources || [],
    savedAt: new Date().toISOString(),
  };
}
