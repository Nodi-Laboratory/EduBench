import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';

const isEntrypoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

export async function seedDatabase(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`delete from provider_configs where provider_key in ('claude','openai','midm')`);
    const providers = [
      { key: 'exaone', name: 'EXAONE', protocol: 'openai-compatible', baseUrl: process.env.EXAONE_BASE_URL || 'https://api.friendli.ai/serverless/v1', modelId: process.env.EXAONE_MODEL || null },
      { key: 'gemini', name: 'Gemini', protocol: 'gemini', baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com', modelId: process.env.GEMINI_GENERATION_MODEL || null },
      { key: 'upstage', name: 'Upstage', protocol: 'openai-compatible', baseUrl: process.env.UPSTAGE_BASE_URL || 'https://api.upstage.ai/v1', modelId: process.env.UPSTAGE_MODEL || null },
    ];
    for (const provider of providers) {
      await client.query(`
        insert into provider_configs(provider_key, display_name, protocol, base_url, model_id, config)
        values ($1, $2, $3, $4, $5, '{"bootstrap":true,"source":"environment"}')
        on conflict(provider_key) do update set
          display_name = excluded.display_name,
          protocol = excluded.protocol,
          base_url = excluded.base_url,
          model_id = excluded.model_id,
          config = excluded.config,
          updated_at = now()
      `, [provider.key, provider.name, provider.protocol, provider.baseUrl, provider.modelId]);
    }

    await client.query(`
      insert into score_profiles(id, version, title, metrics, rubric_prompt, judge_provider, judge_model, content_hash)
      values (
        '20000000-0000-0000-0000-000000000001',
        'score-v1',
        'EduBench 선수관계 교육 적합성 프로필',
        '["accuracy","faithfulness","completeness","curriculum_alignment","student_fit","misconception","hallucination"]',
        '모델 식별자를 보지 않고 문항 청사진, 교과서 근거, 원자 채점 기준으로 절대평가한다.',
        'gemini',
        $1,
        encode(digest('edubench-score-profile-v1', 'sha256'), 'hex')
      ) on conflict(version) do update set
        title=excluded.title,
        metrics=excluded.metrics,
        rubric_prompt=excluded.rubric_prompt,
        judge_provider=excluded.judge_provider,
        judge_model=excluded.judge_model
    `, [process.env.GEMINI_GENERATION_MODEL || null]);
  });
}

if (isEntrypoint) {
  seedDatabase()
    .then(async () => {
      console.log('Bootstrapped EduBench runtime configuration without sample data.');
      await db.end();
    })
    .catch(async (error: unknown) => {
      console.error(error);
      await db.end();
      process.exitCode = 1;
    });
}
