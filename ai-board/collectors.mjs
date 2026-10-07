import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import {
  parseSaramin,
  parseJobKorea,
  parseCatch,
  parseWork24,
  parseAlio,
} from '../server.mjs';
import { hasAiEvidence } from './ai-model.mjs';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 AiBoard/1.0';
const CP949_HOSTS = /incruit\.co\.kr$/i;
const REGION_PATTERN = /(서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주)/;

async function fetchText(url, options = {}) {
  const { timeoutMs = 20000, forceCp949 = false, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    headers: { 'user-agent': USER_AGENT, ...(rest.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const legacy = forceCp949
    || CP949_HOSTS.test(new URL(url).hostname)
    || /charset=(?:euc-kr|ks_c_5601-1987|cp949)/i.test(contentType);
  return legacy ? iconv.decode(bytes, 'cp949') : bytes.toString('utf8');
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = 20000, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(rest.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const items = Array.from(values || []);
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

// 키워드 검색이 지원되는 수집처가 함께 확인하는 AI·앱 개발 검색어.
const SEARCH_KEYWORDS = Object.freeze([
  'AI',
  '인공지능',
  '머신러닝',
  '딥러닝',
  'LLM',
  '생성형 AI',
  'MLOps',
  'AX',
  '안드로이드',
  'iOS',
  '앱 개발',
  'Flutter',
  '데이터 엔지니어',
]);

const SARAMIN_SEARCH = 'https://www.saramin.co.kr/zf_user/search?searchType=search&searchword=';
const WORK24_HTML_SEARCH = 'https://www.work24.go.kr/wk/a/b/1200/retriveDtlEmpSrchListInPost.do';

// 사람인: 공유 파서에 그룹 배지(corp_affiliate)만 얹는다.
function parseSaraminAi(html) {
  const $ = cheerio.load(html);
  const affiliateById = new Map();
  $('.item_recruit').each((_, node) => {
    const id = `saramin-${String($(node).attr('value') || '')}`;
    const affiliate = $(node).find('.corp_affiliate').first().text().replace(/\s+/g, ' ').trim();
    if (id !== 'saramin-' && affiliate) affiliateById.set(id, affiliate);
  });
  return parseSaramin(html).map((job) => ({
    ...job,
    category: 'tech',
    affiliate: affiliateById.get(job.id) || '',
  }));
}

// 사람인: 기존 다중 키워드 수집 흐름을 AI 파서로 수행한다.
async function collectSaraminAi({ previousJobs = [] } = {}) {
  const keywords = SEARCH_KEYWORDS;
  const settled = await Promise.allSettled(keywords.map(async (keyword) => ({
    keyword,
    jobs: parseSaraminAi(await fetchText(`${SARAMIN_SEARCH}${encodeURIComponent(keyword)}`)),
  })));
  const fulfilled = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  if (!fulfilled.length) throw new Error('사람인 검색을 모두 확인하지 못했습니다.');
  const failedKeywords = new Set(settled.flatMap((result, index) => result.status === 'rejected' ? [keywords[index]] : []));
  const byId = new Map();
  for (const { keyword, jobs } of fulfilled) {
    for (const job of jobs) {
      const previous = byId.get(job.id);
      byId.set(job.id, {
        ...(previous || {}),
        ...job,
        searchKeywords: [...new Set([...(previous?.searchKeywords || []), keyword])],
      });
    }
  }
  if (failedKeywords.size) {
    for (const previous of Array.isArray(previousJobs) ? previousJobs : []) {
      const previousKeywords = Array.isArray(previous.searchKeywords) ? previous.searchKeywords : [];
      const belongsToFailedSearch = !previousKeywords.length || previousKeywords.some((keyword) => failedKeywords.has(keyword));
      if (!belongsToFailedSearch || !previous?.id) continue;
      if (!byId.has(previous.id)) byId.set(previous.id, previous);
    }
  }
  return [...byId.values()];
}

// 잡코리아: 공유 파서 결과에 급여·경력·직무 칩을 얹는다.
function parseJobKoreaAi(html) {
  const $ = cheerio.load(html);
  const extraById = new Map();
  $('a[href*="/Recruit/GI_Read/"]').filter((_, el) => $(el).attr('class')?.includes('mb-0.5')).each((_, el) => {
    const link = $(el), href = link.attr('href') || '';
    const rawId = href.match(/GI_Read\/(\d+)/)?.[1];
    if (!rawId) return;
    const scope = link.closest('.rounded-2xl');
    const chips = scope.find('[data-sentry-component="GrayChip"]')
      .map((_, chip) => $(chip).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
    const salary = chips.find((text) => /연봉|월급|시급|주급|일급|면접\s*후\s*결정|회사내규/.test(text)) || '';
    const sectors = chips.filter((text) => text !== salary && !REGION_PATTERN.test(text) && !/지원|스크랩/.test(text)).join(', ');
    const experience = scope.find('span.flex-shrink-0.text-gray700').first().text().replace(/\s+/g, ' ').trim()
      || (scope.text().match(/신입 지원 가능|경력\s*\d+년?|경력무관|신입/) || [''])[0];
    extraById.set(`jobkorea-${rawId}`, {
      salary,
      sectors: sectors ? sectors.split(/,\s*/).slice(0, 6) : [],
      experience: /무관/.test(experience) ? '경력무관' : experience.replace(' 지원 가능', ''),
    });
  });
  return parseJobKorea(html).map((job) => ({ ...job, category: 'tech', ...(extraById.get(job.id) || {}) }));
}

// 잡코리아: 검색어당 첫 결과 페이지를 읽는다.
async function collectJobKoreaAi() {
  const byId = new Map();
  const settled = await Promise.allSettled(SEARCH_KEYWORDS.map(async (keyword) => {
    const url = `https://www.jobkorea.co.kr/Search/?stext=${encodeURIComponent(keyword)}`;
    return parseJobKoreaAi(await fetchText(url));
  }));
  const ok = settled.filter((result) => result.status === 'fulfilled');
  if (!ok.length) throw new Error('잡코리아 검색을 모두 확인하지 못했습니다.');
  for (const jobs of ok.map((result) => result.value)) {
    for (const job of jobs) if (!byId.has(job.id)) byId.set(job.id, job);
  }
  return [...byId.values()];
}

// 캐치: 공유 파서 결과에 직무 분야·경력·고용형태를 얹는다.
function parseCatchAi(html) {
  const $ = cheerio.load(html);
  const extraById = new Map();
  $('table.table2 tbody tr').each((_, node) => {
    const scope = $(node), link = scope.find('a[href*="RecruitInfoDetails"]').first();
    const rawId = (link.attr('href') || '').match(/RecruitInfoDetails\/(\d+)/)?.[1];
    if (!rawId) return;
    const head = scope.find('td').first();
    const duties = head.find('.t3_1').first().text().replace(/\s+/g, ' ').trim();
    const condition = scope.find('td').eq(1).text().replace(/\s+/g, ' ').trim();
    extraById.set(`catch-${rawId}`, {
      sectors: duties ? duties.split(/,\s*/).slice(0, 6) : [],
      experience: (condition.match(/신입|경력\s*\d*년?|경력무관|무관/) || [''])[0],
      employment: (condition.match(/정규직|계약직|인턴|파견|프리랜서|위촉/) || [''])[0],
    });
  });
  return parseCatch(html).map((job) => ({ ...job, category: 'tech', ...(extraById.get(job.id) || {}) }));
}

// 캐치: 검색어당 첫 결과 페이지를 읽는다.
async function collectCatchAi() {
  const byId = new Map();
  const settled = await Promise.allSettled(SEARCH_KEYWORDS.map(async (keyword) => {
    const url = `https://www.catch.co.kr/Search/SearchList?Keyword=${encodeURIComponent(keyword)}`;
    return parseCatchAi(await fetchText(url));
  }));
  const ok = settled.filter((result) => result.status === 'fulfilled');
  if (!ok.length) throw new Error('캐치 검색을 모두 확인하지 못했습니다.');
  for (const jobs of ok.map((result) => result.value)) {
    for (const job of jobs) if (!byId.has(job.id)) byId.set(job.id, job);
  }
  return [...byId.values()];
}

// 고용24: 공유 파서 결과에 기업규모 표기·급여·경력·학력을 얹는다.
const WORK24_REGION_DETAIL = /(서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주)\s*([가-힣]{1,8}(?:구|시|군|읍|면|동))?/;
function parseWork24Ai(html) {
  const $ = cheerio.load(html);
  const extraById = new Map();
  $('table#contentArea tbody tr[id^="list"]').each((_, node) => {
    const scope = $(node);
    const link = scope.find('a[data-emp-detail]').first();
    const rawId = new URL(link.attr('href') || '', 'https://www.work24.go.kr').searchParams.get('wantedAuthNo');
    if (!rawId) return;
    scope.find('script').remove();
    const text = scope.text().replace(/\s+/g, ' ').trim();
    extraById.set(`work24-${rawId}`, {
      companyScaleHint: (text.match(/\[([^\]]{1,12}(?:기업|지주사|벤처|외국계|강소|중견|중소|공공)[^\]]{0,12})\]/) || [])[1] || '',
      salary: (text.match(/(?:월급|연봉|시급|주급|일급|건당)\s*[\d,]+\s*만?원?(?:\s*[~\-]\s*[\d,]+\s*만?원)?|회사내규에?\s*따름|면접\s*후\s*결정/) || [''])[0],
      experience: (text.match(/경력\s*\d+\s*년?|경력무관|신입|무관/) || [''])[0],
      education: (text.match(/대졸|고졸|석사|박사|초대졸|전문대졸|학력무관/) || [''])[0],
      region: (text.match(WORK24_REGION_DETAIL) || [''])[0].trim() || '지역 미표기',
    });
  });
  return parseWork24(html).map((job) => ({
    ...job,
    category: 'tech',
    ...(extraById.get(job.id) || {}),
    region: extraById.get(job.id)?.region || job.region,
  }));
}

// 고용24: HTML 검색. Open API 파서는 간호 증거만 통과시키므로 AI 수집에는 쓰지 않는다.
async function collectWork24Ai({ previousJobs = [] } = {}) {
  const byId = new Map();
  const settled = await Promise.allSettled(SEARCH_KEYWORDS.map(async (keyword) => {
    const html = await fetchText(WORK24_HTML_SEARCH, {
      method: 'POST',
      timeoutMs: 30000,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        srcKeyword: keyword, searchMode: 'Y', keywordWantedTitle: 'Y',
        resultCnt: '30', pageIndex: '1', currentPageNo: '1',
        sortField: 'DATE', sortOrderBy: 'DESC', siteClcd: 'all', empTpGbcd: '1',
      }),
    });
    return { keyword, jobs: parseWork24Ai(html) };
  }));
  const ok = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  if (!ok.length) throw new Error('고용24 검색을 모두 확인하지 못했습니다.');
  for (const { jobs } of ok) {
    for (const job of jobs) if (!byId.has(job.id)) byId.set(job.id, job);
  }
  const failedKeywords = new Set(settled.flatMap((result, index) => result.status === 'rejected' ? [SEARCH_KEYWORDS[index]] : []));
  if (failedKeywords.size) {
    for (const previous of Array.isArray(previousJobs) ? previousJobs : []) {
      if (previous?.id && !byId.has(previous.id)) byId.set(previous.id, previous);
    }
  }
  return [...byId.values()];
}

// JOB-ALIO: 공공기관 채용 정보 키워드 검색.
const ALIO_KEYWORDS = Object.freeze(['AI', '인공지능', '데이터', '디지털', 'SW', '안드로이드', '앱']);
async function collectAlioAi() {
  const byId = new Map();
  const settled = await Promise.allSettled(ALIO_KEYWORDS.map(async (keyword) => {
    const url = `https://job.alio.go.kr/recruit.do?keyword=${encodeURIComponent(keyword)}&pageSet=50&ing=2`;
    return parseAlio(await fetchText(url));
  }));
  const ok = settled.filter((result) => result.status === 'fulfilled');
  if (!ok.length) throw new Error('JOB-ALIO 검색을 모두 확인하지 못했습니다.');
  for (const jobs of ok.map((result) => result.value)) {
    for (const job of jobs) {
      if (byId.has(job.id)) continue;
      const text = [job.title, job.company].join(' ');
      if (!hasAiEvidence(text) && !/ict|정보화|전산|sw|소프트웨어|it\b/i.test(text)) continue;
      byId.set(job.id, job);
    }
  }
  return [...byId.values()];
}

// 원티드: 공개 검색 API.
const WANTED_SEARCH_API = 'https://www.wanted.co.kr/api/chaos/search/v1/position';
const WANTED_PAGE_SIZE = 20;
const WANTED_MAX_PAGES = 4;
function parseWantedPositionsAi(data) {
  const jobs = [];
  for (const item of Array.isArray(data?.data) ? data.data : []) {
    const rawId = Number.isFinite(item?.id) ? item.id : null;
    const title = String(item?.position || '').replace(/\s+/g, ' ').trim();
    if (rawId == null || !title || jobs.some((job) => job.id === `wanted-${rawId}`)) continue;
    const company = String(item?.company?.name || '').replace(/\s+/g, ' ').trim();
    const detail = [title, company, ...(Array.isArray(item?.skill_tags) ? item.skill_tags : [])].join(' ');
    if (!hasAiEvidence(detail)) continue;
    const from = Number.isFinite(item?.annual_from) ? item.annual_from : null;
    const to = Number.isFinite(item?.annual_to) ? item.annual_to : null;
    const experience = from != null && from > 0
      ? (to != null && to < 100 ? `경력 ${from}~${to}년` : `경력 ${from}년 이상`)
      : (from === 0 ? '신입 가능' : '');
    jobs.push({
      id: `wanted-${rawId}`,
      company: company || '원티드 등록기업',
      title,
      region: '지역 미표기',
      deadline: '원문 확인',
      employment: { regular: '정규직', contract: '계약직', intern: '인턴' }[item?.employment_type] || '',
      experience,
      keywords: Array.isArray(item?.skill_tags) ? item.skill_tags.slice(0, 12) : [],
      source: '원티드',
      url: `https://www.wanted.co.kr/wd/${rawId}`,
    });
  }
  return jobs;
}
async function collectWantedAi() {
  const byId = new Map();
  for (const keyword of SEARCH_KEYWORDS) {
    for (let page = 0; page < WANTED_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        query: keyword, offset: String(page * WANTED_PAGE_SIZE), limit: String(WANTED_PAGE_SIZE),
      });
      let data;
      try {
        data = await fetchJson(`${WANTED_SEARCH_API}?${params}`, {
          timeoutMs: 30000,
          headers: { referer: `https://www.wanted.co.kr/search?query=${encodeURIComponent(keyword)}&tab=position` },
        });
      } catch (error) {
        if (byId.size) return [...byId.values()];
        throw error;
      }
      for (const job of parseWantedPositionsAi(data)) if (!byId.has(job.id)) byId.set(job.id, job);
      if (!Array.isArray(data?.data) || data.data.length < WANTED_PAGE_SIZE) break;
    }
  }
  return [...byId.values()];
}

// 직행: AI_데이터 카테고리 전체 + 앱 개발 키워드 검색.
const ZIGHANG_API = 'https://api.zighang.com/api/recruitments';
const ZIGHANG_APP_KEYWORDS = Object.freeze(['안드로이드', 'iOS', '앱 개발', 'Flutter', '모바일']);
const ZIGHANG_CATEGORY_PAGES = 8;
const ZIGHANG_KEYWORD_PAGES = 3;
const ZIGHANG_PAGE_SIZE = 100;

function zighangDeadline(item) {
  const endDate = String(item?.endDate || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (endDate) return endDate;
  const type = String(item?.deadlineType || '').replace(/\s+/g, '');
  if (/채용시/.test(type)) return '채용시';
  if (/상시/.test(type)) return '상시채용';
  return '원문 확인';
}
function zighangCareer(item) {
  const min = Number(item?.careerMin);
  const rawMax = Number(item?.careerMax);
  const max = rawMax >= 100 ? Number.POSITIVE_INFINITY : rawMax;
  if (!Number.isFinite(min) && !Number.isFinite(max)) return '경력 미표기';
  if ((!min || min === 0) && (!max || max === 0 || max === Number.POSITIVE_INFINITY)) return '경력무관';
  if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max >= min) return `경력 ${min}~${max}년`;
  if (Number.isFinite(min) && min > 0) return `경력 ${min}년 이상`;
  if (Number.isFinite(max) && max > 0) return `경력 ${max}년 이하`;
  return '경력무관';
}
function zighangCreatedAt(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) return `${text}+09:00`;
  return text;
}
function zighangKey(company, title) {
  return `${company}\n${title}`.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[^\p{L}\p{N}]+/gu, '');
}
function zighangJob(item) {
  const id = String(item?.id || '').trim();
  const company = String(item?.company?.name || '').replace(/\s+/g, ' ').trim();
  const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
  if (!id || !company || !title) return null;
  const depthTwos = Array.isArray(item?.depthTwos) ? item.depthTwos : [];
  const depthThrees = Array.isArray(item?.depthThrees) ? item.depthThrees.filter(Boolean) : [];
  const tags = Array.isArray(item?.tags) ? item.tags.filter(Boolean) : [];
  const keywords = [...(Array.isArray(item?.keywords) ? item.keywords.filter(Boolean) : []), ...tags].slice(0, 14);
  const inAiCategory = Array.isArray(item?.depthOnes) && item.depthOnes.includes('AI_데이터');
  const sectors = [...depthTwos, ...depthThrees].slice(0, 10);
  const evidence = [title, ...sectors, ...keywords].join(' ');
  if (!inAiCategory && !hasAiEvidence(evidence)) return null;
  return {
    id: `zighang-${id}`,
    company, title,
    region: Array.isArray(item.regions) && item.regions.length ? item.regions.join(' · ') : '지역 미표기',
    deadline: zighangDeadline(item),
    experience: zighangCareer(item),
    employment: Array.isArray(item.employeeTypes) ? item.employeeTypes.join(' · ') : '',
    education: Array.isArray(item.educations) ? item.educations.join(' · ') : '',
    postedAt: zighangCreatedAt(item.createdAt),
    affiliate: String(item.affiliate || '').trim(),
    keywords,
    sectors,
    role: evidence,
    source: '직행',
    url: `https://zighang.com/recruitment/${id}`,
  };
}
async function zighangPage(params) {
  const url = new URL(ZIGHANG_API);
  url.searchParams.set('page', String(params.page));
  url.searchParams.set('size', String(ZIGHANG_PAGE_SIZE));
  for (const [key, value] of Object.entries(params.query || {})) url.searchParams.append(key, value);
  url.searchParams.set('sortCondition', 'LATEST');
  url.searchParams.set('orderCondition', 'DESC');
  const payload = await fetchJson(url.href, { timeoutMs: 30000 });
  if (!Array.isArray(payload?.data?.content)) throw new Error('직행 채용 API 응답 형식이 바뀌었습니다.');
  return payload.data;
}
async function collectZighangAi() {
  const byPosting = new Map();
  const add = (payload) => {
    for (const item of payload?.content || []) {
      const job = zighangJob(item);
      if (!job) continue;
      const key = zighangKey(job.company, job.title);
      if (!byPosting.has(key)) byPosting.set(key, job);
    }
  };
  const first = await zighangPage({ page: 0, query: { depthOnes: 'AI_데이터' } });
  add(first);
  const categoryPages = Math.max(1, Math.min(ZIGHANG_CATEGORY_PAGES, Number(first?.totalPages) || 1));
  if (categoryPages > 1) {
    const pages = await mapWithConcurrency(
      Array.from({ length: categoryPages - 1 }, (_, index) => index + 1),
      3,
      (page) => zighangPage({ page, query: { depthOnes: 'AI_데이터' } }),
    );
    for (const payload of pages) add(payload);
  }
  for (const keyword of ZIGHANG_APP_KEYWORDS) {
    for (let page = 0; page < ZIGHANG_KEYWORD_PAGES; page += 1) {
      const payload = await zighangPage({ page, query: { keyword } });
      add(payload);
      if ((payload?.content || []).length < ZIGHANG_PAGE_SIZE) break;
    }
  }
  return [...byPosting.values()];
}

// 인크루트: CP949 검색 결과 페이지.
function parseIncruit(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('a[href*="jobpost.asp?job="]').each((_, el) => {
    const link = $(el);
    const href = link.attr('href') || '';
    const rawId = href.match(/jobpost\.asp\?job=(\d+)/)?.[1];
    const box = link.closest('.cPrdlists_box');
    const scope = box.length ? box : link.closest('div');
    const title = (link.attr('title') || scope.find('.cTitle').text()).replace(/\s+/g, ' ').trim();
    const company = scope.find('.cCpName').first().text().replace(/\s+/g, ' ').trim();
    const text = scope.text().replace(/\s+/g, ' ').trim();
    const region = text.match(REGION_PATTERN)?.[1] || '지역 미표기';
    const deadline = scope.find('.cDate').first().text().replace(/\s+/g, '').trim()
      || text.match(/D-\d+|채용시|상시|(?:\d{2,4}[./])?\d{1,2}[./]\d{1,2}/)?.[0]
      || '공고 확인';
    if (rawId && title && company && !jobs.some((job) => job.id === `incruit-${rawId}`)) {
      jobs.push({
        id: `incruit-${rawId}`, company, title, region, deadline,
        source: '인크루트', url: new URL(href, 'https://job.incruit.com').href,
      });
    }
  });
  return jobs;
}
async function collectIncruitAi() {
  const byId = new Map();
  const settled = await Promise.allSettled(SEARCH_KEYWORDS.map(async (keyword) => {
    const url = `https://job.incruit.com/jobdb_list/searchjob.asp?kw=${encodeURIComponent(keyword)}&occ3=`;
    return parseIncruit(await fetchText(url, { forceCp949: true }));
  }));
  const ok = settled.filter((result) => result.status === 'fulfilled');
  if (!ok.length) throw new Error('인크루트 검색을 모두 확인하지 못했습니다.');
  for (const jobs of ok.map((result) => result.value)) {
    for (const job of jobs) if (!byId.has(job.id)) byId.set(job.id, job);
  }
  return [...byId.values()];
}

// 네이버 채용(계열사 포함): 공개 목록 JSON 전체를 읽고 AI·앱 공고만 추린다.
const NAVER_LIST_API = 'https://recruit.navercorp.com/rcrt/loadJobList.do';
const NAVER_MAX_PAGES = 12;
function naverDate(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}
async function naverPage(firstIndex) {
  const params = new URLSearchParams({ sw: '', firstIndex: String(firstIndex) });
  return fetchJson(`${NAVER_LIST_API}?${params}`, {
    headers: { 'x-requested-with': 'XMLHttpRequest', referer: 'https://recruit.navercorp.com/rcrt/list.do' },
  });
}
async function collectNaverAi() {
  const first = await naverPage(0);
  if (!Array.isArray(first?.list)) throw new Error('네이버 채용 목록 형식이 바뀌었습니다.');
  const total = Math.max(0, Number(first.totalSize) || first.list.length);
  const pageCount = Math.max(1, Math.min(NAVER_MAX_PAGES, Math.ceil(total / 10)));
  const pages = [first];
  if (pageCount > 1) {
    const rest = await mapWithConcurrency(
      Array.from({ length: pageCount - 1 }, (_, index) => (index + 1) * 10),
      3,
      (firstIndex) => naverPage(firstIndex),
    );
    pages.push(...rest);
  }
  const byId = new Map();
  for (const payload of pages) {
    for (const item of Array.isArray(payload?.list) ? payload.list : []) {
      const annoId = String(item?.annoId || '').trim();
      const title = String(item?.annoSubject || '').replace(/\s+/g, ' ').trim();
      const company = String(item?.sysCompanyCdNm || item?.subCompanyCdNm || '네이버').replace(/\s+/g, ' ').trim();
      if (!annoId || !title || byId.has(`naver-${annoId}`)) continue;
      if (!hasAiEvidence([title, company].join(' '))) continue;
      byId.set(`naver-${annoId}`, {
        id: `naver-${annoId}`,
        company: company || '네이버',
        title,
        region: '지역 미표기',
        deadline: naverDate(item?.endYmd) || '원문 확인',
        publishedAt: naverDate(item?.staYmd) || null,
        experience: String(item?.entTypeCdNm || '').trim(),
        employment: String(item?.reqTypeCdNm || '').trim(),
        source: '네이버채용',
        url: `https://recruit.navercorp.com/rcrt/view.do?annoId=${encodeURIComponent(annoId)}&lang=ko`,
      });
    }
  }
  return [...byId.values()];
}

// 당근 채용: 서버 렌더 목록에서 AI·앱 공고만 추린다.
const DAANGN_JOBS_URL = 'https://careers.daangn.com/jobs/';
function parseDaangn(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('a[href^="/jobs/role/"]').each((_, el) => {
    const link = $(el);
    const href = link.attr('href') || '';
    const rawId = href.match(/\/jobs\/role\/(\d+)/)?.[1];
    const row = link.closest('li');
    const title = link.find('h3 span, h3').first().text().replace(/\s+/g, ' ').trim()
      || link.text().replace(/\s+/g, ' ').trim();
    const meta = row.length ? row.text().replace(/\s+/g, ' ').trim() : '';
    const keywords = row.attr('data-search-keywords') || row.attr('data-keywords') || '';
    if (!rawId || !title || jobs.some((job) => job.id === `daangn-${rawId}`)) return;
    if (!hasAiEvidence([title, meta, keywords].join(' '))) return;
    const employment = /정규직|계약직|인턴/.test(meta) ? meta.match(/정규직|계약직|인턴/)[0] : '';
    jobs.push({
      id: `daangn-${rawId}`,
      company: '당근',
      title,
      region: '서울',
      deadline: '상시채용',
      employment,
      role: meta,
      source: '당근채용',
      url: new URL(href, DAANGN_JOBS_URL).href,
    });
  });
  return jobs;
}

export const AI_LINK_SOURCES = Object.freeze([
  { id: 'jumpit', name: '점핏', url: 'https://www.jumpit.co.kr/search?keyword=AI', note: '서버 수집 차단 — 브라우저에서 확인' },
  { id: 'rocketpunch', name: '로켓펀치', url: 'https://www.rocketpunch.com/jobs?keywords=AI', note: '서버 수집 차단 — 브라우저에서 확인' },
  { id: 'programmers', name: '프로그래머스', url: 'https://career.programmers.co.kr/job_positions', note: '서버 연결 불가 — 브라우저에서 확인' },
  { id: 'jobplanet', name: '잡플래닛', url: 'https://www.jobplanet.co.kr/job/search?posting_type_id=1&search_keyword=AI', note: '서버 수집 차단 — 브라우저에서 확인' },
  { id: 'kakao', name: '카카오 채용', url: 'https://careers.kakao.com/jobs?keyword=AI&page=1', note: '공식 채용 페이지' },
  { id: 'toss', name: '토스 채용', url: 'https://toss.im/career/jobs', note: '공식 채용 페이지' },
  { id: 'line', name: '라인 채용', url: 'https://careers.linecorp.com/ko/jobs?keywords=AI', note: '공식 채용 페이지' },
  { id: 'coupang', name: '쿠팡 채용', url: 'https://www.coupang.jobs/kr/jobs/?keywords=AI', note: '공식 채용 페이지' },
  { id: 'superookie', name: '슈퍼루키', url: 'https://www.superookie.com/jobs?keyword=AI', note: '화면 렌더링 필요 — 브라우저에서 확인' },
  { id: 'linkedin', name: '링크드인', url: 'https://www.linkedin.com/jobs/search/?keywords=AI&location=대한민국', note: '로그인 필요 — 브라우저에서 확인' },
]);

export function createAiSourceDefinitions() {
  return [
    {
      id: 'saramin', name: '사람인',
      url: `${SARAMIN_SEARCH}${encodeURIComponent('AI')}`,
      collect: ({ previousJobs = [] } = {}) => collectSaraminAi({ previousJobs }),
    },
    {
      id: 'jobkorea', name: '잡코리아',
      url: `https://www.jobkorea.co.kr/Search/?stext=${encodeURIComponent('AI')}`,
      collect: () => collectJobKoreaAi(),
    },
    {
      id: 'catch', name: '캐치',
      url: `https://www.catch.co.kr/Search/SearchList?Keyword=${encodeURIComponent('AI')}`,
      collect: () => collectCatchAi(),
    },
    {
      id: 'work24', name: '고용24',
      url: 'https://www.work24.go.kr/wk/a/b/1200/retriveDtlEmpSrchListInPost.do',
      collect: ({ previousJobs = [] } = {}) => collectWork24Ai({ previousJobs }),
    },
    {
      id: 'alio', name: 'JOB-ALIO',
      url: `https://job.alio.go.kr/recruit.do?keyword=${encodeURIComponent('AI')}&pageSet=50&ing=2`,
      collect: () => collectAlioAi(),
    },
    {
      id: 'wanted', name: '원티드',
      url: `https://www.wanted.co.kr/search?query=${encodeURIComponent('AI')}&tab=position`,
      collect: () => collectWantedAi(),
    },
    {
      id: 'zighang', name: '직행',
      url: 'https://zighang.com/',
      collect: () => collectZighangAi(),
    },
    {
      id: 'incruit', name: '인크루트',
      url: `https://job.incruit.com/jobdb_list/searchjob.asp?kw=${encodeURIComponent('AI')}&occ3=`,
      collect: () => collectIncruitAi(),
    },
    {
      id: 'naver', name: '네이버채용',
      url: 'https://recruit.navercorp.com/rcrt/list.do',
      collect: () => collectNaverAi(),
    },
    {
      id: 'daangn', name: '당근채용',
      url: DAANGN_JOBS_URL,
      collect: async () => parseDaangn(await fetchText(DAANGN_JOBS_URL)),
    },
  ];
}
