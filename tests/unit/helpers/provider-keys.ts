import { expect } from 'vitest';

/** Features that call providers stay disabled until the browser has a key. */
export function saveTestProviderKeys() {
  localStorage.setItem('edubench:provider-keys', JSON.stringify({
    gemini:'test-gemini', upstage:'test-upstage', openai:'test-openai',
    exaone:'test-exaone', claude:'test-claude', midm:'test-midm',
  }));
}

export const postWithProviderKeys = {
  method:'POST',
  headers:expect.objectContaining({ 'x-edubench-provider-keys':expect.any(String) }),
};
