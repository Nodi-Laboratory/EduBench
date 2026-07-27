import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DomainError } from '@/domain/errors';
import {
  createQuestionSet,
  listQuestionSets,
} from '@/server/question-sets/service';

const createQuestionSetSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
});

export async function GET() {
  return NextResponse.json({ items: await listQuestionSets() });
}

export async function POST(request: Request) {
  try {
    const input = createQuestionSetSchema.parse(await request.json());
    return NextResponse.json(
      { item: await createQuestionSet(input) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { code: 'INVALID_QUESTION_SET_INPUT', issues: error.issues },
        { status: 400 },
      );
    }
    if (error instanceof DomainError) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: 409 },
      );
    }
    throw error;
  }
}
