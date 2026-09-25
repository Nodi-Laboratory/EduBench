import { NextResponse } from 'next/server';
import type { StoredBenchmarkRetrievalMode } from '@/domain/benchmark-retrieval';
import { getRunDetails } from '@/server/runs/details';

export const dynamic = 'force-dynamic';

const retrievalModes = new Set<StoredBenchmarkRetrievalMode>([
  'LEGACY_EVIDENCE',
  'NONE',
  'VECTOR',
  'PIKE',
]);

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const includeHistory = searchParams.get('history') === '1';
  const pageValue = searchParams.get('page');
  const pageSizeValue = searchParams.get('pageSize');
  const runModelId = searchParams.get('runModelId');
  const stateValue = searchParams.get('state');
  const retrievalModeValue = searchParams.get('retrievalMode');
  const itemPage = pageValue == null ? undefined : Number(pageValue);
  const itemPageSize = pageSizeValue == null ? undefined : Number(pageSizeValue);
  const retrievalMode = retrievalModes.has(
    retrievalModeValue as StoredBenchmarkRetrievalMode,
  )
    ? retrievalModeValue as StoredBenchmarkRetrievalMode
    : undefined;
  const details = await getRunDetails(id, {
    includeHistory,
    itemPage:Number.isInteger(itemPage) ? itemPage : undefined,
    itemPageSize:Number.isInteger(itemPageSize) ? itemPageSize : undefined,
    runModelId:runModelId || undefined,
    itemState:stateValue || undefined,
    retrievalMode,
  });
  return details
    ? NextResponse.json(details)
    : NextResponse.json({ code: 'RUN_NOT_FOUND' }, { status: 404 });
}
