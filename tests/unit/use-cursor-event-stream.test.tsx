// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  activityCursorStorageKey,
  useCursorEventStream,
  type CursorActivityEvent,
} from '@/hooks/use-cursor-event-stream';

class EventSourceStub {
  static instances: EventSourceStub[] = [];

  readonly url: string;
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function activityEvent(input: {
  id: string;
  aggregate?: 'source' | 'generation' | 'benchmark_run';
  aggregateId?: string;
  eventType?: string;
}) {
  const envelope: CursorActivityEvent = {
    id: input.id,
    aggregate: input.aggregate ?? 'source',
    aggregateId: input.aggregateId ?? 'source-a',
    eventType: input.eventType ?? 'NEW_EVENT_TYPE',
    payload: { id: input.id },
    createdAt: '2026-07-26T00:00:00.000Z',
  };
  return new MessageEvent('activity', {
    data: JSON.stringify(envelope),
    lastEventId: input.id,
  });
}

function Harness({
  aggregate = 'source',
  id,
  initialCursor,
}: {
  aggregate?: 'source' | 'generation' | 'benchmark_run';
  id: string;
  initialCursor: string;
}) {
  const [received, setReceived] = useState<CursorActivityEvent[]>([]);
  const stream = useCursorEventStream({
    aggregate,
    id,
    initialCursor,
    onEvent(event) {
      setReceived((current) => [...current, event]);
    },
  });
  return <>
    <span data-testid="status">{stream.status}</span>
    <span data-testid="cursor">{stream.cursor}</span>
    <span data-testid="events">{received.map((item) => item.eventType).join(',')}</span>
  </>;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  EventSourceStub.instances = [];
  vi.unstubAllGlobals();
});

test('resumes from the greatest exact session/snapshot cursor and deduplicates reconnect delivery', () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  sessionStorage.setItem(
    activityCursorStorageKey('source', 'source-a'),
    '9007199254740993',
  );
  render(<Harness id="source-a" initialCursor="9007199254740992" />);

  const source = EventSourceStub.instances[0]!;
  expect(source.url).toBe('/api/events/source/source-a?after=9007199254740993');
  expect(screen.getByTestId('status')).toHaveTextContent('connecting');
  act(() => source.emit('open', new Event('open')));
  expect(screen.getByTestId('status')).toHaveTextContent('live');

  act(() => {
    source.emit('activity', activityEvent({ id: '9007199254740993' }));
    source.emit('activity', activityEvent({ id: '9007199254740992' }));
  });
  expect(screen.getByTestId('events')).toBeEmptyDOMElement();

  act(() => source.emit('activity', activityEvent({
    id: '9007199254740994',
    eventType: 'BRAND_NEW_SERVER_EVENT',
  })));
  expect(screen.getByTestId('events')).toHaveTextContent('BRAND_NEW_SERVER_EVENT');
  expect(screen.getByTestId('cursor')).toHaveTextContent('9007199254740994');
  expect(sessionStorage.getItem(activityCursorStorageKey('source', 'source-a')))
    .toBe('9007199254740994');

  act(() => source.emit('error', new Event('error')));
  expect(screen.getByTestId('status')).toHaveTextContent('reconnecting');
  act(() => {
    source.emit('open', new Event('open'));
    source.emit('activity', activityEvent({
      id: '9007199254740994',
      eventType: 'DUPLICATE_AFTER_RECONNECT',
    }));
  });
  expect(screen.getByTestId('status')).toHaveTextContent('live');
  expect(screen.getByTestId('events')).not.toHaveTextContent('DUPLICATE_AFTER_RECONNECT');
  expect(EventSourceStub.instances).toHaveLength(1);
});

test('closes the prior target and ignores its late events after a target switch', () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const view = render(<Harness id="source-a" initialCursor="12" />);
  const previous = EventSourceStub.instances[0]!;

  view.rerender(<Harness id="source-b" initialCursor="20" />);
  const current = EventSourceStub.instances[1]!;

  expect(previous.close).toHaveBeenCalledTimes(1);
  expect(current.url).toBe('/api/events/source/source-b?after=20');
  act(() => previous.emit('activity', activityEvent({
    id: '21',
    aggregateId: 'source-a',
    eventType: 'LATE_OLD_TARGET',
  })));
  expect(screen.getByTestId('events')).not.toHaveTextContent('LATE_OLD_TARGET');

  act(() => current.emit('activity', activityEvent({
    id: '21',
    aggregateId: 'source-b',
    eventType: 'CURRENT_TARGET',
  })));
  expect(screen.getByTestId('events')).toHaveTextContent('CURRENT_TARGET');
  expect(sessionStorage.getItem(activityCursorStorageKey('source', 'source-b'))).toBe('21');
});
