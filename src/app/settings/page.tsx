import type { Metadata } from 'next';
import { db } from '@/server/db/pool';
import { SettingsWorkspace } from '@/components/settings/settings-workspace';

export const metadata: Metadata = { title: '시스템 설정' };
export const dynamic = 'force-dynamic';

const envMap: Record<string, string[]> = {
  gemini: ['GOOGLE_API_KEY','GEMINI_GENERATION_MODEL'], claude: ['ANTHROPIC_API_KEY','ANTHROPIC_MODEL'],
  openai: ['OPENAI_API_KEY','OPENAI_MODEL'], upstage: ['UPSTAGE_API_KEY','UPSTAGE_MODEL'],
  exaone: ['EXAONE_API_KEY','EXAONE_BASE_URL','EXAONE_MODEL'], midm: ['MIDM_API_KEY','MIDM_BASE_URL','MIDM_MODEL'],
};

export default async function SettingsPage() {
  const [providers, scores, prices] = await Promise.all([
    db.query<{ provider_key: string; display_name: string; protocol: string }>('select provider_key, display_name, protocol from provider_configs order by display_name'),
    db.query<{ version: string; title: string; judge_provider: string | null; created_at: string }>('select version,title,judge_provider,created_at::text from score_profiles order by created_at desc'),
    db.query<{ version: string; provider_key: string; model_pattern: string; currency: string; input_per_million: string; output_per_million: string }>('select version,provider_key,model_pattern,currency,input_per_million::text,output_per_million::text from price_profiles order by created_at desc'),
  ]);
  const mock = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  return <SettingsWorkspace providers={providers.rows.map((provider) => ({ ...provider, configured: mock || envMap[provider.provider_key]!.every((key) => Boolean(process.env[key])), envNames: envMap[provider.provider_key]! }))} scores={scores.rows} prices={prices.rows} mockMode={mock} />;
}
