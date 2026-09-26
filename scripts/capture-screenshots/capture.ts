import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

/**
 * Captures README screenshots from a running instance (`docker compose up`).
 *
 *   npm run screenshots                 # http://localhost:63000
 *   BASE_URL=http://localhost:3000 npm run screenshots
 *
 * Logs in with the seeded demo account and saves 1440x900 PNGs to image/.
 * No API key is entered, so key-gated features show their "key required"
 * notice; result screens use the seeded demo run.
 */

const baseUrl = (process.env.BASE_URL ?? 'http://localhost:63000').replace(/\/+$/, '');
const outputDir = path.resolve(process.cwd(), 'image');

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  // Let charts finish their entry animation and live clocks render.
  await page.waitForTimeout(1_200);
}

async function shoot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: path.join(outputDir, `${name}.png`) });
  console.log(`saved image/${name}.png`);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--lang=ko-KR'] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/login`);
  await shoot(page, 'login');
  await page.getByLabel('아이디').fill('demo');
  await page.getByLabel('비밀번호').fill('demo1234');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.waitForURL(`${baseUrl}/dashboard`);
  // The control room streams events, so wait for its first snapshot instead of network idle.
  await page.getByText('실제 운영 데이터를 불러오는 중입니다.').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => undefined);
  await shoot(page, 'dashboard');

  await page.goto(`${baseUrl}/sources`);
  await page.getByRole('row').nth(1).click();
  await shoot(page, 'sources');

  await page.goto(`${baseUrl}/document-lab`);
  await shoot(page, 'document-lab');

  await page.goto(`${baseUrl}/generation`);
  await shoot(page, 'generation');

  await page.goto(`${baseUrl}/review`);
  await shoot(page, 'review');

  await page.goto(`${baseUrl}/datasets`);
  await shoot(page, 'datasets');

  await page.goto(`${baseUrl}/runs`);
  await shoot(page, 'runs');

  const runs = await (await page.request.get(`${baseUrl}/api/runs`)).json() as {
    items: Array<{ id: string; state: string }>;
  };
  const completed = runs.items.find((run) => run.state === 'COMPLETED');
  if (completed) {
    await page.goto(`${baseUrl}/runs/${completed.id}`);
    await shoot(page, 'run-detail');
    await page.goto(`${baseUrl}/results/${completed.id}`);
    await shoot(page, 'result-analytics');
  }

  await page.goto(`${baseUrl}/settings`);
  await shoot(page, 'settings-api-keys');

  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
