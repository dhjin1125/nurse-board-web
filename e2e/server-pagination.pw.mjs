import { test, expect } from '@playwright/test';
import { jobPage } from '../lib/job-page.mjs';

const snapshot = {
  jobs: Array.from({ length: 80 }, (_, index) => ({
    id: `server-page-${index}`, dedupeKey: `server-page-key-${index}`,
    title: `산업간호사 ${String(index).padStart(2, '0')}`, company: index === 79 ? '마지막기업' : '테스트기업',
    region: '서울', employment: '정규직', experience: '경력무관', deadline: '채용시까지',
    category: 'health', duties: '사업장 보건관리', workHours: '주5일 주간 09:00~18:00',
    source: '테스트', publishedAt: '2026-09-14', url: `https://www.nursejob.co.kr/recruit/${index}`,
  })), counts: { total: 80 }, updatedAt: '2026-09-14T00:00:00Z',
};

test('initial download is 24 jobs, scrolling fetches another page, and search covers all server jobs', async ({ page }) => {
  const responses = [];
  await page.route('**/api/jobs?*', async route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    const { body } = jobPage(snapshot, query);
    responses.push({ query, data: JSON.parse(body) });
    await route.fulfill({ contentType: 'application/json', body });
  });
  await page.goto('/');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(24);
  expect(responses).toHaveLength(1);
  expect(responses[0].data.jobs).toHaveLength(24);
  await expect(page.getByTestId('all-jobs-list').locator('.result-count')).toHaveText('80건');
  await page.getByTestId('all-jobs-list').getByTestId('job-list-pager').scrollIntoViewIfNeeded();
  await expect.poll(() => responses.some(r => r.query.offset === '24')).toBe(true);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(48);
  await page.getByRole('textbox', { name: '공고 검색어' }).fill('마지막기업');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toContainText('마지막기업');
  await expect(page.getByTestId('all-jobs-list').locator('.result-count')).toHaveText('1건');
  expect(responses.every(r => r.data.jobs.length <= 24)).toBe(true);
});

test('a late response for a previous query cannot replace current results', async ({ page }) => {
  let release;
  await page.route('**/api/jobs?*', async route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    if (JSON.parse(query.filters).query === '테스트') await new Promise(resolve => { release = resolve; });
    await route.fulfill({ contentType: 'application/json', body: jobPage(snapshot, query).body });
  });
  await page.goto('/');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(24);
  const input = page.getByRole('textbox', { name: '공고 검색어' });
  await input.fill('테스트');
  await expect.poll(() => Boolean(release)).toBe(true);
  await input.fill('마지막기업');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(1);
  release();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toContainText('마지막기업');
});

test('failed searches do not display the previous query results as new matches', async ({ page }) => {
  await page.route('**/api/jobs?*', async route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    if (JSON.parse(query.filters).query) return route.fulfill({ status: 503, json: { error: '일시 오류' } });
    return route.fulfill({ contentType: 'application/json', body: jobPage(snapshot, query).body });
  });
  await page.goto('/');
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(24);
  await page.getByRole('textbox', { name: '공고 검색어' }).fill('새 검색');
  await expect(page.getByText('공고를 불러오지 못했어요')).toBeVisible();
  await expect(page.locator('.jobs-panel, .saved-panel, .hidden-panel').getByTestId('job-card')).toHaveCount(0);
});
