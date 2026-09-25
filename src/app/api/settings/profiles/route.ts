import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  hasJudgeMetrics,
  isJudgeProvenanceResolved,
  isRetiredScoreMetric,
} from '@/domain/score-profile';
import { db } from '@/server/db/pool';
import { isSupportedProviderKey } from '@/server/providers/registry';

const priceSchema = z.object({ kind: z.literal('price'), version: z.string().min(1), providerKey: z.string().min(1), modelPattern: z.string().min(1), currency: z.string().length(3), inputPerMillion: z.number().min(0), outputPerMillion: z.number().min(0), krwExchangeRate: z.number().positive().optional(), sourceUrl: z.string().url().optional() });
const scoreSchema = z.object({
  kind:z.literal('score'),
  version:z.string().trim().min(1),
  title:z.string().trim().min(2),
  metrics:z.array(z.string().trim().min(1)).min(1),
  weights:z.record(z.string().min(1), z.number().finite().nonnegative()).default({}),
  rubricPrompt:z.string().max(20_000).optional(),
  judgeProvider:z.string().trim().optional(),
  judgeModel:z.string().trim().optional(),
}).superRefine((profile, context) => {
  const provider = profile.judgeProvider || null;
  const model = profile.judgeModel || null;
  if (profile.metrics.some(isRetiredScoreMetric)) {
    context.addIssue({
      code:'custom',
      path:['metrics'],
      message:'exact_match는 폐기된 지표입니다. 의미 기반 Judge 지표 또는 response_present를 사용하십시오.',
    });
  }
  if ((provider == null) !== (model == null)) {
    context.addIssue({
      code:'custom',
      path:provider == null ? ['judgeProvider'] : ['judgeModel'],
      message:'Judge 제공자와 모델은 함께 지정해야 합니다.',
    });
  }
  if (provider && !isSupportedProviderKey(provider)) {
    context.addIssue({
      code:'custom',
      path:['judgeProvider'],
      message:'지원하지 않는 Judge 제공자 키입니다.',
    });
  }
  if (!isJudgeProvenanceResolved(provider, model)) {
    context.addIssue({
      code:'custom',
      path:['judgeModel'],
      message:'출처가 확인되지 않은 레거시 Judge 값은 사용할 수 없습니다. 새 프로필 버전을 만드십시오.',
    });
  }
  if (hasJudgeMetrics(profile.metrics) && (!provider || !model)) {
    context.addIssue({
      code:'custom',
      path:['judgeModel'],
      message:'Judge 지표가 있는 프로필에는 Judge 제공자와 모델이 모두 필요합니다.',
    });
  }
});

export async function GET() {
  const profiles = await db.query(
    `select id,version,title,metrics,weights,rubric_prompt,judge_provider,judge_model,
       content_hash,created_at,
       not score_profile_definition_usable(metrics,judge_provider,judge_model)
         provenance_unresolved
     from score_profiles order by created_at desc`,
  );
  return NextResponse.json({ items:profiles.rows });
}

export async function POST(request: Request) {
  const parsed = z.discriminatedUnion('kind', [priceSchema, scoreSchema]).safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ code: 'INVALID_PROFILE', issues: parsed.error.issues }, { status: 400 });
  try {
    if (parsed.data.kind === 'price') {
      const item = parsed.data;
      await db.query(
        `insert into price_profiles(version, provider_key, model_pattern, currency, input_per_million, output_per_million, krw_exchange_rate, valid_from, source_url)
         values ($1,$2,$3,$4,$5,$6,$7,now(),$8)`,
        [item.version, item.providerKey, item.modelPattern, item.currency.toUpperCase(), item.inputPerMillion, item.outputPerMillion, item.krwExchangeRate ?? null, item.sourceUrl ?? null],
      );
    } else {
      const item = parsed.data;
      const definition = {
        version:item.version,
        title:item.title,
        metrics:item.metrics,
        weights:item.weights,
        rubricPrompt:item.rubricPrompt || null,
        judgeProvider:item.judgeProvider || null,
        judgeModel:item.judgeModel || null,
      };
      const created = await db.query<{ id:string; content_hash:string }>(
        `insert into score_profiles(version,title,metrics,weights,rubric_prompt,judge_provider,judge_model)
         values ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)
         returning id,content_hash`,
        [
          definition.version,
          definition.title,
          JSON.stringify(definition.metrics),
          JSON.stringify(definition.weights),
          definition.rubricPrompt,
          definition.judgeProvider,
          definition.judgeModel,
        ],
      );
      return NextResponse.json({ created:true, profile:created.rows[0] }, { status:201 });
    }
    return NextResponse.json({ created: true }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return NextResponse.json({ code: 'PROFILE_CONFLICT', message: '같은 버전의 프로필이 이미 있습니다.' }, { status: 409 });
    throw error;
  }
}
