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
};

type LabResponse = {
  pages: LabPage[];
  requestConfig: unknown;
  mock: boolean;
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
  const [error, setError] = useState<string | null>(null);

  const page = result?.pages[selectedPage] ?? null;

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
      const body = await response.json() as LabResponse & { message?: string };
      if (!response.ok) throw new Error(body.message ?? '문서를 파싱하지 못했습니다.');
      if (!Array.isArray(body.pages) || body.pages.length === 0) throw new Error('파싱된 페이지가 없습니다.');
      setResult(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '문서를 파싱하지 못했습니다.');
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
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button className="button primary" disabled={!file || loading}>
            {loading ? <><LoaderCircle className="lab-spinner" size={15} /> 파싱 중…</> : '문서 파싱'}
          </button>
        </form>
        <div className="lab-config-values" aria-label="고정 요청 설정">
          <div><span>MODE</span><strong>Enhanced</strong></div>
          <div><span>OCR</span><code>ocr=force</code></div>
          <div><span>BASE64</span><code>{"base64_encoding=['footnote']"}</code></div>
          <div><span>OUTPUT</span><code>{"output_formats=['html']"}</code></div>
          <div className="lab-runtime-state"><span>ENV</span><strong className={result?.mock ? 'is-mock' : ''}>{loading ? 'PARSING' : result ? (result.mock ? 'MOCK' : 'LIVE') : '실행 전'}</strong></div>
        </div>
      </section>

      {loading && <p className="lab-status-message" role="status"><LoaderCircle className="lab-spinner" size={16} /> 문서를 페이지별로 분석하고 있습니다.</p>}
      {error && <div className="lab-error" role="alert"><AlertTriangle size={17} /><div><strong>{error}</strong><span>파일 형식과 서버 설정을 확인한 뒤 같은 파일로 다시 시도하세요.</span></div></div>}

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
          {page ? htmlTab === 'preview' ? (
            <div className="lab-html-content" role="tabpanel" id="document-lab-preview-panel" aria-labelledby="document-lab-preview-tab">
              <iframe title={`변환 HTML 페이지 ${page.pageNumber}`} sandbox="" srcDoc={page.html} />
            </div>
          ) : (
            <pre className="lab-code" role="tabpanel" id="document-lab-source-panel" aria-labelledby="document-lab-source-tab">{page.html}</pre>
          ) : <EmptyPane icon={<FileCode2 size={22} />} text="파싱이 끝나면 샌드박스 미리보기와 소스 HTML을 확인할 수 있습니다." />}
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
          {page ? (
            <div className="lab-detail-content" role="tabpanel" id={`document-lab-${detailTab}-panel`} aria-labelledby={`document-lab-${detailTab}-tab`}>
              {detailTab === 'elements' && <pre>{pretty(page.elements)}</pre>}
              {detailTab === 'raw' && <pre>{pretty(page.raw)}</pre>}
              {detailTab === 'request' && (
                <dl className="lab-request-info">
                  <div><dt>REQUEST ID</dt><dd className="mono">{page.requestId ?? '제공되지 않음'}</dd></div>
                  <div><dt>MODEL</dt><dd className="mono">{page.model || '제공되지 않음'}</dd></div>
                  <div><dt>FILE</dt><dd>{page.filename}</dd></div>
                  <div><dt>MIME TYPE</dt><dd className="mono">{page.mimeType}</dd></div>
                  <div><dt>PAGE</dt><dd className="mono">{page.pageNumber}</dd></div>
                  <div><dt>REQUEST CONFIG</dt><dd><pre>{pretty(page.requestConfig)}</pre></dd></div>
                </dl>
              )}
            </div>
          ) : <EmptyPane icon={<ScrollText size={22} />} text="Elements, 원본 JSON, 요청 정보는 응답을 받은 뒤 표시됩니다." />}
        </section>
      </div>
    </div>
  );
}

function EmptyPane({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="lab-empty">{icon}<p>{text}</p></div>;
}
