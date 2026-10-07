import { fileURLToPath } from 'node:url';

export const NURSCAPE_LIST_URL = 'https://recruit.nurscape.net/Jobs/List?nurseBoardSync=1';
export const NURSCAPE_IMPORT_URL = 'https://nurse-board-ten.vercel.app/api/import/nurscape';
const EXTENSION_ORIGIN = 'chrome-extension://hnoonhnmaolblmbpmedgggbacifnhjjp';
const COLLECTOR_PATH = fileURLToPath(new URL('../nurscape-bridge/collector.js', import.meta.url));
const BLOCKED_TITLE = /attention required|just a moment|access denied|security verification/i;

function assertAccessible(status, title = '') {
  if ([401, 403, 429].includes(status) || BLOCKED_TITLE.test(title)) {
    throw new Error(`너스케입 접근 확인이 필요합니다 (HTTP ${status || 'unknown'}). 정상 브라우저 접근 또는 사이트의 수집 허용을 확인해 주세요.`);
  }
  if (status < 200 || status >= 300) throw new Error(`너스케입 HTTP ${status}`);
}

// A complete snapshot replaces the previous import. A single missing page must
// fail the run, otherwise an outage would silently remove valid cached jobs.
export async function collectNurscapeSnapshot({
  browserType, headless = true, maxPages = 15, requestTimeoutMs = 20_000,
  onPage = () => {},
} = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) {
    throw new Error('--max-pages는 1~20 사이의 정수여야 합니다.');
  }
  const browser = await browserType.launch({ headless });
  try {
    const page = await browser.newPage();
    const response = await page.goto(NURSCAPE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: requestTimeoutMs });
    assertAccessible(response?.status(), await page.title());
    const landed = new URL(page.url());
    if (landed.origin !== new URL(NURSCAPE_LIST_URL).origin || landed.pathname !== '/Jobs/List') {
      throw new Error('채용 목록이 다른 페이지로 이동했습니다. 로그인 또는 사이트 상태를 확인해 주세요.');
    }
    await page.waitForSelector('.list_body, .list_jobs .listBody', { timeout: requestTimeoutMs });
    await page.addScriptTag({ path: COLLECTOR_PATH });
    const first = await page.evaluate((limit) => ({
      jobs: globalThis.NurseBoardNurscapeCollector.collectNurscapeJobs(document),
      pages: globalThis.NurseBoardNurscapeCollector.collectNurscapePageRequests(document, location.href, limit),
      hasMore: [...document.querySelectorAll('[data-page-number], .number-page')]
        .some((node) => Number(node.getAttribute('data-page-number') || node.textContent) >= 2),
    }), maxPages);
    if (!first.jobs.length) throw new Error('1페이지에서 공개 공고를 찾지 못했습니다. 기존 공고는 유지합니다.');
    if (maxPages > 1 && first.hasMore && !first.pages.length) {
      throw new Error('페이지 이동 정보를 읽지 못했습니다. 불완전한 목록은 전송하지 않습니다.');
    }
    const byId = new Map(first.jobs.map((job) => [job.id, job]));
    const pages = [{ page: 1, count: first.jobs.length }];
    onPage(pages[0]);
    for (const request of first.pages) {
      const result = await page.evaluate(async ({ request, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(request.url, {
            method: 'POST', credentials: 'include', signal: controller.signal,
            headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
            body: request.body,
          });
          const contentType = response.headers.get('content-type') || '';
          const html = await response.text();
          if (html.length > 2_000_000) throw new Error('페이지 응답이 너무 큽니다.');
          const doc = new DOMParser().parseFromString(html, 'text/html');
          return { status: response.status, contentType, title: doc.title,
            jobs: globalThis.NurseBoardNurscapeCollector.collectNurscapeJobs(doc) };
        } finally { clearTimeout(timer); }
      }, { request, timeoutMs: requestTimeoutMs });
      assertAccessible(result.status, result.title);
      if (!/text\/html/i.test(result.contentType) || !result.jobs.length) {
        throw new Error(`${request.page}페이지가 비어 있거나 응답 형식이 바뀌었습니다. 불완전한 목록은 전송하지 않습니다.`);
      }
      for (const job of result.jobs) byId.set(job.id, job);
      const item = { page: request.page, count: result.jobs.length };
      pages.push(item);
      onPage(item);
    }
    const jobs = [...byId.values()];
    // The import API accepts at most 450 entries. Refuse silent truncation.
    if (jobs.length > 450) throw new Error(`공고 ${jobs.length}건이 수신 한도 450건을 넘었습니다. 범위를 조정한 후 재실행해 주세요.`);
    return { jobs, pages, complete: true };
  } finally { await browser.close(); }
}

export async function sendNurscapeSnapshot(jobs, {
  urls = [NURSCAPE_IMPORT_URL], fetchImpl = fetch, timeoutMs = 30_000,
} = {}) {
  if (!jobs?.length || jobs.length > 450) throw new Error('완전한 공고 1~450건만 전송할 수 있습니다.');
  const targets = [];
  for (const target of urls) {
    const url = new URL(target);
    if (url.username || url.password || !(url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
      throw new Error('수신 주소는 HTTPS 또는 로컬 서버 주소여야 합니다.');
    }
    try {
      const controller = new AbortController();
      let timer;
      const result = await Promise.race([
        (async () => {
          const response = await fetchImpl(target, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Origin: EXTENSION_ORIGIN },
            body: JSON.stringify({ jobs }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const result = await response.json();
          if (result.received !== jobs.length || result.rejected !== 0 || result.inserted + result.updated !== jobs.length) {
            throw new Error('서버가 전체 공고의 저장을 확인하지 않았습니다.');
          }
          return result;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('전송 시간이 초과되었습니다.')); }, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      targets.push({ target: url.origin, ok: true, result });
    } catch (error) { targets.push({ target: url.origin, ok: false, error: error.message }); }
  }
  // Local success must never hide a failed production upload.
  return { ok: targets[0]?.ok === true, targets };
}
