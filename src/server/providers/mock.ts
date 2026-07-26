import { createHash } from 'node:crypto';
import type { GenerationRequest, ModelProvider, NormalizedGeneration } from './types';

export class MockProvider implements ModelProvider {
  readonly key: string;
  readonly modelId: string;
  constructor(key: string, modelId = `mock-${key}`) { this.key = key; this.modelId = modelId; }
  async generate(request: GenerationRequest): Promise<NormalizedGeneration> {
    const requestId = `mock-${createHash('sha256').update(`${this.key}:${request.prompt}`).digest('hex').slice(0, 16)}`;
    let text = `[MOCK ${this.key}] API 키 없이 로컬 실행 흐름을 검증한 응답입니다. 공식 평가 결과로 사용할 수 없습니다.`;
    if (request.system.includes('EDUBENCH_JUDGE_JSON')) {
      const parsed = JSON.parse(request.prompt) as { requiredMetrics?: string[] };
      text = JSON.stringify({ scores:(parsed.requiredMetrics ?? []).map((metricKey)=>({metricKey,value:0.5,label:'MOCK_ONLY',rationale:'MOCK 모드의 파이프라인 검증값이며 공식 결과로 사용할 수 없습니다.',evidence:[]})) });
    }
    return {
      text, raw: { mock: true, provider: this.key, requestId }, inputTokens: Math.ceil((request.system.length + request.prompt.length) / 3),
      outputTokens: Math.ceil(text.length / 3), finishReason: 'mock_complete', requestId,
      modelId: this.modelId, modelSnapshot: 'mock-local', latencyMs: 0,
    };
  }
}
