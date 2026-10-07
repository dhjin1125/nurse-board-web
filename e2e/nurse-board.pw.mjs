import { test, expect } from '@playwright/test';
import { selectRegion, expectRegion } from './ui-controls.mjs';

const now = '2026-07-11T09:00:00.000Z';
const jobs = [
  {
    id: 'fixture-1',
    dedupeKey: '한빛전자:보건관리자',
    company: '한빛전자',
    title: '서울 사업장 보건관리자 간호사 채용',
    region: '서울',
    regionCode: '11',
    employmentType: '정규직',
    experienceLevel: '신입',
    department: '건강관리실',
    workPattern: '상근·주간',
    deadline: '~ 07/14',
    deadlineAt: '2026-07-14',
    roleTags: ['보건관리자', '간호사'],
    source: '고용24',
    url: 'https://www.work24.go.kr/job/fixture-1',
    firstSeenAt: now,
    lastSeenAt: now,
  },
  {
    id: 'fixture-2',
    dedupeKey: '새봄병원:외래간호사',
    company: '새봄병원',
    title: '경기 외래 간호사 채용',
    region: '경기',
    regionCode: '41',
    employmentType: null,
    experienceLevel: '경력',
    department: '외래',
    workPattern: '상근·주간',
    deadline: '채용시',
    deadlineKind: 'until-filled',
    roleTags: ['간호사'],
    source: '널스잡',
    url: 'https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=2',
    firstSeenAt: '2026-07-10T09:00:00.000Z',
    lastSeenAt: now,
  },
  {
    id: 'fixture-3',
    dedupeKey: '부산온병원:병동간호사',
    company: '부산온병원',
    title: '부산 병동 간호사 채용',
    region: '부산',
    regionCode: '26',
    employmentType: '정규직',
    experienceLevel: '신입',
    department: '병동',
    workPattern: '3교대',
    deadline: '~ 08/14',
    deadlineAt: '2026-08-14',
    roleTags: ['간호사'],
    source: '널스잡',
    url: 'https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=3',
    firstSeenAt: '2026-07-11T08:00:00.000Z',
    lastSeenAt: now,
  },
  {
    id: 'fixture-4',
    dedupeKey: '푸른산업:계약직보건관리자',
    company: '푸른산업',
    title: '서울 계약직 보건관리자 간호사 채용',
    region: '서울',
    regionCode: '11',
    employmentType: '계약직',
    experienceLevel: '경력',
    department: '건강관리실',
    workPattern: '상근·주간',
    deadline: '채용시',
    deadlineKind: 'until-filled',
    roleTags: ['보건관리자', '간호사'],
    source: '널스잡',
    url: 'https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=4',
    firstSeenAt: '2026-07-09T09:00:00.000Z',
    lastSeenAt: now,
  },
];

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  await page.route('**/api/jobs?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        jobs,
        needsReviewJobs: [],
        lastSuccessAt: now,
        lastAttemptAt: now,
        refresh: { inProgress: false },
      }),
    });
  });
  await page.route('**/api/job-detail', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      duties: '사업장 건강관리와 건강상담',
      qualifications: '간호사 면허 소지자',
      workHours: '주 5일 09:00~18:00',
      applicationMethod: '채용 홈페이지에서 지원',
    }),
  }));
  await page.route('**/api/refresh', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({ accepted: true, refresh: { inProgress: true } }),
  }));
});

test('처음 열면 온보딩 없이 서울·경기 채용 공고부터 보여준다', async ({ page }, testInfo) => {
  await page.goto('/');

  await expect(page.getByTestId('onboarding')).toHaveCount(0);
  await expect(page.getByText('중환자실 경력 → 상근 전환')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '서울·경기 간호사 채용 공고' })).toHaveCount(0);
  await expectRegion(page, '서울·경기');
  await expect(page.getByTestId('discovery-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: /등급별 최신 추천 공고|나에게 맞는 공고/ })).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(2);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first()).toContainText('서울 사업장 보건관리자 간호사 채용');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 사업장 보건관리자 간호사 채용')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('경기 외래 간호사 채용')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 계약직 보건관리자 간호사 채용')).toBeHidden();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('부산 병동 간호사 채용')).toBeHidden();

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(navigation.getByRole('button')).toHaveCount(3);
  await page.screenshot({ path: `artifacts/jobs-focus-${testInfo.project.name}.png`, fullPage: true });
});

test('서울만 선택하면 경기 공고를 빼고 서울 공고만 보여준다', async ({ page }) => {
  await page.goto('/');

  await selectRegion(page, '서울');
  await expectRegion(page, '서울');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 사업장 보건관리자 간호사 채용')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 계약직 보건관리자 간호사 채용')).toBeHidden();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('경기 외래 간호사 채용')).toBeHidden();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
});

test('추천 공고는 그대로 두고 전체 공고 탭에서 계약직 보건관리자까지 모두 본다', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 계약직 보건관리자 간호사 채용')).toBeHidden();

  await page.getByTestId('nav-full').click();
  await expect(page).toHaveURL(/\/all-jobs$/);
  await expect(page.getByRole('heading', { name: '전국 전체 채용 공고' })).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 계약직 보건관리자 간호사 채용')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('부산 병동 간호사 채용')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(4);
  await page.screenshot({ path: `artifacts/all-jobs-${testInfo.project.name}.png`, fullPage: true });

  await page.getByRole('button', { name: /공고 필터 열기/ }).click();
  const employment = page.getByRole('group', { name: '고용 형태' });
  await expect(employment.getByRole('checkbox', { name: '전체', exact: true })).toBeChecked();
  await expect(employment.getByRole('checkbox', { name: '정규직' })).not.toBeChecked();
  await page.locator('.filter-sheet:visible').getByRole('button', { name: /조건 적용|공고 보기/ }).click();

  await page.reload();
  await expect(page.getByRole('heading', { name: '전국 전체 채용 공고' })).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 계약직 보건관리자 간호사 채용')).toBeVisible();

  await page.getByTestId('nav-all').click();
  await expect(page).toHaveURL(/\/$/);
  await expectRegion(page, '서울·경기');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 계약직 보건관리자 간호사 채용')).toBeHidden();
  await page.getByTestId('discovery-new').click();
  await expect(page.getByText('새로 발견한 공고가 없어요')).toBeVisible();
  await page.getByTestId('discovery-all').click();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(2);
});

test('전체 지역은 직접 선택한 현재 세션에서만 보여준다', async ({ page }) => {
  await page.goto('/');
  await selectRegion(page, '전체');

  await expectRegion(page, '전체');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('부산 병동 간호사 채용')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(3);

  await page.reload();
  await expectRegion(page, '서울·경기');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('부산 병동 간호사 채용')).toBeHidden();
});

test('검색하고 저장한 공고를 별도 목록에서 다시 연다', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('공고 검색어').fill('한빛전자');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);

  await page.getByRole('button', { name: '서울 사업장 보건관리자 간호사 채용 저장' }).click();
  await page.getByTestId('nav-saved').click();
  await expect(page).toHaveURL(/\/saved$/);
  await expect(page.getByRole('heading', { name: '저장한 공고', level: 1 })).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 사업장 보건관리자 간호사 채용')).toBeVisible();

  await page.getByTestId('open-job-detail').click();
  const detail = page.getByTestId('job-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { name: '먼저 확인할 조건' })).toBeVisible();
  await expect(detail.getByText('간호사 면허 소지자')).toBeVisible();
  await expect(detail.getByTestId('apply-original')).toHaveText(/채용 사이트에서 보기/);
  await expect(detail.getByTestId('progress-action')).toHaveCount(0);
});

test('상세 원문이 느려도 목록 조건과 지원 링크를 즉시 보여주고 같은 요청을 재사용한다', async ({ page }, testInfo) => {
  await page.unroute('**/api/job-detail');
  const pending = [];
  let detailRequestCount = 0;
  let reputationRequestCount = 0;
  await page.route('**/api/job-detail', (route) => {
    detailRequestCount += 1;
    pending.push(route);
  });
  await page.route('**/api/company-reputation', (route) => {
    reputationRequestCount += 1;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, sources: [], candidates: [] }) });
  });

  await page.goto('/');
  const openButton = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first().getByTestId('open-job-detail');
  await openButton.focus();
  await expect.poll(() => pending.length).toBe(1);
  await openButton.click();

  const detail = page.getByTestId('job-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('detail-progress')).toBeVisible();
  await expect(detail.getByTestId('detail-facts')).toContainText('서울');
  await expect(detail.getByTestId('detail-facts')).toContainText('정규직');
  await expect(detail.getByTestId('detail-facts')).toContainText('신입');
  await expect(detail.getByTestId('posting-deadline')).toContainText('D-3');
  await expect(detail.getByTestId('apply-original')).toBeVisible();
  expect(detailRequestCount).toBe(1);
  expect(reputationRequestCount).toBe(0);
  await detail.screenshot({ path: `artifacts/detail-progress-${testInfo.project.name}.png` });

  await pending[0].fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      detailVerified: true,
      detailBodyAvailable: true,
      detailOrigin: 'original',
      duties: '사업장 건강관리와 유소견자 상담',
      qualifications: '간호사 면허 소지자',
      workHours: '주 5일 09:00~18:00',
      applicationMethod: '채용 홈페이지에서 지원',
    }),
  });
  await expect(detail.getByTestId('detail-progress')).toBeHidden();
  await expect(detail.getByTestId('detail-sections')).toContainText('유소견자 상담');

  await detail.getByRole('button', { name: '상세 닫기' }).click();
  await expect(detail).toBeHidden();
  await page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').first().getByTestId('open-job-detail').click();
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('detail-sections')).toContainText('유소견자 상담');
  expect(detailRequestCount).toBe(1);
});

test('상세 주소로 바로 들어오면 공고 목록 응답 전부터 진행 상태를 보여준다', async ({ page }, testInfo) => {
  await page.unroute('**/api/jobs?*');
  let pendingJobsRoute;
  await page.route('**/api/jobs?*', (route) => { pendingJobsRoute = route; });

  await page.goto('/recruitment/fixture-1');
  await expect.poll(() => Boolean(pendingJobsRoute)).toBe(true);

  const routeState = page.getByTestId('job-detail-route-state');
  await expect(routeState).toBeVisible();
  await expect(routeState.getByTestId('route-detail-progress')).toBeVisible();
  await expect(routeState.getByRole('heading', { name: '공고 정보를 준비하고 있어요' })).toBeVisible();
  await expect(routeState.getByText('공고 목록 연결')).toBeVisible();
  await routeState.screenshot({ path: `artifacts/direct-route-progress-${testInfo.project.name}.png` });

  await pendingJobsRoute.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ jobs, needsReviewJobs: [], lastSuccessAt: now, lastAttemptAt: now, refresh: { inProgress: false } }),
  });

  const detail = page.getByTestId('job-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { name: '서울 사업장 보건관리자 간호사 채용' })).toBeVisible();
  await expect(routeState).toHaveCount(0);
});

test('4자리 코드로 한 번 연결하면 새로 열어도 저장 공고가 계속 동기화된다', async ({ page }) => {
  let remoteSnapshots = {};
  const syncToken = 'A'.repeat(43);
  await page.route('**/api/saved-sync', async (route) => {
    const request = route.request();
    const payload = request.method() === 'POST' ? request.postDataJSON() : { action: 'read' };
    if (['create-pairing', 'redeem-pairing'].includes(payload.action)) remoteSnapshots = { ...remoteSnapshots, ...payload.savedSnapshots };
    if (payload.action === 'save') remoteSnapshots[payload.snapshot.jobKey] = payload.snapshot;
    if (payload.action === 'remove') delete remoteSnapshots[payload.jobKey];
    const pairing = payload.action === 'create-pairing' ? { token: syncToken, pairingCode: '0427', expiresAt: new Date(new Date(now).getTime() + 600_000).toISOString() } : {};
    const redeemed = payload.action === 'redeem-pairing' ? { token: syncToken } : {};
    return route.fulfill({
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({ version: 1, revision: 1, updatedAt: now, savedSnapshots: remoteSnapshots, ...pairing, ...redeemed }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '서울 사업장 보건관리자 간호사 채용 저장' }).click();
  await page.getByTestId('sync-settings').click();
  await page.getByRole('button', { name: '이 기기에서 동기화 시작' }).click();
  await expect(page.getByText('이 기기는 계속 연결돼요')).toBeVisible();
  await expect(page.locator('.saved-sync-code-card code')).toHaveText('0427');

  await page.evaluate(() => localStorage.removeItem('nurse-saved-sync-token'));
  await page.reload();
  await page.getByTestId('sync-settings').click();
  await page.getByLabel('4자리 연결 코드').fill('0427');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByText('이 기기는 계속 연결돼요')).toBeVisible();
  await page.getByRole('button', { name: '스크랩 동기화 닫기' }).click();
  await page.reload();
  await page.getByTestId('sync-settings').click();
  await expect(page.getByText('이 기기는 계속 연결돼요')).toBeVisible();

  remoteSnapshots[jobs[1].dedupeKey] = {
    ...jobs[1],
    jobKey: jobs[1].dedupeKey,
    savedAt: now,
    snapshotUpdatedAt: now,
  };
  await page.getByRole('button', { name: '지금 동기화' }).click();
  await page.getByRole('button', { name: '스크랩 동기화 닫기' }).click();
  await page.getByTestId('nav-saved').click();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('서울 사업장 보건관리자 간호사 채용')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByText('경기 외래 간호사 채용')).toBeVisible();
});

test('새 공고 확인 버튼은 수집 요청만 시작하고 목록 탐색을 유지한다', async ({ page }) => {
  await page.goto('/');
  const refreshRequest = page.waitForRequest((request) => request.url().endsWith('/api/refresh') && request.method() === 'POST');
  await page.getByRole('button', { name: '새 공고 확인' }).click();
  await refreshRequest;
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(2);
});
