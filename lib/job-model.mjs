const KST_TIME_ZONE = 'Asia/Seoul';

const EMPTY_FIELD = /^(?:|[-·]|(?:경력|지역|고용형태)?\s*미표기|원문\s*확인|공고\s*확인|정보\s*확인)$/;
const GENERAL_SOURCES = new Set(['사람인', '잡코리아', '캐치', '고용24', 'JOB-ALIO', '원티드', '직행', '인크루트']);
const MIXED_BOARD_SOURCES = new Set(['직업건강협회', '산업보건협의회']);
const TRUSTED_NURSING_SOURCES = new Set([
  '널스잡', '널스링크', '너스케입', '널스넷', 'RNJOB', '서울대병원', '서울아산병원',
  '삼성서울병원', '메디컬잡', '병원잡', '서울성모병원', '분당서울대병원', '국립암센터',
  '보험심사간호사회', '연세의료원', '이화의료원', '고려대의료원', '경희의료원',
  '건국대병원', '가톨릭의료원',
  '국립중앙의료원', '보훈의료공단', '백병원', '한림대의료원', '서울의료원',
]);

const REGION_CODES = [
  ['서울', '11'], ['부산', '26'], ['대구', '27'], ['인천', '28'], ['광주', '29'], ['대전', '30'], ['울산', '31'], ['세종', '36'],
  ['경기', '41'], ['강원', '51'], ['충북', '43'], ['충남', '44'], ['전북', '52'], ['전남', '46'], ['경북', '47'], ['경남', '48'], ['제주', '50'],
];

function cleanText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\u200b|\ufeff/g, '').replace(/\s+/g, ' ').trim();
}

function meaningful(value) {
  const text = cleanText(value);
  return text && !EMPTY_FIELD.test(text) ? text : '';
}

function compact(value) {
  return cleanText(value).toLocaleLowerCase('ko-KR').replace(/[^\p{L}\p{N}]+/gu, '');
}

function validIso(value, fallback) {
  if (!value || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function validDateOnly(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  return isRealDate(year, month, day) ? dateOnly({ year, month, day }) : null;
}

function stripLegalForms(value) {
  return cleanText(value)
    .replace(/\(\s*(?:주|재|사|학|의)\s*\)|㈜/g, ' ')
    .replace(/(?:주식회사|유한회사|의료법인|재단법인|사단법인|사회복지법인|학교법인|법인)/g, ' ');
}

export function companyNameTokens(value) {
  return stripLegalForms(value)
    .split(/[\s·,./()[\]|]+/)
    .map((token) => compact(token))
    .filter(Boolean)
    .sort();
}

export function normalizeCompanyName(value) {
  return companyNameTokens(value).join('');
}

// 공백만 다른 표기("한빛 메디컬" vs "한빛메디컬")를 위한 어순 보존 키.
function companyNameCompactKey(value) {
  return compact(stripLegalForms(value));
}

export function normalizeJobTitle(value, company = '') {
  const title = cleanText(value)
    .replace(/^새로운\s*글\s*/i, '')
    .replace(/\(\s*\d{1,2}\s*[.\/-]\s*\d{1,2}\s*[~∼-]\s*\d{1,2}\s*[.\/-]\s*\d{1,2}\s*\)/g, '')
    .replace(/\(\s*주\s*\)|㈜/g, '');
  const original = compact(title)
    .replace(/(?:주식회사|유한회사|의료법인|재단법인|사단법인|사회복지법인|학교법인)/g, '')
    .replace(/촉탁직/g, '촉탁')
    .replace(/(?:신입경력|경력무관)/g, '')
    .replace(/(?:채용공고|모집공고|채용|모집|구인|영입|공개)/g, '')
    .replace(/채$/, '');
  const companyTokens = companyNameTokens(company).filter((token) => token.length > 1);
  const withoutCompany = companyTokens.length
    ? companyTokens.reduce((text, token) => text.replaceAll(token, ''), original)
    : original;
  return withoutCompany || original;
}

export function createDedupeKey(job) {
  const companyKey = normalizeCompanyName(job?.company);
  const titleKey = normalizeJobTitle(job?.title, job?.company);
  if (!companyKey || !titleKey || /등록기관|기관정보확인/.test(companyKey)) {
    return `source:${cleanText(job?.source)}:${cleanText(job?.id)}`;
  }
  return `${companyKey}:${titleKey}`;
}

// 회사명 표기가 다른 두 정규화(토큰 정렬·공백 제거)를 모두 후보로 쓴다.
function dedupeKeysFor(job) {
  const titleKey = normalizeJobTitle(job?.title, job?.company);
  if (!titleKey) return [];
  return [...new Set([normalizeCompanyName(job?.company), companyNameCompactKey(job?.company)])]
    .filter((companyKey) => companyKey && !/등록기관|기관정보확인/.test(companyKey))
    .map((companyKey) => `${companyKey}:${titleKey}`);
}

function kstDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function dateOnly({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateOnlyMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDateDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function parsePublishedDate(value, observedAt = new Date()) {
  const raw = meaningful(value);
  if (!raw) return { publishedAt: null, publishedKind: 'unknown' };

  const today = kstDateParts(observedAt);
  let relativeDays = null;
  if (/그제|그저께/.test(raw)) relativeDays = -2;
  else if (/어제/.test(raw)) relativeDays = -1;
  else if (/오늘|방금|\d+\s*(?:분|시간)\s*전/.test(raw)) relativeDays = 0;
  else {
    const relative = raw.match(/(\d+)\s*일\s*전/);
    if (relative) relativeDays = -Number(relative[1]);
  }
  if (relativeDays != null) {
    return { publishedAt: dateOnly(addDateDays(today, relativeDays)), publishedKind: 'relative' };
  }

  const exactDate = validDateOnly(raw);
  if (exactDate) return { publishedAt: exactDate, publishedKind: 'explicit' };

  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && !Number.isNaN(Date.parse(raw))) {
    return { publishedAt: dateOnly(kstDateParts(raw)), publishedKind: 'explicit' };
  }

  const full = raw.match(/(?:^|\D)((?:19|20)\d{2})\s*(?:[.\/-]|년\s*)\s*(\d{1,2})\s*(?:[.\/-]|월\s*)\s*(\d{1,2})(?:\s*일)?/);
  if (full) {
    const [year, month, day] = full.slice(1).map(Number);
    return isRealDate(year, month, day)
      ? { publishedAt: dateOnly({ year, month, day }), publishedKind: 'explicit' }
      : { publishedAt: null, publishedKind: 'unknown' };
  }

  const shortYear = raw.match(/(?:^|\D)(\d{2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})(?:\D|$)/);
  if (shortYear) {
    const year = 2000 + Number(shortYear[1]), month = Number(shortYear[2]), day = Number(shortYear[3]);
    return isRealDate(year, month, day)
      ? { publishedAt: dateOnly({ year, month, day }), publishedKind: 'explicit' }
      : { publishedAt: null, publishedKind: 'unknown' };
  }

  const short = raw.match(/(?:^|[^\d])([01]?\d)\s*[.\/-]\s*([0-3]?\d)(?:\D|$)/);
  if (short) {
    const month = Number(short[1]), day = Number(short[2]);
    let year = today.year;
    if (isRealDate(year, month, day)) {
      const candidate = Date.UTC(year, month - 1, day);
      const todayMs = Date.UTC(today.year, today.month - 1, today.day);
      // 게시일의 연도 생략 표기는 미래 날짜가 아니라 가장 최근의 같은 날짜로 해석한다.
      if (candidate > todayMs + 7 * 86400000) year -= 1;
      if (isRealDate(year, month, day)) {
        return { publishedAt: dateOnly({ year, month, day }), publishedKind: 'explicit' };
      }
    }
  }
  return { publishedAt: null, publishedKind: 'unknown' };
}

export function parseDeadline(value, observedAt = new Date()) {
  const raw = meaningful(value);
  if (!raw) return { deadlineAt: null, deadlineKind: 'unknown' };
  if (/상시/.test(raw)) return { deadlineAt: null, deadlineKind: 'always' };
  if (/채용\s*시/.test(raw)) return { deadlineAt: null, deadlineKind: 'until-filled' };

  const today = kstDateParts(observedAt);
  let relativeDays = null;
  if (/오늘/.test(raw)) relativeDays = 0;
  else if (/내일/.test(raw)) relativeDays = 1;
  else {
    const relative = raw.match(/D\s*-\s*(\d+)/i);
    if (relative) relativeDays = Number(relative[1]);
  }
  if (relativeDays != null) return { deadlineAt: dateOnly(addDateDays(today, relativeDays)), deadlineKind: 'fixed' };

  const full = raw.match(/(?:^|\D)((?:19|20)\d{2})\s*(?:[.\/-]|년\s*)\s*(\d{1,2})\s*(?:[.\/-]|월\s*)\s*(\d{1,2})(?:\s*일)?/);
  if (full) {
    const [year, month, day] = full.slice(1).map(Number);
    return isRealDate(year, month, day)
      ? { deadlineAt: dateOnly({ year, month, day }), deadlineKind: 'fixed' }
      : { deadlineAt: null, deadlineKind: 'unknown' };
  }

  const shortYear = raw.match(/(?:^|\D)(\d{2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})(?:\D|$)/);
  if (shortYear) {
    const year = 2000 + Number(shortYear[1]), month = Number(shortYear[2]), day = Number(shortYear[3]);
    return isRealDate(year, month, day)
      ? { deadlineAt: dateOnly({ year, month, day }), deadlineKind: 'fixed' }
      : { deadlineAt: null, deadlineKind: 'unknown' };
  }

  const short = raw.match(/(?:^|[^\d])([01]?\d)\s*[.\/-]\s*([0-3]?\d)(?:\D|$)/);
  if (short) {
    const month = Number(short[1]), day = Number(short[2]);
    let year = today.year;
    if (isRealDate(year, month, day)) {
      const candidate = Date.UTC(year, month - 1, day);
      const todayMs = Date.UTC(today.year, today.month - 1, today.day);
      if (candidate < todayMs - 180 * 86400000) year += 1;
      else if (candidate > todayMs + 180 * 86400000) year -= 1;
      if (isRealDate(year, month, day)) return { deadlineAt: dateOnly({ year, month, day }), deadlineKind: 'fixed' };
    }
  }
  return { deadlineAt: null, deadlineKind: 'unknown' };
}

export function deadlineState(deadlineAt, deadlineKind = 'unknown', now = new Date()) {
  if (!deadlineAt) {
    const status = deadlineKind === 'always' || deadlineKind === 'until-filled' ? 'open' : 'unknown';
    return { deadlineStatus: status, daysRemaining: null };
  }
  const today = dateOnly(kstDateParts(now));
  const daysRemaining = Math.round((dateOnlyMs(deadlineAt) - dateOnlyMs(today)) / 86400000);
  const deadlineStatus = daysRemaining < 0 ? 'expired' : daysRemaining === 0 ? 'today' : daysRemaining <= 3 ? 'closing-soon' : 'upcoming';
  return { deadlineStatus, daysRemaining };
}

export function normalizeRegionCode(value) {
  const text = meaningful(value);
  return REGION_CODES.find(([name]) => text.includes(name))?.[1] || null;
}

export function normalizeEmploymentType(value) {
  const text = meaningful(value);
  if (!text) return null;
  const matches = [
    [/정규직/, '정규직'], [/계약직|촉탁직|파견직/, '계약직'], [/기간제/, '기간제'],
    [/시간제|파트타임|아르바이트/, '시간제'], [/인턴/, '인턴'], [/일용/, '일용직'],
  ].filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  return matches.length === 1 ? matches[0] : matches.length > 1 ? [...new Set(matches)].join('·') : text;
}

export function normalizeExperienceLevel(value) {
  const text = meaningful(value);
  if (!text) return null;
  const isOpen = /경력\s*무관|신입\s*·?\s*경력|신입\s*\/\s*경력/.test(text);
  if (isOpen) return '경력무관';
  if (/신입|졸업예정/.test(text)) return '신입';
  if (/경력|\d+\s*년/.test(text)) return '경력';
  return text;
}

function roleEvidence(job) {
  return [
    ['제목', cleanText(job.title)], ['직무 태그', Array.isArray(job.sectors) ? job.sectors.join(' ') : cleanText(job.sectors)],
    ['설명', cleanText(job.role || job.description || job.duties)],
  ];
}

export function classifyRole(job) {
  const matchers = [
    [/보건\s*관리(?:자|직|담당)?/, '보건관리자'], [/산업\s*간호(?:사|직)?/, '산업간호사'],
    [/사업장\s*간호/, '산업간호사'], [/간호사|간호직/, '간호사'], [/보건직/, '보건직'],
  ];
  const roleTags = [];
  const confidenceReasons = [];
  for (const [field, text] of roleEvidence(job)) {
    for (const [pattern, tag] of matchers) {
      if (!pattern.test(text)) continue;
      if (!roleTags.includes(tag)) roleTags.push(tag);
      const reason = `${field}에 ${tag}`;
      if (!confidenceReasons.includes(reason)) confidenceReasons.push(reason);
    }
  }
  const source = cleanText(job.source);
  const requiresEvidence = GENERAL_SOURCES.has(source) || MIXED_BOARD_SOURCES.has(source);
  if (!roleTags.length && !requiresEvidence && TRUSTED_NURSING_SOURCES.has(source)) {
    roleTags.push(job.category === 'health' ? '보건·산업간호' : '임상간호');
    confidenceReasons.push(`${source} 간호 전문 채용처`);
  }
  const needsReview = roleTags.length === 0;
  if (needsReview) confidenceReasons.push('화면에 보이는 직무 정보 부족');
  return { roleTags, confidenceReasons, needsReview };
}

export function normalizeJob(job, { seenAt = new Date().toISOString(), previousSeen } = {}) {
  const observedAt = validIso(seenAt, new Date().toISOString());
  const company = meaningful(job?.company) || '기관 정보 확인';
  const title = meaningful(job?.title);
  const region = meaningful(job?.region) || '원문 확인';
  const deadline = meaningful(job?.deadline) || '원문 확인';
  const suppliedDeadline = meaningful(job?.deadlineAt);
  const parsedSuppliedDeadline = suppliedDeadline ? parseDeadline(suppliedDeadline, observedAt) : null;
  const deadlineInfo = parsedSuppliedDeadline?.deadlineAt
    ? { deadlineAt: parsedSuppliedDeadline.deadlineAt, deadlineKind: 'fixed' }
    : ['always', 'until-filled'].includes(job?.deadlineKind)
      ? { deadlineAt: null, deadlineKind: job.deadlineKind }
      : parseDeadline(deadline, observedAt);
  const displayDeadline = deadlineInfo.deadlineKind === 'unknown' && /^\d+$/.test(deadline) ? '원문 확인' : deadline;
  const role = classifyRole({ ...job, company, title });
  let firstSeenAt = validIso(job?.firstSeenAt || previousSeen?.firstSeenAt, observedAt);
  const lastSeenAt = validIso(job?.lastSeenAt, observedAt);
  if (Date.parse(firstSeenAt) > Date.parse(lastSeenAt)) firstSeenAt = lastSeenAt;
  const publishedInfo = parsePublishedDate(job?.publishedAt || job?.postedAt, observedAt);
  const normalized = {
    ...job,
    id: cleanText(job?.id), company, title, region, deadline: displayDeadline,
    source: cleanText(job?.source), url: cleanText(job?.url),
    dedupeKey: createDedupeKey({ ...job, company, title }),
    roleTags: [...new Set([...(job?.roleTags || []), ...role.roleTags])],
    regionCode: job?.regionCode || normalizeRegionCode(region),
    employmentType: job?.employmentType || normalizeEmploymentType(job?.employment),
    experienceLevel: job?.experienceLevel || normalizeExperienceLevel(job?.experience),
    deadlineAt: deadlineInfo.deadlineAt,
    deadlineKind: deadlineInfo.deadlineKind,
    publishedAt: publishedInfo.publishedAt,
    publishedKind: publishedInfo.publishedKind,
    firstSeenAt, lastSeenAt,
    collectedAt: lastSeenAt,
    confidenceReasons: [...new Set([...(job?.confidenceReasons || []), ...role.confidenceReasons])],
    alternateSources: Array.isArray(job?.alternateSources) ? job.alternateSources : [],
    needsReview: job?.needsReview === false ? false : role.needsReview,
  };
  const state = deadlineState(normalized.deadlineAt, normalized.deadlineKind, observedAt);
  return {
    ...normalized,
    ...state,
    dates: {
      publishedAt: normalized.publishedAt,
      firstCollectedAt: firstSeenAt,
      lastCollectedAt: lastSeenAt,
      deadlineAt: normalized.deadlineAt,
      deadlineKind: normalized.deadlineKind,
      deadlineStatus: state.deadlineStatus,
    },
  };
}

function completeness(job) {
  return ['regionCode', 'employmentType', 'experienceLevel', 'publishedAt', 'deadlineAt', 'description', 'sectors'].reduce((score, key) => score + (job[key] ? 1 : 0), 0);
}

function sourceLink(job) {
  return { source: job.source, url: job.url, sourceId: job.id, sourceEntryId: job.sourceEntryId || null };
}

function selectField(group, key, fallback = null) {
  const found = group.find((job) => job[key] != null && job[key] !== '' && !EMPTY_FIELD.test(String(job[key])));
  return found?.[key] ?? fallback;
}

function canMergeSyndicatedJobs(left, right) {
  const sameSource = left.sourceEntryId && right.sourceEntryId
    ? left.sourceEntryId === right.sourceEntryId
    : left.source === right.source;
  if (sameSource) return left.id === right.id;
  if (left.regionCode && right.regionCode && left.regionCode !== right.regionCode) return false;
  if (left.deadlineAt && right.deadlineAt) {
    const deadlineGap = Math.abs(dateOnlyMs(left.deadlineAt) - dateOnlyMs(right.deadlineAt));
    if (deadlineGap > 7 * 86400000) return false;
  }
  if (left.url && right.url && left.url === right.url) return true;
  const leftKeys = dedupeKeysFor(left);
  if (leftKeys.length && leftKeys.some((key) => dedupeKeysFor(right).includes(key))) return true;
  if (!GENERAL_SOURCES.has(left.source) || !GENERAL_SOURCES.has(right.source)) return false;
  if (normalizeCompanyName(left.company) !== normalizeCompanyName(right.company)) return false;
  const leftTitle = normalizeJobTitle(left.title, left.company).replace(/(?:신입|경력직|경력)/g, '');
  const rightTitle = normalizeJobTitle(right.title, right.company).replace(/(?:신입|경력직|경력)/g, '');
  const [shorter, longer] = leftTitle.length <= rightTitle.length ? [leftTitle, rightTitle] : [rightTitle, leftTitle];
  return shorter.length >= 10 && shorter.length / longer.length >= 0.6 && longer.includes(shorter);
}

export function mergeDuplicateJobs(jobs, now = new Date()) {
  const normalizedJobs = jobs.filter((job) => job?.id && job?.title).map((job) => normalizeJob(job, { seenAt: job.lastSeenAt || now }));
  const parents = normalizedJobs.map((_, index) => index);
  const find = (index) => parents[index] === index ? index : (parents[index] = find(parents[index]));
  const unite = (left, right) => {
    const leftRoot = find(left), rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  const candidateBuckets = [new Map(), new Map(), new Map(), new Map(), new Map()];
  const addCandidate = (bucket, key, index) => {
    if (!key) return;
    const candidates = bucket.get(key);
    if (candidates) candidates.push(index);
    else bucket.set(key, [index]);
  };
  normalizedJobs.forEach((job, index) => {
    addCandidate(candidateBuckets[0], job.source && job.id ? `${job.source}\u0000${job.id}` : '', index);
    addCandidate(candidateBuckets[1], job.sourceEntryId && job.id ? `${job.sourceEntryId}\u0000${job.id}` : '', index);
    addCandidate(candidateBuckets[2], job.url, index);
    addCandidate(candidateBuckets[3], job.dedupeKey, index);
    for (const key of dedupeKeysFor(job)) addCandidate(candidateBuckets[3], key, index);
    if (GENERAL_SOURCES.has(job.source)) {
      addCandidate(candidateBuckets[4], normalizeCompanyName(job.company), index);
    }
  });

  const jobCount = normalizedJobs.length;
  const candidatePairs = new Set();
  for (const bucket of candidateBuckets) {
    for (const candidates of bucket.values()) {
      for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
          const left = candidates[leftIndex], right = candidates[rightIndex];
          candidatePairs.add(left * jobCount + right);
        }
      }
    }
  }
  for (const pair of [...candidatePairs].sort((left, right) => left - right)) {
    const left = Math.floor(pair / jobCount), right = pair % jobCount;
    if (canMergeSyndicatedJobs(normalizedJobs[left], normalizedJobs[right])) unite(left, right);
  }

  const groups = new Map();
  normalizedJobs.forEach((job, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(job);
    else groups.set(root, [job]);
  });
  return [...groups.values()].map((group) => {
    const ranked = [...group].sort((a, b) => Number(a.needsReview) - Number(b.needsReview) || completeness(b) - completeness(a));
    const primary = ranked[0];
    const links = group.map(sourceLink).filter((link, index, all) => link.url && all.findIndex((item) => item.url === link.url) === index);
    const fixedDeadlines = group.map((job) => job.deadlineAt).filter(Boolean).sort();
    const deadlineAt = fixedDeadlines[0] || null;
    const deadlineJob = deadlineAt ? ranked.find((job) => job.deadlineAt === deadlineAt) : null;
    const publishedDates = group.map((job) => job.publishedAt).filter(Boolean).sort();
    const publishedAt = publishedDates[0] || null;
    const firstSeenAt = group.map((job) => job.firstSeenAt).filter(Boolean).sort()[0] || primary.firstSeenAt;
    const lastSeenAt = group.map((job) => job.lastSeenAt).filter(Boolean).sort().at(-1) || primary.lastSeenAt;
    const sourceEntryIds = [...new Set(group.map((job) => job.sourceEntryId).filter(Boolean))];
    const merged = {
      ...primary,
      category: group.some((job) => job.category === 'health') ? 'health' : primary.category,
      regionCode: selectField(ranked, 'regionCode'),
      employmentType: selectField(ranked, 'employmentType'),
      experienceLevel: selectField(ranked, 'experienceLevel'),
      deadline: deadlineJob?.deadline || primary.deadline,
      deadlineAt,
      deadlineKind: deadlineAt ? 'fixed' : selectField(ranked, 'deadlineKind', 'unknown'),
      deadlineConflict: new Set(fixedDeadlines).size > 1,
      publishedAt,
      publishedKind: publishedAt ? selectField(group.filter((job) => job.publishedAt === publishedAt), 'publishedKind', 'explicit') : 'unknown',
      firstSeenAt, lastSeenAt, collectedAt: lastSeenAt,
      roleTags: [...new Set(group.flatMap((job) => job.roleTags || []))],
      confidenceReasons: [...new Set(group.flatMap((job) => job.confidenceReasons || []))],
      needsReview: group.every((job) => job.needsReview),
      sourceIds: [...new Set(group.map((job) => job.id))],
      sourceEntryIds,
      sourceCount: sourceEntryIds.length || new Set(group.map((job) => job.source)).size,
      duplicateCount: Math.max(0, group.length - 1),
      alternateSources: links.filter((link) => link.url !== primary.url),
    };
    const state = deadlineState(merged.deadlineAt, merged.deadlineKind, now);
    return {
      ...merged,
      ...state,
      dates: {
        publishedAt: merged.publishedAt,
        firstCollectedAt: firstSeenAt,
        lastCollectedAt: lastSeenAt,
        deadlineAt: merged.deadlineAt,
        deadlineKind: merged.deadlineKind,
        deadlineStatus: state.deadlineStatus,
        deadlineConflict: merged.deadlineConflict,
      },
    };
  });
}

export function partitionJobs(jobs) {
  return jobs.reduce((result, job) => {
    result[job.needsReview ? 'needsReviewJobs' : 'jobs'].push(job);
    return result;
  }, { jobs: [], needsReviewJobs: [] });
}

export const jobModelInternals = { cleanText, meaningful, kstDateParts, dateOnlyMs };
