// The background worker runs inside the Next.js server process so it can use
// the provider API keys that route handlers keep in memory for each job
// (see src/server/providers/credentials.ts). Set EMBEDDED_WORKER=false to run
// the web server without it, e.g. when only browsing seeded data.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.EMBEDDED_WORKER?.toLowerCase() === 'false') return;
  const { runWorkerLoops } = await import('./worker');
  runWorkerLoops().catch((error: unknown) => {
    console.error('[EduBench worker] embedded worker stopped with an error', error);
  });
}
