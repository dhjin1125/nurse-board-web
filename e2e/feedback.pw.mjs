import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/jobs?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      jobs: [],
      needsReviewJobs: [],
      lastSuccessAt: '2026-09-03T06:00:00.000Z',
      lastAttemptAt: '2026-09-03T06:00:00.000Z',
      refresh: { inProgress: false },
    }),
  }));
});

test('피드백 메뉴에서 현재 화면 맥락과 의견을 비공개로 보낸다', async ({ page }) => {
  let submitted;
  await page.route('**/api/feedback', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        id: 'feedback-e2e-receipt',
        createdAt: '2026-09-03T06:30:00.000Z',
      }),
    });
  });

  await page.goto('/');
  await page.getByTestId('feedback-menu').click();
  const panel = page.getByTestId('feedback-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: '피드백 남기기' })).toBeVisible();

  await panel.getByRole('button', { name: '공고 정보가 달라요' }).click();
  await panel.getByLabel('내용').fill('마감일이 원문과 다르게 보여요. 확인 부탁드립니다.');
  await expect(panel.getByLabel('현재 화면 정보 함께 보내기')).toBeChecked();
  await panel.getByRole('button', { name: '피드백 보내기' }).click();

  await expect(panel.getByText('잘 접수됐어요')).toBeVisible();
  expect(submitted.category).toBe('data');
  expect(submitted.message).toBe('마감일이 원문과 다르게 보여요. 확인 부탁드립니다.');
  expect(submitted.context.pagePath).toBe('/');
  expect(submitted.context.viewport).toBe((await page.viewportSize()).width <= 760 ? 'mobile' : 'desktop');
  expect(submitted.context).not.toHaveProperty('profile');
  expect(submitted.context).not.toHaveProperty('savedSnapshots');
});
