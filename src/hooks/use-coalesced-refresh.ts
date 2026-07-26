'use client';

import { useCallback, useEffect, useRef } from 'react';

type CoalescedRefreshOptions = {
  delayMs?: number;
  retryDelayMs?: number;
  retryLimit?: number;
};

export function useCoalescedRefresh(
  refresh: () => void | Promise<void>,
  options: number | CoalescedRefreshOptions = 150,
) {
  const delayMs = typeof options === 'number'
    ? options
    : options.delayMs ?? 150;
  const retryDelayMs = typeof options === 'number'
    ? options
    : options.retryDelayMs ?? delayMs;
  const retryLimit = typeof options === 'number'
    ? 0
    : Math.max(0, Math.floor(options.retryLimit ?? 0));
  const refreshRef = useRef(refresh);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const retryAttemptRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = false;
      retryAttemptRef.current = 0;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const schedule = useCallback(() => {
    if (!mountedRef.current) return;
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    if (timerRef.current) return;
    retryAttemptRef.current = 0;
    const run = () => {
      timerRef.current = null;
      if (!mountedRef.current) return;
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      Promise.resolve()
        .then(() => refreshRef.current())
        .then(
          () => true,
          () => false,
        )
        .then((succeeded) => {
          inFlightRef.current = false;
          if (!mountedRef.current) return;
          if (!succeeded && retryAttemptRef.current < retryLimit) {
            retryAttemptRef.current += 1;
            pendingRef.current = false;
            timerRef.current = setTimeout(run, retryDelayMs);
            return;
          }
          retryAttemptRef.current = 0;
          if (!pendingRef.current) return;
          pendingRef.current = false;
          timerRef.current = setTimeout(run, delayMs);
        });
    };
    timerRef.current = setTimeout(run, delayMs);
  }, [delayMs, retryDelayMs, retryLimit]);

  return schedule;
}
