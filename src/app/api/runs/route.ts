import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DomainError } from '@/domain/errors';
import { db } from '@/server/db/pool';
import { generationParametersSchema } from '@/server/providers/types';
import { createRun } from '@/server/runs/service';
import {
  providerEnvFromKeys,
  providerKeysFromRequest,
  rememberProviderKeys,
} from '@/server/providers/credentials';

const modelSchema = z.object({
  providerKey: z.string().min(1), displayName: z.string().min(1), modelId: z.string().min(1),
  protocol: z.enum(['gemini', 'anthropic', 'openai-responses', 'openai-compatible']),
  parameters: generationParametersSchema.optional(),
  concurrency: z.number().int().min(1).max(50).optional(),
  requestIntervalMs: z.number().int().min(0).max(60_000).optional(),
});
const postgresUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const retrievalModesSchema = z.array(
  z.enum(['NONE', 'VECTOR', 'PIKE']),
).min(1).max(3).refine(
  (modes) => new Set(modes).size === modes.length,
  { message:'검색 조건을 중복해서 선택할 수 없습니다.' },
);

const runSchema = z.object({
  title: z.string().trim().min(2).max(200), datasetVersionId: postgresUuid,
  scoreProfileId: postgresUuid, priceProfileVersion: z.string().min(1).max(80),
  systemPrompt: z.string().min(1).max(20_000), questionLimit: z.number().int().min(1).max(5000).optional(),
  retrievalModes:retrievalModesSchema.optional(),
  models: z.array(modelSchema).min(1).max(12),
});

export async function GET() {
  const result = await db.query(
    `select br.id, br.public_id, br.title, br.state, br.total_items, br.completed_items,
       br.failed_items, br.created_at,br.retrieval_modes,
       dv.version as dataset_version,
       count(rm.id)::int as model_count
     from benchmark_runs br join dataset_versions dv on dv.id = br.dataset_version_id
     left join run_models rm on rm.benchmark_run_id = br.id
     group by br.id, dv.version order by br.created_at desc`,
  );
  return NextResponse.json({ items: result.rows });
}

export async function POST(request: Request) {
  try {
    const input = runSchema.parse(await request.json());
    const keys = providerKeysFromRequest(request);
    const run = await createRun({ ...input, providerEnv:providerEnvFromKeys(keys) });
    rememberProviderKeys(`run:${run.id}`, keys);
    return NextResponse.json(run, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: 'INVALID_RUN_INPUT', issues: error.issues }, { status: 400 });
    if (error instanceof DomainError) return NextResponse.json({ code: error.code, message: error.message }, { status: 409 });
    throw error;
  }
}
