import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/server/db/pool';

const priceSchema = z.object({ kind: z.literal('price'), version: z.string().min(1), providerKey: z.string().min(1), modelPattern: z.string().min(1), currency: z.string().length(3), inputPerMillion: z.number().min(0), outputPerMillion: z.number().min(0), krwExchangeRate: z.number().positive().optional(), sourceUrl: z.string().url().optional() });
const scoreSchema = z.object({ kind: z.literal('score'), version: z.string().min(1), title: z.string().min(2), metrics: z.array(z.string().min(1)).min(1), rubricPrompt: z.string().max(20_000).optional(), judgeProvider: z.string().optional(), judgeModel: z.string().optional() });

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
      const item = parsed.data; const canonical = JSON.stringify(item);
      await db.query(
        `insert into score_profiles(version,title,metrics,rubric_prompt,judge_provider,judge_model,content_hash)
         values ($1,$2,$3::jsonb,$4,$5,$6,$7)`,
        [item.version, item.title, JSON.stringify(item.metrics), item.rubricPrompt ?? null, item.judgeProvider || null, item.judgeModel || null, createHash('sha256').update(canonical).digest('hex')],
      );
    }
    return NextResponse.json({ created: true }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return NextResponse.json({ code: 'PROFILE_CONFLICT', message: '같은 버전의 프로필이 이미 있습니다.' }, { status: 409 });
    throw error;
  }
}
