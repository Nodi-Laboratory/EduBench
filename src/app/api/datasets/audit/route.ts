import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getDatasetAuditQuestionDetail,
  listDatasetAuditQuestions,
} from '@/server/datasets/audit';

const scopeSchema = z.enum(['set', 'unassigned', 'version']);

function requireScopeId(
  query: { scope: z.infer<typeof scopeSchema>; scopeId?: string },
  context: z.RefinementCtx,
) {
  if (query.scope !== 'unassigned' && !query.scopeId) {
    context.addIssue({
      code: 'custom',
      path: ['scopeId'],
      message: `${query.scope} 범위에는 scopeId가 필요합니다.`,
    });
  }
}

const listQuerySchema = z.object({
  scope: scopeSchema,
  scopeId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  query: z.string().trim().max(500).optional(),
  purpose: z.string().trim().max(200).optional(),
  difficulty: z.string().trim().max(200).optional(),
  questionType: z.string().trim().max(200).optional(),
  evidenceMode: z.string().trim().max(200).optional(),
}).superRefine(requireScopeId);

const detailQuerySchema = z.object({
  scope: scopeSchema,
  scopeId: z.string().uuid().optional(),
  questionId: z.string().uuid(),
  revision: z.coerce.number().int().positive(),
}).superRefine(requireScopeId);

function queryObject(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

export async function GET(request: Request) {
  const query = queryObject(request);
  try {
    if (query.questionId) {
      const input = detailQuerySchema.parse(query);
      const item = await getDatasetAuditQuestionDetail(input);
      if (!item) {
        return NextResponse.json(
          { code: 'DATASET_AUDIT_QUESTION_NOT_FOUND', message: '문항 감사 상세를 찾을 수 없습니다.' },
          { status: 404 },
        );
      }
      return NextResponse.json({ item });
    }
    return NextResponse.json(await listDatasetAuditQuestions(
      listQuerySchema.parse(query),
    ));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { code: 'INVALID_DATASET_AUDIT_QUERY', issues: error.issues },
        { status: 400 },
      );
    }
    throw error;
  }
}
