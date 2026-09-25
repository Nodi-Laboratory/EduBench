import { NextResponse } from 'next/server';
import { openQuestionSetAuditExport } from '@/server/datasets/audit';
import {
  invalidQuestionSetPathResponse,
  questionSetPathSchema,
} from '@/app/api/question-sets/path-validation';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const params = questionSetPathSchema.safeParse(await context.params);
  if (!params.success) {
    return invalidQuestionSetPathResponse(params.error);
  }
  const exportStream = await openQuestionSetAuditExport(params.data.id);
  if (!exportStream) {
    return NextResponse.json(
      {
        code: 'QUESTION_SET_NOT_FOUND',
        message: '질문 세트를 찾을 수 없습니다.',
      },
      { status: 404 },
    );
  }

  return new Response(exportStream.body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="edubench-question-set-${exportStream.id}.json"`,
    },
  });
}
