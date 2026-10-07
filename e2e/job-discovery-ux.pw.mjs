import { test, expect } from '@playwright/test';
import { selectRegion, expectRegion } from './ui-controls.mjs';

const now = new Date().toISOString();
const dateOffset = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const jobs = [
  {
    id: 'ux-outpatient',
    dedupeKey: '새봄종합병원:외래간호사',
    company: '새봄종합병원',
    title: '외래 주간근무 간호사 채용',
    region: '서울',
    employmentType: '정규직',
    experienceLevel: '신입',
    department: '외래',
    workPattern: '상근·주간',
    facilityType: '병원·의료원',
    postedAt: '7/10 등록',
    deadline: `~ ${dateOffset(30)}`,
    deadlineAt: dateOffset(30),
    roleTags: ['임상간호사'],
    source: '널스잡',
    url: 'https://www.nursejob.co.kr/recruit/ux-outpatient',
    firstSeenAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    lastSeenAt: now,
  },
  {
    id: 'ux-health-manager',
    dedupeKey: '한빛전자:건강관리실보건관리자',
    company: '한빛전자',
    title: '건강관리실 보건관리자 채용',
    region: '경기',
    employmentType: null,
    experienceLevel: '경력',
    experience: '경력 2년 이상',
    department: '건강관리실',
    workPattern: null,
    facilityType: '기업',
    postedAt: '7/11 등록',
    publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
    deadline: `~ ${dateOffset(60)}`,
    deadlineAt: dateOffset(60),
    roleTags: ['보건관리자', '간호사'],
    source: '고용24',
    url: 'https://www.work24.go.kr/job/ux-health-manager',
    firstSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
    lastSeenAt: now,
  },
  {
    id: 'ux-closed',
    dedupeKey: '마감병원:병동간호사',
    company: '마감병원',
    title: '마감된 병동 간호사 채용',
    region: '서울',
    employmentType: '정규직',
    experienceLevel: '경력',
    department: '병동',
    workPattern: '3교대',
    facilityType: '상급종합병원',
    postedAt: '지난해 등록',
    deadline: '마감',
    deadlineAt: dateOffset(-365),
    roleTags: ['임상간호사'],
    source: '서울대병원',
    url: 'https://recruit.snuh.org/ux-closed',
    firstSeenAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
    lastSeenAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
  },
  {
    id: 'ux-busan',
    dedupeKey: '부산온병원:병동간호사',
    company: '부산온병원',
    title: '부산 병동 간호사 채용',
    region: '부산',
    employmentType: '정규직',
    experienceLevel: '신입',
    department: '병동',
    workPattern: '3교대',
    facilityType: '병원·의료원',
    postedAt: '7/12 등록',
    deadline: `~ ${dateOffset(45)}`,
    deadlineAt: dateOffset(45),
    roleTags: ['임상간호사'],
    source: '널스잡',
    url: 'https://www.nursejob.co.kr/recruit/ux-busan',
    firstSeenAt: now,
    lastSeenAt: now,
  },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript((timestamp) => {
    localStorage.setItem('nurse-user-state', JSON.stringify({
      version: 2,
      profile: {
        onboardingCompletedAt: timestamp,
        roleTags: ['clinical-nurse', 'health-manager'],
        regionCodes: [],
        employmentTypes: [],
        experienceLevels: [],
        workPatterns: [],
        preferredKeywords: [],
        excludedKeywords: [],
      },
      savedSnapshots: {}, applications: {}, notifications: [],
      recentFilters: { query: '보건관리자', department: '산업보건', sort: '최신 등록순' },
      meta: { createdAt: timestamp, updatedAt: timestamp, lastVisitedAt: timestamp, importedAt: null, migratedFromV1At: null, pendingLegacySavedIds: [] },
    }));
  }, now);
  await page.route('**/api/jobs?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      jobs,
      needsReviewJobs: [],
      sourceStatus: [],
      lastSuccessAt: now,
      lastAttemptAt: now,
      dataTrust: {
        state: 'mixed',
        sources: { total: 20, fresh: 18, cached: 2, stale: 2, failed: 0, unavailable: 0 },
        jobs: { raw: 38, merged: 19, duplicatesRemoved: 19, visible: 3, needsReview: 0 },
      },
      collection: { refreshIntervalMs: 1_800_000, automaticSourceCount: 19 },
      refresh: { inProgress: false },
    }),
  }));
  await page.route('**/api/job-detail', (route) => {
    const job = route.request().postDataJSON()?.job;
    if (job?.id === 'ux-outpatient') return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '원문 사이트가 자동 상세 조회를 제한했습니다.' }) });
    const detail = job?.id === 'ux-health-manager' ? {
      detailVerified: true,
      detailOrigin: 'original',
      experience: '경력 2년 이상',
      qualifications: '간호사 면허 필수 · 보건관리자 경력 2년 이상 우대',
      experienceDomain: 'health-manager',
      experienceEvidence: { field: 'qualifications', excerpt: '보건관리자 경력 2년 이상', strength: 'explicit-detail' },
      education: '전문대졸 이상',
      employment: '정규직',
      location: '경기 수원시 영통구',
      workHours: '주 5일 09:00~18:00',
      duties: '사업장 건강상담\n유소견자 사후관리\n건강검진 운영',
      preferredQualifications: '산업보건 업무 경험자\n문서 작성 능력 우수자',
      recruitmentProcess: '1. 서류전형\n▶\n2. 1차면접 → 최종합격',
      applicationMethod: '채용 홈페이지를 통한 입사지원',
      otherInformation: '지원서 내용이 사실과 다를 경우 합격 취소',
      deadlineText: '2026년 9월 11일 23:59까지',
      salary: '연봉 3,800만원 이상',
      headcount: '1명',
      welfare: ['중식 제공', '건강검진 지원'],
      description: '보건관리자 선임과 임직원 건강증진 프로그램 운영을 담당합니다.',
      descriptionKind: 'jobPosting',
    } : {};
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(detail) });
  });
  await page.goto('/');
  await page.locator('[data-testid="nav-all"]:visible').click();
});

async function openFilters(page) {
  const button = page.locator('.mobile-filter-button:visible');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('.filter-sheet:visible')).toBeVisible();
}

async function applyMobileFilters(page) {
  const sheet = page.locator('.filter-sheet:visible');
  if (await sheet.count()) await sheet.getByRole('button', { name: /조건 적용|공고 보기/ }).click();
}

async function showAllEmployment(page) {
  await openFilters(page);
  const employment = page.getByRole('group', { name: '고용 형태' });
  const all = employment.getByRole('checkbox', { name: '전체', exact: true });
  if (!await all.isChecked()) await all.check();
  await applyMobileFilters(page);
}

async function selectFilter(page, label, option) {
  const fields = page.locator('.filter-fields:visible');
  const control = fields.locator('label').filter({ has: page.getByText(label, { exact: true }) }).locator('select');
  await control.selectOption({ label: option });
}

test('마감 공고는 기본으로 숨기고 목록에서 확인된 신뢰 메타만 먼저 보여준다', async ({ page }) => {
  await showAllEmployment(page);
  const mainList = page.getByTestId('all-jobs-list');
  await expect(mainList.getByTestId('job-card')).toHaveCount(2);
  await expect(page.getByText('마감된 병동 간호사 채용')).toBeHidden();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('부산 병동 간호사 채용')).toBeHidden();

  const card = mainList.getByTestId('job-card').filter({ hasText: '외래 주간근무 간호사 채용' });
  await expect(card).toContainText('외래');
  await expect(card).toContainText('상근·주간');
  await expect(card).toContainText('정규직');
  await expect(card).toContainText('신입');
  await expect(card).toContainText('등록');
  await expect(card).not.toContainText(/공고 확인|원문 상세 미확인/);

  const healthCard = mainList.getByTestId('job-card').filter({ hasText: '건강관리실 보건관리자 채용' });
  await expect(healthCard).toContainText('상근 후보');
  await expect(healthCard).toContainText('경력 2년 이상');
  await expect(healthCard).toContainText('기업·사업장');
  await expect(healthCard).toContainText('근무형태 확인 필요');
  await expect(healthCard).toContainText('고용형태 확인 필요');
  await expect(healthCard).not.toContainText('연봉 3,800만원 이상');
  await expect(healthCard).not.toContainText('전문대졸 이상');
  await expect(healthCard).not.toContainText('상세 정보 자동 확인');
});

test('예전 보건관리자 검색을 초기화하고 워라벨·최신·마감 정렬을 전환한다', async ({ page }) => {
  await showAllEmployment(page);
  await page.getByTestId('discovery-all').click();
  const workLife = page.getByTestId('sort-work-life');
  const latest = page.getByTestId('sort-latest');
  const deadline = page.getByTestId('sort-deadline');

  await expect(workLife).toHaveAttribute('aria-pressed', 'true');
  await expect(workLife).toHaveText('추천순');
  await expect(page.getByLabel('공고 검색어')).toHaveValue('');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first()).toContainText('건강관리실 보건관리자 채용');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first().getByTestId('listing-age')).toHaveText('1일 전');

  await latest.click();
  await expect(latest).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first()).toContainText('건강관리실 보건관리자 채용');

  await deadline.click();
  await expect(deadline).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first()).toContainText('외래 주간근무 간호사 채용');

  await workLife.click();
  await expect(workLife).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first()).toContainText('건강관리실 보건관리자 채용');
});

test('전체 공고를 현재 확인된 추천 등급으로 나누고 조건이 아쉬운 공고도 계속 보여준다', async ({ page }) => {
  await showAllEmployment(page);
  await page.getByTestId('discovery-all').click();
  await selectRegion(page, '전체');

  const tierB = page.getByTestId('all-jobs-list').getByTestId('application-tier-group-B');
  const excludedTier = page.getByTestId('all-jobs-list').getByTestId('application-tier-group-exclude');
  await expect(page.getByTestId('all-jobs-list').getByTestId('application-tier-group-S')).toHaveCount(0);
  await expect(tierB.locator('.job-list-group')).toContainText('조건 확인');
  await expect(tierB.locator('.job-list-group')).toContainText('2건');
  await expect(excludedTier.locator('.job-list-group')).toContainText('제외 권장');
  await expect(excludedTier.locator('.job-list-group')).toContainText('1건');

  const tierBToggle = page.getByTestId('all-jobs-list').getByTestId('tier-toggle-B');
  await expect(tierBToggle).toHaveAttribute('aria-expanded', 'true');
  await tierBToggle.click();
  await expect(tierBToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(tierB.locator('.application-tier-cards')).toBeHidden();
  await expect(tierB.getByTestId('job-card')).toHaveCount(0);
  await expect(tierBToggle).toContainText('2건');
  await tierBToggle.click();
  await expect(tierBToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(tierB.locator('.application-tier-cards')).toBeVisible();

  const collapseAll = page.getByTestId('all-jobs-list').getByTestId('toggle-all-tiers');
  await expect(collapseAll).toHaveText('전체 접기');
  await collapseAll.click();
  await expect(collapseAll).toHaveText('전체 펼치기');
  await expect(tierB.locator('.application-tier-cards')).toBeHidden();
  await expect(excludedTier.locator('.application-tier-cards')).toBeHidden();
  await expect(tierB.getByTestId('job-card')).toHaveCount(0);
  await expect(excludedTier.getByTestId('job-card')).toHaveCount(0);
  await collapseAll.click();
  await expect(collapseAll).toHaveText('전체 접기');
  await expect(tierB.locator('.application-tier-cards')).toBeVisible();
  await expect(excludedTier.locator('.application-tier-cards')).toBeVisible();

  const healthManager = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '건강관리실 보건관리자 채용' });
  const outpatient = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '외래 주간근무 간호사 채용' });
  const busanShift = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '부산 병동 간호사 채용' });
  await expect(healthManager).toContainText('B조건 확인');
  await expect(healthManager).toContainText('지원 검토 가능');
  await expect(healthManager).toContainText('산업간호 전환 직무');
  await expect(healthManager).toContainText('실제 근무시간 확인');
  await expect(outpatient).toContainText('B조건 확인');
  await expect(outpatient.getByTestId('listing-age')).toHaveText('? 등록일 미확인');
  await expect(outpatient.getByText('상근·주간 확인', { exact: true })).toBeVisible();
  await expect(busanShift).toContainText('제외');
  await expect(busanShift.locator('.schedule-badge').getByText('3교대 명시', { exact: true })).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(3);

  const order = await page.getByTestId('all-jobs-list').locator('.application-tier-list > .application-tier-section').evaluateAll((elements) => elements.map((element) => element.textContent));
  const position = (text) => order.findIndex((item) => item.includes(text));
  expect(position('조건 확인')).toBeLessThan(position('제외 권장'));
});

test('서울·경기를 기본으로 유지하고 전체 지역을 직접 선택할 때만 지방 공고를 연다', async ({ page }) => {
  await showAllEmployment(page);
  await expectRegion(page, '서울·경기');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('부산 병동 간호사 채용')).toBeHidden();

  await selectRegion(page, '서울');
  await expectRegion(page, '서울');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('외래 주간근무 간호사 채용')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('건강관리실 보건관리자 채용')).toBeHidden();

  await selectRegion(page, '전체');
  await expectRegion(page, '전체');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(3);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('부산 병동 간호사 채용')).toBeVisible();

  await page.reload();
  await expectRegion(page, '서울·경기');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('부산 병동 간호사 채용')).toBeHidden();
});

test('첫 화면의 주요 메뉴에서 추천·전체·저장 공고를 구분한다', async ({ page }) => {
  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(navigation.getByRole('button')).toHaveCount(3);
  await expect(navigation.getByRole('button', { name: /추천 공고/ })).toBeVisible();
  await expect(navigation.getByRole('button', { name: /전체 공고/ })).toBeVisible();
  await expect(navigation.getByRole('button', { name: /저장 공고/ })).toBeVisible();
  await expect(page.getByTestId('onboarding')).toHaveCount(0);
  await expect(page.getByTestId('nav-applications')).toHaveCount(0);
  await expect(page.getByTestId('nav-sources')).toHaveCount(0);
});

test('공고가 있으면 내부 수집 상태로 탐색을 방해하지 않는다', async ({ page }) => {
  await showAllEmployment(page);
  await expect(page.getByTestId('data-trust-bar')).toHaveCount(0);
  await expect(page.getByText(/새 공고 확인이 늦어지고|현재 목록은 마지막으로|일부 공고는 업데이트/)).toHaveCount(0);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(2);
});

test('확인된 요약과 원문 섹션만 단일 흐름으로 보여준다', async ({ page }) => {
  let detailRequestCount = 0;
  page.on('request', (request) => {
    const payload = request.url().includes('/api/job-detail') && request.method() === 'POST'
      ? request.postDataJSON()
      : null;
    if (payload?.job?.id === 'ux-health-manager' && payload.purpose !== 'detail-enrichment') detailRequestCount += 1;
  });
  await showAllEmployment(page);
  const card = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '건강관리실 보건관리자 채용' });
  await expect(card).toContainText('경력 2년 이상');

  await card.getByTestId('open-job-detail').click();
  const detail = page.getByTestId('job-detail');
  const facts = detail.getByTestId('detail-facts');
  const tierSummary = detail.getByTestId('application-tier-summary');
  await expect(detail.getByTestId('personal-match')).toHaveCount(0);
  await expect(tierSummary.getByRole('heading', { name: '최우선 지원' })).toBeVisible();
  await expect(tierSummary).toContainText('지원 우선순위');
  await expect(tierSummary).toContainText('공고 매력도 82점 · 지원 검토 가능');
  await expect(tierSummary).not.toContainText('판단 근거');
  await expect(tierSummary).not.toContainText('지원 전 확인');
  for (const label of ['직무·경력', '기관', '상근', '안정성', '보상', '현실성']) await expect(tierSummary.getByText(label, { exact: true })).toHaveCount(0);
  await expect(detail.getByText('빠른 확인', { exact: true })).toHaveCount(0);
  await expect(detail.getByRole('heading', { name: '간호 직무 관련 내용' })).toHaveCount(0);
  for (const label of ['근무 부서', '근무 형태', '근무지', '근무 시간', '급여', '경력', '고용 형태', '마감']) await expect(facts.getByText(label, { exact: true })).toBeVisible();
  await expect(facts).toContainText('경력 2년 이상');
  for (const heading of ['담당업무', '자격요건', '우대사항', '근무조건·복지', '전형절차', '지원방법', '기타사항']) {
    await expect(detail.getByRole('heading', { name: heading })).toBeVisible();
  }
  for (const value of ['유소견자 사후관리', '간호사 면허 필수', '산업보건 업무 경험자', '주 5일 09:00~18:00', '연봉 3,800만원 이상', '1차면접', '채용 홈페이지를 통한 입사지원', '지원서 내용이 사실과 다를 경우 합격 취소', '2026년 9월 11일 23:59까지']) {
    await expect(detail.getByText(value, { exact: false }).first()).toBeVisible();
  }
  const processSection = detail.getByRole('heading', { name: '전형절차' }).locator('..');
  await expect(processSection.locator('ol > li')).toHaveText(['서류전형', '1차면접', '최종합격']);
  await expect(processSection).not.toContainText('▶');
  await expect(facts).toContainText('건강관리실');
  await expect(facts).toContainText('상근·주간');
  await expect(detail.getByTestId('posting-deadline')).toContainText('2026년 9월 11일 23:59까지');
  await detail.getByRole('heading', { name: '기타사항' }).scrollIntoViewIfNeeded();
  await expect(detail.getByTestId('apply-original')).toBeInViewport();
  await expect(detail.getByTestId('progress-action')).toHaveCount(0);
  await expect(detail).not.toContainText('원문 확인');

  await detail.getByRole('tab', { name: '원문 내용' }).click();
  await expect(detail.getByText('보건관리자 선임과 임직원 건강증진 프로그램 운영을 담당합니다.')).toBeVisible();
  await detail.getByRole('tab', { name: '공고 요약' }).click();

  await detail.getByRole('button', { name: '상세 닫기' }).click();
  await expect(detail).toBeHidden();
  expect(detailRequestCount).toBe(1);

  await page.reload();
  await showAllEmployment(page);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '건강관리실 보건관리자 채용' })).toBeVisible();
});

test('마감 정보만 있어도 메타 설명을 숨기지 않고 공고 안내로 보여준다', async ({ page }) => {
  await page.unroute('**/api/job-detail');
  await page.route('**/api/job-detail', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      detailVerified: true,
      detailBodyAvailable: false,
      detailOrigin: 'original',
      descriptionKind: 'meta',
      description: '새봄종합병원 외래 간호사 채용의 지원 자격과 근무 조건을 확인하세요.',
      deadlineText: '2026년 8월 14일 23:59까지',
      notice: '원문에서 상세 본문을 자동으로 확인하지 못해 확인 가능한 공고 정보만 표시합니다.',
    }),
  }));

  const card = page.getByTestId('all-jobs-list').getByTestId('job-card').filter({ hasText: '외래 주간근무 간호사 채용' });
  await card.getByTestId('open-job-detail').click();
  const detail = page.getByTestId('job-detail');
  await expect(detail.getByRole('heading', { name: '공고 안내' })).toBeVisible();
  await expect(detail.getByText('새봄종합병원 외래 간호사 채용의 지원 자격과 근무 조건을 확인하세요.')).toBeVisible();
  await expect(detail.getByText('일부 상세 조건은 원문에서 확인해 주세요.')).toBeVisible();
  await expect(detail.getByText('원문에서 상세 본문을 자동으로 확인하지 못해 확인 가능한 공고 정보만 표시합니다.')).toHaveCount(0);
  await expect(detail.getByRole('heading', { name: '마감기한' })).toHaveCount(0);
  await expect(detail.getByRole('tab', { name: '원문 내용' })).toHaveCount(0);
  await expect(detail.getByTestId('posting-deadline')).toContainText('2026년 8월 14일 23:59까지');
  await expect(detail.getByTestId('apply-original')).toBeVisible();
});

test('원문 섹션 순서와 소개·복지 하위 제목을 그대로 보여준다', async ({ page }) => {
  await page.unroute('**/api/job-detail');
  const sections = [
    { key: 'introduction', title: '소개', content: '백패커는 창작자의 가치를 연결하는 서비스를 만듭니다.', kind: 'prose' },
    { key: 'teamIntroduction', title: '유닛/셀 소개', content: 'Mobile셀은 사용자와 가장 가까운 곳에서 서비스를 만듭니다.', kind: 'prose' },
    { key: 'workCulture', title: '우리는 이렇게 일해요', content: '• 문서로 합의하고 코드 리뷰로 신뢰를 쌓아요\n• AI로 반복 작업을 자동화해요', kind: 'mixed' },
    { key: 'duties', title: '주요업무', content: '• 사용자 경험을 개선해요\n• 서비스 성능과 품질을 높여요', kind: 'mixed' },
    { key: 'qualifications', title: '자격요건', content: '• 간호사 면허 소지자\n• 적극적으로 소통하는 분', kind: 'mixed' },
    { key: 'preferredQualifications', title: '우대사항', content: '• 보건관리 업무 경험', kind: 'mixed' },
    { key: 'benefits', title: '혜택 및 복지', content: '[Health]\n• 건강검진 지원\n[Growth]\n• 교육과 도서 구입 지원', kind: 'mixed' },
  ];
  await page.route('**/api/job-detail', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      detailVerified: true,
      detailBodyAvailable: true,
      detailOrigin: 'original',
      descriptionKind: 'content',
      description: sections.map(({ title, content }) => `${title}\n${content}`).join('\n\n'),
      sections,
      duties: 'DUPLICATE_DUTIES',
      qualifications: 'DUPLICATE_QUALIFICATIONS',
      welfare: ['DUPLICATE_BENEFIT'],
    }),
  }));

  const card = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '외래 주간근무 간호사 채용' });
  await card.getByTestId('open-job-detail').click();
  const detail = page.getByTestId('job-detail');
  await expect(detail.locator('.recruitment-section > h3')).toHaveText(['소개', '유닛/셀 소개', '우리는 이렇게 일해요', '주요업무', '자격요건', '우대사항', '혜택 및 복지']);
  await expect(detail.getByText('백패커는 창작자의 가치를 연결하는 서비스를 만듭니다.')).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Health' })).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Growth' })).toBeVisible();
  await expect(detail.getByText('교육과 도서 구입 지원')).toBeVisible();
  await expect(detail).not.toContainText(/DUPLICATE_DUTIES|DUPLICATE_QUALIFICATIONS|DUPLICATE_BENEFIT/);
  await expect(detail.getByRole('heading', { name: '공고 내용' })).toHaveCount(0);
  await expect(detail.getByRole('tab', { name: '원문 내용' })).toBeVisible();
  await expect(detail.getByTestId('apply-original')).toBeVisible();
});

test('공식 병원 원문과 첨부파일을 상세 안에서 바로 확인한다', async ({ page }) => {
  await page.unroute('**/api/job-detail');
  const officialUrl = 'https://ncc.recruiter.co.kr/app/jobnotice/view?systemKindCode=MRS2&jobnoticeSn=77';
  const imageUrl = 'https://ncc.recruiter.co.kr/upload/1/image/page-1.jpg';
  const pdfUrl = 'https://ncc.recruiter.co.kr/mrs2/attachFile/downloadFile?fileUid=notice.pdf';
  await page.route(imageUrl, (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  }));
  await page.route('**/api/job-detail', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      detailVerified: true,
      detailBodyAvailable: true,
      detailOrigin: 'original',
      descriptionKind: 'content',
      description: '담당업무\nIRB 연구윤리 심의 지원\n자격요건\n간호사 면허 소지자',
      sections: [
        { key: 'duties', title: '담당업무', content: 'IRB 연구윤리 심의 지원', kind: 'mixed' },
        { key: 'qualifications', title: '자격요건', content: '간호사 면허 소지자', kind: 'mixed' },
      ],
      officialSourceUrl: officialUrl,
      sourceImages: [imageUrl],
      attachments: [{ name: '국립암센터 간호직 채용공고.pdf', url: pdfUrl, type: 'PDF' }],
    }),
  }));

  const card = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '외래 주간근무 간호사 채용' });
  await card.getByTestId('open-job-detail').click();
  const detail = page.getByTestId('job-detail');
  await expect(detail.getByTestId('official-attachments')).toContainText('국립암센터 간호직 채용공고.pdf');
  await expect(detail.getByTestId('official-attachments').getByRole('link')).toHaveAttribute('href', pdfUrl);
  await expect(detail.getByTestId('apply-original')).toHaveAttribute('href', officialUrl);
  await expect(detail.getByTestId('apply-original')).toContainText('공식 페이지에서 보기');

  await detail.getByRole('tab', { name: '공식 원문' }).click();
  await expect(detail.getByRole('heading', { name: '이미지 원문' })).toBeVisible();
  await expect(detail.locator('.posting-source-images img')).toHaveCount(1);
  await expect(detail.locator('.posting-source-images img')).toHaveAttribute('src', imageUrl);
});

test('상세 자동 조회가 실패해도 사람말 안내와 핵심 지원 버튼을 유지한다', async ({ page }) => {
  const card = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '외래 주간근무 간호사 채용' });
  await card.getByTestId('open-job-detail').click();
  const detail = page.getByTestId('job-detail');
  await expect(detail.getByTestId('detail-facts')).toContainText('서울');
  await expect(detail.getByText('상세 내용을 불러오지 못했습니다.')).toBeVisible();
  await expect(detail.getByRole('heading', { name: '담당업무' })).toHaveCount(0);
  await expect(detail.getByRole('heading', { name: '근무조건·복지' })).toHaveCount(0);
  await expect(detail.getByTestId('detail-facts')).toContainText('상근·주간');
  await expect(detail.getByTestId('detail-facts')).toContainText('공고에서 확인 필요');
  await expect(detail).not.toContainText('담당업무가 따로 적혀 있지 않습니다');
  await expect(detail).not.toContainText('원문 확인');
  await expect(detail.getByTestId('apply-original')).toBeVisible();
  await expect(detail.getByTestId('progress-action')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: /공고 저장/ })).toBeVisible();
});

test('상세 주소와 브라우저 뒤로가기·앞으로가기가 목록 상태를 보존한다', async ({ page }) => {
  await showAllEmployment(page);
  const card = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '건강관리실 보건관리자 채용' });
  await card.getByTestId('open-job-detail').click();
  await expect(page).toHaveURL(/\/recruitment\/ux-health-manager$/);
  await expect(page.getByTestId('job-detail')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('job-detail')).toBeHidden();
  await expectRegion(page, '서울·경기');

  await page.goForward();
  await expect(page).toHaveURL(/\/recruitment\/ux-health-manager$/);
  await expect(page.getByTestId('job-detail')).toBeVisible();
});

test('산업보건 필터를 적용한 목록은 상세를 보고 뒤로가도 그대로 유지된다', async ({ page }) => {
  await showAllEmployment(page);
  await openFilters(page);
  await selectFilter(page, '부서', '산업보건');
  await applyMobileFilters(page);

  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  const card = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '건강관리실 보건관리자 채용' });
  await expect(card).toBeVisible();
  await card.getByTestId('open-job-detail').click();
  await expect(page).toHaveURL(/\/recruitment\/ux-health-manager$/);
  await page.reload();
  await expect(page.getByTestId('job-detail')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  await expect(card).toBeVisible();

  await openFilters(page);
  const department = page.locator('.filter-fields:visible').locator('label').filter({ has: page.getByText('부서', { exact: true }) }).locator('select');
  await expect(department).toHaveValue('산업보건');
  await expect(page.getByRole('group', { name: '고용 형태' }).getByRole('checkbox', { name: '전체', exact: true })).toBeChecked();
});

test('상세에서 목록으로 돌아온 뒤 상단 메뉴로 저장 공고를 연다', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', '데스크톱 상단 메뉴 확인');
  await page.setViewportSize({ width: 1440, height: 900 });
  await showAllEmployment(page);
  const card = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '건강관리실 보건관리자 채용' });
  await card.getByTestId('open-job-detail').click();
  const detail = page.getByTestId('job-detail');
  await expect(detail).toBeVisible();

  await detail.getByRole('button', { name: '상세 닫기' }).click();
  await page.locator('.focus-header').getByTestId('nav-saved').click();
  await expect(page).toHaveURL(/\/saved$/);
  await expect(detail).toBeHidden();
  await expect(page.getByRole('heading', { name: '저장한 공고', exact: true, level: 1 })).toBeVisible();
});

test('상세 주소로 바로 들어온 뒤 목록으로 안전하게 돌아간다', async ({ page }) => {
  let backgroundDetailRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/job-detail') && request.postDataJSON()?.purpose === 'detail-enrichment') backgroundDetailRequests += 1;
  });
  await page.goto('/recruitment/ux-health-manager');
  const detail = page.getByTestId('job-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { name: '건강관리실 보건관리자 채용' })).toBeVisible();
  await page.waitForTimeout(900);
  expect(backgroundDetailRequests).toBe(0);

  await detail.getByRole('button', { name: '상세 닫기' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(detail).toBeHidden();
  await expectRegion(page, '서울·경기');
});

test('간호 직무 필터와 정렬을 데스크톱과 모바일에서 사용할 수 있다', async ({ page }) => {
  await showAllEmployment(page);
  await openFilters(page);
  await selectFilter(page, '부서', '외래');
  await selectFilter(page, '근무 형태', '상근·주간');
  await applyMobileFilters(page);

  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('외래 주간근무 간호사 채용')).toBeVisible();

  await openFilters(page);
  await selectFilter(page, '부서', '전체');
  await selectFilter(page, '근무 형태', '전체');
  await selectFilter(page, '정렬', '최신 등록순');
  await applyMobileFilters(page);

  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(2);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first()).toContainText('건강관리실 보건관리자 채용');
  await expect(page.getByText('마감된 병동 간호사 채용')).toBeHidden();
});
