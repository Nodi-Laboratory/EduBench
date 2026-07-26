import { assertProviderResponse, executeFetch, requestIdFrom } from './http';
import { ProviderError, type FetchLike } from './types';
import { DOCUMENT_PARSE_BASE64_ENCODING } from '@/domain/document-parse-config';
import {
  upstageDocumentParseRequestGate,
  type RequestConcurrencyGate,
} from './concurrency-gate';

export type UpstageDocumentParserOptions = {
  apiKey:string;
  model?:string;
  baseUrl?:string;
  fetch?:FetchLike;
  timeoutMs?:number;
  mode?:'standard' | 'enhanced' | 'auto';
  ocr?:'auto' | 'force';
  base64Encoding?:readonly ('table' | 'figure' | 'chart' | 'equation')[];
  outputFormats?:readonly ('html' | 'markdown')[];
  requestGate?:RequestConcurrencyGate;
};

export type DocumentParseOptions = {
  mimeType: string;
  pageNumber: number;
  signal?: AbortSignal;
};

function markdownToHtml(markdown: string): string {
  const escape = (value: string) => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  return `<article data-source-format="markdown">${lines.map((line) => {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      return `<h${level}>${escape(heading[2]!)}</h${level}>`;
    }
    return line.trim() ? `<p>${escape(line)}</p>` : '';
  }).join('')}</article>`;
}

export class UpstageDocumentParser {
  constructor(private readonly options: UpstageDocumentParserOptions) {}
  async parse(bytes: Uint8Array, filename: string, options: DocumentParseOptions) {
    const form = new FormData();
    const model = this.options.model ?? 'document-parse';
    const requestConfig = {
      model,
      ocr:this.options.ocr ?? 'force',
      mode:this.options.mode ?? 'enhanced',
      base64_encoding:[
        ...(this.options.base64Encoding ?? DOCUMENT_PARSE_BASE64_ENCODING),
      ],
      output_formats:[...(this.options.outputFormats ?? ['html'])],
      mimeType: options.mimeType,
      pageNumber: options.pageNumber,
    };
    form.append('document', new Blob([bytes as BlobPart], { type: options.mimeType }), filename);
    form.append('model', model);
    form.append('ocr', requestConfig.ocr);
    form.append('mode', requestConfig.mode);
    form.append('base64_encoding', JSON.stringify(requestConfig.base64_encoding));
    form.append('output_formats', JSON.stringify(requestConfig.output_formats));
    const configuredTimeout = this.options.timeoutMs ?? Number(process.env.PROVIDER_TIMEOUT_MS || 120_000);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120_000;
    let response: Response;
    try {
      response = await (
        this.options.requestGate ?? upstageDocumentParseRequestGate
      ).run(async () => {
        const timeoutController = new AbortController();
        const timer = setTimeout(
          () => timeoutController.abort(
            new DOMException(
              'Document Parse request timed out.',
              'TimeoutError',
            ),
          ),
          timeoutMs,
        );
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeoutController.signal])
          : timeoutController.signal;
        try {
          return await executeFetch(() => (this.options.fetch ?? fetch)(
            `${(this.options.baseUrl ?? 'https://api.upstage.ai/v1').replace(/\/+$/, '')}/document-digitization`,
            {
              method:'POST',
              headers:{ Authorization:`Bearer ${this.options.apiKey}` },
              body:form,
              signal,
            },
          ));
        } finally {
          clearTimeout(timer);
        }
      }, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw error;
    }
    await assertProviderResponse(response, this.options.apiKey);
    const raw = await response.json() as {
      html?:string;
      markdown?:string;
      content?:{ html?:string; markdown?:string };
      elements?:unknown[];
      model?:string;
    };
    const markdown = raw.content?.markdown ?? raw.markdown;
    const html = raw.content?.html ?? raw.html
      ?? (markdown ? markdownToHtml(markdown) : undefined);
    if (!html) {
      throw new ProviderError({
        kind:'PARSE',
        message:'PARSE: Document Parse 응답에 HTML 또는 Markdown이 없습니다.',
        retryable:false,
      });
    }
    return {
      html,
      ...(markdown == null ? {} : { markdown }),
      elements:raw.elements ?? [],
      raw,
      requestId:requestIdFrom(response),
      model:raw.model ?? model,
      requestConfig,
    };
  }
}
