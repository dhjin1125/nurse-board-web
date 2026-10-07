import { expect } from '@playwright/test';

const regionIds = { '서울': 'region-seoul', '서울·경기': 'region-seoul-gyeonggi', '전체': 'region-all' };
const roleLabels = { all: '모든 관심직무', pa: 'PA·전담', outpatient: '외래', health: '보건·산업간호' };

// Test the actual control at each viewport: native mobile selects or desktop buttons.
export async function selectRegion(page, value) {
  const select = page.getByRole('combobox', { name: '지역 선택', exact: true });
  if (await select.isVisible()) await select.selectOption(value);
  else await page.getByTestId(regionIds[value]).click();
}

export async function expectRegion(page, value) {
  const select = page.getByRole('combobox', { name: '지역 선택', exact: true });
  if (await select.isVisible()) await expect(select).toHaveValue(value);
  else await expect(page.getByTestId(regionIds[value])).toHaveAttribute('aria-pressed', 'true');
}

export async function selectCareRole(page, value) {
  const select = page.getByRole('combobox', { name: '직무 선택', exact: true });
  if (await select.isVisible()) await select.selectOption(value);
  else await page.getByRole('group', { name: '관심 직무', exact: true }).getByRole('button', { name: roleLabels[value], exact: true }).click();
}

export async function expectCareRole(page, value) {
  const select = page.getByRole('combobox', { name: '직무 선택', exact: true });
  if (await select.isVisible()) await expect(select).toHaveValue(value);
  else await expect(page.getByRole('group', { name: '관심 직무', exact: true }).getByRole('button', { name: roleLabels[value], exact: true })).toHaveAttribute('aria-pressed', 'true');
}
