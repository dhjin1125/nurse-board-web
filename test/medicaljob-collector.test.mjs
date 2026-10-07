import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { MEDICALJOB_SEARCH_KEYWORDS, collectMedicalJobJobs } from '../server.mjs';

function medicalJobCard(id, title = '외래 간호사 채용') {
  return `<a href="/job/view.asp?jsn=999">공통 광고 간호사 채용</a>
    <table width="680">
      <tr><th>채용공고 제목</th></tr>
      <tr><td>
        <a href="/job/view.asp?jsn=${id}">햇살의원</a>
        <a href="/job/view.asp?jsn=${id}">${title}</a>
        서울 채용시
      </td></tr>
    </table>`;
}

function decodeCp949Field(body, name) {
  const encoded = String(body).match(new RegExp(`(?:^|&)${name}=([^&]*)`))?.[1] || '';
  const bytes = [];
  for (let index = 0; index < encoded.length;) {
    if (encoded[index] === '%' && /^[0-9A-F]{2}$/i.test(encoded.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 3;
    } else {
      bytes.push(encoded[index] === '+' ? 0x20 : encoded.charCodeAt(index));
      index += 1;
    }
  }
  return iconv.decode(Buffer.from(bytes), 'cp949');
}

test('메디컬잡 4개 비교대 검색어를 CP949 POST로 모두 요청하고 중복 공고를 합친다', async () => {
  const requested = [];
  const jobs = await collectMedicalJobJobs({
    fetcher: async (url, options) => {
      assert.equal(url, 'https://www.medicaljob.co.kr/job/list.asp');
      assert.equal(options.method, 'POST');
      assert.match(options.headers['content-type'], /EUC-KR/);
      assert.match(options.body, /jobid=etc/);
      requested.push(decodeCp949Field(options.body, 's_jkind'));
      return medicalJobCard(101);
    },
  });

  assert.deepEqual(requested, MEDICALJOB_SEARCH_KEYWORDS);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'medicaljob-101');
  assert.equal(jobs.some((job) => job.id === 'medicaljob-999'), false);
  assert.deepEqual(jobs[0].searchKeywords, MEDICALJOB_SEARCH_KEYWORDS);
});

test('메디컬잡 일부 검색이 실패하면 성공 결과와 실패 검색어의 이전 공고를 유지한다', async () => {
  const previous = {
    id: 'medicaljob-909',
    company: '연구병원',
    title: 'CRC 연구간호사 채용',
    source: '메디컬잡',
    searchKeywords: ['CRC'],
  };
  const jobs = await collectMedicalJobJobs({
    previousJobs: [previous],
    fetcher: async (_url, options) => {
      const keyword = decodeCp949Field(options.body, 's_jkind');
      if (keyword === 'CRC') throw new Error('temporary failure');
      return medicalJobCard(202, '상근 외래 간호사 채용');
    },
  });

  assert.deepEqual(jobs.map((job) => job.id).sort(), ['medicaljob-202', 'medicaljob-909']);
});

test('메디컬잡 검색이 전부 실패하면 기존 소스 캐시를 유지할 수 있도록 오류를 낸다', async () => {
  await assert.rejects(
    () => collectMedicalJobJobs({ fetcher: async () => { throw new Error('blocked'); } }),
    /메디컬잡 검색을 모두 확인하지 못했습니다/,
  );
});
