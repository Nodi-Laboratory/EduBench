import { expect, test } from 'vitest';
import { NAV_ITEMS } from '@/components/shell/navigation';

test('exposes every benchmark workflow without auth or API checks', () => {
  expect(NAV_ITEMS.map((item) => item.href)).toEqual([
    '/dashboard',
    '/document-lab',
    '/sources',
    '/generation',
    '/review',
    '/datasets',
    '/runs',
    '/results',
    '/settings',
  ]);
});
