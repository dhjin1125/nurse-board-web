import { test, expect } from '@playwright/test';

const now = new Date().toISOString();
const deadlineAt = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const LONG_KOREAN_TITLE = '서울경기권역 기업건강관리실 상근직 외래검진센터 산업보건 간호사 채용 공고 제목이 아주 길어지는 경우';
const LONG_KOREAN_COMPANY = '대한민국직장인건강증진산업보건통합의료지원센터 부설 건강관리실';
const LONG_TOKEN_TITLE = `RN${'OutpatientDaytimeNurse'.repeat(7)}`;
const LONG_TOKEN_COMPANY = `Company${'WithoutAnyBreakOpportunity'.repeat(7)}`;

function jobFixture(index, overrides = {}) {
  return {
    id: `mobile-stability-${index}`,
    dedupeKey: `mobile-stability:${index}`,
    sourceIds: [`mobile-stability-${index}`],
    company: `모바일 안정성 병원 ${index}`,
    title: `상근 외래 간호사 채용 ${index}`,
    region: '서울',
    employmentType: '정규직',
    experienceLevel: '신입·무관',
    department: '외래',
    workPattern: '상근·주간',
    facilityType: '병원·의료원',
    deadline: `~ ${deadlineAt}`,
    deadlineAt,
    roleTags: ['임상간호사'],
    source: '모바일테스트',
    url: `https://example.com/mobile-stability-${index}`,
    firstSeenAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

function jobsFixture(primaryId = 'long-primary-a') {
  return [
    jobFixture(0, {
      id: primaryId,
      dedupeKey: 'stable:long-korean-card',
      sourceIds: ['long-primary-a', 'long-primary-b'],
      title: LONG_KOREAN_TITLE,
      company: LONG_KOREAN_COMPANY,
      url: 'https://example.com/stable-long-korean-card',
    }),
    jobFixture(1, {
      title: LONG_TOKEN_TITLE,
      company: LONG_TOKEN_COMPANY,
    }),
    ...Array.from({ length: 24 }, (_, index) => jobFixture(index + 2)),
  ];
}

function snapshot(jobs, overrides = {}) {
  return {
    jobs,
    needsReviewJobs: [],
    sourceStatus: [],
    lastSuccessAt: now,
    lastAttemptAt: now,
    dataTrust: { state: 'fresh' },
    collection: { refreshIntervalMs: 1_800_000, automaticSourceCount: 1 },
    refresh: { inProgress: false },
    ...overrides,
  };
}

async function seedUserState(page) {
  await page.addInitScript((timestamp) => {
    localStorage.setItem('nurse-user-state', JSON.stringify({
      version: 2,
      profile: {
        onboardingCompletedAt: timestamp,
        roleTags: [],
        regionCodes: [],
        employmentTypes: [],
        experienceLevels: [],
        workPatterns: [],
        preferredKeywords: [],
        excludedKeywords: [],
      },
      savedSnapshots: {},
      applications: {},
      notifications: [],
      recentFilters: {},
      meta: {
        createdAt: timestamp,
        updatedAt: timestamp,
        lastVisitedAt: timestamp,
        importedAt: null,
        migratedFromV1At: null,
        pendingLegacySavedIds: [],
      },
    }));
  }, now);
}

async function installRoutes(page, { jobs = jobsFixture(), refreshedJobs = jobsFixture('long-primary-b'), gateEnrichment = false } = {}) {
  const pendingEnrichments = [];
  let currentJobs = jobs;
  await page.route('**/api/jobs?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(snapshot(currentJobs)),
  }));
  await page.route('**/api/job-detail', (route) => {
    const payload = route.request().postDataJSON();
    if (gateEnrichment && payload?.purpose === 'intent-prefetch') {
      pendingEnrichments.push({ route, job: payload.job });
      return;
    }
    return route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: '상세 테스트 응답' }),
    });
  });
  await page.route('**/api/refresh', (route) => {
    currentJobs = refreshedJobs;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ accepted: true, snapshot: snapshot(refreshedJobs) }),
    });
  });
  return { pendingEnrichments };
}

async function scrollY(page) {
  return page.evaluate(() => window.scrollY);
}

async function scrollImmediately(page, top) {
  await page.evaluate((nextTop) => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo({ top: nextTop, left: 0, behavior: 'auto' });
    root.style.scrollBehavior = previous;
  }, top);
}

async function startScrollProbe(page) {
  await page.evaluate(() => {
    window.clearInterval(window.__mobileScrollProbeTimer);
    window.__mobileScrollSamples = [window.scrollY];
    window.__mobileScrollProbeTimer = window.setInterval(() => window.__mobileScrollSamples.push(window.scrollY), 16);
  });
}

async function stopScrollProbe(page) {
  return page.evaluate(() => {
    window.clearInterval(window.__mobileScrollProbeTimer);
    return [...(window.__mobileScrollSamples || []), window.scrollY];
  });
}

async function expectCurrentPositionPreserved(page, currentY, action, { tolerance = 4, allowDownstreamReflow = false } = {}) {
  await startScrollProbe(page);
  await action();
  await page.waitForTimeout(120);
  const samples = await stopScrollProbe(page);
  if (allowDownstreamReflow) {
    expect(Math.min(...samples)).toBeGreaterThan(currentY - 40);
  } else {
    expect(Math.max(...samples.map((value) => Math.abs(value - currentY)))).toBeLessThanOrEqual(tolerance);
  }
}

async function textMetrics(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const cardRect = element.closest('.job-card')?.getBoundingClientRect();
    const lineHeight = Number.parseFloat(style.lineHeight);
    return {
      overflow: style.overflow,
      overflowWrap: style.overflowWrap,
      webkitLineClamp: style.webkitLineClamp,
      height: rect.height,
      lineHeight,
      left: rect.left,
      right: rect.right,
      cardLeft: cardRect?.left,
      cardRight: cardRect?.right,
    };
  });
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', '모바일 목록 안정성 전용');
  await seedUserState(page);
});

test('popstate만 이전 위치를 복원하고 이후 목록 상태 갱신은 현재 스크롤과 카드 identity를 유지한다', async ({ page }) => {
  const initialJobs = jobsFixture();
  const refreshedJobs = jobsFixture('long-primary-b');
  const { pendingEnrichments } = await installRoutes(page, { jobs: initialJobs, refreshedJobs, gateEnrichment: true });
  await page.goto('/');
  // New/unseen intentionally removes viewed jobs on explicit refresh. This
  // regression tests identity and scroll for the unchanged full recommendation.
  await page.getByTestId('discovery-all').click();
  // A mouse-based test click leaves hover at the tab's former position;
  // moving it away prevents accidental intent-prefetch while scrolling.
  await page.mouse.move(0, 0);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(24);
  await page.getByTestId('all-jobs-list').getByTestId('job-list-pager').scrollIntoViewIfNeeded();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(initialJobs.length);
  await page.waitForTimeout(900);
  expect(pendingEnrichments).toHaveLength(0);

  const returnCard = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').nth(7);
  await returnCard.scrollIntoViewIfNeeded();
  const storedY = await scrollY(page);
  expect(storedY).toBeGreaterThan(500);
  await returnCard.getByTestId('open-job-detail').click();
  await expect(page.getByTestId('job-detail')).toBeVisible();
  await expect.poll(() => pendingEnrichments.length).toBe(1);
  await pendingEnrichments[0].route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      detailVerified: true,
      detailOrigin: 'original',
      workHours: '주 5일 09:00~18:00',
      employment: '정규직',
      duties: '외래 환자 상담',
    }),
  });
  await expect(page.getByTestId('job-detail').getByTestId('detail-progress')).toBeHidden();
  await page.getByTestId('job-detail').getByRole('button', { name: '상세 닫기' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('job-detail')).toBeHidden();
  await expect.poll(async () => Math.abs((await scrollY(page)) - storedY)).toBeLessThanOrEqual(4);

  const maximumY = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  const currentY = Math.min(storedY + 700, maximumY - 100);
  expect(currentY - storedY).toBeGreaterThan(300);
  await scrollImmediately(page, currentY);
  await expect.poll(async () => Math.abs((await scrollY(page)) - currentY)).toBeLessThanOrEqual(4);

  const stableCard = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: LONG_KOREAN_TITLE });
  const stableCardHandle = await stableCard.elementHandle();
  expect(stableCardHandle).not.toBeNull();

  await expectCurrentPositionPreserved(page, currentY, async () => {
    await stableCard.locator('.save-button').evaluate((button) => button.click());
    await expect(stableCard.locator('.save-button')).toHaveAttribute('aria-pressed', 'true');
  });

  await scrollImmediately(page, currentY);
  await expectCurrentPositionPreserved(page, currentY, async () => {
    const refreshResponse = page.waitForResponse((response) => response.url().endsWith('/api/refresh'));
    await page.getByRole('button', { name: /새 공고 확인/ }).evaluate((button) => button.click());
    await refreshResponse;
    await expect(page.getByText('새 공고 수집을 완료했습니다.')).toBeVisible();
  });

  expect(await stableCardHandle.evaluate((element) => element.isConnected)).toBe(true);
  await expect(stableCard).toBeVisible();
});

for (const width of [390, 320]) {
  test(`${width}px에서 긴 한글·공백 없는 제목과 회사명이 카드와 상세 안에서 안전하게 줄바꿈된다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const jobs = jobsFixture().slice(0, 2);
    await installRoutes(page, { jobs, refreshedJobs: jobs });
    await page.goto('/');
    await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(2);

    for (const card of [
      page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: LONG_KOREAN_TITLE }),
      page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: LONG_TOKEN_TITLE }),
    ]) {
      const title = card.locator('.job-copy h3');
      const company = card.locator('.job-copy > p:not(.career-priority-reason)');
      for (const element of [title, company]) {
        const metrics = await textMetrics(element);
        expect(metrics.overflow).toBe('hidden');
        expect(metrics.overflowWrap).toBe('anywhere');
        expect(metrics.webkitLineClamp).toBe('2');
        expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 2 + 1);
        expect(metrics.left).toBeGreaterThanOrEqual(metrics.cardLeft - 1);
        expect(metrics.right).toBeLessThanOrEqual(metrics.cardRight + 1);
      }
    }

    const pageWidth = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);

    const koreanCard = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: LONG_KOREAN_TITLE });
    await koreanCard.locator('.save-button').click();
    await expect(koreanCard.locator('.save-button')).toHaveAttribute('aria-pressed', 'true');
    const skipLinkState = await page.locator('.skip-link').evaluate((link) => ({
      focused: document.activeElement === link,
      top: link.getBoundingClientRect().top,
    }));
    expect(skipLinkState.focused).toBe(false);
    expect(skipLinkState.top).toBeLessThan(-40);
    if (width === 320) await page.getByTestId('all-jobs-list').locator('.job-list').screenshot({ path: 'artifacts/mobile-long-text-320.png' });

    await koreanCard.getByTestId('open-job-detail').click();
    const detail = page.getByTestId('job-detail');
    await expect(detail).toBeVisible();
    const detailBounds = await detail.evaluate((sheet) => {
      const sheetRect = sheet.getBoundingClientRect();
      const titleRect = sheet.querySelector('.posting-header h2').getBoundingClientRect();
      const companyRect = sheet.querySelector('.posting-meta span').getBoundingClientRect();
      return {
        sheetLeft: sheetRect.left,
        sheetRight: sheetRect.right,
        titleLeft: titleRect.left,
        titleRight: titleRect.right,
        companyLeft: companyRect.left,
        companyRight: companyRect.right,
        titleWrap: getComputedStyle(sheet.querySelector('.posting-header h2')).overflowWrap,
        companyWrap: getComputedStyle(sheet.querySelector('.posting-meta span')).overflowWrap,
      };
    });
    expect(detailBounds.titleWrap).toBe('anywhere');
    expect(detailBounds.companyWrap).toBe('anywhere');
    expect(detailBounds.titleLeft).toBeGreaterThanOrEqual(detailBounds.sheetLeft - 1);
    expect(detailBounds.titleRight).toBeLessThanOrEqual(detailBounds.sheetRight + 1);
    expect(detailBounds.companyLeft).toBeGreaterThanOrEqual(detailBounds.sheetLeft - 1);
    expect(detailBounds.companyRight).toBeLessThanOrEqual(detailBounds.sheetRight + 1);
    if (width === 320) {
      await page.waitForTimeout(300);
      await detail.screenshot({ path: 'artifacts/mobile-long-detail-320.png' });
    }

    await detail.getByRole('button', { name: '상세 닫기' }).click();
    await expect(detail).toBeHidden();
  });
}
