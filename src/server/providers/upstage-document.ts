import { assertProviderResponse, executeFetch, requestIdFrom } from './http';
import { ProviderError, type FetchLike } from './types';

export class UpstageDocumentParser {
  constructor(private readonly options: { apiKey: string; model?: string; baseUrl?: string; fetch?: FetchLike }) {}
  async parse(bytes: Uint8Array, filename: string, signal?: AbortSignal) {
    const form = new FormData();
    form.append('document', new Blob([bytes as BlobPart], { type: 'application/pdf' }), filename);
    form.append('model', this.options.model ?? 'document-parse');
    form.append('ocr', 'auto');
    const response = await executeFetch(() => (this.options.fetch ?? fetch)(
      `${(this.options.baseUrl ?? 'https://api.upstage.ai/v1').replace(/\/$/, '')}/document-digitization`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}` }, body: form, signal },
    ));
    await assertProviderResponse(response, this.options.apiKey);
    const raw = await response.json() as { html?: string; content?: { html?: string }; model?: string };
    const html = raw.content?.html ?? raw.html;
    if (!html) throw new ProviderError({ kind: 'PARSE', message: 'PARSE: Document Parse 응답에 HTML이 없습니다.', retryable: false });
    return { html, raw, requestId: requestIdFrom(response), model: raw.model ?? this.options.model ?? 'document-parse' };
  }
}
