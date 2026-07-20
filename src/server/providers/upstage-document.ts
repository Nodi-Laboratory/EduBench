import { assertProviderResponse, executeFetch, requestIdFrom } from './http';
import { ProviderError, type FetchLike } from './types';

export type DocumentParseOptions = {
  mimeType: string;
  pageNumber: number;
  signal?: AbortSignal;
};

export class UpstageDocumentParser {
  constructor(private readonly options: { apiKey: string; model?: string; baseUrl?: string; fetch?: FetchLike }) {}
  async parse(bytes: Uint8Array, filename: string, options?: DocumentParseOptions) {
    const parseOptions = options ?? { mimeType: 'application/pdf', pageNumber: 1 };
    const form = new FormData();
    const model = this.options.model ?? 'document-parse';
    const requestConfig = {
      model,
      ocr: 'force',
      mode: 'enhanced',
      base64_encoding: ['footnote'],
      output_formats: ['html'],
      mimeType: parseOptions.mimeType,
      pageNumber: parseOptions.pageNumber,
    };
    form.append('document', new Blob([bytes as BlobPart], { type: parseOptions.mimeType }), filename);
    form.append('model', model);
    form.append('ocr', requestConfig.ocr);
    form.append('mode', requestConfig.mode);
    form.append('base64_encoding', JSON.stringify(requestConfig.base64_encoding));
    form.append('output_formats', JSON.stringify(requestConfig.output_formats));
    const response = await executeFetch(() => (this.options.fetch ?? fetch)(
      `${(this.options.baseUrl ?? 'https://api.upstage.ai/v1').replace(/\/$/, '')}/document-digitization`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}` }, body: form, signal: parseOptions.signal },
    ));
    await assertProviderResponse(response, this.options.apiKey);
    const raw = await response.json() as { html?: string; content?: { html?: string }; elements?: unknown[]; model?: string };
    const html = raw.content?.html ?? raw.html;
    if (!html) throw new ProviderError({ kind: 'PARSE', message: 'PARSE: Document Parse 응답에 HTML이 없습니다.', retryable: false });
    return { html, elements: raw.elements ?? [], raw, requestId: requestIdFrom(response), model: raw.model ?? model, requestConfig };
  }
}
