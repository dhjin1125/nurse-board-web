import { test, expect } from '@playwright/test';

const observedAt = '2026-08-21T09:00:00.000Z';
const jobs = Array.from({ length: 18 }, (_, index) => ({
  id: `scroll-${index + 1}`,
  dedupeKey: `스크롤병원:${index + 1}`,
  company: `스크롤병원 ${index + 1}`,
  title: `서울 간호사 채용 ${String(index + 1).padStart(2, '0')}`,
  region: '서울',
  regionCode: '11',
  employmentType: '정규직',
  experienceLevel: '경력무관',
  department: '외래',
  workPattern: '상근·주간',
  deadline: '2099-12-31',
  deadlineAt: '2099-12-31',
  roleTags: ['간호사'],
  source: '널스잡',
  url: `https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=${index + 1}`,
  publishedAt: `2026-08-${String(20 - index).padStart(2, '0')}`,
  firstSeenAt: observedAt,
  lastSeenAt: observedAt,
}));

async function installJobs(page) {
  await page.clock.setFixedTime(new Date(observedAt));
  await page.route('**/api/jobs?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      jobs,
      needsReviewJobs: [],
      lastSuccessAt: observedAt,
      lastAttemptAt: observedAt,
      refresh: { inProgress: false },
    }),
  }));
}

const verifiedDetail = {
  detailVerified: true,
  detailBodyAvailable: true,
  detailOrigin: 'original',
  employment: '정규직',
  experience: '경력무관',
  workHours: '주 5일 09:00~18:00',
  duties: '외래 환자 상담과 건강검진 안내',
  qualifications: '간호사 면허 소지자',
};

test('목록을 보고만 있을 때는 상세를 일괄 조회하지 않고 관심 공고 하나만 미리 가져온다', async ({ page }) => {
  await installJobs(page);
  const requests = [];
  await page.route('**/api/job-detail', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(verifiedDetail) });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(jobs.length);
  await page.waitForTimeout(1_000);
  expect(requests).toEqual([]);

  const target = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').nth(9);
  await target.scrollIntoViewIfNeeded();
  const beforeY = await page.evaluate(() => window.scrollY);
  await target.getByTestId('open-job-detail').focus();

  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].purpose).toBe('intent-prefetch');
  expect(requests[0].job.id).toBe(jobs[9].id);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - beforeY)).toBeLessThanOrEqual(2);
  await expect(page.getByText('상세 정보 자동 확인')).toHaveCount(0);
});

test('포커스 선조회와 클릭이 같은 상세 요청을 공유하고 다시 열 때 세션 캐시를 쓴다', async ({ page }) => {
  await installJobs(page);
  const pending = [];
  let requestCount = 0;
  await page.route('**/api/job-detail', (route) => {
    requestCount += 1;
    pending.push(route);
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const card = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first();
  const openButton = card.getByTestId('open-job-detail');
  await openButton.focus();
  await expect.poll(() => pending.length).toBe(1);
  await openButton.click();

  const detail = page.getByTestId('job-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('detail-progress')).toBeVisible();
  expect(requestCount).toBe(1);

  await pending[0].fulfill({ contentType: 'application/json', body: JSON.stringify(verifiedDetail) });
  await expect(detail.getByTestId('detail-progress')).toBeHidden();
  await expect(detail.getByTestId('detail-sections')).toContainText('외래 환자 상담과 건강검진 안내');

  await detail.getByRole('button', { name: '상세 닫기' }).click();
  await expect(detail).toBeHidden();
  await page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first().getByTestId('open-job-detail').click();
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('detail-sections')).toContainText('외래 환자 상담과 건강검진 안내');
  expect(requestCount).toBe(1);
});
