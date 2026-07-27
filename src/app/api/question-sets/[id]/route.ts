import { NextResponse } from 'next/server';
import { DomainError } from '@/domain/errors';
import { softDeleteQuestionSet } from '@/server/question-sets/service';
import {
  invalidQuestionSetPathResponse,
  questionSetPathSchema,
} from '@/app/api/question-sets/path-validation';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const params = questionSetPathSchema.safeParse(await context.params);
    if (!params.success) {
      return invalidQuestionSetPathResponse(params.error);
    }
    const { id } = params.data;
    return NextResponse.json({ item: await softDeleteQuestionSet(id) });
  } catch (error) {
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
