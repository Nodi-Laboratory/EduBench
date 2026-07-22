import { NextResponse } from 'next/server';
import { getRunDetails } from '@/server/runs/details';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const details = await getRunDetails(id);
  return details
    ? NextResponse.json(details)
    : NextResponse.json({ code: 'RUN_NOT_FOUND' }, { status: 404 });
}
