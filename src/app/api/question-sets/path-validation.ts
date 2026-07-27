import { NextResponse } from 'next/server';
import { z } from 'zod';

const postgresUuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'PostgreSQL UUID 형식이어야 합니다.',
);

export const questionSetPathSchema = z.object({
  id: postgresUuid,
});

export const questionSetQuestionPathSchema = z.object({
  id: postgresUuid,
  questionId: postgresUuid,
});

export function invalidQuestionSetPathResponse(error: z.ZodError) {
  return NextResponse.json(
    { code: 'INVALID_QUESTION_SET_PATH', issues: error.issues },
    { status: 400 },
  );
}
