import test from 'node:test';
import assert from 'node:assert/strict';
import { SARAMIN_SEARCH_KEYWORDS, collectSaraminJobs } from '../server.mjs';

function saraminCard(id, title = '외래 간호사 채용') {
  return `<div class="item_recruit" value="${id}">
    <h2 class="job_tit"><a href="/zf_user/jobs/relay/view?rec_idx=${id}">${title}</a></h2>
    <div class="job_condition"><span><a>서울</a></span><span>경력무관</span><span>초대졸↑</span><span>정규직</span></div>
    <div class="job_date"><span class="date">~ 09/30(수)</span></div>
    <div class="job_sector"><a>간호사</a><span class="job_day">등록일 26/08/28</span></div>
    <strong class="corp_name"><a>햇살의원</a></strong>
  </div>`;
}

test('사람인 6개 복합 검색어를 모두 요청하고 겹치는 공고 ID를 하나로 합친다', async () => {
  const requested = [];
  const jobs = await collectSaraminJobs({
    fetcher: async (url) => {
      requested.push(new URL(url).searchParams.get('searchword'));
      return saraminCard(101);
    },
  });

  assert.deepEqual(requested, SARAMIN_SEARCH_KEYWORDS);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'saramin-101');
  assert.deepEqual(jobs[0].searchKeywords, SARAMIN_SEARCH_KEYWORDS);
});

test('일부 검색이 실패하면 성공 결과와 실패 검색어의 이전 공고를 함께 유지한다', async () => {
  const previous = {
    id: 'saramin-909',
    company: '연구병원',
    title: 'CRC 연구간호사 채용',
    source: '사람인',
    searchKeywords: ['CRC 간호사'],
    lastSeenAt: '2026-08-27T00:00:00.000Z',
  };
  const jobs = await collectSaraminJobs({
    previousJobs: [previous],
    fetcher: async (url) => {
      const keyword = new URL(url).searchParams.get('searchword');
      if (keyword === 'CRC 간호사') throw new Error('temporary failure');
      return saraminCard(202, '상근 외래 간호사 채용');
    },
  });

  assert.deepEqual(jobs.map((job) => job.id).sort(), ['saramin-202', 'saramin-909']);
  assert.equal(jobs.find((job) => job.id === previous.id).lastSeenAt, previous.lastSeenAt);
});

test('사람인 검색이 전부 실패하면 기존 소스 캐시를 유지할 수 있도록 오류를 낸다', async () => {
  await assert.rejects(() => collectSaraminJobs({ fetcher: async () => { throw new Error('blocked'); } }), /모두 확인하지 못했습니다/);
});
