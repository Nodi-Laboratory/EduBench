import { afterEach, expect, test, vi } from 'vitest';
import {
  PROVIDER_KEYS_HEADER,
  credentialScopeForJob,
  currentRequestProviderKeys,
  forgetProviderKeys,
  parseProviderKeysHeader,
  providerEnvFor,
  providerEnvFromKeys,
  rememberProviderKeys,
  withRequestProviderKeys,
} from '@/server/providers/credentials';

function header(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

afterEach(() => {
  vi.unstubAllEnvs();
  forgetProviderKeys('run:test-run');
});

test('parses only known providers from the request header', () => {
  expect(parseProviderKeysHeader(header({ gemini:' g-key ', unknown:'x', openai:'' }))).toEqual({ gemini:'g-key' });
  expect(parseProviderKeysHeader('not-base64-json')).toEqual({});
  expect(parseProviderKeysHeader(null)).toEqual({});
});

test('never takes API keys from the server environment', () => {
  vi.stubEnv('GOOGLE_API_KEY', 'server-key');
  vi.stubEnv('GEMINI_BASE_URL', 'https://gemini.test');
  const env = providerEnvFromKeys({});
  expect(env.GOOGLE_API_KEY).toBeUndefined();
  expect(env.GEMINI_BASE_URL).toBe('https://gemini.test');
  expect(providerEnvFromKeys({ gemini:'user-key' }).GOOGLE_API_KEY).toBe('user-key');
});

test('keeps keys per scope in memory until they are forgotten', () => {
  rememberProviderKeys('run:test-run', { openai:'o-key' });
  rememberProviderKeys('run:test-run', { gemini:'g-key' });
  expect(providerEnvFor('run:test-run')).toMatchObject({ OPENAI_API_KEY:'o-key', GOOGLE_API_KEY:'g-key' });
  forgetProviderKeys('run:test-run');
  expect(providerEnvFor('run:test-run').OPENAI_API_KEY).toBeUndefined();
});

test('exposes request keys only inside the request context', async () => {
  const request = new Request('http://localhost', { headers:{ [PROVIDER_KEYS_HEADER]:header({ upstage:'u-key' }) } });
  await withRequestProviderKeys(request, async () => {
    expect(currentRequestProviderKeys()).toEqual({ upstage:'u-key' });
  });
  expect(currentRequestProviderKeys()).toEqual({});
});

test('maps provider jobs to the scope the worker reads', () => {
  expect(credentialScopeForJob('document.parse', { sourceId:'s1' })).toBe('source:s1');
  expect(credentialScopeForJob('question.generate', { batchId:'b1' })).toBe('generation:b1');
  expect(credentialScopeForJob('other', {})).toBeNull();
});
