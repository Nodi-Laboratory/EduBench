import { assertProviderResponse, executeFetch } from './http';
import { ProviderError, type FetchLike } from './types';

export class GeminiEmbedder {
  readonly modelId: string;
  constructor(private readonly options: {
    apiKey:string;
    modelId:string;
    dimensions?:number;
    baseUrl?:string;
    fetch?:FetchLike;
    timeoutMs?:number;
  }) { this.modelId = options.modelId; }
  async embed(texts: string[], signal?: AbortSignal, taskType: 'RETRIEVAL_DOCUMENT'|'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT'): Promise<number[][]> {
    if (!texts.length) return [];
    const configuredTimeout = this.options.timeoutMs ?? 120_000;
    const timeoutMs = Number.isFinite(configuredTimeout)
      && configuredTimeout > 0
      ? configuredTimeout
      : 120_000;
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(
        new DOMException('Embedding request timed out.', 'TimeoutError'),
      ),
      timeoutMs,
    );
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    let response: Response;
    try {
      response = await executeFetch(() => (this.options.fetch ?? fetch)(
        `${(this.options.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(this.modelId)}:batchEmbedContents?key=${encodeURIComponent(this.options.apiKey)}`,
        {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          signal:requestSignal,
          body:JSON.stringify({
            requests:texts.map((text) => ({
              model:`models/${this.modelId}`,
              content:{ parts:[{ text }] },
              ...(this.modelId === 'gemini-embedding-2' ? {} : { taskType }),
              outputDimensionality:this.options.dimensions ?? 3072,
            })),
          }),
        },
      ));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    await assertProviderResponse(response, this.options.apiKey);
    const raw = await response.json() as { embeddings?: Array<{ values?: number[] }> };
    const vectors = raw.embeddings?.map((item) => item.values ?? []) ?? [];
    if (vectors.length !== texts.length || vectors.some((vector) => !vector.length)) throw new ProviderError({ kind: 'PARSE', message: 'PARSE: 임베딩 응답 개수가 일치하지 않습니다.', retryable: false });
    return vectors;
  }
}
