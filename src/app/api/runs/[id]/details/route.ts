import { NextResponse } from 'next/server';
import { getRunDetails } from '@/server/runs/details';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const includeHistory = new URL(request.url).searchParams.get('history') !== '0';
  const details = await getRunDetails(id, { includeHistory });
  return details
    ? NextResponse.json(details)
    : NextResponse.json({ code: 'RUN_NOT_FOUND' }, { status: 404 });
}
