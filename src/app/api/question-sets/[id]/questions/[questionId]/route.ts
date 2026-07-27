import { NextResponse } from 'next/server';
import { DomainError } from '@/domain/errors';
import { removeQuestionFromSet } from '@/server/question-sets/service';
import {
  invalidQuestionSetPathResponse,
  questionSetQuestionPathSchema,
} from '@/app/api/question-sets/path-validation';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; questionId: string }> },
) {
  try {
    const params = questionSetQuestionPathSchema.safeParse(
      await context.params,
    );
    if (!params.success) {
      return invalidQuestionSetPathResponse(params.error);
    }
    const { id, questionId } = params.data;
    return NextResponse.json(
      await removeQuestionFromSet(id, questionId),
    );
  } catch (error) {
    if (error instanceof DomainError) {
      const status = [
        'QUESTION_SET_NOT_FOUND',
        'QUESTION_SET_QUESTION_NOT_FOUND',
      ].includes(error.code) ? 404 : 409;
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status },
      );
    }
    throw error;
  }
}
