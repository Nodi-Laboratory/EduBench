export type ProviderKeyInfo = {
  provider: 'gemini' | 'upstage' | 'openai' | 'exaone' | 'claude' | 'midm';
  label: string;
  usage: string;
  issueUrl: string | null;
  issueLabel: string;
};

// Where each user-supplied key is used and where to get one. Shown on the
// settings screen and in the notices of features that need a key.
export const PROVIDER_KEY_CATALOG: readonly ProviderKeyInfo[] = [
  {
    provider:'gemini',
    label:'Google Gemini',
    usage:'임베딩, 문항 생성, Judge 채점, 벤치마크 대상 모델',
    issueUrl:'https://aistudio.google.com/apikey',
    issueLabel:'Google AI Studio',
  },
  {
    provider:'upstage',
    label:'Upstage',
    usage:'교과서 PDF 파싱(Document Parse), 벤치마크 대상 모델(Solar)',
    issueUrl:'https://console.upstage.ai/api-keys',
    issueLabel:'Upstage Console',
  },
  {
    provider:'openai',
    label:'OpenAI',
    usage:'벤치마크 대상 모델',
    issueUrl:'https://platform.openai.com/api-keys',
    issueLabel:'OpenAI Platform',
  },
  {
    provider:'exaone',
    label:'EXAONE (FriendliAI)',
    usage:'벤치마크 대상 모델',
    issueUrl:'https://friendli.ai/suite',
    issueLabel:'Friendli Suite',
  },
  {
    provider:'claude',
    label:'Anthropic Claude',
    usage:'선택 벤치마크 대상 모델',
    issueUrl:'https://console.anthropic.com/settings/keys',
    issueLabel:'Anthropic Console',
  },
  {
    provider:'midm',
    label:'Mi:dm',
    usage:'선택 벤치마크 대상 모델 (MIDM_BASE_URL 필요)',
    issueUrl:null,
    issueLabel:'계약 또는 자체 호스팅 endpoint',
  },
];

export function providerKeyLabel(provider: string): string {
  return PROVIDER_KEY_CATALOG.find((entry) => entry.provider === provider)?.label ?? provider;
}
