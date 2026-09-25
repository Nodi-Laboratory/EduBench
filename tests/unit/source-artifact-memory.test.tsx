// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  SourcesWorkspace,
  type SourceListItem,
} from '@/components/sources/sources-workspace';

class EventSourceStub {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const source:SourceListItem = {
  id:'source-a',
  original_name:'science.pdf',
  subject:'과학',
  grade:'중2',
  byte_size:100,
  status:'READY',
  failed_stage:null,
  created_at:'2026-07-30T00:00:00.000Z',
  current_job_id:'job-a',
  current_job_state:'SUCCEEDED',
};

function activity() {
  return {
    source:{ ...source, updated_at:source.created_at },
    job:{ id:'job-a', state:'SUCCEEDED', attempts:1, max_attempts:4 },
    eventCursor:'1',
    events:[],
  };
}

function revisionArtifact(contentView?:'markdown' | 'html' | 'reviewed') {
  return {
    kind:'revision',
    source:{ id:source.id, original_name:source.original_name },
    completeness:'COMPLETE',
    artifact:{
      id:'revision-a',
      revision:1,
      parseModel:'upstage',
      parseRequestId:'request-a',
      rawResponse:null,
      rawResponseIncluded:false,
      rawHtml:contentView === 'html' ? 'HTML-LARGE' : null,
      rawMarkdown:contentView === 'markdown' ? 'MARKDOWN-LARGE' : null,
      reviewedHtml:contentView === 'reviewed' ? 'REVIEWED-LARGE' : null,
      reviewSummary:null,
      contentIncluded:Boolean(contentView),
      contentView:contentView ?? null,
      contentAvailable:true,
      contentBytes:{ rawHtml:10, rawMarkdown:10, reviewedHtml:10 },
      createdAt:'2026-07-30T00:00:00.000Z',
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('revision inspection fetches and retains only the selected representation', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const fetchMock = vi.fn(async (
    input:RequestInfo | URL,
    init?:RequestInit,
  ) => {
    void init;
    const url = String(input);
    if (url === '/api/sources/source-a/activity') {
      return { ok:true, json:async () => activity() };
    }
    if (url.includes('kind=revision') && url.includes('contentView=markdown')) {
      return { ok:true, json:async () => revisionArtifact('markdown') };
    }
    if (url.includes('kind=revision') && url.includes('contentView=html')) {
      return { ok:true, json:async () => revisionArtifact('html') };
    }
    if (url.includes('kind=revision')) {
      return { ok:true, json:async () => revisionArtifact() };
    }
    if (url === '/api/sources') {
      return { ok:true, json:async () => ({ items:[source] }) };
    }
    return { ok:false, json:async () => ({ code:'UNEXPECTED_REQUEST' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SourcesWorkspace initialSources={[source]} />);

  fireEvent.click(screen.getAllByText('science.pdf')[0]!);
  await screen.findByText('실제 산출물');
  fireEvent.click(screen.getByRole('tab', { name:'파싱 원문' }));
  await screen.findByRole('button', { name:'파싱 본문 불러오기' });
  fireEvent.click(screen.getByRole('button', { name:'파싱 본문 불러오기' }));

  expect(await screen.findByText('MARKDOWN-LARGE')).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(
    ([url]) => String(url).includes('contentView=markdown'),
  )).toBe(true);

  fireEvent.click(screen.getByRole('button', { name:'원본 HTML' }));
  expect(await screen.findByText('HTML-LARGE')).toBeInTheDocument();
  expect(screen.queryByText('MARKDOWN-LARGE')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(
    ([url]) => String(url).includes('contentView=html'),
  )).toBe(true);
});

test('a stale artifact tab response cannot replace the active tab', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  let resolveRevision!: (value:{
    ok:boolean;
    json:() => Promise<ReturnType<typeof revisionArtifact>>;
  }) => void;
  const delayedRevision = new Promise<{
    ok:boolean;
    json:() => Promise<ReturnType<typeof revisionArtifact>>;
  }>((resolve) => {
    resolveRevision = resolve;
  });
  const fetchMock = vi.fn(async (input:RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/sources/source-a/activity') {
      return { ok:true, json:async () => activity() };
    }
    if (url.includes('kind=revision')) return delayedRevision;
    if (url.includes('kind=chunks')) {
      return {
        ok:true,
        json:async () => ({
          kind:'chunks',
          source:{ id:source.id, original_name:source.original_name },
          revision:{ id:'revision-a', revision:1 },
          completeness:'COMPLETE',
          total:1,
          nextAfterOrdinal:null,
          items:[{
            id:'chunk-a',
            ordinal:1,
            chapter:null,
            unit:null,
            pageStart:1,
            pageEnd:1,
            kind:'text',
            html:null,
            content:null,
            contentIncluded:false,
            contentAvailable:true,
            contentPreview:'ACTIVE-CHUNK',
            contentBytes:12,
            htmlBytes:12,
            tokenCount:3,
            embedding:{
              model:'embedding',
              version:'v1',
              vectorSpaceId:'space',
              profileHash:'hash',
              provenance:'AT_CREATION_VERIFIED',
              dimensions:3,
              norm:1,
            },
          }],
        }),
      };
    }
    return { ok:true, json:async () => ({ items:[source] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SourcesWorkspace initialSources={[source]} />);

  fireEvent.click(screen.getAllByText('science.pdf')[0]!);
  await screen.findByText('실제 산출물');
  fireEvent.click(screen.getByRole('tab', { name:'파싱 원문' }));
  fireEvent.click(screen.getByRole('tab', { name:'청크·임베딩' }));
  expect(await screen.findByText('ACTIVE-CHUNK')).toBeInTheDocument();

  resolveRevision({
    ok:true,
    json:async () => revisionArtifact(),
  });
  await waitFor(() => expect(screen.getByText('ACTIVE-CHUNK')).toBeInTheDocument());
});

test('closing a page detail aborts its large response and does not retain it', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  let resolveContent!: (value:{
    ok:boolean;
    json:() => Promise<Record<string, unknown>>;
  }) => void;
  const delayedContent = new Promise<{
    ok:boolean;
    json:() => Promise<Record<string, unknown>>;
  }>((resolve) => {
    resolveContent = resolve;
  });
  const fetchMock = vi.fn(async (
    input:RequestInfo | URL,
    init?:RequestInit,
  ) => {
    void init;
    const url = String(input);
    if (url === '/api/sources/source-a/activity') {
      return { ok:true, json:async () => activity() };
    }
    if (url.includes('kind=pages') && url.includes('includeContent=1')) {
      return delayedContent;
    }
    if (url.includes('kind=pages')) {
      return {
        ok:true,
        json:async () => ({
          kind:'pages',
          source:{ id:source.id, original_name:source.original_name },
          revision:{ id:'revision-a', revision:1 },
          completeness:'COMPLETE',
          expectedPageCount:1,
          persistedPageCount:1,
          total:1,
          nextAfterPage:null,
          items:[{
            id:'page-a',
            pageNumber:1,
            filename:'page-1.png',
            mimeType:'image/png',
            rasterWidth:100,
            rasterHeight:100,
            parseModel:'upstage',
            parseRequestId:'request-a',
            requestConfig:{},
            rawResponse:null,
            rawResponseIncluded:false,
            rawHtml:null,
            rawMarkdown:null,
            contentIncluded:false,
            contentAvailable:true,
            contentPreview:'PAGE-PREVIEW',
            contentBytes:{ rawHtml:100, rawMarkdown:100 },
            createdAt:'2026-07-30T00:00:00.000Z',
          }],
        }),
      };
    }
    return { ok:true, json:async () => ({ items:[source] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SourcesWorkspace initialSources={[source]} />);

  fireEvent.click(screen.getAllByText('science.pdf')[0]!);
  await screen.findByText('실제 산출물');
  fireEvent.click(screen.getByRole('tab', { name:'파싱 페이지' }));
  const summary = await screen.findByText('페이지 본문·HTML · 펼칠 때 불러오기');
  const details = summary.closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => String(url).includes('includeContent=1'),
  )).toBe(true));
  const contentCall = fetchMock.mock.calls.find(
    ([url]) => String(url).includes('includeContent=1'),
  )!;
  const signal = contentCall[1]?.signal as AbortSignal;

  details.open = false;
  fireEvent(details, new Event('toggle'));
  expect(signal.aborted).toBe(true);
  resolveContent({
    ok:true,
    json:async () => ({
      kind:'pages',
      source:{ id:source.id, original_name:source.original_name },
      revision:{ id:'revision-a', revision:1 },
      completeness:'COMPLETE',
      expectedPageCount:1,
      persistedPageCount:1,
      total:1,
      nextAfterPage:null,
      items:[{
        id:'page-a',
        pageNumber:1,
        rawHtml:'LATE-LARGE-HTML',
        rawMarkdown:'LATE-LARGE-MARKDOWN',
        contentIncluded:true,
      }],
    }),
  });
  await Promise.resolve();
  expect(screen.queryByText('LATE-LARGE-MARKDOWN')).not.toBeInTheDocument();
});

test('TOC mapping JSON mounts only while its disclosure is open', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const fetchMock = vi.fn(async (input:RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/sources/source-a/activity') {
      return { ok:true, json:async () => activity() };
    }
    if (url.includes('kind=toc')) {
      return {
        ok:true,
        json:async () => ({
          kind:'toc',
          source:{ id:source.id, original_name:source.original_name },
          revision:{ id:'revision-a', revision:1 },
          completeness:'COMPLETE',
          total:1,
          mappingSummary:{ mapped:1, unmapped:0 },
          nextAfterOrdinal:null,
          items:[{
            id:'toc-a',
            ordinal:1,
            title:'운동과 에너지',
            level:1,
            printedPage:12,
            mappingStatus:'MAPPED',
            mappingConfidence:0.95,
            mappings:[{ chunkId:'chunk-a', rawMarker:'TOC-MAPPING-RAW' }],
          }],
        }),
      };
    }
    return { ok:true, json:async () => ({ items:[source] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SourcesWorkspace initialSources={[source]} />);

  fireEvent.click(screen.getAllByText('science.pdf')[0]!);
  await screen.findByText('실제 산출물');
  fireEvent.click(screen.getByRole('tab', { name:'목차 매핑' }));

  const mappingDisclosure = await screen.findByText('청크 매핑 1건');
  expect(screen.queryByText(/TOC-MAPPING-RAW/)).not.toBeInTheDocument();
  fireEvent.click(mappingDisclosure);
  expect(await screen.findByText(/TOC-MAPPING-RAW/)).toBeInTheDocument();
});
