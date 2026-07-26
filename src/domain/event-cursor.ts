export const POSTGRES_BIGINT_MAX_CURSOR = '9223372036854775807';
export const INITIAL_EVENT_CURSOR = '0';

declare const eventCursorBrand: unique symbol;
export type EventCursor = string & { readonly [eventCursorBrand]: true };

function asEventCursor(value: string): EventCursor {
  return value as EventCursor;
}

export function compareEventCursors(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function parseEventCursor(value: string | null | undefined): EventCursor | null {
  if (value == null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  if (compareEventCursors(value, POSTGRES_BIGINT_MAX_CURSOR) > 0) return null;
  return asEventCursor(value);
}

export function selectRequestEventCursor(input: {
  after: string | null | undefined;
  lastEventId: string | null | undefined;
}): EventCursor {
  const after = parseEventCursor(input.after);
  const lastEventId = parseEventCursor(input.lastEventId);
  if (!after) return lastEventId ?? asEventCursor(INITIAL_EVENT_CURSOR);
  if (!lastEventId) return after;
  return compareEventCursors(after, lastEventId) >= 0 ? after : lastEventId;
}
