import { test, expect } from '@playwright/test';
import { selectCareRole, expectCareRole } from './ui-controls.mjs';
import { jobPage } from '../lib/job-page.mjs';

const timestamp = (hours = 0) => new Date(Date.now() + hours * 3_600_000).toISOString();
function fixture() {
  const make = (id, hours, extra = {}) => ({ id, dedupeKey: id, title: `${id} 간호사 채용`, company: '분당서울대학교병원', region: '경기', employment: '정규직', deadline: '채용시까지', publishedAt: timestamp(-24), firstSeenAt: timestamp(hours), lastSeenAt: timestamp(), url: `https://snubh.recruiter.co.kr/app/jobnotice/view?jobnoticeSn=${id}`, ...extra });
  return { jobs: [make('기존', -48), make('새전담', -2, { duties: '외과 병동 전담간호사 업무' }), make('이미확인', -1), make('지원완료', -1)], lastSuccessAt: timestamp(), refresh: { inProgress: false }, counts: { total: 4 } };
}
async function setup(page, { returning = true } = {}) {
  const snapshot = fixture();
  await page.addInitScript(({ returning, since, applied }) => {
    if (localStorage.getItem('nurse-user-state')) return;
    localStorage.setItem('nurse-user-state', JSON.stringify({ version: 2, profile: {}, savedSnapshots: { 지원완료: applied }, applications: { 지원완료: { jobKey: '지원완료', status: 'applied' } }, ...(returning ? { discovery: { lastCheckedAt: since, viewed: { 이미확인: since } } } : {}) }));
  }, { returning, since: timestamp(-24), applied: snapshot.jobs[3] });
  await page.route('**/api/jobs?*', route => route.fulfill({ contentType: 'application/json', body: jobPage(snapshot, Object.fromEntries(new URL(route.request().url()).searchParams)).body }));
  await page.route('**/api/job-detail', route => route.fulfill({ json: { detailVerified: true, duties: '외과 병동 전담간호사 업무', workHours: '원문 확인' } }));
  await page.route('**/api/company-reputation*', route => route.fulfill({ json: {} }));
  return snapshot;
}

test('return visit shows only new unseen jobs, PA finds Korean duty, and zero is honest after reload', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await page.getByTestId('discovery-new').click();
  await expect(page.getByTestId('all-jobs-list').getByTestId('application-tier-list')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toContainText('새전담');
  await page.getByTestId('discovery-all').click();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '기존' })).toBeVisible();
  await page.getByTestId('discovery-new').click();
  await selectCareRole(page, 'pa');
  await page.getByRole('textbox', { name: '공고 검색어' }).fill('PA');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  await page.getByTestId('all-jobs-list').getByTestId('open-job-detail').click();
  await expect(page.getByTestId('job-detail')).toBeVisible();
  await page.getByRole('button', { name: '상세 닫기' }).click();
  await page.reload();
  await page.getByTestId('discovery-new').click();
  await expect(page.getByText('새로 발견한 공고가 없어요')).toBeVisible();
  await page.getByTestId('discovery-all').click();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  await expectCareRole(page, 'pa');
});

test('기존 지원 상태는 보존하지만 지원 기록 입력·관리 UI는 노출하지 않는다', async ({ page }) => {
  await setup(page);
  await page.goto('/saved');
  await expect(page.getByRole('button', { name: /지원 관리/ })).toHaveCount(0);
  const card = page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card').filter({ hasText: '지원완료 간호사 채용' });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('지원 완료');
  await card.getByTestId('open-job-detail').click();
  await expect(page.getByTestId('job-detail').getByRole('form', { name: '내 지원 기록' })).toHaveCount(0);
  await expect(page.getByLabel('지원 메모', { exact: true })).toHaveCount(0);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('nurse-user-state')));
  expect(persisted.applications.지원완료.status).toBe('applied');
});

test('manual refresh stays pending until the new publication arrives, not an old completed snapshot', async ({ page }) => {
  const snapshot = await setup(page);
  const startedAt = timestamp(0);
  let phase = 'old';
  await page.route('**/api/refresh', route => { phase = 'waiting'; return route.fulfill({ status: 202, json: { accepted: true, refresh: { inProgress: true, startedAt } } }); });
  await page.unroute('**/api/jobs?*');
  await page.route('**/api/jobs?*', route => {
    const data = { ...snapshot, refresh: phase === 'published' ? { inProgress: false, startedAt, completedAt: timestamp() } : { inProgress: false, startedAt: timestamp(-2), completedAt: timestamp(-1) } };
    return route.fulfill({ contentType: 'application/json', body: jobPage(data, Object.fromEntries(new URL(route.request().url()).searchParams)).body });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '새 공고 확인', exact: true }).click();
  await expect.poll(() => phase).toBe('waiting');
  await expect(page.getByRole('button', { name: '새 공고 확인 중' })).toBeDisabled();
  // Wait for one stale response before exposing the completed publication.
  await page.waitForResponse(response => response.url().includes('/api/jobs?'));
  await expect(page.getByRole('button', { name: '새 공고 확인 중' })).toBeDisabled();
  phase = 'published';
  await expect(page.getByRole('button', { name: '새 공고 확인', exact: true })).toBeEnabled({ timeout: 10_000 });
});

test('manual refresh excludes a job just read without requiring another visit', async ({ page }) => {
  const snapshot = await setup(page);
  await page.route('**/api/refresh', route => route.fulfill({ status: 202, json: { accepted: true, snapshot } }));
  await page.goto('/');
  await page.getByTestId('discovery-new').click();
  await page.getByTestId('all-jobs-list').getByTestId('open-job-detail').click();
  await page.getByRole('button', { name: '상세 닫기' }).click();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  await page.getByRole('button', { name: '새 공고 확인', exact: true }).click();
  await expect(page.getByText('새로 발견한 공고가 없어요')).toBeVisible();
});

test('rejected refresh reconciles viewed jobs without claiming collection succeeded', async ({ page }) => {
  await setup(page);
  await page.route('**/api/refresh', route => route.fulfill({ status: 429, json: { error: '잠시 후 다시 수집할 수 있습니다.' } }));
  await page.goto('/');
  await page.getByTestId('discovery-new').click();
  await page.getByTestId('all-jobs-list').getByTestId('open-job-detail').click();
  await page.getByRole('button', { name: '상세 닫기' }).click();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  await page.getByRole('button', { name: '새 공고 확인', exact: true }).click();
  await expect(page.getByText('잠시 후 다시 수집할 수 있습니다.')).toBeVisible();
  await expect(page.getByText('새로 발견한 공고가 없어요')).toBeVisible();
  await expect(page.getByText('새 공고 수집을 완료했습니다.')).toHaveCount(0);
});

test('지원 입력 UI를 제거해도 기존 지원 상태 데이터는 기기에 보존한다', async ({ page }) => {
  await setup(page);
  await page.goto('/saved');
  await expect(page.getByRole('button', { name: /지원 관리/ })).toHaveCount(0);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('nurse-user-state')));
  expect(persisted.applications.지원완료.status).toBe('applied');
  await page.reload();
  const persistedAfterReload = await page.evaluate(() => JSON.parse(localStorage.getItem('nurse-user-state')));
  expect(persistedAfterReload.applications.지원완료.status).toBe('applied');
});
