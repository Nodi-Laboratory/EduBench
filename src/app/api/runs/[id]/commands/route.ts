import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DomainError } from '@/domain/errors';
import { commandRun, retryFailedRunItems, retryScoringRun } from '@/server/runs/service';

const schema = z.object({ command: z.enum(['QUEUE','START','PAUSE','FINISH_PAUSE','STOP','FINISH_STOP','RESUME','CANCEL','FINISH_CANCEL','BEGIN_SCORING','COMPLETE','FAIL','RETRY_FAILED','RETRY_SCORING']) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { command } = schema.parse(await request.json());
    if (command === 'RETRY_FAILED') return NextResponse.json({ retried: await retryFailedRunItems(id) });
    if (command === 'RETRY_SCORING') return NextResponse.json(await retryScoringRun(id));
    return NextResponse.json(await commandRun(id, command));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: 'INVALID_RUN_COMMAND', issues: error.issues }, { status: 400 });
    if (error instanceof DomainError) return NextResponse.json({ code: error.code, message: error.message }, { status: 409 });
    throw error;
  }
}
