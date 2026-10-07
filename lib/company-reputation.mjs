import * as cheerio from 'cheerio';

const MAX_COMPANY_LENGTH = 160;
const MAX_HTML_LENGTH = 2_000_000;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_CACHE_ENTRIES = 200;
const LEGAL_ENTITY_MARKERS = /(?:주식회사|의료법인|학교법인|재단법인|사단법인|사회복지법인|㈜|[(（]\s*(?:주|유|재|사|의)\s*[)）])/giu;
const NAVER_SEARCH_ORIGIN = 'https://search.naver.com';
const NAVER_SEARCH_PATH = '/search.naver';

export const COMPANY_REPUTATION_SOURCES = Object.freeze({
  jobplanet: Object.freeze({
    id: 'jobplanet',
    name: '잡플래닛',
    hosts: new Set(['jobplanet.co.kr', 'www.jobplanet.co.kr']),
  }),
  blind: Object.freeze({
    id: 'blind',
    name: '블라인드',
    hosts: new Set(['teamblind.com', 'www.teamblind.com', 'kr.teamblind.com']),
  }),
});

const asText = (value, maxLength = MAX_COMPANY_LENGTH) => typeof value === 'string'
  ? value.trim().slice(0, maxLength)
  : '';

export function companyReputationDisplayName(value) {
  const original = asText(value);
  if (!original) return '';
  return original.normalize('NFKC').replace(LEGAL_ENTITY_MARKERS, ' ').replace(/\s+/g, ' ').trim() || original;
}

export function companyReputationServerKey(value) {
  return companyReputationDisplayName(value).toLocaleLowerCase('ko-KR').replace(/[^0-9a-z가-힣]/giu, '');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || '')).replace(/[+_-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function finiteRating(value) {
  const rating = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(rating) && rating >= 0 && rating <= 5 ? Math.round(rating * 10) / 10 : null;
}

function finiteReviewCount(value) {
  const count = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isInteger(count) && count >= 0 && count <= 10_000_000 ? count : null;
}

function sourceLink(sourceId, company) {
  const display = companyReputationDisplayName(company);
  return sourceId === 'jobplanet'
    ? `https://www.jobplanet.co.kr/search?query=${encodeURIComponent(display)}`
    : `https://www.teamblind.com/kr/company/${encodeURIComponent(display)}/reviews`;
}

function normalizeSourceUrl(sourceId, value) {
  const source = COMPANY_REPUTATION_SOURCES[sourceId];
  if (!source) return '';
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !source.hosts.has(url.hostname.toLowerCase())) return '';
    url.hash = '';
    url.search = '';
    if (sourceId === 'jobplanet') {
      if (!/^\/companies\/\d+\/(?:landing|reviews|premium_reviews)(?:\/|$)/u.test(url.pathname)) return '';
      return `https://www.jobplanet.co.kr${url.pathname}`;
    }
    const match = /^\/kr\/company\/([^/]+)(?:\/|$)/u.exec(url.pathname);
    return match ? `https://www.teamblind.com/kr/company/${match[1]}/reviews` : '';
  } catch {
    return '';
  }
}

function resultCompanyName(sourceId, text) {
  const clean = String(text || '').replace(/새\s*창\s*열림/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (sourceId === 'jobplanet') {
    return asText(/^(.+?)\s+\d{4}년\s+기업정보(?:\s*[|｜]|\s*$)/u.exec(clean)?.[1] || '');
  }
  return asText(
    /^(.+?)\s*[-–—]\s*블라인드(?:\s|$)/u.exec(clean)?.[1]
      || /^블라인드\s*[|｜]\s*(.+?)(?:\s+리뷰|\s*$)/u.exec(clean)?.[1]
      || '',
  );
}

function aggregateFromText(text) {
  const clean = String(text || '').replace(/새\s*창\s*열림/gu, ' ').replace(/\s+/g, ' ').trim();
  let match = /기업리뷰\s*([\d,]+)\s*건\s*,?\s*([0-5](?:\.\d+)?)\s*리뷰평점/iu.exec(clean);
  if (match) {
    const reviewCount = finiteReviewCount(match[1]);
    const rating = finiteRating(match[2]);
    if (rating !== null && reviewCount !== null) return { rating, reviewCount };
  }
  match = /평점\s*:?[\s\u00a0]*([0-5](?:\.\d+)?)\s*\/\s*5\s*([\d,]+)\s*참여/iu.exec(clean);
  if (match) {
    const rating = finiteRating(match[1]);
    const reviewCount = finiteReviewCount(match[2]);
    if (rating !== null && reviewCount !== null) return { rating, reviewCount };
  }
  match = /평점\s*:?\s*([0-5](?:\.\d+)?)[\s\S]{0,180}?리뷰\s*:?\s*([\d,]+)/iu.exec(clean);
  if (match) {
    const rating = finiteRating(match[1]);
    const reviewCount = finiteReviewCount(match[2]);
    if (rating !== null && reviewCount !== null) return { rating, reviewCount };
  }
  return null;
}

function parsedLink(sourceId, value) {
  const url = normalizeSourceUrl(sourceId, value);
  if (!url) return null;
  const parsed = new URL(url);
  if (sourceId === 'jobplanet') {
    const match = /^\/companies\/(\d+)\/(landing|reviews|premium_reviews)(?:\/([^/]+))?/u.exec(parsed.pathname);
    if (!match) return null;
    return {
      key: match[1],
      url,
      companyName: safeDecode(match[3]),
      priority: match[2] === 'reviews' ? 2 : 1,
    };
  }
  const match = /^\/kr\/company\/([^/]+)/u.exec(parsed.pathname);
  if (!match) return null;
  return {
    key: match[1].toLocaleLowerCase('ko-KR'),
    url,
    companyName: safeDecode(match[1]),
    priority: /\/reviews\/?$/u.test(parsed.pathname) ? 2 : 1,
  };
}

/**
 * 공개 검색 결과에서 회사별 집계값만 추출합니다. 리뷰 문장이나 작성자 정보는
 * 반환 객체에 포함하지 않으며, 허용된 잡플래닛·블라인드 회사 주소만 유지합니다.
 */
export function parseNaverCompanyRatings(html, sourceId) {
  if (!COMPANY_REPUTATION_SOURCES[sourceId]) return [];
  const $ = cheerio.load(String(html || ''));
  const groups = new Map();
  $('a[href]').each((_index, element) => {
    const link = parsedLink(sourceId, $(element).attr('href'));
    if (!link) return;
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    const group = groups.get(link.key) || {
      id: sourceId,
      name: COMPANY_REPUTATION_SOURCES[sourceId].name,
      companyName: '',
      url: link.url,
      urlPriority: 0,
      rating: null,
      reviewCount: null,
    };
    const titleName = resultCompanyName(sourceId, text);
    if (titleName) group.companyName = titleName;
    else if (!group.companyName && link.companyName) group.companyName = link.companyName;
    if (link.priority > group.urlPriority) {
      group.url = link.url;
      group.urlPriority = link.priority;
    }
    const aggregate = aggregateFromText(text);
    if (aggregate) {
      group.rating = aggregate.rating;
      group.reviewCount = aggregate.reviewCount;
    }
    groups.set(link.key, group);
  });
  return [...groups.values()]
    .filter((entry) => entry.companyName && entry.rating !== null && entry.reviewCount !== null)
    .map(({ urlPriority: _urlPriority, ...entry }) => entry)
    .slice(0, 12);
}

function unavailableSource(sourceId, company, message) {
  return {
    id: sourceId,
    name: COMPANY_REPUTATION_SOURCES[sourceId].name,
    companyName: companyReputationDisplayName(company),
    url: sourceLink(sourceId, company),
    status: 'unavailable',
    message,
  };
}

function fuzzyCompanyMatch(requestedKey, candidateKey) {
  if (!requestedKey || !candidateKey || requestedKey === candidateKey) return 0;
  if (!requestedKey.includes(candidateKey) && !candidateKey.includes(requestedKey)) return 0;
  return Math.min(requestedKey.length, candidateKey.length) / Math.max(requestedKey.length, candidateKey.length);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function currentDate(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

export function createCompanyReputationLookup({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 8_000,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxCacheEntries = DEFAULT_CACHE_ENTRIES,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch 구현이 필요합니다.');
  const cache = new Map();

  async function fetchSearch(company, sourceId) {
    const query = `${company} ${sourceId === 'jobplanet' ? '잡플래닛' : '블라인드 평점'}`;
    const url = new URL(NAVER_SEARCH_PATH, NAVER_SEARCH_ORIGIN);
    url.searchParams.set('where', 'nexearch');
    url.searchParams.set('query', query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'ko-KR,ko;q=0.9',
          'user-agent': 'Mozilla/5.0 (compatible; NurseBoard/1.0)',
        },
        signal: controller.signal,
      });
      const length = Number(response.headers?.get?.('content-length') || 0);
      if (!response.ok || (length && length > MAX_HTML_LENGTH)) throw new Error(`공개 검색 응답 오류 (${response.status})`);
      const html = String(await response.text());
      if (html.length > MAX_HTML_LENGTH) throw new Error('공개 검색 응답이 너무 큽니다.');
      return parseNaverCompanyRatings(html, sourceId);
    } finally {
      clearTimeout(timer);
    }
  }

  function sourceResult(sourceId, company, requestedKey, settled, checkedAt) {
    if (settled.status === 'rejected') {
      return {
        source: unavailableSource(sourceId, company, '공개 평점 검색에 연결하지 못해 직접 확인이 필요합니다.'),
        failed: true,
      };
    }
    const matches = settled.value;
    const exact = matches.find((candidate) => companyReputationServerKey(candidate.companyName) === requestedKey);
    if (exact) return { source: { ...exact, status: 'ok', checkedAt }, failed: false };
    const candidate = matches
      .map((entry) => ({ entry, score: fuzzyCompanyMatch(requestedKey, companyReputationServerKey(entry.companyName)) }))
      .filter(({ score }) => score >= 0.5)
      .sort((left, right) => right.score - left.score)[0]?.entry;
    if (candidate) {
      return {
        source: unavailableSource(sourceId, company, '회사명이 정확히 일치하지 않아 확인이 필요합니다.'),
        candidate: { ...candidate, status: 'candidate', checkedAt },
        failed: false,
      };
    }
    return {
      source: unavailableSource(sourceId, company, '등록된 공개 직원 평가를 찾지 못했습니다.'),
      failed: false,
    };
  }

  async function freshLookup(company, requestedKey) {
    const checkedAt = currentDate(now).toISOString();
    const [jobPlanetSettled, blindSettled] = await Promise.allSettled([
      fetchSearch(company, 'jobplanet'),
      fetchSearch(company, 'blind'),
    ]);
    const jobplanet = sourceResult('jobplanet', company, requestedKey, jobPlanetSettled, checkedAt);
    const blind = sourceResult('blind', company, requestedKey, blindSettled, checkedAt);
    const sources = [jobplanet.source, blind.source];
    const candidates = [jobplanet.candidate, blind.candidate].filter(Boolean);
    const allFailed = jobplanet.failed && blind.failed;
    return {
      ok: sources.some((source) => source.status === 'ok'),
      company,
      sources,
      candidates,
      ...(allFailed ? { error: '공개 평점 검색에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.' } : {}),
    };
  }

  async function cachedLookup(company, requestedKey) {
    const nowMs = currentDate(now).getTime();
    const cached = cache.get(requestedKey);
    if (cached && cached.expiresAt > nowMs) return clone(await cached.value);
    if (cached) cache.delete(requestedKey);
    const value = freshLookup(company, requestedKey);
    cache.set(requestedKey, { expiresAt: nowMs + Math.max(0, cacheTtlMs), value });
    try {
      const result = await value;
      if (result.error) cache.delete(requestedKey);
      while (cache.size > Math.max(1, maxCacheEntries)) cache.delete(cache.keys().next().value);
      return clone(result);
    } catch (error) {
      cache.delete(requestedKey);
      throw error;
    }
  }

  async function lookup({ company, selection } = {}) {
    const requestedCompany = asText(company);
    const requestedKey = companyReputationServerKey(requestedCompany);
    if (!requestedCompany || requestedKey.length < 2) {
      throw Object.assign(new TypeError('회사명을 두 글자 이상 입력해 주세요.'), { status: 400 });
    }
    const result = await cachedLookup(requestedCompany, requestedKey);
    const sourceId = asText(selection?.sourceId, 20);
    const selectedUrl = normalizeSourceUrl(sourceId, selection?.url);
    if (!sourceId || !selectedUrl) return result;
    const selected = result.candidates.find((candidate) => candidate.id === sourceId && candidate.url === selectedUrl);
    if (!selected) return result;
    result.sources = result.sources.map((source) => source.id === sourceId ? { ...selected, status: 'ok' } : source);
    result.candidates = result.candidates.filter((candidate) => candidate !== selected);
    result.ok = true;
    return result;
  }

  return { lookup, clearCache: () => cache.clear() };
}

export function registerCompanyReputationRoute(app, { lookup } = {}) {
  if (!app || typeof app.post !== 'function') throw new TypeError('Express app is required');
  if (!lookup || typeof lookup.lookup !== 'function') throw new TypeError('company reputation lookup is required');
  app.post('/api/company-reputation', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return res.json(await lookup.lookup({ company: req.body?.company, selection: req.body?.selection }));
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
      return res.status(status).json({
        error: status === 400 ? error.message : '공개 직원 평점을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      });
    }
  });
}
