import { test, expect } from '@playwright/test';

const observedAt = new Date().toISOString();
const jobs = Array.from({ length: 24 }, (_, index) => ({
  id: `scroll-regression-${index + 1}`,
  dedupeKey: `scroll-regression:${index + 1}`,
  company: `스크롤 진단 병원 ${index + 1}`,
  title: `서울 간호사 채용 ${String(index + 1).padStart(2, '0')}`,
  region: '서울',
  regionCode: '11',
  deadline: '2099-12-31',
  deadlineAt: '2099-12-31',
  roleTags: ['간호사'],
  source: '널스잡',
  url: `https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=${3000 + index}`,
  publishedAt: new Date(Date.now() - index * 86_400_000).toISOString(),
  firstSeenAt: observedAt,
  lastSeenAt: observedAt,
}));

async function seedProfile(page) {
  await page.addInitScript((timestamp) => {
    localStorage.setItem('nurse-user-state', JSON.stringify({
      version: 2,
      profile: {
        onboardingCompletedAt: timestamp,
        roleTags: ['clinical'],
        regionCodes: ['11'],
        employmentTypes: ['정규직'],
        experienceLevels: [],
        workPatterns: ['daytime'],
        preferredKeywords: [],
        excludedKeywords: ['3교대'],
      },
      savedSnapshots: {}, applications: {}, notifications: [], recentFilters: {},
      meta: { createdAt: timestamp, updatedAt: timestamp, lastVisitedAt: timestamp },
    }));
  }, observedAt);
}

async function mockJobs(page, jobList = jobs) {
  await page.route('**/api/jobs?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      jobs: jobList,
      needsReviewJobs: [],
      lastSuccessAt: observedAt,
      lastAttemptAt: observedAt,
      refresh: { inProgress: false },
    }),
  }));
}

test('상세 정보로 목록 순서가 바뀌어도 닫으면 보고 있던 카드로 돌아온다', async ({ page, isMobile }) => {
  await seedProfile(page);
  await mockJobs(page);
  let detailCompleted = false;
  await page.route('**/api/job-detail', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    detailCompleted = true;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        detailVerified: true,
        detailBodyAvailable: true,
        employment: '정규직',
        experience: '경력무관',
        workHours: '3교대 근무',
        duties: '병동 환자 간호와 입퇴원 관리',
        qualifications: '간호사 면허 소지자',
        education: '전문대졸 이상',
        salary: '연봉 3,800만원 이상',
      }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('discovery-all').click();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(jobs.length);
  await page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').nth(12).evaluate((card) => card.scrollIntoView({ block: 'center' }));
  const before = await page.evaluate(() => {
    const card = [...document.querySelectorAll('[data-testid="all-jobs-list"] [data-testid="job-card"][data-job-key]')]
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > document.querySelector('.focus-header').getBoundingClientRect().bottom && rect.top < window.innerHeight;
      });
    return {
      jobKey: card?.dataset.jobKey,
      viewportTop: card?.getBoundingClientRect().top,
      scrollY: window.scrollY,
    };
  });
  expect(before.jobKey).toBeTruthy();
  expect(before.scrollY).toBeGreaterThan(0);

  const anchorCard = page.getByTestId('all-jobs-list').locator(`[data-testid="job-card"][data-job-key=${JSON.stringify(before.jobKey)}]`);
  const beforeIndex = await anchorCard.evaluate((card) => [...document.querySelectorAll('[data-testid="all-jobs-list"] [data-testid="job-card"]')].indexOf(card));
  // Tap the exposed part of a partially visible card. Locator.click() can scroll
  // its center out from under the fixed header and change the anchor before opening.
  const tap = await anchorCard.getByTestId('open-job-detail').evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const headerBottom = document.querySelector('.focus-header').getBoundingClientRect().bottom;
    const nav = document.querySelector('.primary-nav');
    const viewportBottom = getComputedStyle(nav).position === 'fixed'
      ? nav.getBoundingClientRect().top : window.innerHeight;
    const top = Math.max(rect.top, headerBottom);
    const bottom = Math.min(rect.bottom, viewportBottom);
    return { x: rect.left + rect.width / 2, y: (top + bottom) / 2, visibleHeight: bottom - top };
  });
  expect(tap.visibleHeight).toBeGreaterThan(0);
  if (isMobile) await page.touchscreen.tap(tap.x, tap.y);
  else await page.mouse.click(tap.x, tap.y);
  await expect(page.getByTestId('job-detail')).toBeVisible();
  await expect.poll(() => detailCompleted).toBe(true);
  await expect(page.getByTestId('detail-facts')).toContainText('3교대');
  const reorderedIndex = await anchorCard.evaluate((card) => [...document.querySelectorAll('[data-testid="all-jobs-list"] [data-testid="job-card"]')].indexOf(card));
  expect(reorderedIndex).not.toBe(beforeIndex);

  await page.getByRole('button', { name: '상세 닫기' }).click();
  await expect(page.getByTestId('job-detail')).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/u);
  const after = await page.evaluate((jobKey) => {
    const card = [...document.querySelectorAll('[data-testid="all-jobs-list"] [data-testid="job-card"][data-job-key]')]
      .find((candidate) => candidate.dataset.jobKey === jobKey);
    const rect = card?.getBoundingClientRect();
    return {
      viewportTop: rect?.top,
      viewportBottom: rect?.bottom,
      scrollY: window.scrollY,
      maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
      innerHeight: window.innerHeight,
      scrollRestoration: window.history.scrollRestoration,
    };
  }, before.jobKey);

  const exactRestore = Math.abs(after.viewportTop - before.viewportTop) <= 1;
  const clampedAtTop = after.scrollY <= 1 && after.viewportTop < before.viewportTop;
  const clampedAtBottom = Math.abs(after.maxScrollY - after.scrollY) <= 1 && after.viewportTop > before.viewportTop;
  expect(exactRestore || clampedAtTop || clampedAtBottom).toBe(true);
  expect(after.viewportBottom).toBeGreaterThan(0);
  expect(after.viewportTop).toBeLessThan(after.innerHeight);
  expect(after.scrollRestoration).toBe('manual');
});

test('화면 위에 걸친 카드도 상세 닫기 뒤 같은 픽셀 위치로 복원한다', async ({ page }) => {
  const stableJobs = jobs.map((job) => ({
    ...job,
    employmentType: '정규직',
    experienceLevel: '경력무관',
    department: '외래',
    workPattern: '상근·주간',
  }));
  await seedProfile(page);
  await mockJobs(page, stableJobs);
  await page.route('**/api/job-detail', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        detailVerified: true,
        detailBodyAvailable: true,
        employment: '정규직',
        experience: '경력무관',
        workHours: '주 5일 09:00~18:00',
        duties: '외래 환자 상담과 건강검진 안내',
        qualifications: '간호사 면허 소지자',
      }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(stableJobs.length);
  await page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').nth(12).evaluate((card) => {
    window.scrollTo({ top: window.scrollY + card.getBoundingClientRect().top + 72, behavior: 'instant' });
  });
  const before = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="all-jobs-list"] [data-testid="job-card"][data-job-key]')];
    const index = cards.findIndex((card) => {
      const rect = card.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > document.querySelector('.focus-header').getBoundingClientRect().bottom && rect.top < window.innerHeight;
    });
    const card = cards[index];
    return { index, jobKey: card?.dataset.jobKey, viewportTop: card?.getBoundingClientRect().top };
  });
  expect(before.viewportTop).toBeLessThan(0);

  await page.evaluate((jobKey) => {
    const card = [...document.querySelectorAll('[data-testid="all-jobs-list"] [data-testid="job-card"][data-job-key]')]
      .find((candidate) => candidate.dataset.jobKey === jobKey);
    card?.querySelector('[data-testid="open-job-detail"]')?.click();
  }, before.jobKey);
  await expect(page.getByTestId('detail-facts')).toContainText('상근·주간');
  await page.getByRole('button', { name: '상세 닫기' }).click();
  await expect(page.getByTestId('job-detail')).toHaveCount(0);
  await expect.poll(() => page.evaluate(({ jobKey, viewportTop }) => {
    const card = [...document.querySelectorAll('[data-testid="all-jobs-list"] [data-testid="job-card"][data-job-key]')]
      .find((candidate) => candidate.dataset.jobKey === jobKey);
    return Math.abs((card?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY) - viewportTop);
  }, before)).toBeLessThanOrEqual(1);
});

test('연속 스크롤 중 역방향 보정이나 부드러운 전역 애니메이션이 끼어들지 않는다', async ({ page }) => {
  await seedProfile(page);
  await mockJobs(page);
  await page.addInitScript(() => {
    window.__forcedScrolls = [];
    const nativeScrollBy = window.scrollBy.bind(window);
    window.scrollBy = (...args) => {
      window.__forcedScrolls.push({ before: window.scrollY, args });
      return nativeScrollBy(...args);
    };
  });
  await page.route('**/api/job-detail', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ detailVerified: true }) });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(jobs.length);
  let previousScrollY = await page.evaluate(() => window.scrollY);
  let reverseMoves = 0;
  for (let index = 0; index < 100; index += 1) {
    await page.mouse.wheel(0, 70);
    await page.waitForTimeout(24);
    const currentScrollY = await page.evaluate(() => window.scrollY);
    if (currentScrollY < previousScrollY - 2) reverseMoves += 1;
    previousScrollY = currentScrollY;
  }
  const state = await page.evaluate(() => ({
    scrollY: window.scrollY,
    forcedScrolls: window.__forcedScrolls,
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
  }));
  expect(state.scrollY).toBeGreaterThan(500);
  expect(state.forcedScrolls).toEqual([]);
  expect(state.scrollBehavior).toBe('auto');
  expect(reverseMoves).toBe(0);
});
