import { NextResponse } from 'next/server';
import { getRunItemDetails } from '@/server/runs/details';

export const dynamic = 'force-dynamic';

function optionalInteger(value:string | null) {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export async function GET(
  request:Request,
  context:{ params:Promise<{ id:string; itemId:string }> },
) {
  const { id, itemId } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const details = await getRunItemDetails(id, itemId, {
    judgeLimit:optionalInteger(searchParams.get('judgeLimit')),
    judgeOffset:optionalInteger(searchParams.get('judgeOffset')),
  });
  return details
    ? NextResponse.json(details)
    : NextResponse.json({ code:'RUN_ITEM_NOT_FOUND' }, { status:404 });
}
