import { test, expect } from '@playwright/test';

const checkedAt = '2026-09-01T06:00:00.000Z';
const job = {
  id: 'company-reputation-fixture',
  dedupeKey: '유플러스홈서비스:보건관리자',
  company: '(주)유플러스홈서비스',
  title: '본사 건강관리실 보건관리자 채용',
  region: '서울',
  employmentType: '정규직',
  experienceLevel: '경력',
  department: '건강관리실',
  workPattern: '상근·주간',
  deadline: '~ 09/30',
  deadlineAt: '2026-09-30',
  roleTags: ['보건관리자', '간호사'],
  source: '사람인',
  url: 'https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=54767177',
  firstSeenAt: checkedAt,
  lastSeenAt: checkedAt,
};

async function installRoutes(page) {
  await page.route('**/api/jobs?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ jobs: [job], needsReviewJobs: [], sourceStatus: [], lastSuccessAt: checkedAt, lastAttemptAt: checkedAt }),
  }));
  await page.route('**/api/job-detail', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      detailVerified: true,
      duties: '임직원 건강상담과 유소견자 사후관리',
      qualifications: '간호사 면허 소지자',
      workHours: '주 5일 09:00~18:00',
    }),
  }));
}

async function openDetail(page) {
  await page.goto('/');
  await page.getByTestId('job-card').getByTestId('open-job-detail').click();
  await expect(page.getByTestId('job-detail')).toBeVisible();
  return page.getByTestId('company-reputation');
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(checkedAt));
  await installRoutes(page);
});

test('공고에 들어오면 집계값을 자동으로 표시하고 7일 캐시를 재사용한다', async ({ page }, testInfo) => {
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
  await page.addInitScript(({ ack, request, response, timestamp }) => {
    window.__companyReputationRequestCount = 0;
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.type !== request) return;
      window.__companyReputationRequestCount += 1;
      window.postMessage({ type: ack, requestId: event.data.requestId }, window.location.origin);
      window.postMessage({
        type: response,
        requestId: event.data.requestId,
        result: {
          ok: true,
          company: event.data.company,
          sources: [
            { id: 'jobplanet', companyName: '(주)유플러스홈서비스', rating: 2, reviewCount: 31, url: 'https://www.jobplanet.co.kr/companies/388635/landing', checkedAt: timestamp, reviewText: '저장 금지' },
            { id: 'blind', companyName: '유플러스홈서비스', rating: 2.5, reviewCount: 32, url: 'https://www.teamblind.com/kr/company/%EC%9C%A0%ED%94%8C%EB%9F%AC%EC%8A%A4%ED%99%88%EC%84%9C%EB%B9%84%EC%8A%A4/reviews', checkedAt: timestamp, reviewText: '저장 금지' },
          ],
          candidates: [],
        },
      }, window.location.origin);
    });
  }, {
    ack: 'NURSE_BOARD_COMPANY_REPUTATION_ACK',
    request: 'NURSE_BOARD_COMPANY_REPUTATION_REQUEST',
    response: 'NURSE_BOARD_COMPANY_REPUTATION_RESPONSE',
    timestamp: checkedAt,
  });

  const card = await openDetail(page);
  await expect(card).toContainText('2.0');
  await expect(card).toContainText('리뷰 31개');
  await expect(card).toContainText('2.5');
  await expect(card).toContainText('리뷰 32개');
  await expect(card).toContainText('평점 확인 기준');
  await expect(card).not.toContainText('7일 캐시');
  await expect(card).not.toContainText('이 브라우저에만 저장');

  const stored = await page.evaluate(() => localStorage.getItem('nurse-company-reputation-v1'));
  expect(stored).toContain('"rating":2.5');
  expect(stored).not.toContain('저장 금지');
  expect(await page.evaluate(() => window.__companyReputationRequestCount)).toBe(1);

  await page.getByTestId('job-detail').getByRole('button', { name: '상세 닫기' }).click();
  await page.getByTestId('job-card').getByTestId('open-job-detail').click();
  const reopenedCard = page.getByTestId('company-reputation');
  await expect(reopenedCard).toContainText('2.5');
  expect(await page.evaluate(() => window.__companyReputationRequestCount)).toBe(1);
  await card.screenshot({ path: `artifacts/company-reputation-${testInfo.project.name}.png` });
  expect(runtimeErrors).toEqual([]);
});

test('회사명이 다르면 사용자가 확인하기 전에는 평가를 저장하지 않는다', async ({ page }) => {
  await page.addInitScript(({ ack, request, response, timestamp }) => {
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.type !== request) return;
      window.postMessage({ type: ack, requestId: event.data.requestId }, window.location.origin);
      window.postMessage({
        type: response,
        requestId: event.data.requestId,
        result: {
          ok: false,
          company: event.data.company,
          sources: [{ id: 'jobplanet', companyName: '유플러스홈서비스', url: 'https://www.jobplanet.co.kr/search?query=%EC%9C%A0%ED%94%8C%EB%9F%AC%EC%8A%A4%ED%99%88%EC%84%9C%EB%B9%84%EC%8A%A4', status: 'unavailable', message: '직접 확인이 필요합니다.' }],
          candidates: [{ id: 'blind', companyName: '유플러스 홈', rating: 3.1, reviewCount: 8, url: 'https://www.teamblind.com/kr/company/%EC%9C%A0%ED%94%8C%EB%9F%AC%EC%8A%A4%20%ED%99%88/reviews', checkedAt: timestamp }],
        },
      }, window.location.origin);
    });
  }, {
    ack: 'NURSE_BOARD_COMPANY_REPUTATION_ACK',
    request: 'NURSE_BOARD_COMPANY_REPUTATION_REQUEST',
    response: 'NURSE_BOARD_COMPANY_REPUTATION_RESPONSE',
    timestamp: checkedAt,
  });

  const card = await openDetail(page);
  await expect(card).toContainText('같은 회사가 맞는지 확인해 주세요');
  await expect(card).toContainText('유플러스 홈');
  expect(await page.evaluate(() => localStorage.getItem('nurse-company-reputation-v1'))).toBeNull();

  await card.getByRole('button', { name: '이 회사가 맞아요' }).click();
  await expect(card).toContainText('3.1');
  expect(await page.evaluate(() => localStorage.getItem('nurse-company-reputation-v1'))).toContain('"rating":3.1');
});

test('확장 프로그램이 없는 일반·모바일 브라우저도 서버 집계값을 표시한다', async ({ page }) => {
  let requestCount = 0;
  await page.route('**/api/company-reputation', async (route) => {
    requestCount += 1;
    const body = route.request().postDataJSON();
    expect(body.company).toBe('(주)유플러스홈서비스');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        company: body.company,
        sources: [{
          id: 'jobplanet',
          name: '잡플래닛',
          companyName: '유플러스홈서비스',
          rating: 2,
          reviewCount: 31,
          url: 'https://www.jobplanet.co.kr/companies/388635/reviews/%EC%9C%A0%ED%94%8C%EB%9F%AC%EC%8A%A4%ED%99%88%EC%84%9C%EB%B9%84%EC%8A%A4',
          checkedAt,
          reviewText: '브라우저에 전달돼도 제거되어야 하는 리뷰 본문',
        }],
        candidates: [],
      }),
    });
  });

  const card = await openDetail(page);
  await expect(card).toContainText('2.0');
  await expect(card).toContainText('리뷰 31개');
  await expect(card).not.toContainText('현재 브라우저에서는');
  await expect.poll(() => requestCount).toBe(1);
  const stored = await page.evaluate(() => localStorage.getItem('nurse-company-reputation-v1'));
  expect(stored).toContain('"rating":2');
  expect(stored).not.toContain('리뷰 본문');
});
