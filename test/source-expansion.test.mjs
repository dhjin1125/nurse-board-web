import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  app,
  collectBohunJobs,
  collectNmcJobs,
  collectNurseJobJobs,
  collectZighangJobs,
  parseBohunJobs,
  parseNmcJobs,
  parseZighangJobs,
  parseRecruiter,
  parseOfficialRecruiterDetail,
  collectJobDetail,
  prepareJobWithDetail,
  selectDetailWarmJobs,
  detailWorkerOptions,
} from '../server.mjs';
import { normalizeJob } from '../lib/job-model.mjs';
import { jobPage } from '../lib/job-page.mjs';
import { createJobDetailService } from '../lib/job-detail-service.mjs';
import { readFileSync } from 'node:fs';
import { makeHwp, makeZip, surgeryText, heartText, recruiterHtml } from './fixtures/official-attachments.mjs';

const recruiterConfig = { id: 'snubh', company: '분당서울대학교병원', source: '분당서울대병원', region: '경기', origin: 'https://snubh.recruiter.co.kr' };
const recruiterItem = { jobnoticeSn: 987654, jobnoticeName: '경력 간호직 채용', applyStartDate: '2026-09-10 09:00:00', applyEndDate: '2026-09-21 23:59:59', receiptState: '접수중', deadlineCount: 10 };
const recruiterJob = () => parseRecruiter(JSON.stringify({ jobnoticeInProgressList: [recruiterItem] }), recruiterConfig)[0];

test('Recruiter retains absolute KST dates and excludes explicit closure even with a future deadline', () => {
  const rows = [recruiterItem, ...['접수마감', '접수종료', 'CLOSED'].map((receiptState, index) => ({ ...recruiterItem, jobnoticeSn: index, receiptState, applyEndDate: '2099-12-31 23:59:59' })),
    { ...recruiterItem, jobnoticeSn: 5, deadlineCount: -1 }];
  const jobs = parseRecruiter(JSON.stringify({ jobnoticeInProgressList: rows }), recruiterConfig);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].postedAt, '2026-09-10T09:00:00+09:00');
  assert.equal(jobs[0].applyStartDate, '2026-09-10T09:00:00+09:00');
  assert.equal(jobs[0].applyEndDate, '2026-09-21T23:59:59+09:00');
  assert.equal(jobs[0].deadline, '2026-09-21');
  const normalized = normalizeJob(jobs[0], { seenAt: '2026-09-22T00:00:00Z' });
  assert.equal(normalized.publishedAt, '2026-09-10');
  assert.equal(normalized.deadlineAt, '2026-09-21');
  assert.equal(normalized.deadlineStatus, 'expired');
  const invalid = parseRecruiter(JSON.stringify({ jobnoticeInProgressList: [{ ...recruiterItem, applyStartDate: '2026-02-30', applyEndDate: 'bad', deadlineCount: undefined }] }), recruiterConfig)[0];
  assert.equal(invalid.deadline, '원문 확인');
  assert.equal(invalid.postedAt, undefined);
});

test('Recruiter department table retains rowspans and separate experience requirements', () => {
  const detail = parseOfficialRecruiterDetail(recruiterHtml, recruiterJob().url);
  assert.equal(detail.department, '외과 · 심장혈관센터');
  assert.equal(detail.recruitmentScope, 'mixed');
  assert.match(detail.experience, /외과.*경력 3년/);
  assert.match(detail.experience, /심장혈관센터.*경력 1년/);
  assert.match(detail.description, /간호직 \| 심장혈관센터/);
});

test('official boilerplate about possible schedule changes is retained without declaring night-only work', () => {
  const html = recruiterHtml.replace('병원 사정에 따라 근무형태 변경 가능', '입사전후 교대근무, 야간근무, 휴일근무 등 근무형태는 병원사정에 따라 변경될 수 있음');
  const detail = parseOfficialRecruiterDetail(html, recruiterJob().url);
  assert.match(detail.otherInformation, /야간근무/);
  assert.doesNotMatch(detail.workConditions || '', /야간근무/);
  const prepared = prepareJobWithDetail(recruiterJob(), { ...detail, detailVerified: true });
  assert.equal(prepared.workPattern, '원문 확인');
});

test('direct Recruiter ZIP enriches list searches and retains mixed-role and on-call evidence', async (t) => {
  const job = recruiterJob();
  const zip = makeZip([
    { name: '직무소개서(외과).hwp', bytes: makeHwp(surgeryText) },
    { name: '직무소개서(심장혈관센터).hwp', bytes: makeHwp(heartText) },
  ]);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    calls.push(String(input));
    assert.equal(options.redirect, 'manual');
    return String(input) === job.url ? new Response(recruiterHtml) : new Response(zip);
  });
  const detail = await collectJobDetail(job);
  assert.equal(calls.length, 2);
  assert.equal(detail.detailVerified, true);
  assert.equal(detail.attachments[0].extractionStatus, 'extracted');
  assert.equal(detail.attachmentDocuments.length, 2);
  assert.match(detail.duties, /외과 병동의 전담간호사 업무/);
  assert.match(detail.duties, /심장·뇌혈관조영실 간호 업무/);
  assert.match(detail.workConditions, /응급 온콜/);
  assert.equal(detail.recruitmentScope, 'mixed');
  assert.equal(detail.recruitmentRoles.length, 2);
  assert.match(detail.recruitmentRoles[0].qualifications, /경력 3년/);
  assert.match(detail.recruitmentRoles[1].qualifications, /경력 1년/);
  assert.doesNotMatch(detail.recruitmentRoles[1].duties, /전담간호사/);
  const prepared = prepareJobWithDetail(job, detail);
  assert.equal(prepared.recruitmentScope, 'mixed');
  assert.deepEqual(prepared.recruitmentRoles, detail.recruitmentRoles);
  assert.notEqual(prepared.workPattern, '상근·주간');
  for (const query of ['전담간호사', '심장·뇌혈관조영실', '응급 온콜', '경력 3년', '경력 1년']) {
    const page = JSON.parse(jobPage({ jobs: [prepared] }, { filters: JSON.stringify({ query }) }).body);
    assert.equal(page.pagination.total, 1, query);
  }
  assert.equal(JSON.parse(jobPage({ jobs: [job] }, { filters: JSON.stringify({ query: '전담간호사' }) }).body).pagination.total, 0);
  assert.equal(prepareJobWithDetail(job, { ...detail, detailVerified: false }).description, undefined);
});

test('one unavailable attachment keeps official body and a later valid HWP; attempts are bounded', async (t) => {
  const job = recruiterJob();
  const html = recruiterHtml.replace(/<a class="fileWrapperView"[\s\S]+$/u,
    Array.from({ length: 6 }, (_, i) => `<a href="/mrs2/attachFile/downloadFile?fileUid=${i}.hwp">직무${i}.hwp</a>`).join(''));
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    if (String(input) === job.url) return new Response(html);
    downloads += 1;
    return String(input).includes('=1.hwp') ? new Response(makeHwp(surgeryText)) : new Response('missing', { status: 503 });
  });
  const detail = await collectJobDetail(job);
  assert.equal(detail.detailVerified, true);
  assert.equal(downloads, 4);
  assert.match(detail.description, /심장혈관센터/);
  assert.match(detail.duties, /전담간호사/);
  assert.equal(detail.attachments.filter((item) => item.extractionStatus === 'limit').length, 2);
});

test('official worker selection excludes stale closed nodes, favors hospitals and fairly interleaves sources', () => {
  const make = (host, id, score = 0, overrides = {}) => ({ id, url: `https://${host}/app/jobnotice/view?jobnoticeSn=${id}`, applicationTierGroupScore: score, ...overrides });
  const jobs = [
    ...Array.from({ length: 100 }, (_, i) => make('www.nursejob.co.kr', `feed${i}`, 100)),
    ...Array.from({ length: 30 }, (_, i) => make('snubh.recruiter.co.kr', `snubh${i}`, 50)),
    make('ncc.recruiter.co.kr', 'ncc', 1), make('yuhs.recruiter.co.kr', 'yuhs'),
    make('www.jobkorea.co.kr', 'general2'),
    make('snubh.recruiter.co.kr', 'closed-future', 100, { receiptState: '접수마감', deadlineStatus: 'upcoming', deadlineAt: '2099-12-31' }),
    make('ncc.recruiter.co.kr', 'expired-today', 100, { applyEndDate: '2026-09-21 09:00:00' }),
    make('ncc.recruiter.co.kr', 'old', 100, { deadlineAt: '2026-09-20', deadlineStatus: 'upcoming' }),
    make('evil.example', 'bad'),
  ];
  const options = { now: new Date('2026-09-21T10:00:00+09:00') };
  const ordered = selectDetailWarmJobs({ jobs, needsReviewJobs: [jobs[0]] }, options);
  assert.deepEqual(ordered.slice(0, 6).map((job) => job.id), ['snubh0', 'ncc', 'feed0', 'yuhs', 'snubh1', 'general2']);
  assert.equal(ordered.length, 133);
  const official = selectDetailWarmJobs({ jobs }, { ...options, officialOnly: true });
  assert.equal(official.length, 32);
  assert.ok(official.every((job) => new URL(job.url).hostname.endsWith('.recruiter.co.kr')));
});

test('official collector mode is wired in compose, fetches one official detail at a time and respects cache TTL', async () => {
  assert.deepEqual(detailWorkerOptions('official', false), { enabled: true, officialOnly: true, concurrency: 1 });
  assert.equal(detailWorkerOptions('false', false).enabled, false);
  assert.equal(detailWorkerOptions('official', true).enabled, false);
  assert.match(readFileSync(new URL('../deploy/iwinv/docker-compose.yml', import.meta.url), 'utf8'), /NURSE_BOARD_DETAIL_WORKER: "official"/);
  let active = 0, peak = 0, collected = 0;
  const service = createJobDetailService({ ...detailWorkerOptions('official', false), collect: async () => {
    active += 1; peak = Math.max(peak, active); collected += 1;
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { detailVerified: true, duties: '간호 업무' };
  } });
  const jobs = [recruiterJob(), { ...recruiterJob(), url: `${recruiterJob().url}1` }];
  const first = service.warm(jobs);
  assert.strictEqual(service.warm(jobs), first, 'overlapping warm calls share one queue');
  await first; await service.warm(jobs);
  assert.equal(peak, 1); assert.equal(collected, 2);
});

function nurseJobCard(id, title = `병동 간호사 ${id} 채용`) {
  return `<div class="nurse_box"><div class="basic_box">
    <a href="/recruit/recruit_view.php?r_idx=${id}">
      <ul class="b_t_company">테스트병원 ${id}</ul>
      <ul class="b_t_subject">${title}</ul>
    </a>
    <ul class="b_i_area"><li>서울</li></ul>
    <ul class="b_i_time"><li>D-7</li></ul>
  </div></div>`;
}

test('널스잡은 첫 화면에서 확인한 페이지 범위까지 수집하고 ID 중복을 제거한다', async () => {
  const requestedPages = [];
  const jobs = await collectNurseJobJobs({
    maxPages: 10,
    concurrency: 2,
    fetcher: async (url) => {
      const page = Number(new URL(url).searchParams.get('page') || 1);
      requestedPages.push(page);
      if (page === 1) return `${nurseJobCard(101)}<a href="?tch=nurse&m=new&page=2">2</a><a href="?tch=nurse&m=new&page=3">3</a>`;
      if (page === 2) return `${nurseJobCard(101)}${nurseJobCard(202)}`;
      return nurseJobCard(303);
    },
  });

  assert.deepEqual(requestedPages.sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual(jobs.map((job) => job.id).sort(), ['nursejob-101', 'nursejob-202', 'nursejob-303']);
});

function zighangItem(id, overrides = {}) {
  return {
    id,
    affiliate: '고용24',
    company: { name: '서울테스트병원' },
    title: '외래 간호사 채용',
    createdAt: '2026-09-01T10:00:00',
    endDate: '2026-09-20T23:59:59',
    deadlineType: '날짜마감',
    careerMin: 0,
    careerMax: 0,
    regions: ['서울'],
    employeeTypes: ['정규직'],
    educations: ['대졸'],
    depthOnes: ['의료_보건'],
    depthTwos: ['간호사'],
    keywords: ['외래'],
    ...overrides,
  };
}

test('직행은 간호사 제목만 남기고 조무사 및 회사·제목 중복을 제거한다', async () => {
  const payload = {
    data: {
      content: [
        zighangItem('a'),
        zighangItem('b'),
        zighangItem('c', { title: '간호조무사 채용' }),
        zighangItem('d', { title: '병원 원무 담당자 채용' }),
      ],
    },
  };
  const jobs = parseZighangJobs(payload);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'zighang-a');
  assert.equal(jobs[0].deadline, '2026-09-20');
  assert.equal(jobs[0].experience, '경력무관');
  assert.equal(jobs[0].postedAt, '2026-09-01T10:00:00+09:00');
  assert.equal(normalizeJob(jobs[0], { seenAt: '2026-09-15T00:00:00.000Z' }).publishedAt, '2026-09-01');
  assert.equal(parseZighangJobs({ data: { content: [zighangItem('z', { createdAt: '2026-09-01T01:00:00Z' })] } })[0].postedAt, '2026-09-01T01:00:00Z');
  const openEnded = parseZighangJobs({ data: { content: [zighangItem('e', { careerMin: 2, careerMax: 100 })] } });
  assert.equal(openEnded[0].experience, '경력 2년 이상');
});

test('직행 수집기는 보고된 모든 페이지를 요청하고 페이지 간 중복도 합친다', async () => {
  const pages = [];
  const jobs = await collectZighangJobs({
    maxPages: 10,
    fetcher: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      return {
        data: {
          totalPages: 3,
          content: page === 0
            ? [zighangItem('a')]
            : page === 1
              ? [zighangItem('b'), zighangItem('c', { company: { name: '경기병원' }, title: '검진센터 간호사 채용', regions: ['경기'] })]
              : [zighangItem('d', { company: { name: '서울대체병원' }, title: '산업간호사 채용' })],
        },
      };
    },
  });
  assert.deepEqual(pages.sort((a, b) => a - b), [0, 1, 2]);
  assert.deepEqual(jobs.map((job) => job.id).sort(), ['zighang-a', 'zighang-c', 'zighang-d']);
});

test('직행 상세 API는 요약 문서의 담당업무·자격요건·전형절차를 구조화한다', async (t) => {
  const { jobDetailService } = await import('../server.mjs');
  const refresh = jobDetailService.refresh;
  t.mock.method(jobDetailService, 'refresh', (job) => refresh(job, { persistResult: false }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const originalUrl = 'https://www.jobkorea.co.kr/Recruit/GI_Read/49826013';
  const heading = (text) => ({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text }] });
  const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const bulletList = (...items) => ({
    type: 'bulletList',
    content: items.map((text) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })),
  });
  globalThis.fetch = async (input, options) => {
    if (String(input) === `https://api.zighang.com/api/recruitments/${id}`) {
      return new Response(JSON.stringify({
        data: {
          ...zighangItem(id),
          status: 'ACTIVE',
          redirectUrl: originalUrl,
          summary: {
            type: 'doc',
            content: [
              heading('담당업무'), bulletList('외래 환자 간호', '진료 지원'),
              heading('자격요건'), bulletList('간호사 면허 소지자'),
              heading('전형절차'), bulletList('서류전형', '면접전형'),
              heading('마감일'), paragraph('2026년 9월 20일 23:59까지'),
            ],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, options);
  };

  const response = await originalFetch(`http://127.0.0.1:${server.address().port}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      refresh: true,
      url: `https://zighang.com/recruitment/${id}`,
      job: { title: '외래 간호사 채용', source: '직행' },
    }),
  });
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.match(detail.duties, /외래 환자 간호/);
  assert.match(detail.qualifications, /간호사 면허/);
  assert.match(detail.recruitmentProcess, /면접전형/);
  assert.equal(detail.employment, '정규직');
  assert.equal(detail.location, '서울');
  assert.equal(detail.officialSourceUrl, originalUrl);
  assert.doesNotMatch(detail.description, /공고 원문|jobkorea\.co\.kr/u);
  assert.doesNotMatch(detail.deadlineText, /공고 원문|jobkorea\.co\.kr/u);
  assert.equal(detail.sections.find((section) => section.semanticKey === 'deadlineText')?.value, '2026년 9월 20일 23:59까지');
  assert.equal(detail.detailOrigin, 'original');
});

function nmcRow(id, title, status = '공고') {
  return `<tr>
    <td class="post_title"><button onclick="goToPostDetail(this, '/nmc/board/B0000007/${id}')">${title}</button></td>
    <td>채용관리자</td><td>2026-09-01 ~ 2026-09-16</td><td>계약직</td>
    <td class="post_status">${status}</td>
  </tr>`;
}

test('국립중앙의료원은 접수 중인 간호 공고만 읽는다', async () => {
  const html = `<table>${nmcRow(11, '계약직 간호사 채용')}${nmcRow(12, '간호조무사 채용')}${nmcRow(13, '간호직 채용', '마감')}</table>`;
  const jobs = parseNmcJobs(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'nmc-11');
  assert.equal(jobs[0].deadline, '2026-09-16');
  assert.equal(jobs[0].employment, '계약직');

  const collected = await collectNmcJobs({ fetcher: async () => html });
  assert.equal(collected.length, 1);
});

function bohunRow(id, title, date) {
  return `<tr><td class="bbs_list_tit"><a class="nttInfoBtn" data-id="${id}">${title}</a></td><td>${date}</td></tr>`;
}

test('보훈의료공단은 최근 원모집 간호 공고만 남기고 결과 공지는 제외한다', async () => {
  const html = `<table>
    ${bohunRow(21, '[한국보훈복지의료공단] [수원보훈요양원] 간호사 공개채용 공고', '2026.08.24')}
    ${bohunRow(22, '[수원보훈요양원] 간호사 최종 합격자 발표', '2026.08.25')}
    ${bohunRow(23, '[중앙보훈병원] 간호조무사 채용 공고', '2026.08.26')}
    ${bohunRow(24, '[중앙보훈병원] 간호직 공개채용 공고', '2026.06.01')}
  </table>`;
  const parsed = parseBohunJobs(html);
  assert.deepEqual(parsed.map((job) => job.id), ['bohun-21', 'bohun-24']);
  assert.equal(parsed[0].company, '수원보훈요양원');
  assert.equal(parsed[0].region, '경기');

  const collected = await collectBohunJobs({
    searches: [{ rcrut: 'medical', mi: '37030', keyword: '간호사' }],
    fetcher: async () => html,
    now: new Date('2026-09-01T00:00:00.000Z'),
    maxAgeDays: 45,
  });
  assert.deepEqual(collected.map((job) => job.id), ['bohun-21']);
});
