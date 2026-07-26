import { describe, expect, test } from 'vitest';
import {
  compareEventCursors,
  parseEventCursor,
  selectRequestEventCursor,
} from '@/domain/event-cursor';

describe('event cursor', () => {
  test.each([
    ['0', '0'],
    ['9007199254740993', '9007199254740993'],
    ['9223372036854775807', '9223372036854775807'],
  ])('preserves canonical PostgreSQL bigint cursor %s as a string', (input, expected) => {
    expect(parseEventCursor(input)).toBe(expected);
    expect(typeof parseEventCursor(input)).toBe('string');
  });

  test.each([
    null,
    undefined,
    '',
    ' 1',
    '1 ',
    '-1',
    '1.5',
    '01',
    '9223372036854775808',
    'not-a-cursor',
  ])('rejects invalid cursor %s', (input) => {
    expect(parseEventCursor(input)).toBeNull();
  });

  test('compares large cursors without IEEE-754 precision loss', () => {
    expect(compareEventCursors('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareEventCursors('9223372036854775807', '9007199254740993')).toBe(1);
    expect(compareEventCursors('9007199254740993', '9007199254740993')).toBe(0);
  });

  test.each([
    {
      after: '9007199254740993',
      lastEventId: '9007199254740992',
      expected: '9007199254740993',
    },
    {
      after: '1',
      lastEventId: '9223372036854775807',
      expected: '9223372036854775807',
    },
    {
      after: 'invalid',
      lastEventId: '9007199254740993',
      expected: '9007199254740993',
    },
    {
      after: '9223372036854775808',
      lastEventId: '-1',
      expected: '0',
    },
  ])('selects the greatest valid query/header cursor: $expected', ({
    after,
    lastEventId,
    expected,
  }) => {
    expect(selectRequestEventCursor({ after, lastEventId })).toBe(expected);
  });
});
