import { test, expect } from '@playwright/test';

const now = new Date().toISOString();
const jobs = Array.from({ length: 8 }, (_, index) => ({
  id: `responsive-${index}`,
  dedupeKey: `responsive:${index}`,
  company: index === 0 ? '서울경기직장인건강증진산업보건의료지원센터' : `새봄병원 ${index}`,
  title: index === 0 ? '서울·경기 기업 건강관리실 상근직 산업보건 간호사 신입 채용' : `외래 검진센터 상근 간호사 모집 ${index}`,
  region: '서울',
  employmentType: '정규직',
  experienceLevel: '신입·무관',
  department: '외래',
  workPattern: '상근·주간',
  facilityType: '병원·의료원',
  deadline: '채용시',
  deadlineKind: 'until-filled',
  roleTags: ['간호사'],
  source: '채용정보',
  url: `https://example.com/responsive-${index}`,
  firstSeenAt: now,
  lastSeenAt: now,
}));

const snapshot = {
  jobs, needsReviewJobs: [], sourceStatus: [],
  lastSuccessAt: now, lastAttemptAt: now,
  dataTrust: { state: 'fresh' }, refresh: { inProgress: false },
};

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(!isMobile, '휴대폰 브라우저의 반응형 화면 검증');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/jobs?*', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/job-detail', (route) => route.fulfill({ json: {
    detailVerified: true,
    detailOrigin: 'original',
    employment: '정규직',
    workHours: '월요일~금요일 09:00~18:00',
    duties: '외래 환자 상담과 건강검진 업무를 담당합니다.',
    requirements: '간호사 면허 소지자. 신입 지원 가능.',
    welfare: '식사 제공, 교육비 지원, 연차 휴가',
  } }));
  await page.route('**/api/company-reputation', (route) => route.fulfill({ json: { ok: false, sources: [], candidates: [] } }));
  await page.route('**/api/refresh', (route) => route.fulfill({ json: { accepted: true, snapshot } }));
});

async function expectContained(page) {
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.width);
}

async function expectReachable(locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return rect.top >= 0 && rect.bottom <= window.innerHeight + 1 && element.contains(target);
  })).toBe(true);
}

for (const width of [320, 360, 375, 390, 412, 430]) {
  test(`${width}px에서 공고의 읽기 영역과 터치 메뉴를 확보한다`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const mainList = page.getByTestId('all-jobs-list');
    await expect(mainList.getByTestId('job-card')).toHaveCount(jobs.length);
    await expectContained(page);

    const card = mainList.getByTestId('job-card').first();
    const metrics = await card.evaluate((element) => {
      const title = element.querySelector('.job-copy h3');
      const company = element.querySelector('.job-copy > p');
      const button = element.querySelector('.save-button');
      return {
        cardWidth: element.clientWidth,
        titleWidth: title.clientWidth,
        titleFont: parseFloat(getComputedStyle(title).fontSize),
        titleBottom: title.getBoundingClientRect().bottom,
        cardHeight: element.getBoundingClientRect().height,
        companyFont: parseFloat(getComputedStyle(company).fontSize),
        touchWidth: button.clientWidth,
        touchHeight: button.clientHeight,
      };
    });
    expect(metrics.titleWidth).toBeGreaterThanOrEqual(metrics.cardWidth - (width < 360 ? 32 : 40));
    expect(metrics.titleFont).toBeGreaterThanOrEqual(17);
    expect(metrics.companyFont).toBeGreaterThanOrEqual(14);
    expect(metrics.touchWidth).toBeGreaterThanOrEqual(44);
    expect(metrics.touchHeight).toBeGreaterThanOrEqual(44);
    expect(await page.getByLabel('공고 검색어').evaluate((input) => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);
    await expect(page.getByRole('button', { name: /새 공고 확인/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '지역 선택' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '직무 선택' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: '주요 메뉴' });
    const bounds = await nav.boundingBox();
    expect(bounds.y + bounds.height).toBeCloseTo(844, 0);
    // The first actual job must be readable before scrolling past the controls.
    expect(metrics.titleBottom).toBeLessThan(bounds.y);
    expect(metrics.cardHeight).toBeLessThanOrEqual(360);
    for (const button of await nav.getByRole('button').all()) {
      await expectReachable(button);
      const rect = await button.boundingBox();
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }

    await card.locator('.save-button').click();
    await expect(card.locator('.save-button')).toHaveAttribute('aria-pressed', 'true');
    await nav.getByTestId('nav-saved').click();
    await expect(page.locator('.saved-panel').getByTestId('job-card')).toHaveCount(1);
    await expectContained(page);
    if ([360, 390].includes(width)) {
      await page.screenshot({ path: `artifacts/mobile-responsive-${testInfo.project.name}-${width}.png`, fullPage: true });
    }
  });
}

test('작은 화면에서 필터 입력과 적용 버튼을 사용할 수 있다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.getByRole('button', { name: /공고 필터 열기/ }).click();
  const sheet = page.getByRole('dialog', { name: '공고 필터' });
  await expectContained(page);
  const dimensions = await sheet.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  for (const select of await sheet.getByRole('combobox').all()) {
    expect(await select.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  }
  await sheet.getByRole('combobox', { name: '정렬', exact: true }).selectOption('최신 등록순');
  const apply = sheet.getByRole('button', { name: /공고 보기|조건 적용/ });
  await expectReachable(apply);
  await page.screenshot({ path: `artifacts/mobile-filter-small-${testInfo.project.name}.png` });
  await apply.click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('sort-latest')).toHaveAttribute('aria-pressed', 'true');
});

test('상세 읽기와 하단 작업 버튼, 뒤로가기가 화면 크기 변경 후에도 유지된다', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  await page.getByTestId('all-jobs-list').getByTestId('open-job-detail').first().click();
  const detail = page.getByTestId('job-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('detail-progress')).toBeHidden();
  await expect(detail.getByRole('form', { name: '내 지원 기록' })).toHaveCount(0);
  await expect(detail.getByTestId('detail-facts')).toBeVisible();
  await expect(detail.getByTestId('posting-deadline')).toBeVisible();

  for (const viewport of [{ width: 360, height: 800 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await expectContained(page);
    for (const action of [detail.getByRole('button', { name: '공고 저장', exact: true }), detail.getByTestId('detail-hide-job'), detail.getByTestId('apply-original')]) {
      await expectReachable(action);
    }
    await detail.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expectReachable(detail.getByRole('button', { name: '상세 닫기' }));
    const fits = await detail.evaluate((element) => {
      const content = element.querySelector('.posting-main').getBoundingClientRect();
      const actions = element.querySelector('.posting-side').getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth && content.bottom <= actions.top + 1;
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: `artifacts/mobile-detail-${testInfo.project.name}-${viewport.width}.png` });
  }
  await detail.getByRole('button', { name: '상세 닫기' }).click();
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  expect(errors).toEqual([]);
});

test('피드백과 동기화 입력창은 휴대폰에서 읽을 수 있는 크기를 유지한다', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  await page.getByTestId('feedback-menu').click();
  const feedback = page.getByTestId('feedback-panel');
  const input = feedback.getByRole('textbox', { name: '내용' });
  await expect(input).toBeVisible();
  expect(await input.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await input.fill('모바일에서 공고를 편하게 보고 싶어요.');
  const submit = feedback.getByRole('button', { name: '피드백 보내기' });
  await submit.scrollIntoViewIfNeeded();
  await expectReachable(submit);
  await expectContained(page);
  await feedback.getByRole('button', { name: '피드백 닫기' }).click();
  await page.getByTestId('sync-settings').click();
  const sync = page.getByTestId('saved-sync-panel');
  const code = sync.getByLabel('4자리 연결 코드', { exact: true });
  expect(await code.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await code.fill('1234');
  await expectReachable(sync.getByRole('button', { name: '연결', exact: true }));
  await expectContained(page);
});

test('가로 모드와 태블릿에서도 화면 밖으로 밀리지 않고 데스크톱 배치로 전환한다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toHaveCount(jobs.length);
  for (const viewport of [{ width: 667, height: 375 }, { width: 768, height: 1024 }, { width: 844, height: 390 }, { width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    await expectContained(page);
    const nav = page.getByRole('navigation', { name: '주요 메뉴' });
    for (const button of await nav.getByRole('button').all()) await expectReachable(button);
    if (viewport.width > 760) {
      expect(await nav.evaluate((element) => getComputedStyle(element).position)).not.toBe('fixed');
      await expect(page.getByTestId('all-jobs-list').locator('.job-mark').first()).toBeVisible();
    } else {
      const bounds = await nav.boundingBox();
      expect(bounds.y + bounds.height).toBeCloseTo(viewport.height, 0);
    }
  }
});
