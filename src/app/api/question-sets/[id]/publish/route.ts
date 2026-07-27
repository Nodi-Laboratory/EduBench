import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DomainError } from '@/domain/errors';
import { publishQuestionSet } from '@/server/question-sets/service';
import {
  invalidQuestionSetPathResponse,
  questionSetPathSchema,
} from '@/app/api/question-sets/path-validation';

const publishSchema = z.object({
  version: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const params = questionSetPathSchema.safeParse(await context.params);
    if (!params.success) {
      return invalidQuestionSetPathResponse(params.error);
    }
    const { id } = params.data;
    const input = publishSchema.parse(await request.json());
    const result = await publishQuestionSet(id, input);
    return NextResponse.json(
      result,
      { status: result.existing ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { code: 'INVALID_DATASET_INPUT', issues: error.issues },
        { status: 400 },
      );
    }
    if (error instanceof DomainError) {
      const status = error.code === 'QUESTION_SET_NOT_FOUND' ? 404 : 409;
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status },
      );
    }
    throw error;
  }
}
