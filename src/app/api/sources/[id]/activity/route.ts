import { NextResponse } from 'next/server';
import {
  readActivityEventCursor,
  readActivityEventHistory,
} from '@/server/activity/event-stream';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const includeHistory = new URL(request.url).searchParams.get('history') !== '0';
  const snapshot = await withReadOnlyRepeatableReadTransaction(async (client) => {
    const source = await client.query<{
      id: string;
      original_name: string;
      subject: string | null;
      grade: string | null;
      status: string;
      failed_stage: string | null;
      failure_code: string | null;
      failure_message: string | null;
      created_at: Date;
      updated_at: Date;
      document_parse_profile_id: string | null;
      document_parse_profile_snapshot: unknown;
      document_parse_profile_hash: string | null;
      document_parse_profile_snapshot_provenance: string;
      embedding_rag_profile_id: string | null;
      embedding_rag_profile_snapshot: unknown;
      embedding_rag_profile_hash: string | null;
      embedding_rag_profile_snapshot_provenance: string;
    }>(
      `select id, original_name, subject, grade, status, failed_stage, failure_code,
              failure_message, created_at, updated_at,
              document_parse_profile_id, document_parse_profile_snapshot,
              document_parse_profile_hash,
              document_parse_profile_snapshot_provenance,
              embedding_rag_profile_id, embedding_rag_profile_snapshot,
              embedding_rag_profile_hash,
              embedding_rag_profile_snapshot_provenance
         from source_files where id = $1 and deleted_at is null`,
      [id],
    );
    const sourceRow = source.rows[0];
    if (!sourceRow) return null;
    const job = await client.query(
      `select id, state, attempts, max_attempts, created_at, updated_at, completed_at,
              last_error_code, last_error_message, result
         from jobs where kind = 'document.parse' and payload->>'sourceId' = $1
        order by created_at desc limit 1`,
      [id],
    );
    const events = includeHistory
      ? await readActivityEventHistory(client, 'source', id)
      : null;
    const eventCursor = await readActivityEventCursor(client, 'source', id);
    const {
      document_parse_profile_id,
      document_parse_profile_snapshot,
      document_parse_profile_hash,
      document_parse_profile_snapshot_provenance,
      embedding_rag_profile_id,
      embedding_rag_profile_snapshot,
      embedding_rag_profile_hash,
      embedding_rag_profile_snapshot_provenance,
      ...publicSource
    } = sourceRow;
    return {
      source: publicSource,
      job: job.rows[0] ?? null,
      eventCursor,
      executionProfiles: {
        documentParse: {
          kind: 'document_parse',
          profileId: document_parse_profile_id,
          definition: document_parse_profile_snapshot,
          contentHash: document_parse_profile_hash,
          provenance: document_parse_profile_snapshot_provenance,
        },
        embeddingRag: {
          kind: 'embedding_rag',
          profileId: embedding_rag_profile_id,
          definition: embedding_rag_profile_snapshot,
          contentHash: embedding_rag_profile_hash,
          provenance: embedding_rag_profile_snapshot_provenance,
        },
      },
      ...(events ? {
        events: events.map((event) => ({
          id: event.id,
          event_type: event.eventType,
          payload: event.payload,
          created_at: event.createdAt.toISOString(),
        })),
      } : {}),
    };
  });
  return snapshot
    ? NextResponse.json(snapshot)
    : NextResponse.json({ code: 'SOURCE_NOT_FOUND' }, { status: 404 });
}
