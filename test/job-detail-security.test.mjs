import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { app, jobDetailService, fetchOfficialAttachment, parseOfficialRecruiterAssets } from '../server.mjs';

test.beforeEach((t) => {
  const refresh = jobDetailService.refresh;
  t.mock.method(jobDetailService, 'refresh', (job) => refresh(job, { persistResult: false }));
});

async function listen(t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function requestDetail(origin, url) {
  return fetch(`${origin}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true, url }),
  });
}

const officialSource = new URL('https://snubh.recruiter.co.kr/app/jobnotice/view?jobnoticeSn=123');
const officialAttachment = new URL('/mrs2/attachFile/downloadFile?fileUid=role.zip', officialSource);

test('Saramin image proxy requires an official recruitment image and sends the posting referrer', async (t) => {
  const fetchLocal = globalThis.fetch;
  const origin = await listen(t);
  let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    upstreamCalls += 1;
    assert.equal(String(url), 'https://pds.saramin.co.kr/recruit/recruit/202609/posting.jpg');
    assert.equal(options.headers.referer, 'https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=55102113');
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
  });
  const bad = await fetchLocal(`${origin}/api/saramin-image?rec_idx=55102113&url=${encodeURIComponent('https://evil.example/recruit/recruit/posting.jpg')}`);
  assert.equal(bad.status, 400);
  assert.equal(upstreamCalls, 0);
  const imageUrl = 'https://pds.saramin.co.kr/recruit/recruit/202609/posting.jpg';
  const response = await fetchLocal(`${origin}/api/saramin-image?rec_idx=55102113&url=${encodeURIComponent(imageUrl)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0xff, 0xd8, 0xff]);
  assert.equal(upstreamCalls, 1);
});

test('official attachment source and every redirect require a registered hospital and exact download path', async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches += 1; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); });
  for (const url of [
    'http://snubh.recruiter.co.kr/mrs2/attachFile/downloadFile?fileUid=x',
    'https://snubh.recruiter.co.kr.evil.example/mrs2/attachFile/downloadFile',
    'https://ncc.recruiter.co.kr/mrs2/attachFile/downloadFile',
    'https://user:secret@snubh.recruiter.co.kr/mrs2/attachFile/downloadFile',
    'https://snubh.recruiter.co.kr:8443/mrs2/attachFile/downloadFile',
    'https://snubh.recruiter.co.kr/mrs2/attachFile/../../admin',
    'https://snubh.recruiter.co.kr/mrs2/attachFile/deleteFile',
  ]) await assert.rejects(fetchOfficialAttachment(new URL(url), officialSource), /Unsafe/);
  assert.equal(fetches, 0);
  const hostileSource = new URL('https://127.0.0.1/app/jobnotice/view?jobnoticeSn=1');
  await assert.rejects(fetchOfficialAttachment(new URL('/mrs2/attachFile/downloadFile', hostileSource), hostileSource), /Unsafe/);
  assert.deepEqual(parseOfficialRecruiterAssets('<a href="/mrs2/attachFile/downloadFile?fileUid=x.hwp">x.hwp</a>', hostileSource.href).attachments, []);
  assert.equal(fetches, 0);
  await assert.rejects(fetchOfficialAttachment(officialAttachment, officialSource), /Unsafe.*redirect/);
  assert.equal(fetches, 1);
});

test('official attachment rejects overlong redirect loops', async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    fetches += 1; assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: officialAttachment.href } });
  });
  await assert.rejects(fetchOfficialAttachment(officialAttachment, officialSource), /Too many/);
  assert.equal(fetches, 6);
});

test('official attachment size checks cancel declared and streamed oversized responses', async (t) => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(32)); },
      cancel() { cancelled = true; },
    });
    t.mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: declared ? { 'content-length': '32' } : {} }));
    await assert.rejects(fetchOfficialAttachment(officialAttachment, officialSource, { maxBytes: 16 }), /too large/);
    assert.equal(cancelled, true);
    t.mock.restoreAll();
  }
});

test('job detail rejects credentials and non-default ports before fetching', async (t) => {
  const origin = await listen(t);
  for (const url of [
    'https://www.nursejob.co.kr:8443/recruit/view',
    'https://user:password@www.nursejob.co.kr/recruit/view',
  ]) {
    const response = await requestDetail(origin, url);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, '등록되지 않은 채용처 주소입니다.');
  }
});

test('job detail never follows a redirect outside the protocol and host allowlist', async (t) => {
  const origin = await listen(t);
  const originalFetch = globalThis.fetch;
  let externalFetches = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    externalFetches += 1;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };

  const response = await originalFetch(`${origin}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true, url: 'https://www.nursejob.co.kr/recruit/view' }),
  });
  assert.equal(response.status, 502);
  assert.equal(externalFetches, 1);
});

test('job detail follows allowlisted redirects manually and stops after five redirects', async (t) => {
  const origin = await listen(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let allowedFetches = 0;
  globalThis.fetch = async (input) => {
    allowedFetches += 1;
    if (String(input).endsWith('/Recruit/GI_Read/1')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://www.jobkorea.co.kr/Recruit/GI_Read/2' },
      });
    }
    return new Response('<meta name="description" content="산업보건 관리와 건강상담을 담당하는 보건관리자 채용 공고입니다.">', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  const followed = await originalFetch(`${origin}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true, url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/1' }),
  });
  assert.equal(followed.status, 200);
  assert.match((await followed.json()).description, /산업보건/);
  assert.equal(allowedFetches, 2);

  let loopFetches = 0;
  globalThis.fetch = async () => {
    loopFetches += 1;
    return new Response(null, { status: 302, headers: { location: '/redirect-loop' } });
  };
  const stopped = await originalFetch(`${origin}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true, url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/3' }),
  });
  assert.equal(stopped.status, 502);
  assert.equal(loopFetches, 6);
});
