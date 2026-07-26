import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import * as sourcesRoute from '@/app/api/sources/route';
import { GET as GET_ACTIVITY } from '@/app/api/sources/[id]/activity/route';
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

  await expect(db.query(
    `update source_revisions
        set raw_markdown='# 변조된 파서 출력'
      where source_file_id=$1`,
    [id],
  )).rejects.toMatchObject({ code: '55000' });
});
