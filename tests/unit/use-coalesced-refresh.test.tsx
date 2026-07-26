// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useCoalescedRefresh } from '@/hooks/use-coalesced-refresh';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('runs one refresh at a time and folds an in-flight burst into one trailing refresh', async () => {
  vi.useFakeTimers();
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let concurrent = 0;
  let maximumConcurrent = 0;
  const refresh = vi.fn(async () => {
    concurrent += 1;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    if (refresh.mock.calls.length === 1) await first;
    concurrent -= 1;
  });

  function Harness() {
    const schedule = useCoalescedRefresh(refresh, 10);
    return <button type="button" onClick={schedule}>refresh</button>;
  }

  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(refresh).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(refresh).toHaveBeenCalledTimes(1);

  await act(async () => {
    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(refresh).toHaveBeenCalledTimes(2);
  expect(maximumConcurrent).toBe(1);
});

test('retries a failed refresh only up to the configured limit without overlapping attempts', async () => {
  vi.useFakeTimers();
  let concurrent = 0;
  let maximumConcurrent = 0;
  const refresh = vi.fn(async () => {
    concurrent += 1;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    await Promise.resolve();
    concurrent -= 1;
    throw new Error('temporary detail failure');
  });

  function Harness() {
    const schedule = useCoalescedRefresh(refresh, {
      delayMs: 10,
      retryDelayMs: 20,
      retryLimit: 2,
    });
    return <button type="button" onClick={schedule}>refresh</button>;
  }

  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  expect(refresh).toHaveBeenCalledTimes(3);
  expect(maximumConcurrent).toBe(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(refresh).toHaveBeenCalledTimes(3);
});
