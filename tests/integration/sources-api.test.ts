import { rememberProviderKeys } from '@/server/providers/credentials';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import * as sourcesRoute from '@/app/api/sources/route';
import { GET as GET_ACTIVITY } from '@/app/api/sources/[id]/activity/route';
import { GET as GET_ARTIFACTS } from '@/app/api/sources/[id]/artifacts/route';
import { POST as CANCEL } from '@/app/api/sources/[id]/cancel/route';
import { DELETE } from '@/app/api/sources/[id]/route';
import { processDocument } from '@/server/documents/pipeline';
import {
  defaultResearchConfigDefinitions,
  type DocumentParseResearchConfig,
} from '@/domain/research-config';
import { reprocessSourceWithCurrentProfiles } from '@/server/sources/reprocessing';

const { GET, POST } = sourcesRoute;

beforeAll(async () => {
  await migrate();
  process.env.STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'edubench-sources-'));
});

beforeEach(async () => {
  await db.query(`delete from job_events where job_id in (select id from jobs where kind = 'document.parse')`);
  await db.query(`delete from jobs where kind = 'document.parse'`);
  await db.query(
    `delete from question_evidence
      where source_chunk_id in (select id from source_chunks)`,
  );
  await db.query('delete from source_chunks');
  await db.query('delete from source_revisions');
  await db.query('delete from source_files');
});

afterAll(async () => {
  await db.end();
});

function uploadRequest() {
  const form = new FormData();
  form.set('file', new File(['%PDF-1.7\nfixture'], 'science-2.pdf', { type: 'application/pdf' }));
  form.set('subject', '과학');
  form.set('grade', '중학교 2학년');
  return new Request('http://localhost/api/sources', { method: 'POST', body: form });
}

test('stores one PDF and enqueues one idempotent parse job', async () => {
  const first = await POST(uploadRequest());
  const second = await POST(uploadRequest());
  const firstBody = await first.json();
  const secondBody = await second.json();

  expect(first.status).toBe(201);
  expect(second.status).toBe(200);
  expect(firstBody.existing).toBe(false);
  expect(secondBody).toMatchObject({ existing: true, id: firstBody.id });

  const sourceCount = await db.query<{ count: string }>('select count(*) from source_files');
  const jobCount = await db.query<{ count: string }>(`select count(*) from jobs where kind = 'document.parse'`);
  expect(Number(sourceCount.rows[0]?.count)).toBe(1);
  expect(Number(jobCount.rows[0]?.count)).toBe(1);
});

test('rejects a non-PDF upload and lists stored sources', async () => {
  const invalid = new FormData();
  invalid.set('file', new File(['hello'], 'notes.txt', { type: 'text/plain' }));
  const response = await POST(new Request('http://localhost/api/sources', { method: 'POST', body: invalid }));
  expect(response.status).toBe(400);

  await POST(uploadRequest());
  const list = await GET();
  const body = await list.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    original_name:'science-2.pdf',
    status:'UPLOADED',
    reprocess_required:false,
  });
});

test('lists source processing events and cancels its active parse job', async () => {
  const upload = await POST(uploadRequest());
  const { id, jobId } = await upload.json();

  const activity = await GET_ACTIVITY(new Request(`http://localhost/api/sources/${id}/activity`), {
    params: Promise.resolve({ id }),
  });
  const activityBody = await activity.json();
  expect(activityBody.source.id).toBe(id);
  expect(activityBody.events[0]).toMatchObject({ event_type: 'JOB_ENQUEUED' });
  expect(activityBody.eventCursor).toBe(activityBody.events.at(-1).id);
  expect(activityBody.executionProfiles).toMatchObject({
    documentParse: {
      kind: 'document_parse',
      profileId: expect.any(String),
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      provenance: 'AT_CREATION_VERIFIED',
      definition: { kind: 'document_parse' },
    },
    embeddingRag: {
      kind: 'embedding_rag',
      profileId: expect.any(String),
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      provenance: 'AT_CREATION_VERIFIED',
      definition: { kind: 'embedding_rag' },
    },
  });

  const refresh = await GET_ACTIVITY(
    new Request(`http://localhost/api/sources/${id}/activity?history=0`),
    { params: Promise.resolve({ id }) },
  );
  const refreshBody = await refresh.json();
  expect(refreshBody).not.toHaveProperty('events');
  expect(refreshBody.eventCursor).toBe(activityBody.eventCursor);

  const cancelled = await CANCEL(new Request(`http://localhost/api/sources/${id}/cancel`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ jobId, state: 'CANCELLED' });

  const rows = await db.query<{ job_state: string; source_status: string }>(
    `select j.state as job_state, s.status as source_status
       from jobs j join source_files s on s.id = (j.payload->>'sourceId')::uuid
      where j.id = $1`,
    [jobId],
  );
  expect(rows.rows[0]).toEqual({ job_state: 'CANCELLED', source_status: 'CANCELLED' });
});

test('stores different contents with the same filename as separate sources', async () => {
  const first = await POST(uploadRequest());
  const secondForm = new FormData();
  secondForm.set('file', new File(['%PDF-1.7\ndifferent'], 'science-2.pdf', { type: 'application/pdf' }));
  const second = await POST(new Request('http://localhost/api/sources', { method: 'POST', body: secondForm }));
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect((await first.json()).id).not.toBe((await second.json()).id);
});

test('stores the same PDF as a new lineage row when active research profiles changed', async () => {
  const first = await POST(uploadRequest());
  const firstBody = await first.json() as { id:string };
  const active = await db.query<{ profile_id:string }>(
    `select profile_id
       from research_config_active_profiles
      where kind='document_parse'`,
  );
  const definition = structuredClone(defaultResearchConfigDefinitions.find(
    (profile): profile is DocumentParseResearchConfig =>
      profile.kind === 'document_parse',
  )!);
  definition.version = `document-parse-lineage-${randomUUID()}`;
  definition.title = '동일 파일 새 파싱 계보';
  definition.description = '동일한 PDF를 변경된 연구 설정 아래에서 별도 결과 계보로 다시 처리하기 위한 파싱 프로필입니다.';
  definition.settings.pageConcurrency = 2;
  const created = await db.query<{ id:string }>(
    `insert into research_config_profiles(
       kind,version,title,definition,content_hash
     ) values('document_parse',$1,$2,$3::jsonb,null)
     returning id`,
    [definition.version, definition.title, JSON.stringify(definition)],
  );

  try {
    await db.query(
      `update research_config_active_profiles
          set profile_id=$1,activated_at=now()
        where kind='document_parse'`,
      [created.rows[0]!.id],
    );
    const second = await POST(uploadRequest());
    const secondBody = await second.json() as {
      id:string;
      existing:boolean;
      reprocessedFrom?:string;
    };

    expect(second.status).toBe(201);
    expect(secondBody).toMatchObject({
      existing:false,
      reprocessedFrom:firstBody.id,
    });
    expect(secondBody.id).not.toBe(firstBody.id);

    const rows = await db.query<{
      id:string;
      source_lineage_id:string;
      reprocessed_from_source_file_id:string | null;
    }>(
      `select id,source_lineage_id,reprocessed_from_source_file_id
         from source_files
        where id=any($1::uuid[])
        order by created_at`,
      [[firstBody.id, secondBody.id]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[1]).toMatchObject({
      id:secondBody.id,
      source_lineage_id:rows.rows[0]!.source_lineage_id,
      reprocessed_from_source_file_id:firstBody.id,
    });
  } finally {
    await db.query(
      `update research_config_active_profiles
          set profile_id=$1,activated_at=now()
        where kind='document_parse'`,
      [active.rows[0]!.profile_id],
    );
  }
});

test('reprocesses a READY legacy source into a verified row without mutating the original', async () => {
  const upload = await POST(uploadRequest());
  const { id } = await upload.json() as { id:string };
  await db.query(
    `delete from job_events
      where job_id in (select id from jobs where kind='document.parse')`,
  );
  await db.query(`delete from jobs where kind='document.parse'`);
  await db.query(`alter table source_files disable trigger source_files_research_config_immutable`);
  try {
    await db.query(
      `update source_files
          set status='READY',
              document_parse_profile_id=null,
              document_parse_profile_snapshot=null,
              document_parse_profile_hash=null,
              document_parse_profile_snapshot_provenance='LEGACY_BACKFILL_UNVERIFIED',
              embedding_rag_profile_id=null,
              embedding_rag_profile_snapshot=null,
              embedding_rag_profile_hash=null,
              embedding_rag_profile_snapshot_provenance='LEGACY_BACKFILL_UNVERIFIED'
        where id=$1`,
      [id],
    );
  } finally {
    await db.query(`alter table source_files enable trigger source_files_research_config_immutable`);
  }

  const result = await reprocessSourceWithCurrentProfiles(id);
  expect(result).toMatchObject({
    existing:false,
    jobId:expect.any(String),
    reprocessedFrom:id,
  });
  expect(result?.id).not.toBe(id);

  const original = await db.query<{
    status:string;
    provenance:string;
  }>(
    `select status,
            embedding_rag_profile_snapshot_provenance provenance
       from source_files where id=$1`,
    [id],
  );
  expect(original.rows[0]).toEqual({
    status:'READY',
    provenance:'LEGACY_BACKFILL_UNVERIFIED',
  });
  const replacement = await db.query<{
    status:string;
    provenance:string;
    reprocessed_from_source_file_id:string | null;
  }>(
    `select status,
            embedding_rag_profile_snapshot_provenance provenance,
            reprocessed_from_source_file_id
       from source_files where id=$1`,
    [result!.id],
  );
  expect(replacement.rows[0]).toEqual({
    status:'UPLOADED',
    provenance:'AT_CREATION_VERIFIED',
    reprocessed_from_source_file_id:id,
  });
});

test('soft deletes a source, cancels its job, and restores it when the same file is uploaded again', async () => {
  const upload = await POST(uploadRequest());
  const { id } = await upload.json();
  const removed = await DELETE(new Request(`http://localhost/api/sources/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });
  expect(removed.status).toBe(200);
  expect((await GET().then((response) => response.json())).items).toHaveLength(0);

  const restored = await POST(uploadRequest());
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ id, restored: true });
  expect((await GET().then((response) => response.json())).items).toHaveLength(1);
});

test('validates every required real provider before reading or rasterizing the source PDF', async () => {
  const upload = await POST(uploadRequest());
  const { id } = await upload.json() as { id: string };
  const source = await db.query<{ storage_path: string }>(
    'select storage_path from source_files where id=$1',
    [id],
  );
  await rm(source.rows[0]!.storage_path);

  const previousMock = process.env.MOCK_PROVIDERS;
  const previousUpstage = process.env.UPSTAGE_API_KEY;
  const previousGoogle = process.env.GOOGLE_API_KEY;
  process.env.MOCK_PROVIDERS = 'false';
  delete process.env.UPSTAGE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    await expect(processDocument(id)).rejects.toThrow(
      'UPSTAGE_NOT_CONFIGURED: Upstage API 키가 필요합니다.',
    );
    // Keys come from the browser request that enqueued the job, never env.
    process.env.UPSTAGE_API_KEY = 'ignored-server-env-key';
    await expect(processDocument(id)).rejects.toThrow('UPSTAGE_NOT_CONFIGURED');
    rememberProviderKeys(`source:${id}`, { upstage:'test-upstage-key' });
    await expect(processDocument(id)).rejects.toThrow(
      'EMBEDDING_NOT_CONFIGURED: Gemini API 키가 필요합니다.',
    );
  } finally {
    if (previousMock == null) delete process.env.MOCK_PROVIDERS;
    else process.env.MOCK_PROVIDERS = previousMock;
    if (previousUpstage == null) delete process.env.UPSTAGE_API_KEY;
    else process.env.UPSTAGE_API_KEY = previousUpstage;
    if (previousGoogle == null) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousGoogle;
  }
});

test('keeps the parsed revision and full page artifacts when downstream vector persistence fails', async () => {
  const upload = await POST(uploadRequest());
  const sourceId = (await upload.json() as { id: string }).id;
  await db.query(`
    create or replace function fail_test_source_chunk_insert()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.source_file_id='${sourceId}'::uuid then
        raise exception 'TEST_DOWNSTREAM_FAILURE';
      end if;
      return new;
    end;
    $$;
    create trigger fail_test_source_chunk_insert
    before insert on source_chunks
    for each row execute function fail_test_source_chunk_insert();
  `);
  try {
    await expect(processDocument(sourceId)).rejects.toThrow('TEST_DOWNSTREAM_FAILURE');

    const persisted = await db.query<{
      revision: number;
      page_count: number;
      raw_response: unknown;
    }>(
      `select revision.revision,
              count(page.id)::int page_count,
              revision.raw_response
         from source_revisions revision
         left join source_revision_page_artifacts page
           on page.source_revision_id=revision.id
        where revision.source_file_id=$1
        group by revision.id`,
      [sourceId],
    );
    expect(persisted.rows).toEqual([{
      revision: 1,
      page_count: 1,
      raw_response: {
        pageCount: 1,
        pages: expect.any(Array),
      },
    }]);
  } finally {
    await db.query(`
      drop trigger if exists fail_test_source_chunk_insert on source_chunks;
      drop function if exists fail_test_source_chunk_insert();
    `);
  }
});

test('persists the complete parser Markdown in a dedicated immutable revision artifact', async () => {
  const upload = await POST(uploadRequest());
  const { id } = await upload.json();

  await processDocument(id);

  const revision = await db.query<{
    raw_markdown: string | null;
    markdown_bytes: number | null;
  }>(
    `select raw_markdown, octet_length(raw_markdown)::int markdown_bytes
       from source_revisions
      where source_file_id=$1`,
    [id],
  );
  const expectedMarkdown = '# 로컬 파이프라인 검증\n\nscience-2.pdf';
  expect(revision.rows[0]).toEqual({
    raw_markdown: expectedMarkdown,
    markdown_bytes: Buffer.byteLength(expectedMarkdown, 'utf8'),
  });

  const pageArtifact = await db.query<{
    page_number: number;
    raw_markdown: string | null;
    raw_response: unknown;
  }>(
    `select page_number,raw_markdown,raw_response
       from source_revision_page_artifacts
      where source_revision_id=(
        select id from source_revisions where source_file_id=$1
      )`,
    [id],
  );
  expect(pageArtifact.rows).toEqual([{
    page_number: 1,
    raw_markdown: expectedMarkdown,
    raw_response: { mock: true, settings: expect.any(Object) },
  }]);

  await expect(db.query(
    `update source_revisions
        set raw_markdown='# 변조된 파서 출력'
      where source_file_id=$1`,
    [id],
  )).rejects.toMatchObject({ code: '55000' });
  await expect(db.query(
    `update source_revision_page_artifacts
        set raw_markdown='# 변조된 페이지 출력'
      where source_revision_id=(
        select id from source_revisions where source_file_id=$1
      )`,
    [id],
  )).rejects.toMatchObject({ code: '55000' });
});

test('exposes parsed revision, chunk content, vector metadata, and TOC as inspectable artifacts', async () => {
  const upload = await POST(uploadRequest());
  const { id } = await upload.json();
  await processDocument(id);
  const canonicalHtml = await db.query<{
    chunks:number;
    inline_html:number;
    canonical_refs:number;
  }>(
    `select count(*)::int chunks,
            count(*) filter (where chunk.html is not null)::int inline_html,
            count(*) filter (
              where chunk.html_blob_id is not null
                and blob.id is not null
            )::int canonical_refs
       from source_chunks chunk
       left join source_html_blobs blob on blob.id=chunk.html_blob_id
      where chunk.source_file_id=$1`,
    [id],
  );
  expect(canonicalHtml.rows[0]).toEqual({
    chunks:expect.any(Number),
    inline_html:0,
    canonical_refs:canonicalHtml.rows[0]!.chunks,
  });

  const revisionResponse = await GET_ARTIFACTS(
    new Request(`http://localhost/api/sources/${id}/artifacts?kind=revision`),
    { params: Promise.resolve({ id }) },
  );
  expect(revisionResponse.status).toBe(200);
  const revision = await revisionResponse.json();
  expect(revision).toMatchObject({
    kind: 'revision',
    completeness: 'COMPLETE',
    artifact: {
      revision: 1,
      parseModel: 'mock-document-parse',
      rawHtml: null,
      rawMarkdown: null,
      reviewedHtml: null,
      contentIncluded:false,
      contentAvailable:true,
      contentBytes:{
        rawHtml:expect.any(Number),
        rawMarkdown:expect.any(Number),
        reviewedHtml:expect.any(Number),
      },
      rawResponse: null,
      rawResponseIncluded:false,
    },
  });
  const revisionRawResponse = await GET_ARTIFACTS(
    new Request(
      `http://localhost/api/sources/${id}/artifacts?kind=revision&revisionId=${revision.artifact.id}&includeRaw=1`,
    ),
    { params:Promise.resolve({ id }) },
  );
  expect(revisionRawResponse.status).toBe(200);
  await expect(revisionRawResponse.json()).resolves.toMatchObject({
    kind:'revision',
    artifact:{
      id:revision.artifact.id,
      rawResponseIncluded:true,
      rawResponse:{
        pageCount:1,
        pages:[{
          pageNumber:1,
          requestId:'mock-document-parse',
          model:'mock-document-parse',
        }],
      },
    },
  });
  const revisionContentResponse = await GET_ARTIFACTS(
    new Request(
      `http://localhost/api/sources/${id}/artifacts?kind=revision&revisionId=${revision.artifact.id}&includeContent=1&contentView=markdown`,
    ),
    { params:Promise.resolve({ id }) },
  );
  expect(revisionContentResponse.status).toBe(200);
  await expect(revisionContentResponse.json()).resolves.toMatchObject({
    kind:'revision',
    artifact:{
      id:revision.artifact.id,
      contentIncluded:true,
      contentView:'markdown',
      rawHtml:null,
      rawMarkdown:expect.stringContaining('science-2.pdf'),
      reviewedHtml:null,
    },
  });
  const revisionHtmlResponse = await GET_ARTIFACTS(
    new Request(
      `http://localhost/api/sources/${id}/artifacts?kind=revision&revisionId=${revision.artifact.id}&includeContent=1&contentView=html`,
    ),
    { params:Promise.resolve({ id }) },
  );
  expect(revisionHtmlResponse.status).toBe(200);
  await expect(revisionHtmlResponse.json()).resolves.toMatchObject({
    kind:'revision',
    artifact:{
      id:revision.artifact.id,
      contentView:'html',
      rawHtml:expect.stringContaining('로컬 파이프라인 검증'),
      rawMarkdown:null,
      reviewedHtml:null,
    },
  });
  const revisionReviewedResponse = await GET_ARTIFACTS(
    new Request(
      `http://localhost/api/sources/${id}/artifacts?kind=revision&revisionId=${revision.artifact.id}&includeContent=1&contentView=reviewed`,
    ),
    { params:Promise.resolve({ id }) },
  );
  expect(revisionReviewedResponse.status).toBe(200);
  await expect(revisionReviewedResponse.json()).resolves.toMatchObject({
    kind:'revision',
    artifact:{
      id:revision.artifact.id,
      contentView:'reviewed',
      rawHtml:null,
      rawMarkdown:null,
      reviewedHtml:expect.stringContaining('로컬 파이프라인 검증'),
    },
  });

  const pagesResponse = await GET_ARTIFACTS(
    new Request(`http://localhost/api/sources/${id}/artifacts?kind=pages&limit=1`),
    { params: Promise.resolve({ id }) },
  );
  expect(pagesResponse.status).toBe(200);
  const pages = await pagesResponse.json();
  expect(pages).toMatchObject({
    kind: 'pages',
    completeness: 'COMPLETE',
    expectedPageCount: 1,
    persistedPageCount: 1,
    total: 1,
    nextAfterPage: null,
    items: [{
      pageNumber: 1,
      rawHtml: null,
      rawMarkdown: null,
      contentIncluded: false,
      contentAvailable: true,
      contentBytes: {
        rawHtml: expect.any(Number),
        rawMarkdown: expect.any(Number),
      },
      contentPreview: expect.stringContaining('science-2.pdf'),
      rawResponse: null,
      rawResponseIncluded:false,
    }],
  });
  const pageContentResponse = await GET_ARTIFACTS(
    new Request(
      `http://localhost/api/sources/${id}/artifacts?kind=pages&revisionId=${pages.revision.id}&artifactId=${pages.items[0].id}&includeContent=1`,
    ),
    { params:Promise.resolve({ id }) },
  );
  expect(pageContentResponse.status).toBe(200);
  await expect(pageContentResponse.json()).resolves.toMatchObject({
    kind:'pages',
    items:[{
      id:pages.items[0].id,
      contentIncluded:true,
      rawHtml:expect.stringContaining('로컬 파이프라인 검증'),
      rawMarkdown:expect.stringContaining('science-2.pdf'),
    }],
  });
  const pageRawResponse = await GET_ARTIFACTS(
    new Request(
      `http://localhost/api/sources/${id}/artifacts?kind=pages&limit=100&afterPage=0&revisionId=${pages.revision.id}&includeRaw=1`,
    ),
    { params:Promise.resolve({ id }) },
  );
  expect(pageRawResponse.status).toBe(200);
  await expect(pageRawResponse.json()).resolves.toMatchObject({
    kind:'pages',
    items:[{
      pageNumber:1,
      rawResponse:{ mock:true, settings:expect.any(Object) },
      rawResponseIncluded:true,
    }],
  });

  const chunksResponse = await GET_ARTIFACTS(
    new Request(`http://localhost/api/sources/${id}/artifacts?kind=chunks&limit=10`),
    { params: Promise.resolve({ id }) },
  );
  expect(chunksResponse.status).toBe(200);
  const chunks = await chunksResponse.json();
  expect(chunks).toMatchObject({
    kind: 'chunks',
    total: expect.any(Number),
    items: [
      {
        ordinal: 1,
        content: null,
        html: null,
        contentIncluded: false,
        contentAvailable: true,
        contentPreview: expect.stringContaining('science-2.pdf'),
        contentBytes: expect.any(Number),
        embedding: {
          model: 'mock-embedding-3072',
          dimensions: expect.any(Number),
          norm: expect.any(Number),
        },
      },
    ],
  });
  expect(chunks.items[0]).not.toHaveProperty('storagePath');
  const chunkContentResponse = await GET_ARTIFACTS(
    new Request(
      `http://localhost/api/sources/${id}/artifacts?kind=chunks&revisionId=${chunks.revision.id}&artifactId=${chunks.items[0].id}&includeContent=1`,
    ),
    { params:Promise.resolve({ id }) },
  );
  expect(chunkContentResponse.status).toBe(200);
  await expect(chunkContentResponse.json()).resolves.toMatchObject({
    kind:'chunks',
    items:[{
      id:chunks.items[0].id,
      contentIncluded:true,
      content:expect.stringContaining('science-2.pdf'),
      html:expect.stringContaining('science-2.pdf'),
    }],
  });

  const tocResponse = await GET_ARTIFACTS(
    new Request(`http://localhost/api/sources/${id}/artifacts?kind=toc`),
    { params: Promise.resolve({ id }) },
  );
  expect(tocResponse.status).toBe(200);
  await expect(tocResponse.json()).resolves.toMatchObject({
    kind: 'toc',
    total: expect.any(Number),
    mappingSummary: {
      mapped:expect.any(Number),
      unmapped:expect.any(Number),
    },
    nextAfterOrdinal: null,
    items: expect.any(Array),
  });
});

test('pins paginated artifacts to one revision and rejects unpinned or foreign cursors', async () => {
  const upload = await POST(uploadRequest());
  const { id } = await upload.json() as { id: string };
  await processDocument(id);

  const first = await GET_ARTIFACTS(
    new Request(`http://localhost/api/sources/${id}/artifacts?kind=pages&limit=1`),
    { params: Promise.resolve({ id }) },
  ).then((response) => response.json()) as {
    revision: { id: string; revision: number };
  };
  await processDocument(id);

  const latest = await GET_ARTIFACTS(
    new Request(`http://localhost/api/sources/${id}/artifacts?kind=pages&limit=1`),
    { params: Promise.resolve({ id }) },
  ).then((response) => response.json()) as {
    revision: { id: string; revision: number };
  };
  expect(latest.revision).toMatchObject({ revision: 2 });
  expect(latest.revision.id).not.toBe(first.revision.id);

  const pinnedResponse = await GET_ARTIFACTS(
    new Request(
      `http://localhost/api/sources/${id}/artifacts?kind=pages&limit=1&revisionId=${first.revision.id}`,
    ),
    { params: Promise.resolve({ id }) },
  );
  expect(pinnedResponse.status).toBe(200);
  await expect(pinnedResponse.json()).resolves.toMatchObject({
    revision: first.revision,
    items: [{ pageNumber: 1 }],
  });

  const unpinnedCursor = await GET_ARTIFACTS(
    new Request(`http://localhost/api/sources/${id}/artifacts?kind=pages&afterPage=1`),
    { params: Promise.resolve({ id }) },
  );
  expect(unpinnedCursor.status).toBe(400);
  await expect(unpinnedCursor.json()).resolves.toMatchObject({
    code: 'SOURCE_ARTIFACT_REVISION_REQUIRED',
  });

  const foreignRevision = await GET_ARTIFACTS(
    new Request(
      `http://localhost/api/sources/${id}/artifacts?kind=pages&revisionId=${randomUUID()}`,
    ),
    { params: Promise.resolve({ id }) },
  );
  expect(foreignRevision.status).toBe(409);
  await expect(foreignRevision.json()).resolves.toMatchObject({
    code: 'SOURCE_ARTIFACT_REVISION_MISMATCH',
  });
});
