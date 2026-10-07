import { test, expect } from '@playwright/test';

for (const path of ['/', '/recruitment/casemanager-894']) {
  test(`${path} 공유 미리보기 메타데이터를 HTML에서 바로 제공한다`, async ({ page }) => {
    const response = await page.goto(path);
    const html = await response.text();

    expect(html).toContain('<meta property="og:title" content="다은이를 위한 간호 채용 사이트"');
    expect(html).toContain('<meta property="og:description" content="간호·PA·외래·주간근무 공고를 모아보고 근무 조건과 마감일을 한눈에 확인하세요."');
    expect(html).toContain('<meta property="og:url" content="https://nurse-board-ten.vercel.app/"');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', '다은이를 위한 간호 채용 사이트');
  });
}
