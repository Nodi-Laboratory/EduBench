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

test('groups the existing URLs by research workflow responsibility', () => {
  expect(NAV_ITEMS.map(({ href, group }) => ({ href, group }))).toEqual([
    { href: '/dashboard', group: 'Monitor' },
    { href: '/document-lab', group: 'Corpus' },
    { href: '/sources', group: 'Corpus' },
    { href: '/generation', group: 'Question Pipeline' },
    { href: '/review', group: 'Question Pipeline' },
    { href: '/datasets', group: 'Question Pipeline' },
    { href: '/runs', group: 'Experiments' },
    { href: '/results', group: 'Experiments' },
    { href: '/settings', group: 'Methods' },
  ]);
});
