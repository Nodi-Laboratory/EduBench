import 'dotenv/config';
import { mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

function testDatabaseUrl(): string {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 또는 DATABASE_URL_TEST가 필요합니다.');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}

export default mergeConfig(baseConfig, {
  test: {
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    env: { DATABASE_URL: testDatabaseUrl(), MOCK_PROVIDERS: 'true' },
  },
});
