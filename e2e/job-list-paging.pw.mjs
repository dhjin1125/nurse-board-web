import { expect, test } from '@playwright/test';

const checkedAt = '2026-09-03T03:00:00.000Z';
const jobs = Array.from({ length: 70 }, (_, index) => ({
  id: `paging-${String(index + 1).padStart(3, '0')}`,
  source: '페이징 테스트 채용처',
  sourceId: `paging-source-${index + 1}`,
  title: `보건관리자 ${String(index + 1).padStart(2, '0')} 채용`,
  company: `테스트 기업 ${index + 1}`,
  region: '서울',
  employment: '정규직',
  employmentType: '정규직',
  experience: '경력 무관',
  experienceLevel: '경력 무관',
  role: '사업장 보건관리자',
  roleTags: ['보건관리자'],
  publishedAt: new Date(Date.parse(checkedAt) - index * 60_000).toISOString(),
  firstSeenAt: new Date(Date.parse(checkedAt) - index * 60_000).toISOString(),
  lastSeenAt: checkedAt,
  deadlineAt: '2099-12-31T14:59:00.000Z',
  url: `https://example.com/jobs/${index + 1}`,
}));

test.beforeEach(async ({ page }) => {
  await page.route('**/api/jobs?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      jobs,
      needsReviewJobs: [],
      sourceStatus: [],
      lastSuccessAt: checkedAt,
      lastAttemptAt: checkedAt,
      dataTrust: {
        state: 'healthy',
        sources: { total: 1, fresh: 1, cached: 0, stale: 0, failed: 0, unavailable: 0 },
        jobs: { raw: 70, merged: 70, duplicatesRemoved: 0, visible: 70, needsReview: 0 },
      },
      collection: { refreshIntervalMs: 1_800_000, automaticSourceCount: 1 },
      refresh: { inProgress: false },
    }),
  }));
  await page.goto('/all-jobs');
});

test('전체 결과는 유지하면서 공고 카드를 24개씩 이어서 렌더링한다', async ({ page }) => {
  const cards = page.getByTestId('job-card');
  const pager = page.getByTestId('job-list-pager');

  await expect(page.getByRole('status')).toContainText('70건');
  await expect(cards).toHaveCount(24);
  await expect(pager).toContainText('24 / 70건 표시');

  await pager.scrollIntoViewIfNeeded();
  await expect(cards).toHaveCount(48);
  await expect(pager).toContainText('48 / 70건 표시');

  await pager.scrollIntoViewIfNeeded();
  await expect(cards).toHaveCount(70);
  await expect(pager).toHaveCount(0);
});
