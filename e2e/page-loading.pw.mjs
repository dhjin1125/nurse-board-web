import { test, expect } from '@playwright/test';
import { prepareJobForDisplay } from '../lib/job-presentation.mjs';

const job = prepareJobForDisplay({
  id: 'fast-detail', title: '기업 건강관리실 간호사 채용', company: '로딩검증기업',
  region: '서울', employment: '정규직', experience: '경력무관',
  deadline: '채용시까지', duties: '직원 건강상담',
  url: 'https://www.nursejob.co.kr/recruit/fast-detail',
});
const detail = { detailVerified: true, detailBodyAvailable: true, duties: '서버에 저장된 직원 건강상담 업무', qualifications: '간호사 면허' };
const saraminJob = prepareJobForDisplay({
  id: 'saramin-55102113', title: '[경복궁면세점] 보건관리자 채용', company: '(주)경복궁면세점',
  region: '서울', employment: '정규직', experience: '경력3년↑', source: '사람인',
  url: 'https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=55102113',
});

test.beforeEach(async ({ page }) => {
  await page.route('**/api/company-reputation', (route) => route.fulfill({ json: { sources: [], candidates: [] } }));
});

test('첫 화면은 중복 요청 없이 서버에서 준비한 목록만 받는다', async ({ page }) => {
  const requests = [];
  const errors = [];
  page.on('request', (request) => { if (request.url().includes('/api/')) requests.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/jobs?*', (route) => route.fulfill({ json: { jobs: [job], needsReviewJobs: [] } }));
  await page.goto('/');
  await expect(page.getByTestId('job-card')).toHaveCount(1);
  await expect(page.getByTestId('job-card')).toContainText(job.title);
  await expect(page.getByTestId('job-card').getByTestId('unseen-job-badge')).toHaveText('안 본 공고');
  await expect(page.getByTestId('job-card').getByTestId('source-detail-check')).toHaveCount(0);
  expect(requests.map((url) => new URL(url).pathname)).toEqual(['/api/jobs']);
  expect(errors).toEqual([]);
});

test('상세 확인 시각 같은 내부 수집 정보는 공고 카드에 표시하지 않는다', async ({ page }) => {
  const checkedJob = { ...job, detailEnrichmentCheckedAt: new Date().toISOString() };
  await page.route('**/api/jobs?*', (route) => route.fulfill({ json: { jobs: [checkedJob], needsReviewJobs: [] } }));
  await page.goto('/');
  const card = page.getByTestId('job-card');
  await expect(card.getByTestId('source-detail-check')).toHaveCount(0);
  await expect(card).not.toContainText('공고 확인');
  await expect(card).not.toContainText('원문 상세 미확인');
});

test('상세 주소는 전체 목록과 원문 수집을 기다리지 않고 한 건만 받는다', async ({ page }) => {
  const requests = [];
  const errors = [];
  page.on('request', (request) => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/job?id=*', (route) => route.fulfill({ json: { job, detail } }));
  await page.route('**/api/jobs?*', (route) => route.fulfill({ json: { jobs: [job], needsReviewJobs: [] } }));
  await page.goto(`/recruitment/${job.id}`);
  await expect(page.getByTestId('job-detail')).toBeVisible();
  await expect(page.getByTestId('job-detail')).toContainText(detail.duties);
  expect(requests.filter((path) => path !== '/api/company-reputation')).toEqual(['/api/job']);
  await page.getByRole('button', { name: '상세 닫기' }).click();
  await expect(page.getByTestId('job-card')).toHaveCount(1);
  expect(requests.filter((path) => path === '/api/jobs')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('사람인 상세 주소는 원문 이미지를 자동 확인하고 이미지 중계 주소를 표시한다', async ({ page }) => {
  let detailRequest;
  await page.route('**/api/job?id=*', (route) => route.fulfill({ json: { job: saraminJob, detail: { detailVerified: false, detailOrigin: 'feed-fallback' } } }));
  await page.route('**/api/job-detail', async (route) => {
    detailRequest = route.request().postDataJSON();
    await route.fulfill({ json: {
      detailVerified: true, detailBodyAvailable: true, detailOrigin: 'original',
      sourceImages: ['https://pds.saramin.co.kr/recruit/recruit/202609/22/posting.jpg'],
    } });
  });
  await page.route('**/api/saramin-image?*', (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: '' }));
  await page.goto(`/recruitment/${saraminJob.id}`);
  const detail = page.getByTestId('job-detail');
  const originalTab = detail.getByRole('tab', { name: '공식 원문' });
  await expect(originalTab).toBeVisible();
  expect(detailRequest).toMatchObject({ refresh: true, purpose: 'detail-open' });
  await originalTab.click();
  await expect(detail.locator('.posting-source-images img')).toHaveAttribute('src', /\/api\/saramin-image\?/);
});

test('상세 주소의 늦은 응답은 목록으로 돌아온 화면을 다시 열지 않는다', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/job?id=*', async (route) => { await gate; await route.fulfill({ json: { job, detail } }); });
  await page.route('**/api/jobs?*', (route) => route.fulfill({ json: { jobs: [job], needsReviewJobs: [] } }));
  await page.goto(`/recruitment/${job.id}`);
  await expect(page.getByTestId('job-detail-route-state')).toBeVisible();
  await page.getByRole('button', { name: '상세 닫기' }).click();
  await expect(page.getByTestId('job-card')).toHaveCount(1);
  const lateResponse = page.waitForResponse((response) => response.url().includes('/api/job?id='));
  release();
  await lateResponse;
  await expect(page.getByTestId('job-detail')).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
});
