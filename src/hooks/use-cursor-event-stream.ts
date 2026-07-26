'use client';

import { useEffect, useEffectEvent, useState } from 'react';
import {
  compareEventCursors,
  INITIAL_EVENT_CURSOR,
  parseEventCursor,
  selectRequestEventCursor,
  type EventCursor,
} from '@/domain/event-cursor';

export type CursorActivityAggregate = 'source' | 'generation' | 'benchmark_run';
export type CursorActivityEvent = {
  id: EventCursor | string;
  aggregate: CursorActivityAggregate;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
export type CursorEventStreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting';

export function activityCursorStorageKey(
  aggregate: CursorActivityAggregate,
  aggregateId: string,
) {
  return `edubench:activity-cursor:${aggregate}:${aggregateId}`;
}

function readStoredCursor(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeCursor(key: string, cursor: string) {
  try {
    sessionStorage.setItem(key, cursor);
  } catch {
    // A private browsing policy may disable storage; the in-memory cursor still works.
  }
}

function parseActivityEvent(
  data: string,
  aggregate: CursorActivityAggregate,
  aggregateId: string,
): CursorActivityEvent | null {
  try {
    const value = JSON.parse(data) as Partial<CursorActivityEvent>;
    const id = parseEventCursor(value.id);
    if (
      !id
      || value.aggregate !== aggregate
      || value.aggregateId !== aggregateId
      || typeof value.eventType !== 'string'
      || typeof value.createdAt !== 'string'
      || !value.payload
      || typeof value.payload !== 'object'
      || Array.isArray(value.payload)
    ) {
      return null;
    }
    return {
      id,
      aggregate,
      aggregateId,
      eventType: value.eventType,
      payload: value.payload,
      createdAt: value.createdAt,
    };
  } catch {
    return null;
  }
}

export function useCursorEventStream(input: {
  aggregate: CursorActivityAggregate;
  id: string | null;
  initialCursor?: string | null;
  enabled?: boolean;
  onEvent: (event: CursorActivityEvent) => void;
}) {
  const [connection, setConnection] = useState<{
    targetKey: string;
    status: CursorEventStreamStatus;
    cursor: string;
  }>({
    targetKey: '',
    status: 'idle',
    cursor: INITIAL_EVENT_CURSOR,
  });
  const onActivityEvent = useEffectEvent(input.onEvent);
  const enabled = input.enabled !== false && Boolean(input.id);
  const targetKey = enabled ? `${input.aggregate}:${input.id}` : '';
  const configuredCursor = parseEventCursor(input.initialCursor) ?? INITIAL_EVENT_CURSOR;
  const status: CursorEventStreamStatus = !enabled
    ? 'idle'
    : connection.targetKey === targetKey
      ? connection.status
      : 'connecting';
  const cursor = connection.targetKey === targetKey
    ? connection.cursor
    : configuredCursor;

  useEffect(() => {
    if (input.enabled === false || !input.id) return;
    const aggregate = input.aggregate;
    const aggregateId = input.id;
    const currentTargetKey = `${aggregate}:${aggregateId}`;
    const storageKey = activityCursorStorageKey(aggregate, aggregateId);
    const startingCursor = selectRequestEventCursor({
      after: input.initialCursor,
      lastEventId: readStoredCursor(storageKey),
    });
    let acceptedCursor = startingCursor;
    let active = true;
    storeCursor(storageKey, startingCursor);

    const source = new EventSource(
      `/api/events/${encodeURIComponent(aggregate)}/${encodeURIComponent(aggregateId)}`
      + `?after=${encodeURIComponent(startingCursor)}`,
    );
    const handleOpen = () => {
      if (active) {
        setConnection({
          targetKey: currentTargetKey,
          status: 'live',
          cursor: acceptedCursor,
        });
      }
    };
    const handleError = () => {
      if (active) {
        setConnection({
          targetKey: currentTargetKey,
          status: 'reconnecting',
          cursor: acceptedCursor,
        });
      }
    };
    const handleActivity = (rawEvent: Event) => {
      if (!active) return;
      const message = rawEvent as MessageEvent<string>;
      const event = parseActivityEvent(message.data, aggregate, aggregateId);
      if (!event || compareEventCursors(event.id, acceptedCursor) <= 0) return;
      acceptedCursor = event.id as EventCursor;
      storeCursor(storageKey, acceptedCursor);
      setConnection({
        targetKey: currentTargetKey,
        status: 'live',
        cursor: acceptedCursor,
      });
      onActivityEvent(event);
    };
    source.addEventListener('open', handleOpen);
    source.addEventListener('error', handleError);
    source.addEventListener('activity', handleActivity);

    return () => {
      active = false;
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('error', handleError);
      source.removeEventListener('activity', handleActivity);
      source.close();
    };
  }, [input.aggregate, input.enabled, input.id, input.initialCursor]);

  return { status, cursor };
}
