import { AsyncLocalStorage } from 'node:async_hooks';
import { supportedProviderKeys, type ProviderKey } from './registry';

/**
 * User-supplied provider API keys.
 *
 * Keys live in the browser's localStorage and arrive with each request that
 * starts provider work, in the `x-edubench-provider-keys` header. The server
 * never writes them to the database, job payloads, events or logs: it keeps
 * them in this process-local map, scoped to the source, generation batch or
 * benchmark run that needs them, until the TTL expires. A restart therefore
 * forgets every key; the affected work stops with a "key required" error and
 * resumes once the user retries it from the browser, which re-sends the keys.
 */
export const PROVIDER_KEYS_HEADER = 'x-edubench-provider-keys';

export type ProviderKeys = Partial<Record<ProviderKey, string>>;
export type ProviderEnv = Record<string, string | undefined>;
export type CredentialScope =
  | `source:${string}`
  | `generation:${string}`
  | `run:${string}`;

const KEY_ENV_NAMES: Record<ProviderKey, string> = {
  gemini:'GOOGLE_API_KEY',
  claude:'ANTHROPIC_API_KEY',
  openai:'OPENAI_API_KEY',
  upstage:'UPSTAGE_API_KEY',
  exaone:'EXAONE_API_KEY',
  midm:'MIDM_API_KEY',
};

const SECRET_ENV_NAMES = new Set(Object.values(KEY_ENV_NAMES));
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1_000;

type VaultEntry = { keys: ProviderKeys; expiresAt: number };

// Route handlers and the embedded worker can be bundled separately, so the
// map is anchored on globalThis to stay a single instance per process.
const vaultSymbol = Symbol.for('edubench.providerKeyVault');
function vault(): Map<string, VaultEntry> {
  const holder = globalThis as typeof globalThis & { [vaultSymbol]?: Map<string, VaultEntry> };
  holder[vaultSymbol] ??= new Map();
  return holder[vaultSymbol];
}

function sanitize(keys: unknown): ProviderKeys {
  if (!keys || typeof keys !== 'object') return {};
  const result: ProviderKeys = {};
  for (const provider of supportedProviderKeys) {
    const value = (keys as Record<string, unknown>)[provider];
    if (typeof value === 'string' && value.trim() && value.length <= 512) {
      result[provider] = value.trim();
    }
  }
  return result;
}

export function parseProviderKeysHeader(value: string | null | undefined): ProviderKeys {
  if (!value) return {};
  try {
    return sanitize(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    return {};
  }
}

export function providerKeysFromRequest(request: Request): ProviderKeys {
  return parseProviderKeysHeader(request.headers.get(PROVIDER_KEYS_HEADER));
}

function pruneExpired(now = Date.now()) {
  for (const [scope, entry] of vault()) {
    if (entry.expiresAt <= now) vault().delete(scope);
  }
}

export function rememberProviderKeys(
  scope: CredentialScope,
  keys: ProviderKeys,
  ttlMs = DEFAULT_TTL_MS,
): void {
  pruneExpired();
  const clean = sanitize(keys);
  if (!Object.keys(clean).length) return;
  const existing = vault().get(scope)?.keys ?? {};
  vault().set(scope, { keys: { ...existing, ...clean }, expiresAt: Date.now() + ttlMs });
}

export function forgetProviderKeys(scope: CredentialScope): void {
  vault().delete(scope);
}

export function providerKeysFor(scope: CredentialScope): ProviderKeys {
  const entry = vault().get(scope);
  if (!entry || entry.expiresAt <= Date.now()) return {};
  return entry.keys;
}

/**
 * Builds the env-shaped map the provider adapters read. Non-secret settings
 * (base URLs, model ids, MOCK_PROVIDERS) still come from process.env; API key
 * variables come only from the user-supplied keys, never from process.env.
 */
export function providerEnvFromKeys(keys: ProviderKeys): ProviderEnv {
  const env: ProviderEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!SECRET_ENV_NAMES.has(name)) env[name] = value;
  }
  for (const provider of supportedProviderKeys) {
    const key = keys[provider];
    if (key) env[KEY_ENV_NAMES[provider]] = key;
  }
  return env;
}

export function providerEnvFor(scope: CredentialScope): ProviderEnv {
  return providerEnvFromKeys(providerKeysFor(scope));
}

// Keys sent with the current HTTP request. Job enqueueing reads them so the
// keys are scoped to the new job before any worker can claim it.
const requestKeysSymbol = Symbol.for('edubench.requestProviderKeys');
function requestKeysStorage(): AsyncLocalStorage<ProviderKeys> {
  const holder = globalThis as typeof globalThis & {
    [requestKeysSymbol]?: AsyncLocalStorage<ProviderKeys>;
  };
  holder[requestKeysSymbol] ??= new AsyncLocalStorage();
  return holder[requestKeysSymbol];
}

export function withRequestProviderKeys<T>(request: Request, run: () => Promise<T>): Promise<T> {
  return requestKeysStorage().run(providerKeysFromRequest(request), run);
}

export function currentRequestProviderKeys(): ProviderKeys {
  return requestKeysStorage().getStore() ?? {};
}

export function credentialScopeForJob(
  kind: string,
  payload: Record<string, unknown>,
): CredentialScope | null {
  if (kind === 'document.parse' && typeof payload.sourceId === 'string') return `source:${payload.sourceId}`;
  if (kind === 'question.generate' && typeof payload.batchId === 'string') return `generation:${payload.batchId}`;
  return null;
}

export function isMockProviders(env: ProviderEnv = process.env): boolean {
  return env.MOCK_PROVIDERS?.toLowerCase() === 'true';
}

export function providerKeyEnvName(provider: ProviderKey): string {
  return KEY_ENV_NAMES[provider];
}
