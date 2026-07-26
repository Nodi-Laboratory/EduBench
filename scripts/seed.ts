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
      { key: 'exaone', name: 'EXAONE', protocol: 'openai-compatible', baseUrl: process.env.EXAONE_BASE_URL || 'https://api.friendli.ai/serverless/v1', modelId: 'LGAI-EXAONE/K-EXAONE-236B-A23B' },
      { key: 'gemini', name: 'Gemini', protocol: 'gemini', baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com', modelId: 'gemini-3.6-flash' },
      { key: 'upstage', name: 'Upstage', protocol: 'openai-compatible', baseUrl: process.env.UPSTAGE_BASE_URL || 'https://api.upstage.ai/v1', modelId: 'solar-pro3' },
    ];
    for (const provider of providers) {
      await client.query(`
        insert into provider_configs(provider_key, display_name, protocol, base_url, model_id, config)
        values ($1, $2, $3, $4, $5, '{"bootstrap":true,"source":"builtin-current-profile"}')
        on conflict(provider_key) do update set
          display_name = excluded.display_name,
          protocol = excluded.protocol,
          base_url = excluded.base_url,
          model_id = excluded.model_id,
          config = excluded.config,
          updated_at = now()
      `, [provider.key, provider.name, provider.protocol, provider.baseUrl, provider.modelId]);
    }

    const judgeModel = 'gemini-3.5-flash';
    const definition = {
      version:'score-v1',
      title:'EduBench 선수관계 교육 적합성 프로필',
      metrics:['accuracy','faithfulness','completeness','curriculum_alignment','student_fit','misconception','hallucination'],
      weights:{ response_present:0 },
      rubricPrompt:'모델 식별자를 보지 않고 문항 청사진, 교과서 근거, 원자 채점 기준으로 절대평가한다.',
      judgeProvider:'gemini',
      judgeModel,
    };
    await client.query(`
      insert into score_profiles(id, version, title, metrics, weights, rubric_prompt, judge_provider, judge_model)
      values (
        '20000000-0000-0000-0000-000000000001',
        $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7
      ) on conflict(version) do nothing
    `, [
      definition.version,
      definition.title,
      JSON.stringify(definition.metrics),
      JSON.stringify(definition.weights),
      definition.rubricPrompt,
      definition.judgeProvider,
      definition.judgeModel,
    ]);
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
