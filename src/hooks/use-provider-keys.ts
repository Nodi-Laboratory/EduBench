'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Provider API keys stay in this browser. They are sent only as a request
// header on calls that start provider work; the server keeps them in memory
// for that job and never stores them.
const STORAGE_KEY = 'edubench:provider-keys';
const HEADER_NAME = 'x-edubench-provider-keys';
const CHANGE_EVENT = 'edubench:provider-keys-changed';

export type StoredProviderKeys = Partial<Record<string, string>>;

const EMPTY: StoredProviderKeys = Object.freeze({});
let cachedRaw: string | null | undefined;
let cachedKeys: StoredProviderKeys = EMPTY;

export function readProviderKeys(): StoredProviderKeys {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (raw === cachedRaw) return cachedKeys;
  cachedRaw = raw;
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    cachedKeys = parsed && typeof parsed === 'object' ? parsed as StoredProviderKeys : EMPTY;
  } catch {
    cachedKeys = EMPTY;
  }
  return cachedKeys;
}

function writeProviderKeys(keys: StoredProviderKeys) {
  const clean = Object.fromEntries(
    Object.entries(keys).filter(([, value]) => typeof value === 'string' && value.trim()),
  );
  try {
    if (Object.keys(clean).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked (private mode); keys then cannot be kept.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Header to attach to requests that start document parsing, generation or runs. */
export function providerKeyHeaders(): Record<string, string> {
  const keys = readProviderKeys();
  return Object.keys(keys).length ? { [HEADER_NAME]: encodeBase64Url(JSON.stringify(keys)) } : {};
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function useProviderKeys() {
  const keys = useSyncExternalStore(subscribe, readProviderKeys, () => EMPTY);
  const setKey = useCallback((provider: string, value: string) => {
    writeProviderKeys({ ...readProviderKeys(), [provider]: value.trim() });
  }, []);
  const clearAll = useCallback(() => writeProviderKeys({}), []);
  const hasKey = useCallback((provider: string) => Boolean(keys[provider]), [keys]);
  return { keys, setKey, clearAll, hasKey };
}
