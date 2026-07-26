'use client';

import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  Braces,
  Code2,
  FileCode2,
  FileUp,
  ImageIcon,
  Layers3,
  LoaderCircle,
  ScrollText,
} from 'lucide-react';

type LabPage = {
  pageNumber: number;
  filename: string;
  mimeType: string;
  dataUrl: string;
  html: string;
  elements: unknown[];
  raw: unknown;
  requestId: string | null;
  model: string;
  requestConfig: unknown;
  width?: number | null;
  height?: number | null;
};

type LabResponse = {
  pages: LabPage[];
  requestConfig: unknown;
  mock: boolean;
};
type LabError = {
  message: string;
  code: string | null;
  page: number | null;
  requestId: string | null;
  status: number | null;
  category: string | null;
};

type HtmlTab = 'preview' | 'source';
type DetailTab = 'elements' | 'raw' | 'request';

const htmlTabs: readonly { id: HtmlTab; label: string }[] = [
  { id: 'preview', label: '미리보기' },
  { id: 'source', label: '소스 HTML' },
];

const detailTabs: readonly { id: DetailTab; label: string }[] = [
  { id: 'elements', label: 'Elements' },
  { id: 'raw', label: '원본 JSON' },
  { id: 'request', label: '요청 정보' },
];

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function configValue(value: unknown) {
  if (value == null) return '기록 없음';
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function rasterizationValue(value: unknown) {
  const rasterization = record(value);
  const parts = [
    rasterization.format == null ? null : `format=${String(rasterization.format)}`,
    rasterization.dpi == null ? null : `dpi=${String(rasterization.dpi)}`,
    rasterization.jpegQuality == null ? null : `jpegQuality=${String(rasterization.jpegQuality)}`,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : '기록 없음';
}

function previewDocument(html: string) {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}

function coordinate(value: number) {
  return String(value).padStart(2, '0');
}

function moveTab<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  tabs: readonly { id: T }[],
  current: T,
  select: (tab: T) => void,
) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = tabs.findIndex((tab) => tab.id === current);
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  const tab = tabs[nextIndex];
  if (!tab) return;
  select(tab.id);
  event.currentTarget.parentElement
    ?.querySelector<HTMLButtonElement>(`#document-lab-${tab.id}-tab`)
    ?.focus();
}

export function DocumentLabWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<LabResponse | null>(null);
  const [selectedPage, setSelectedPage] = useState(0);
  const [htmlTab, setHtmlTab] = useState<HtmlTab>('preview');
  const [detailTab, setDetailTab] = useState<DetailTab>('elements');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LabError | null>(null);

  const page = result?.pages[selectedPage] ?? null;
  const requestConfig = record(result?.requestConfig);

  function selectFile(nextFile: File | null) {
    setFile(nextFile);
    setResult(null);
    setError(null);
    setSelectedPage(0);
    setHtmlTab('preview');
    setDetailTab('elements');
  }

  async function parse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedPage(0);
    const form = new FormData();
    form.set('file', file);
    try {
      const response = await fetch('/api/document-lab/parse', { method: 'POST', body: form });
      const body = await response.json() as LabResponse & {
        message?: string;
        code?: string;
        page?: number;
        pageNumber?: number;
        requestId?: string;
        status?: number;
        category?: string;
      };
      if (!response.ok) {
        setError({
          message: body.message ?? '문서를 파싱하지 못했습니다.',
          code: body.code ?? null,
          page: body.pageNumber ?? body.page ?? null,
          requestId: body.requestId ?? null,
          status: body.status ?? null,
          category:body.category ?? null,
        });
        return;
      }
      if (!Array.isArray(body.pages) || body.pages.length === 0) throw new Error('파싱된 페이지가 없습니다.');
      setResult(body);
    } catch (caught) {
      setError({
        message: caught instanceof Error ? caught.message : '문서를 파싱하지 못했습니다.',
        code: null,
        page: null,
        requestId: null,
        status: null,
        category:null,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="workflow-page document-lab-page">
      <header className="page-heading document-lab-heading">
        <div>
          <span className="eyebrow">OPERATOR TOOLS / PARSING SANDBOX</span>
          <h1>Document Lab</h1>
          <p>저장 없이 문서 파싱 결과와 원본 페이지를 나란히 검증합니다.</p>
        </div>
        <p className="lab-persistence-note"><AlertTriangle size={15} /> 일회성 검증 전용 · 업로드와 결과를 저장하지 않습니다.</p>
      </header>

      <section className="panel document-lab-config" aria-label="문서 파싱 설정">
        <form onSubmit={parse}>
          <div className="lab-upload-copy">
            <span className="upload-icon"><FileUp size={19} /></span>
            <div><strong>문서 업로드</strong><small>PDF, PNG, JPEG, WebP · 최대 100MB</small></div>
          </div>
          <label className="lab-file-control">테스트 파일
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              disabled={loading}
              onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button className="button primary" disabled={!file || loading}>
            {loading ? <><LoaderCircle className="lab-spinner" size={15} /> 파싱 중…</> : '문서 파싱'}
          </button>
        </form>
        <div className="lab-config-values" aria-label={result ? '실제 요청 설정' : '적용 요청 설정'}>
          {result ? <>
            <div><span>MODE</span><code>{`mode=${configValue(requestConfig.mode)}`}</code></div>
            <div><span>OCR</span><code>{`ocr=${configValue(requestConfig.ocr)}`}</code></div>
            <div><span>BASE64</span><code>{`base64_encoding=${configValue(requestConfig.base64_encoding)}`}</code></div>
            <div><span>OUTPUT</span><code>{`output_formats=${configValue(requestConfig.output_formats)}`}</code></div>
            <div><span>RASTER</span><code>{rasterizationValue(requestConfig.rasterization)}</code></div>
          </> : <div><span>PROFILE</span><strong>활성 연구 프로필 사용</strong></div>}
          <div className="lab-runtime-state"><span>ENV</span><strong className={result?.mock ? 'is-mock' : ''}>{loading ? 'PARSING' : result ? (result.mock ? 'MOCK' : 'LIVE') : '실행 전'}</strong></div>
        </div>
      </section>

      {loading && <p className="lab-status-message" role="status"><LoaderCircle className="lab-spinner" size={16} /> 문서를 페이지별로 분석하고 있습니다.</p>}
      {error && <div className="lab-error" role="alert"><AlertTriangle size={17} /><div>
        <strong>{error.message}</strong>
        {(error.code || error.category || error.page != null || error.requestId || error.status != null) && <span className="mono">
          {[
            error.code,
            error.category,
            error.page == null ? null : `페이지 ${error.page}`,
            error.requestId == null ? null : `request ${error.requestId}`,
            error.status == null ? null : `HTTP ${error.status}`,
          ].filter(Boolean).join(' · ')}
        </span>}
        <span>파일 형식과 서버 설정을 확인한 뒤 같은 파일로 다시 시도하세요.</span>
      </div></div>}

      <div className="document-lab-grid">
        <section className="panel lab-pane lab-original-pane" aria-labelledby="lab-original-title">
          <header className="lab-pane-header">
            <div><ImageIcon size={15} /><h2 id="lab-original-title">원본 페이지</h2></div>
            <span className="lab-coordinate mono">P. {page ? coordinate(page.pageNumber) : '--'} / {result ? coordinate(result.pages.length) : '--'}</span>
          </header>
          {page ? (
            <div className="lab-original-content">
              <div className="lab-page-selector" aria-label="PDF 페이지 선택">
                {result?.pages.map((item, index) => (
                  <button
                    type="button"
                    key={item.pageNumber}
                    aria-label={`Page ${coordinate(item.pageNumber)}`}
                    aria-pressed={index === selectedPage}
                    onClick={() => setSelectedPage(index)}
                  >
                    <span className="mono">{coordinate(item.pageNumber)}</span>
                    <small>{item.filename}</small>
                  </button>
                ))}
              </div>
              <div className="lab-page-image-wrap">
                {/* The server returns a data URL for the exact page image sent to the parser. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={page.dataUrl} alt={`원본 페이지 ${page.pageNumber}`} />
              </div>
            </div>
          ) : <EmptyPane icon={<Layers3 size={22} />} text="테스트 파일을 선택하면 페이지별 결과가 여기에 표시됩니다." />}
        </section>

        <section className="panel lab-pane lab-html-pane" aria-labelledby="lab-html-title">
          <header className="lab-pane-header lab-tabbed-header">
            <div><Code2 size={15} /><h2 id="lab-html-title">변환 HTML</h2></div>
            <div className="lab-tabs" role="tablist" aria-label="HTML 표시 방식">
              {htmlTabs.map((tab) => (
                <button
                  type="button"
                  role="tab"
                  id={`document-lab-${tab.id}-tab`}
                  aria-controls={`document-lab-${tab.id}-panel`}
                  aria-selected={htmlTab === tab.id}
                  tabIndex={htmlTab === tab.id ? 0 : -1}
                  key={tab.id}
                  onClick={() => setHtmlTab(tab.id)}
                  onKeyDown={(event) => moveTab(event, htmlTabs, htmlTab, setHtmlTab)}
                >{tab.label}</button>
              ))}
            </div>
          </header>
          <div
            className="lab-html-panel"
            role="tabpanel"
            id="document-lab-preview-panel"
            aria-labelledby="document-lab-preview-tab"
            hidden={htmlTab !== 'preview'}
          >
            {htmlTab === 'preview' && page ? (
              <div className="lab-html-content">
                <iframe
                  title={`변환 HTML 페이지 ${page.pageNumber}`}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={previewDocument(page.html)}
                />
              </div>
            ) : htmlTab === 'preview' && <EmptyPane icon={<FileCode2 size={22} />} text="파싱이 끝나면 샌드박스 미리보기와 소스 HTML을 확인할 수 있습니다." />}
          </div>
          <div
            className="lab-html-panel"
            role="tabpanel"
            id="document-lab-source-panel"
            aria-labelledby="document-lab-source-tab"
            hidden={htmlTab !== 'source'}
          >
            {htmlTab === 'source' && (page ? <pre className="lab-code">{page.html}</pre> : <EmptyPane icon={<FileCode2 size={22} />} text="파싱이 끝나면 소스 HTML을 확인할 수 있습니다." />)}
          </div>
        </section>

        <section className="panel lab-pane lab-detail-pane" aria-labelledby="lab-detail-title">
          <header className="lab-pane-header lab-detail-header">
            <div><Braces size={15} /><h2 id="lab-detail-title">구조화 응답</h2></div>
          </header>
          <div className="lab-detail-tabs" role="tablist" aria-label="응답 상세">
            {detailTabs.map((tab) => (
              <button
                type="button"
                role="tab"
                id={`document-lab-${tab.id}-tab`}
                aria-controls={`document-lab-${tab.id}-panel`}
                aria-selected={detailTab === tab.id}
                tabIndex={detailTab === tab.id ? 0 : -1}
                key={tab.id}
                onClick={() => setDetailTab(tab.id)}
                onKeyDown={(event) => moveTab(event, detailTabs, detailTab, setDetailTab)}
              >{tab.label}</button>
            ))}
          </div>
          <div
            className="lab-detail-content"
            role="tabpanel"
            id="document-lab-elements-panel"
            aria-labelledby="document-lab-elements-tab"
            hidden={detailTab !== 'elements'}
          >
            {detailTab === 'elements' && (page ? <pre>{pretty(page.elements)}</pre> : <EmptyPane icon={<ScrollText size={22} />} text="Elements는 응답을 받은 뒤 표시됩니다." />)}
          </div>
          <div
            className="lab-detail-content"
            role="tabpanel"
            id="document-lab-raw-panel"
            aria-labelledby="document-lab-raw-tab"
            hidden={detailTab !== 'raw'}
          >
            {detailTab === 'raw' && (page ? <pre>{pretty(page.raw)}</pre> : <EmptyPane icon={<ScrollText size={22} />} text="원본 JSON은 응답을 받은 뒤 표시됩니다." />)}
          </div>
          <div
            className="lab-detail-content"
            role="tabpanel"
            id="document-lab-request-panel"
            aria-labelledby="document-lab-request-tab"
            hidden={detailTab !== 'request'}
          >
            {detailTab === 'request' && (page ? (
                <dl className="lab-request-info">
                  <div><dt>REQUEST ID</dt><dd className="mono">{page.requestId ?? '제공되지 않음'}</dd></div>
                  <div><dt>MODEL</dt><dd className="mono">{page.model || '제공되지 않음'}</dd></div>
                  <div><dt>FILE</dt><dd>{page.filename}</dd></div>
                  <div><dt>MIME TYPE</dt><dd className="mono">{page.mimeType}</dd></div>
                  <div><dt>PAGE</dt><dd className="mono">{page.pageNumber}</dd></div>
                  <div><dt>DIMENSIONS</dt><dd className="mono">{page.width && page.height ? `${page.width} × ${page.height}` : '제공되지 않음'}</dd></div>
                  <div><dt>ELEMENTS</dt><dd className="mono">{page.elements.length}</dd></div>
                  <div><dt>REQUEST CONFIG</dt><dd><pre>{pretty(page.requestConfig)}</pre></dd></div>
                </dl>
              ) : <EmptyPane icon={<ScrollText size={22} />} text="요청 정보는 응답을 받은 뒤 표시됩니다." />)}
          </div>
        </section>
      </div>
    </div>
  );
}

function EmptyPane({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="lab-empty">{icon}<p>{text}</p></div>;
}
