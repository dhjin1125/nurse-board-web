import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORK24_SEARCH_KEYWORDS,
  collectWork24OpenApiJobs,
  parseWork24OpenApi,
} from '../server.mjs';

function wantedXml({ id = 'K123', title = '외래 상근 간호사 채용', company = '한빛병원' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <wantedRoot><total>1</total><startPage>1</startPage><display>100</display><wanted>
      <wantedAuthNo>${id}</wantedAuthNo><company>${company}</company><title>${title}</title>
      <region>서울 강남구</region><holidayTpNm>주 5일 근무</holidayTpNm>
      <career>경력무관</career><regDt>20260827</regDt><closeDt>20260910</closeDt>
      <salTpNm>연봉</salTpNm><sal>3600만원</sal><minEdubg>대졸(2~3년)</minEdubg>
      <empTpCd>10</empTpCd><wantedInfoUrl>https://www.work24.go.kr/jobs/${id}</wantedInfoUrl>
    </wanted></wantedRoot>`;
}

test('고용24 공식 XML 목록을 공고 필드로 변환하고 간호조무사 단독 공고는 제외한다', () => {
  const xml = `${wantedXml().replace('</wantedRoot>', '')}
    <wanted><wantedAuthNo>A1</wantedAuthNo><company>보조병원</company><title>간호조무사 채용</title></wanted>
    </wantedRoot>`;
  const jobs = parseWork24OpenApi(xml);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    id: 'work24-K123', company: '한빛병원', title: '외래 상근 간호사 채용', region: '서울 강남구',
    deadline: '2026-09-10', publishedAt: '2026-08-27', salary: '연봉 · 3600만원', education: '대졸(2~3년)',
    experience: '경력무관', employment: '기간의 정함이 없는 근로계약', workConditions: '주 5일 근무',
    source: '고용24', sourceProvider: '고용24 Open API', category: 'clinical', role: '외래 상근 간호사 채용',
    url: 'https://www.work24.go.kr/jobs/K123',
  });
});

test('고용24 공식 API는 최근 2주 간호 직무 6개 검색을 요청하고 겹치는 공고를 합친다', async () => {
  const urls = [];
  const jobs = await collectWork24OpenApiJobs({
    authKey: 'test-key',
    fetcher: async (url) => { urls.push(new URL(url)); return wantedXml(); },
  });
  assert.equal(urls.length, WORK24_SEARCH_KEYWORDS.length);
  assert.deepEqual(urls.map((url) => url.searchParams.get('keyword')), WORK24_SEARCH_KEYWORDS);
  for (const url of urls) {
    assert.equal(url.searchParams.get('authKey'), 'test-key');
    assert.equal(url.searchParams.get('returnType'), 'XML');
    assert.equal(url.searchParams.get('display'), '100');
    assert.equal(url.searchParams.get('regDate'), 'W-2');
    assert.equal(url.searchParams.get('sortOrderBy'), 'DESC');
  }
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].searchKeywords, WORK24_SEARCH_KEYWORDS);
});

test('고용24 일부 검색 실패 시 실패 검색어의 이전 공고를 유지한다', async () => {
  const previous = { id: 'work24-old', title: '산업간호사 이전 공고', company: '이전회사', searchKeywords: ['산업간호사'] };
  const jobs = await collectWork24OpenApiJobs({
    authKey: 'test-key', keywords: ['외래 간호사', '산업간호사'], previousJobs: [previous],
    fetcher: async (url) => new URL(url).searchParams.get('keyword') === '산업간호사'
      ? Promise.reject(new Error('temporary')) : wantedXml(),
  });
  assert.deepEqual(jobs.map((job) => job.id).sort(), ['work24-K123', 'work24-old']);
});

test('고용24 인증키가 없거나 모든 API 검색이 실패하면 기존 캐시를 보존할 수 있도록 오류를 낸다', async () => {
  await assert.rejects(() => collectWork24OpenApiJobs({ authKey: '' }), /WORK24_AUTH_KEY/);
  await assert.rejects(() => collectWork24OpenApiJobs({
    authKey: 'test-key', keywords: ['외래 간호사'], fetcher: async () => { throw new Error('blocked'); },
  }), /모두 확인하지 못했습니다/);
});
