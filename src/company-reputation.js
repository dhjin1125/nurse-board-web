export const COMPANY_REPUTATION_STORAGE_KEY = 'nurse-company-reputation-v1';
export const COMPANY_REPUTATION_CACHE_VERSION = 1;
export const COMPANY_REPUTATION_REQUEST = 'NURSE_BOARD_COMPANY_REPUTATION_REQUEST';
export const COMPANY_REPUTATION_ACK = 'NURSE_BOARD_COMPANY_REPUTATION_ACK';
export const COMPANY_REPUTATION_RESPONSE = 'NURSE_BOARD_COMPANY_REPUTATION_RESPONSE';

const MAX_ENTRIES = 80;
const MAX_SERIALIZED_LENGTH = 120_000;
const MAX_COMPANY_LENGTH = 160;
const MAX_URL_LENGTH = 2_048;
const LEGAL_ENTITY_MARKERS = /(?:주식회사|의료법인|학교법인|재단법인|사단법인|사회복지법인|㈜|[(（]\s*(?:주|유|재|사|의)\s*[)）])/giu;
const SOURCES = Object.freeze({
  jobplanet: { id: 'jobplanet', name: '잡플래닛', hosts: new Set(['jobplanet.co.kr', 'www.jobplanet.co.kr']) },
  blind: { id: 'blind', name: '블라인드', hosts: new Set(['teamblind.com', 'www.teamblind.com', 'kr.teamblind.com']) },
});

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asText = (value, maxLength = MAX_COMPANY_LENGTH) => typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

export function companyDisplayName(value) {
  const original = asText(value);
  if (!original) return '';
  return original.normalize('NFKC').replace(LEGAL_ENTITY_MARKERS, ' ').replace(/\s+/g, ' ').trim() || original;
}

export function companyReputationKey(value) {
  return companyDisplayName(value).toLocaleLowerCase('ko-KR').replace(/[^0-9a-z가-힣]/giu, '');
}

function allowedSourceUrl(sourceId, value) {
  const source = SOURCES[sourceId];
  const text = asText(value, MAX_URL_LENGTH);
  if (!source || !text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && source.hosts.has(url.hostname.toLowerCase()) ? url.href : '';
  } catch {
    return '';
  }
}

function finiteRating(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 && rating <= 5 ? Math.round(rating * 10) / 10 : null;
}

function finiteReviewCount(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const count = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isInteger(count) && count >= 0 && count <= 10_000_000 ? count : null;
}

function validIsoDate(value) {
  const text = asText(value, 40);
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

export function companyReputationLinks(company) {
  const display = companyDisplayName(company);
  if (!display) return [];
  return [
    {
      id: 'jobplanet',
      name: SOURCES.jobplanet.name,
      url: `https://www.jobplanet.co.kr/search?query=${encodeURIComponent(display)}`,
    },
    {
      id: 'blind',
      name: SOURCES.blind.name,
      url: `https://www.teamblind.com/kr/company/${encodeURIComponent(display)}/reviews`,
    },
  ];
}

function normalizeStoredSource(value) {
  if (!isRecord(value) || !SOURCES[value.id]) return null;
  const rating = finiteRating(value.rating);
  const reviewCount = finiteReviewCount(value.reviewCount);
  const url = allowedSourceUrl(value.id, value.url);
  const checkedAt = validIsoDate(value.checkedAt);
  if (rating === null || reviewCount === null || !url || !checkedAt) return null;
  return {
    id: value.id,
    name: SOURCES[value.id].name,
    companyName: asText(value.companyName) || '',
    rating,
    reviewCount,
    url,
    checkedAt,
  };
}

function normalizeStoredEntry(value) {
  if (!isRecord(value)) return null;
  const company = asText(value.company);
  const key = companyReputationKey(company);
  const checkedAt = validIsoDate(value.checkedAt);
  const sources = (Array.isArray(value.sources) ? value.sources : []).map(normalizeStoredSource).filter(Boolean);
  if (!company || !key || !checkedAt || !sources.length) return null;
  return {
    key,
    company,
    checkedAt,
    sources: [...new Map(sources.map((source) => [source.id, source])).values()],
  };
}

const emptyCache = () => ({ version: COMPANY_REPUTATION_CACHE_VERSION, entries: [] });

function normalizeCache(value) {
  if (!isRecord(value) || value.version !== COMPANY_REPUTATION_CACHE_VERSION || !Array.isArray(value.entries)) return emptyCache();
  const entries = value.entries.map(normalizeStoredEntry).filter(Boolean)
    .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt));
  return {
    version: COMPANY_REPUTATION_CACHE_VERSION,
    entries: [...new Map(entries.map((entry) => [entry.key, entry])).values()].slice(0, MAX_ENTRIES),
  };
}

function storageTarget(storage) {
  const target = storage || globalThis.localStorage;
  return target && typeof target.getItem === 'function' && typeof target.setItem === 'function' ? target : null;
}

export function readCompanyReputationCache(storage = globalThis.localStorage) {
  const target = storageTarget(storage);
  if (!target) return emptyCache();
  try {
    const raw = target.getItem(COMPANY_REPUTATION_STORAGE_KEY);
    if (!raw || raw.length > MAX_SERIALIZED_LENGTH) return emptyCache();
    return normalizeCache(JSON.parse(raw));
  } catch {
    return emptyCache();
  }
}

export function writeCompanyReputationCache(storage, cache) {
  const normalized = normalizeCache(cache);
  const target = storageTarget(storage);
  if (!target) return normalized;
  try {
    let entries = normalized.entries;
    let payload = JSON.stringify({ version: COMPANY_REPUTATION_CACHE_VERSION, entries });
    while (payload.length > MAX_SERIALIZED_LENGTH && entries.length) {
      entries = entries.slice(0, -1);
      payload = JSON.stringify({ version: COMPANY_REPUTATION_CACHE_VERSION, entries });
    }
    target.setItem(COMPANY_REPUTATION_STORAGE_KEY, payload);
    return { version: COMPANY_REPUTATION_CACHE_VERSION, entries };
  } catch {
    return normalized;
  }
}

export function findCompanyReputation(cache, company) {
  const key = companyReputationKey(company);
  return key ? normalizeCache(cache).entries.find((entry) => entry.key === key) || null : null;
}

export function rememberCompanyReputation(storage, company, sourceValues, now = new Date()) {
  const key = companyReputationKey(company);
  if (!key) return null;
  const checkedAt = validIsoDate(now instanceof Date ? now.toISOString() : now) || new Date().toISOString();
  const incoming = (Array.isArray(sourceValues) ? sourceValues : []).map((source) => normalizeStoredSource({ ...source, checkedAt: source?.checkedAt || checkedAt })).filter(Boolean);
  const cache = readCompanyReputationCache(storage);
  const existing = cache.entries.find((entry) => entry.key === key);
  const sources = [...new Map([...(existing?.sources || []), ...incoming].map((source) => [source.id, source])).values()];
  if (!sources.length) return existing || null;
  const entry = normalizeStoredEntry({ company: asText(company), checkedAt, sources });
  if (!entry) return existing || null;
  writeCompanyReputationCache(storage, {
    version: COMPANY_REPUTATION_CACHE_VERSION,
    entries: [entry, ...cache.entries.filter((candidate) => candidate.key !== key)],
  });
  return entry;
}

function normalizeLookupSource(value, fallbackStatus = 'unavailable') {
  if (!isRecord(value) || !SOURCES[value.id]) return null;
  const rating = finiteRating(value.rating);
  const reviewCount = finiteReviewCount(value.reviewCount);
  const url = allowedSourceUrl(value.id, value.url) || companyReputationLinks(value.companyName).find((link) => link.id === value.id)?.url || '';
  const hasAggregate = rating !== null && reviewCount !== null && url;
  const status = fallbackStatus === 'candidate' ? 'candidate' : hasAggregate ? 'ok' : fallbackStatus;
  return {
    id: value.id,
    name: SOURCES[value.id].name,
    companyName: asText(value.companyName),
    url,
    status,
    ...(hasAggregate ? { rating, reviewCount, checkedAt: validIsoDate(value.checkedAt) || new Date().toISOString() } : {}),
    ...(asText(value.message, 240) ? { message: asText(value.message, 240) } : {}),
  };
}

function normalizeLookupResult(value, company) {
  const result = isRecord(value) ? value : {};
  const sources = (Array.isArray(result.sources) ? result.sources : []).map((source) => normalizeLookupSource(source)).filter(Boolean);
  const candidates = (Array.isArray(result.candidates) ? result.candidates : []).map((source) => normalizeLookupSource(source, 'candidate')).filter(Boolean);
  return {
    ok: sources.some((source) => source.status === 'ok'),
    company: asText(result.company) || asText(company),
    sources,
    candidates,
    error: asText(result.error, 300),
  };
}

function requestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `reputation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function requestCompanyReputationBridge(company, {
  windowRef = globalThis.window,
  selection,
  bridgeTimeoutMs = 1_200,
  responseTimeoutMs = 20_000,
} = {}) {
  const requestedCompany = asText(company);
  if (!requestedCompany) return Promise.reject(new TypeError('회사명이 필요합니다.'));
  if (!windowRef?.addEventListener || !windowRef?.postMessage || !windowRef?.location?.origin) {
    return Promise.reject(Object.assign(new Error('이 브라우저에서는 회사 평가 브리지를 사용할 수 없습니다.'), { code: 'BRIDGE_UNAVAILABLE' }));
  }

  return new Promise((resolve, reject) => {
    const id = requestId();
    let acknowledged = false;
    const cleanup = () => {
      clearTimeout(bridgeTimer);
      clearTimeout(responseTimer);
      windowRef.removeEventListener('message', onMessage);
    };
    const fail = (message, code) => {
      cleanup();
      reject(Object.assign(new Error(message), { code }));
    };
    const onMessage = (event) => {
      if (event.source !== windowRef || event.origin !== windowRef.location.origin || event.data?.requestId !== id) return;
      if (event.data.type === COMPANY_REPUTATION_ACK) {
        acknowledged = true;
        clearTimeout(bridgeTimer);
        return;
      }
      if (event.data.type !== COMPANY_REPUTATION_RESPONSE) return;
      cleanup();
      resolve(normalizeLookupResult(event.data.result, requestedCompany));
    };
    const bridgeTimer = setTimeout(() => {
      if (!acknowledged) fail('Chrome 확장을 다시 로드한 뒤 확인해 주세요.', 'BRIDGE_UNAVAILABLE');
    }, bridgeTimeoutMs);
    const responseTimer = setTimeout(() => fail('회사 평가 사이트 응답이 늦어지고 있습니다. 잠시 후 다시 확인해 주세요.', 'LOOKUP_TIMEOUT'), responseTimeoutMs);
    windowRef.addEventListener('message', onMessage);
    windowRef.postMessage({
      type: COMPANY_REPUTATION_REQUEST,
      requestId: id,
      company: requestedCompany,
      ...(selection ? { selection } : {}),
    }, windowRef.location.origin);
  });
}

async function requestCompanyReputationApi(company, {
  windowRef = globalThis.window,
  selection,
  fetchImpl = globalThis.fetch,
  apiUrl = '/api/company-reputation',
  apiTimeoutMs = 12_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('이 브라우저에서는 직원 평점 서버에 연결할 수 없습니다.'), { code: 'API_UNAVAILABLE' });
  }
  const requestedCompany = asText(company);
  const origin = windowRef?.location?.origin || globalThis.location?.origin || '';
  let target = apiUrl;
  try {
    if (origin) target = new URL(apiUrl, origin).href;
  } catch {
    throw Object.assign(new Error('직원 평점 조회 주소가 올바르지 않습니다.'), { code: 'API_UNAVAILABLE' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiTimeoutMs);
  try {
    const response = await fetchImpl(target, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ company: requestedCompany, ...(selection ? { selection } : {}) }),
      signal: controller.signal,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {}
    if (!response.ok) {
      throw Object.assign(new Error(asText(payload?.error, 300) || '직원 평점 서버가 응답하지 않았습니다.'), { code: 'API_UNAVAILABLE' });
    }
    return normalizeLookupResult(payload, requestedCompany);
  } catch (error) {
    if (error?.code === 'API_UNAVAILABLE') throw error;
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('공개 평점 확인이 늦어지고 있습니다. 잠시 후 다시 확인해 주세요.'), { code: 'LOOKUP_TIMEOUT' });
    }
    throw Object.assign(new Error('직원 평점 서버에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.'), { code: 'API_UNAVAILABLE' });
  } finally {
    clearTimeout(timer);
  }
}

export async function requestCompanyReputation(company, options = {}) {
  const requestedCompany = asText(company);
  if (!requestedCompany) throw new TypeError('회사명이 필요합니다.');
  try {
    const bridged = await requestCompanyReputationBridge(requestedCompany, options);
    if (bridged.ok || bridged.candidates.length) return bridged;
  } catch (error) {
    const canFallBack = ['BRIDGE_UNAVAILABLE', 'LOOKUP_TIMEOUT'].includes(error?.code) && options.fetchImpl !== null;
    if (!canFallBack) {
      throw error;
    }
  }
  return requestCompanyReputationApi(requestedCompany, options);
}
