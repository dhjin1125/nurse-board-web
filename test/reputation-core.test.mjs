import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const projectRoot = path.resolve(import.meta.dirname, '..');
const source = await fs.readFile(path.join(projectRoot, 'nurscape-bridge/reputation-core.js'), 'utf8');
const context = { AbortController, URL, module: { exports: {} }, setTimeout, clearTimeout };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: 'nurscape-bridge/reputation-core.js' });
const {
  companiesMatch,
  createReputationLookup,
  parseBlindCompanyPage,
  parseJobPlanetCompanyPage,
  parseJobPlanetSearchPage,
} = context.module.exports;

const blindHtml = ({ company = '유플러스홈서비스', rating = '2.5', count = 32 } = {}) => `<!doctype html>
  <title>블라인드 | ${company} 리뷰</title>
  <meta name="title" content="${company} 리뷰">
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'EmployerAggregateRating',
    ratingValue: rating,
    ratingCount: count,
    itemReviewed: { '@type': 'Organization', name: company },
  })}</script>
  <article>이 리뷰 본문은 결과에 포함되면 안 됩니다.</article>`;

const jobPlanetHtml = ({ company = '(주)유플러스홈서비스', rating = '2.0', count = 31 } = {}) => `<!doctype html>
  <title>${company} 2026년 기업정보 | 기업리뷰 ${count}건, 연봉정보 9건</title>
  <meta property="og:title" content="${company} 2026년 기업정보 | 기업리뷰 ${count}건">
  <h1>${company}</h1>
  <span class="rate_point">${rating}</span>
  <article>장단점 리뷰 원문</article>`;

const jobPlanetSearchHtml = `<!doctype html><main>
  <a href="/companies/388635/landing" title="(주)유플러스홈서비스"><span>(주)유플러스홈서비스</span><small>기업리뷰 31건</small></a>
  <a href="/companies/999/reviews" title="유플러스홈"><span>유플러스홈</span></a>
</main>`;

function response(html, url, status = 200) {
  return { ok: status >= 200 && status < 300, status, url, text: async () => html };
}

test('company matching ignores legal-entity markers but not meaningful name differences', () => {
  assert.equal(companiesMatch('(주) 유플러스홈서비스', '유플러스홈서비스'), true);
  assert.equal(companiesMatch('유플러스홈서비스', '유플러스홈'), false);
});

test('parsers return only public aggregate rating fields', () => {
  const blind = parseBlindCompanyPage(blindHtml(), 'https://www.teamblind.com/kr/company/%EC%9C%A0%ED%94%8C%EB%9F%AC%EC%8A%A4%ED%99%88%EC%84%9C%EB%B9%84%EC%8A%A4/reviews');
  assert.equal(blind.companyName, '유플러스홈서비스');
  assert.equal(blind.rating, 2.5);
  assert.equal(blind.reviewCount, 32);
  assert.equal(JSON.stringify(blind).includes('리뷰 본문'), false);

  const jobPlanet = parseJobPlanetCompanyPage(jobPlanetHtml(), 'https://www.jobplanet.co.kr/companies/388635/landing');
  assert.equal(jobPlanet.companyName, '(주)유플러스홈서비스');
  assert.equal(jobPlanet.rating, 2);
  assert.equal(jobPlanet.reviewCount, 31);
  assert.equal(JSON.stringify(jobPlanet).includes('장단점'), false);
});

test('jobplanet search parser extracts bounded official company candidates', () => {
  const candidates = parseJobPlanetSearchPage(jobPlanetSearchHtml);
  assert.equal(candidates.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(candidates[0])), {
    id: 'jobplanet',
    name: '잡플래닛',
    companyName: '(주)유플러스홈서비스',
    url: 'https://www.jobplanet.co.kr/companies/388635/landing',
  });
});

test('on-demand lookup combines exact public aggregates without retaining review text', async () => {
  const requested = [];
  const lookup = createReputationLookup({
    now: () => new Date('2026-09-01T06:00:00.000Z'),
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.includes('jobplanet.co.kr/search')) return response(jobPlanetSearchHtml, url);
      if (url.includes('jobplanet.co.kr/companies/388635')) return response(jobPlanetHtml(), url);
      if (url.includes('teamblind.com')) return response(blindHtml(), url);
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  const result = await lookup.lookup({ company: '(주)유플러스홈서비스' });
  assert.equal(result.ok, true);
  assert.equal(result.sources.filter((item) => item.status === 'ok').length, 2);
  assert.equal(result.candidates.length, 0);
  assert.equal(requested.length, 3);
  assert.equal(JSON.stringify(result).includes('리뷰 원문'), false);
  assert.equal(JSON.stringify(result).includes('리뷰 본문'), false);
});

test('blocked source becomes a direct-link fallback while the other source still succeeds', async () => {
  const lookup = createReputationLookup({
    fetchImpl: async (url) => url.includes('jobplanet.co.kr')
      ? response('<title>Just a moment...</title>', url, 403)
      : response(blindHtml(), url),
  });
  const result = await lookup.lookup({ company: '유플러스홈서비스' });
  assert.equal(result.ok, true);
  assert.equal(result.sources.find((item) => item.id === 'jobplanet').status, 'unavailable');
  assert.equal(result.sources.find((item) => item.id === 'blind').rating, 2.5);
});

test('a mismatched rendered company is returned as a candidate for user confirmation', async () => {
  const lookup = createReputationLookup({
    fetchImpl: async (url) => url.includes('jobplanet.co.kr')
      ? response('', url, 403)
      : response(blindHtml({ company: '유플러스홈' }), url),
  });
  const result = await lookup.lookup({ company: '유플러스홈서비스' });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].companyName, '유플러스홈');
  assert.equal(result.sources.find((item) => item.id === 'blind'), undefined);
});
