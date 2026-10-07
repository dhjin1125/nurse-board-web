import { test, expect } from '@playwright/test';
import { selectCareRole } from './ui-controls.mjs';

const now = new Date().toISOString();
const baseJob = {
  company: '삼성서울병원',
  source: '삼성서울병원',
  region: '서울',
  employmentType: '정규직',
  workPattern: '상근·주간',
  workHours: '평일 09:00~18:00',
  salary: '연봉 6,000만원',
  qualifications: '간호사 면허 소지자',
  roleTags: ['간호사'],
  deadlineAt: '2099-12-31',
  firstSeenAt: now,
  lastSeenAt: now,
};

function posting(id, title, fields = {}) {
  return { ...baseJob, id, dedupeKey: id, title, url: `https://example.com/jobs/${id}`, ...fields };
}

async function mockFeed(page, jobs) {
  await page.addInitScript(() => {
    localStorage.removeItem('nurse-detail-enrichments-v1');
    localStorage.setItem('nurse-user-state', JSON.stringify({
      version: 2,
      profile: { onboardingCompletedAt: new Date().toISOString(), roleTags: [], regionCodes: [] },
      savedSnapshots: {}, applications: {}, notifications: [],
    }));
  });
  await page.route('**/api/jobs?*', (route) => route.fulfill({
    json: { jobs, needsReviewJobs: [], sourceStatus: [], lastSuccessAt: now, refresh: { inProgress: false } },
  }));
}

test('주간 PA·외래와 보건관리는 S/A 후보이고 일반 임상직·CRC·근무 미확인 PA는 B에 유지된다', async ({ page }) => {
  const jobs = [
    posting('clinical-nurse', '간호사 채용'),
    posting('clinical-pa', '진료지원 전담간호사 채용'),
    posting('clinical-outpatient', '외래 상근 간호사 채용'),
    posting('occupational', '사업장 보건관리자(산업간호사) 채용', { company: '삼성전자', source: '고용24' }),
    posting('research', '임상시험 CRC 연구간호사 채용'),
    posting('pa-unknown', '간호직(전담) 채용', {
      company: '분당서울대학교병원', source: '분당서울대병원',
      workPattern: null, workHours: null,
      officialSourceUrl: 'https://recruit.snubh.org/jobs/pa?signature=fixture',
    }),
  ];
  await mockFeed(page, jobs);
  await page.route('**/api/job-detail', (route) => route.fulfill({ json: {} }));
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.getByTestId('discovery-all').click();

  const topCards = page.getByTestId('all-jobs-list').locator('[data-testid="application-tier-group-S"], [data-testid="application-tier-group-A"]').getByTestId('job-card');
  await expect(topCards).toHaveCount(3);
  await expect(topCards.filter({ hasText: '사업장 보건관리자' })).toHaveCount(1);
  await expect(topCards.filter({ hasText: '진료지원 전담간호사' })).toHaveCount(1);
  await expect(topCards.filter({ hasText: '외래 상근 간호사' })).toHaveCount(1);
  const clinicalCards = page.getByTestId('all-jobs-list').getByTestId('application-tier-group-B').getByTestId('job-card');
  await expect(clinicalCards).toHaveCount(3);
  const wardCard = clinicalCards.filter({ has: page.getByRole('heading', { name: '간호사 채용', exact: true }) });
  await expect(wardCard).toHaveAttribute('data-application-tier', 'B');
  await expect(wardCard).toContainText('병원 임상직 · S·A 추천 제외');
  const unknownPa = clinicalCards.filter({ hasText: '간호직(전담)' });
  await expect(unknownPa).toHaveAttribute('data-application-tier', 'B');
  await expect(unknownPa).toContainText('근무형태 확인 필요');
  await expect(unknownPa).not.toContainText('병원 임상직 · S·A 추천 제외');
  const crcCard = clinicalCards.filter({ hasText: '임상시험 CRC' });
  await expect(crcCard).toHaveAttribute('data-application-tier', 'B');
  await expect(crcCard).toContainText('CRC·연구간호사 · S·A 추천 제외');
  await wardCard.getByTestId('open-job-detail').click();
  await expect(page.getByTestId('application-tier-summary').locator('.application-tier-grade')).toHaveText('B');
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await page.locator('[data-testid="nav-full"]:visible').click();
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toHaveCount(6);
  expect(pageErrors).toEqual([]);
});

test('추천 공고 상단에 근거가 확인된 B/C 후보를 등급 구분 없이 점수순으로 보여준다', async ({ page, isMobile }) => {
  await mockFeed(page, [
    posting('opportunity-pa', '분당서울대병원 PA 간호사 채용', { workPattern: null, workHours: null }),
    posting('opportunity-day', '병동 간호사 채용'),
    posting('opportunity-unknown', '간호사 채용', { workPattern: null, workHours: null }),
    posting('opportunity-top', '외래 상근 간호사 채용'),
  ]);
  await page.route('**/api/job-detail', (route) => route.fulfill({ json: {} }));
  await page.goto('/');
  await page.getByTestId('discovery-all').click();

  const panel = page.getByTestId('overlooked-opportunities');
  await expect(panel.getByRole('heading', { name: '놓치기 아까운 후보' })).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('2건');
  const toggle = panel.getByRole('button', { name: /놓치기 아까운 후보 (펼치기|접기)/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByTestId('job-card')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByTestId('job-card')).toHaveCount(2);
  await expect(panel.getByTestId('job-card').first()).toContainText('PA 간호사');
  await expect(panel).toContainText('PA·전담 직무 명시');
  await expect(panel).toContainText('상근·주간 확인');
  await expect(panel).toContainText('근무표·교대 여부 원문 확인');
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toHaveCount(4);
  await page.locator('[data-testid="nav-full"]:visible').click();
  await expect(page.getByTestId('overlooked-opportunities')).toHaveCount(0);
});

test('상세에서 임상 담당업무가 확인되면 기존 A 묶음과 카드·상세 등급 모두 B로 제한된다', async ({ page }) => {
  const job = posting('clinical-detail', '정규직 간호사 채용', { company: '국립건강연구원', source: '고용24' });
  await mockFeed(page, [job]);
  await page.route('**/api/job-detail', (route) => route.fulfill({ json: {
    detailVerified: true,
    detailOrigin: 'original',
    employment: '정규직',
    workHours: '평일 09:00~18:00',
    duties: '중환자실 환자 간호 및 병동 업무',
    qualifications: '간호사 면허 소지자',
    salary: '연봉 6,000만원',
  } }));
  await page.goto('/');
  await page.getByTestId('discovery-all').click();
  const initialCard = page.getByTestId('all-jobs-list').getByTestId('application-tier-group-A').getByTestId('job-card');
  await expect(initialCard).toHaveAttribute('data-application-tier', 'A');
  await initialCard.getByTestId('open-job-detail').click();
  await expect(page.getByTestId('application-tier-summary').locator('.application-tier-grade')).toHaveText('B');
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await expect(page.getByTestId('all-jobs-list').getByTestId('application-tier-group-A')).toHaveCount(0);
  const updatedCard = page.getByTestId('all-jobs-list').getByTestId('application-tier-group-B').getByTestId('job-card');
  await expect(updatedCard).toHaveAttribute('data-application-tier', 'B');
  await expect(updatedCard).toContainText('병원 임상직 · S·A 추천 제외');
});

test('관심 직무와 PA 검색으로 한글 전담·진료지원 공고를 찾고 외래·보건과 구분한다', async ({ page }) => {
  await mockFeed(page, [
    posting('pa-korean', '간호직(전담) 채용'),
    posting('pa-duties', '정규직 간호직 채용', { duties: '진료지원 업무' }),
    posting('outpatient', '외래 간호사 채용'),
    posting('health', '사업장 보건관리자(산업간호사) 채용', { company: '삼성전자', source: '고용24' }),
    posting('infection', '감염관리 전담간호사 채용'),
  ]);
  await page.route('**/api/job-detail', (route) => route.fulfill({ json: {} }));
  await page.goto('/');
  await page.getByTestId('discovery-all').click();
  await selectCareRole(page, 'pa');
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toHaveCount(2);
  const search = page.getByRole('textbox', { name: '공고 검색어', exact: true });
  await search.fill('PA');
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toHaveCount(2);
  await selectCareRole(page, 'all');
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toHaveCount(2);
  await search.fill('');
  await selectCareRole(page, 'outpatient');
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toHaveCount(1);
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toContainText('외래 간호사');
  await selectCareRole(page, 'health');
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toHaveCount(1);
  await expect(page.getByTestId('all-jobs-list').getByTestId('job-card')).toContainText('보건관리자');
});

test('검증된 상세의 PA 업무와 주간근무는 기존 임상 B 묶음을 갱신한다', async ({ page }) => {
  const job = posting('verified-pa', '정규직 간호직 채용');
  await mockFeed(page, [job]);
  await page.route('**/api/job-detail', (route) => route.fulfill({ json: {
    detailVerified: true, detailOrigin: 'original', employment: '정규직',
    duties: '진료지원 전담 간호 업무', workHours: '평일 09:00~18:00',
    qualifications: '간호사 면허 소지자', salary: '연봉 6,000만원',
  } }));
  await page.goto('/');
  await page.getByTestId('discovery-all').click();
  await page.getByTestId('all-jobs-list').getByTestId('application-tier-group-B').getByTestId('open-job-detail').click();
  await expect(page.getByTestId('application-tier-summary').locator('.application-tier-grade')).toHaveText('S');
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await expect(page.getByTestId('all-jobs-list').getByTestId('application-tier-group-B')).toHaveCount(0);
  await expect(page.getByTestId('all-jobs-list').getByTestId('application-tier-group-S').getByTestId('job-card')).toHaveAttribute('data-application-tier', 'S');
});
