import { NextResponse } from 'next/server';
import { getResultDetails } from '@/server/results/details';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const details = await getResultDetails(id);
  return details
    ? NextResponse.json(details)
    : NextResponse.json({ code: 'RESULT_NOT_FOUND' }, { status: 404 });
}
