import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import {
  createCompanyReputationLookup,
  parseNaverCompanyRatings,
  registerCompanyReputationRoute,
} from '../lib/company-reputation.mjs';

const howardJobPlanetSearch = `<!doctype html><main>
  <a href="https://www.jobplanet.co.kr/companies/462795/reviews/%ED%95%98%EC%9B%8C%EB%93%9C%ED%9E%90%EB%B3%91%EC%9B%90">하워드힐병원 2026년 기업정보 | 기업리뷰 1건, 2.0 리뷰평점새 창 열림</a>
  <a href="https://www.jobplanet.co.kr/companies/462795/reviews/%ED%95%98%EC%9B%8C%EB%93%9C%ED%9E%90%EB%B3%91%EC%9B%90">장점과 단점이 들어 있는 리뷰 문장은 결과에 포함되면 안 됩니다.</a>
  <a href="https://www.jobplanet.co.kr/companies/462795/reviews/%ED%95%98%EC%9B%8C%EB%93%9C%ED%9E%90%EB%B3%91%EC%9B%90">평점2/51 참여새 창 열림</a>
  <a href="https://www.jobplanet.co.kr/companies/311608/reviews/%EA%B4%91%ED%99%94%EC%9D%98%EB%A3%8C%EC%9E%AC%EB%8B%A8%ED%95%98%EC%9B%8C%EB%93%9C%ED%9E%90%EB%B3%91%EC%9B%90">(의)광화의료재단하워드힐병원 2026년 기업정보 | 기업리뷰 13건, 2.8 리뷰평점새 창 열림</a>
</main>`;

const blindSearch = `<!doctype html><main>
  <a href="https://www.teamblind.com/kr/company/%EC%9C%A0%ED%94%8C%EB%9F%AC%EC%8A%A4%ED%99%88%EC%84%9C%EB%B9%84%EC%8A%A4/">유플러스홈서비스 - 블라인드새 창 열림</a>
  <a href="https://www.teamblind.com/kr/company/%EC%9C%A0%ED%94%8C%EB%9F%AC%EC%8A%A4%ED%99%88%EC%84%9C%EB%B9%84%EC%8A%A4/">평점2.5/532 참여새 창 열림</a>
</main>`;

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

test('Naver result parser keeps only aggregate fields and separates similarly named legal entities', () => {
  const parsed = parseNaverCompanyRatings(howardJobPlanetSearch, 'jobplanet');
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    id: 'jobplanet',
    name: '잡플래닛',
    companyName: '하워드힐병원',
    url: 'https://www.jobplanet.co.kr/companies/462795/reviews/%ED%95%98%EC%9B%8C%EB%93%9C%ED%9E%90%EB%B3%91%EC%9B%90',
    rating: 2,
    reviewCount: 1,
  });
  assert.equal(parsed[1].companyName, '(의)광화의료재단하워드힐병원');
  assert.equal(parsed[1].rating, 2.8);
  assert.equal(parsed[1].reviewCount, 13);
  assert.equal(JSON.stringify(parsed).includes('장점과 단점'), false);
});

test('Blind compact rating/count text is parsed into its canonical reviews URL', () => {
  assert.deepEqual(parseNaverCompanyRatings(blindSearch, 'blind'), [{
    id: 'blind',
    name: '블라인드',
    companyName: '유플러스홈서비스',
    url: 'https://www.teamblind.com/kr/company/%EC%9C%A0%ED%94%8C%EB%9F%AC%EC%8A%A4%ED%99%88%EC%84%9C%EB%B9%84%EC%8A%A4/reviews',
    rating: 2.5,
    reviewCount: 32,
  }]);
});

test('lookup selects only an exact company and fetches from the fixed public search host', async () => {
  const requests = [];
  const lookup = createCompanyReputationLookup({
    now: () => new Date('2026-09-01T06:00:00.000Z'),
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url);
      return htmlResponse(url.searchParams.get('query').includes('잡플래닛') ? howardJobPlanetSearch : '<main></main>');
    },
  });
  const result = await lookup.lookup({ company: '하워드힐 병원' });
  const jobPlanet = result.sources.find((source) => source.id === 'jobplanet');
  assert.equal(result.ok, true);
  assert.equal(jobPlanet.status, 'ok');
  assert.equal(jobPlanet.rating, 2);
  assert.equal(jobPlanet.reviewCount, 1);
  assert.equal(result.candidates.length, 0, 'an exact listing must not surface the older, differently named entity');
  assert.equal(result.sources.find((source) => source.id === 'blind').status, 'unavailable');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.origin === 'https://search.naver.com' && url.pathname === '/search.naver'));
  assert.equal(JSON.stringify(result).includes('장점과 단점'), false);

  await lookup.lookup({ company: '하워드힐병원' });
  assert.equal(requests.length, 2, 'same-company browser requests reuse the bounded server cache');
});

test('route validates input and returns the sanitized lookup result as JSON', async (t) => {
  const lookup = createCompanyReputationLookup({
    fetchImpl: async (input) => htmlResponse(new URL(input).searchParams.get('query').includes('잡플래닛') ? howardJobPlanetSearch : ''),
  });
  const app = express();
  app.use(express.json());
  registerCompanyReputationRoute(app, { lookup });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const invalid = await fetch(`${origin}/api/company-reputation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'a' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, '회사명을 두 글자 이상 입력해 주세요.');

  const response = await fetch(`${origin}/api/company-reputation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: '하워드힐병원' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.sources[0].rating, 2);
  assert.equal(result.sources[0].reviewCount, 1);
  assert.equal(JSON.stringify(result).includes('리뷰 문장'), false);
});
