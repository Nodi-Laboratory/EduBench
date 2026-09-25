import { NextResponse } from 'next/server';
import {
  benchmarkRetrievalModes,
  type StoredBenchmarkRetrievalMode,
} from '@/domain/benchmark-retrieval';
import {
  defaultResultHeatmapPageSize,
  getResultQuestionHeatmapPage,
  maxResultHeatmapPageSize,
} from '@/server/results/analytics';

export const dynamic = 'force-dynamic';

const selectableModes = new Set<StoredBenchmarkRetrievalMode>([
  ...benchmarkRetrievalModes,
  'LEGACY_EVIDENCE',
]);

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function commaSeparated(value: string | null): string[] | undefined {
  const values = value?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
  return values.length ? [...new Set(values)] : undefined;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const modes = commaSeparated(searchParams.get('modes'))
    ?.filter((mode): mode is StoredBenchmarkRetrievalMode => selectableModes.has(
      mode as StoredBenchmarkRetrievalMode,
    ));
  const pageSize = Math.min(
    maxResultHeatmapPageSize,
    positiveInteger(searchParams.get('pageSize'), defaultResultHeatmapPageSize),
  );
  const result = await getResultQuestionHeatmapPage(id, {
    purpose:searchParams.get('purpose')?.trim() || undefined,
    retrievalModes:modes,
    blindIds:commaSeparated(searchParams.get('models')),
    page:positiveInteger(searchParams.get('page'), 1),
    pageSize,
  });
  return NextResponse.json(result);
}
