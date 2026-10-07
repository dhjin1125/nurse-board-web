import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKaohn } from '../server.mjs';

test('Kaohn current board reads publication dates without inventing deadlines', () => {
  const row = (href, title) => `<tr><td>313</td><td><a href="${href}">${title}</a></td><td>작성자</td><td>2026.09.08</td><td>63</td></tr>`;
  const jobs = parseKaohn(`<table>${row('/board/bbs81_1/1209?&page=1', '[두산건설] 건설현장 상담간호사 인력 모집')}${row('/board/bbs81_1/1209?page=2', '중복')}${row('/board/bbs81_1/1200', '채용 완료 간호사')}${row('https://example.com/board/bbs81_1/123', '간호사')}</table>`);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'kaohn-1209');
  assert.equal(jobs[0].postedAt, '2026-09-08');
  assert.equal(jobs[0].deadline, '원문 확인');
  assert.equal(jobs[0].url, 'https://www.kaohn.or.kr/board/bbs81_1/1209?&page=1');
});

test('Kaohn legacy links remain readable without mistaking publication for deadline', () => {
  const jobs = parseKaohn('<table><tr><td><a href="/bbs/board.php?tbl=bbs81_1&mode=VIEW&num=5">간호사 모집</a></td><td>07-11</td></tr></table>');
  assert.equal(jobs[0].id, 'kaohn-5');
  assert.equal(jobs[0].deadline, '원문 확인');
  assert.equal(jobs[0].postedAt, undefined);
});
