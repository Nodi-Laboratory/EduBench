import { NextResponse } from 'next/server';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';

type ArtifactKind = 'revision' | 'pages' | 'chunks' | 'toc';
type RevisionContentView = 'markdown' | 'html' | 'reviewed';
const revisionContentViews = new Set<RevisionContentView>([
  'markdown',
  'html',
  'reviewed',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const kind = (url.searchParams.get('kind') ?? 'revision') as ArtifactKind;
  if (!(['revision', 'pages', 'chunks', 'toc'] as const).includes(kind)) {
    return NextResponse.json({ code: 'SOURCE_ARTIFACT_KIND_INVALID' }, { status: 400 });
  }
  const requestedLimit = boundedInteger(url.searchParams.get('limit'), 25, 1, 100);
  const afterOrdinal = boundedInteger(url.searchParams.get('afterOrdinal'), 0, 0, 1_000_000);
  const afterPage = boundedInteger(url.searchParams.get('afterPage'), 0, 0, 1_000_000);
  const revisionId = url.searchParams.get('revisionId');
  const artifactId = url.searchParams.get('artifactId');
  const includeVector = url.searchParams.get('includeVector') === '1';
  const includeRaw = url.searchParams.get('includeRaw') === '1';
  const includeContent = url.searchParams.get('includeContent') === '1';
  const requestedContentView = url.searchParams.get('contentView');
  const revisionContentView:RevisionContentView = requestedContentView
    && revisionContentViews.has(requestedContentView as RevisionContentView)
    ? requestedContentView as RevisionContentView
    : 'markdown';
  if (
    kind === 'revision'
    && includeContent
    && requestedContentView
    && !revisionContentViews.has(requestedContentView as RevisionContentView)
  ) {
    return NextResponse.json(
      { code:'SOURCE_ARTIFACT_CONTENT_VIEW_INVALID' },
      { status:400 },
    );
  }
  const singleArtifact = (includeContent || includeVector) && (
    kind === 'pages' || kind === 'chunks'
  );
  const limit = (kind === 'pages' && includeRaw) || singleArtifact
    ? 1
    : requestedLimit;
  const hasPaginationCursor = kind === 'pages'
    ? url.searchParams.has('afterPage')
    : (kind === 'chunks' || kind === 'toc')
      ? url.searchParams.has('afterOrdinal')
      : false;
  if (hasPaginationCursor && !revisionId) {
    return NextResponse.json(
      { code: 'SOURCE_ARTIFACT_REVISION_REQUIRED' },
      { status: 400 },
    );
  }
  if (revisionId && !uuidPattern.test(revisionId)) {
    return NextResponse.json(
      { code: 'SOURCE_ARTIFACT_REVISION_MISMATCH' },
      { status: 409 },
    );
  }
  if (artifactId && !uuidPattern.test(artifactId)) {
    return NextResponse.json(
      { code: 'SOURCE_ARTIFACT_ID_INVALID' },
      { status: 400 },
    );
  }
  if (singleArtifact && (!revisionId || !artifactId)) {
    return NextResponse.json(
      { code: 'SOURCE_ARTIFACT_DETAIL_REQUIRES_ID' },
      { status: 400 },
    );
  }

  const result = await withReadOnlyRepeatableReadTransaction(async (client) => {
    const source = await client.query<{ id: string; original_name: string }>(
      `select id,original_name
         from source_files
        where id=$1 and deleted_at is null`,
      [id],
    );
    if (!source.rows[0]) return null;

    const selectedRevision = await client.query<{
      id: string;
      revision: number;
      parse_model: string | null;
      parse_request_id: string | null;
      raw_response: unknown;
      raw_html: string | null;
      raw_markdown: string | null;
      reviewed_html: string | null;
      review_summary: string | null;
      has_content: boolean;
      raw_html_bytes: number | null;
      raw_markdown_bytes: number | null;
      reviewed_html_bytes: number | null;
      expected_page_count: number | null;
      toc_alignment_attempted_at: Date | null;
      created_at: Date;
    }>(
      `select id,revision,parse_model,parse_request_id,
              ${includeRaw ? 'raw_response' : 'null::jsonb as raw_response'},
              ${includeContent && revisionContentView === 'html' ? 'raw_html' : 'null::text as raw_html'},
              ${includeContent && revisionContentView === 'markdown' ? 'raw_markdown' : 'null::text as raw_markdown'},
              ${includeContent && revisionContentView === 'reviewed' ? 'reviewed_html' : 'null::text as reviewed_html'},
              review_summary,
              (raw_html is not null or raw_markdown is not null) has_content,
              octet_length(raw_html)::int raw_html_bytes,
              octet_length(raw_markdown)::int raw_markdown_bytes,
              octet_length(reviewed_html)::int reviewed_html_bytes,
              case
                when jsonb_typeof(raw_response->'pageCount')='number'
                then (raw_response->>'pageCount')::int
                else null
              end expected_page_count,
              toc_alignment_attempted_at,created_at
         from source_revisions
        where source_file_id=$1
          and ($2::uuid is null or id=$2::uuid)
        order by revision desc
        limit 1`,
      [id, revisionId],
    );
    const revision = selectedRevision.rows[0];
    if (!revision) {
      if (revisionId) {
        return {
          error: 'SOURCE_ARTIFACT_REVISION_MISMATCH' as const,
          status: 409,
        };
      }
      return {
        kind,
        source: source.rows[0],
        completeness: 'NOT_AVAILABLE',
        ...(kind === 'revision' ? { artifact: null } : { total: 0, items: [] }),
      };
    }

    if (kind === 'revision') {
      return {
        kind,
        source: source.rows[0],
        completeness: revision.has_content
          ? 'COMPLETE'
          : 'LEGACY_PARTIAL',
        artifact: {
          id: revision.id,
          revision: revision.revision,
          parseModel: revision.parse_model,
          parseRequestId: revision.parse_request_id,
          rawResponse: revision.raw_response,
          rawResponseIncluded:includeRaw,
          rawHtml: revision.raw_html,
          rawMarkdown: revision.raw_markdown,
          reviewedHtml: revision.reviewed_html,
          contentIncluded:includeContent,
          contentView:includeContent ? revisionContentView : null,
          contentAvailable:revision.has_content,
          contentBytes:{
            rawHtml:revision.raw_html_bytes,
            rawMarkdown:revision.raw_markdown_bytes,
            reviewedHtml:revision.reviewed_html_bytes,
          },
          reviewSummary: revision.review_summary,
          tocAlignmentAttemptedAt: revision.toc_alignment_attempted_at?.toISOString() ?? null,
          createdAt: revision.created_at.toISOString(),
        },
      };
    }

    if (kind === 'pages') {
      const expected = revision.expected_page_count;
      const [count, pageRows] = await Promise.all([
        client.query<{ total: number }>(
          `select count(*)::int as total
             from source_revision_page_artifacts
            where source_revision_id=$1`,
          [revision.id],
        ),
        client.query<{
          id: string;
          page_number: number;
          filename: string;
          mime_type: string;
          raster_width: number | null;
          raster_height: number | null;
          parse_model: string | null;
          parse_request_id: string | null;
          request_config: unknown;
          raw_response: unknown;
          raw_html: string;
          raw_markdown: string | null;
          raw_html_bytes: number | null;
          raw_markdown_bytes: number | null;
          content_preview: string | null;
          created_at: Date;
        }>(
          `select id,page_number,filename,mime_type,raster_width,raster_height,
                  parse_model,parse_request_id,request_config,
                  ${includeRaw ? 'raw_response' : 'null::jsonb as raw_response'},
                  ${includeContent ? 'raw_html' : 'null::text as raw_html'},
                  ${includeContent ? 'raw_markdown' : 'null::text as raw_markdown'},
                  octet_length(raw_html)::int raw_html_bytes,
                  octet_length(raw_markdown)::int raw_markdown_bytes,
                  left(coalesce(nullif(raw_markdown,''),raw_html),320) content_preview,
                  created_at
             from source_revision_page_artifacts
            where source_revision_id=$1
              and ($4::uuid is null or id=$4::uuid)
              and ($4::uuid is not null or page_number>$2)
            order by page_number
            limit $3`,
          [revision.id, afterPage, limit + 1, artifactId],
        ),
      ]);
      const persisted = count.rows[0]?.total ?? 0;
      const hasMore = !artifactId && pageRows.rows.length > limit;
      const rows = pageRows.rows.slice(0, limit);
      return {
        kind,
        source: source.rows[0],
        revision: { id: revision.id, revision: revision.revision },
        completeness: expected == null
          ? 'LEGACY_PARTIAL'
          : expected === persisted
            ? 'COMPLETE'
            : 'INCOMPLETE',
        expectedPageCount: expected,
        persistedPageCount: persisted,
        total: persisted,
        nextAfterPage: hasMore ? rows.at(-1)?.page_number ?? null : null,
        items: rows.map((page) => ({
          id: page.id,
          pageNumber: page.page_number,
          filename: page.filename,
          mimeType: page.mime_type,
          rasterWidth: page.raster_width,
          rasterHeight: page.raster_height,
          parseModel: page.parse_model,
          parseRequestId: page.parse_request_id,
          requestConfig: page.request_config,
          rawResponse: page.raw_response,
          rawResponseIncluded:includeRaw,
          contentIncluded:includeContent,
          contentAvailable:Boolean(page.raw_html_bytes || page.raw_markdown_bytes),
          contentBytes:{
            rawHtml:page.raw_html_bytes,
            rawMarkdown:page.raw_markdown_bytes,
          },
          contentPreview:page.content_preview,
          rawHtml: page.raw_html,
          rawMarkdown: page.raw_markdown,
          createdAt: page.created_at.toISOString(),
        })),
      };
    }

    if (kind === 'chunks') {
      const [count, chunks] = await Promise.all([
        client.query<{ total: number }>(
          `select count(*)::int as total
             from source_chunks
            where source_revision_id=$1`,
          [revision.id],
        ),
        client.query<{
          id: string;
          ordinal: number;
          chapter: string | null;
          unit: string | null;
          page_start: number | null;
          page_end: number | null;
          kind: string;
          html: string | null;
          content: string;
          token_count: number | null;
          embedding_model: string | null;
          embedding_version: string | null;
          embedding_vector_space_id: string | null;
          embedding_rag_profile_hash: string | null;
          embedding_rag_profile_snapshot_provenance: string;
          dimensions: number | null;
          norm: number | null;
          vector_text: string | null;
          content_preview: string;
          content_bytes: number;
          html_bytes: number | null;
        }>(
          `select chunk.id,chunk.ordinal,chunk.chapter,chunk.unit,
                  chunk.page_start,chunk.page_end,chunk.kind,
                  ${includeContent ? 'coalesce(chunk.html,blob.html)' : 'null::text'} as html,
                  ${includeContent ? 'chunk.content' : 'null::text'} as content,
                  left(chunk.content,320) content_preview,
                  octet_length(chunk.content)::int content_bytes,
                  octet_length(coalesce(chunk.html,blob.html))::int html_bytes,
                  chunk.token_count,chunk.embedding_model,chunk.embedding_version,
                  chunk.embedding_vector_space_id,chunk.embedding_rag_profile_hash,
                  chunk.embedding_rag_profile_snapshot_provenance,
                  case when chunk.embedding is null then null else vector_dims(chunk.embedding) end as dimensions,
                  case when chunk.embedding is null then null
                       else sqrt(greatest(0,-(chunk.embedding <#> chunk.embedding)))::double precision
                  end as norm,
                  case when $4::boolean and chunk.embedding is not null
                       then chunk.embedding::text else null end as vector_text
             from source_chunks chunk
             left join source_html_blobs blob on blob.id=chunk.html_blob_id
            where chunk.source_revision_id=$1
              and ($5::uuid is null or chunk.id=$5::uuid)
              and ($5::uuid is not null or chunk.ordinal>$2)
            order by chunk.ordinal
            limit $3`,
          [revision.id, afterOrdinal, limit + 1, includeVector, artifactId],
        ),
      ]);
      const hasMore = !artifactId && chunks.rows.length > limit;
      const rows = chunks.rows.slice(0, limit);
      return {
        kind,
        source: source.rows[0],
        revision: { id: revision.id, revision: revision.revision },
        completeness: 'COMPLETE',
        total: count.rows[0]?.total ?? 0,
        nextAfterOrdinal: hasMore ? rows.at(-1)?.ordinal ?? null : null,
        items: rows.map((chunk) => ({
          id: chunk.id,
          ordinal: chunk.ordinal,
          chapter: chunk.chapter,
          unit: chunk.unit,
          pageStart: chunk.page_start,
          pageEnd: chunk.page_end,
          kind: chunk.kind,
          html: chunk.html,
          content: chunk.content,
          contentIncluded:includeContent,
          contentAvailable:chunk.content_bytes > 0 || Boolean(chunk.html_bytes),
          contentPreview:chunk.content_preview,
          contentBytes:chunk.content_bytes,
          htmlBytes:chunk.html_bytes,
          tokenCount: chunk.token_count,
          embedding: {
            model: chunk.embedding_model,
            version: chunk.embedding_version,
            vectorSpaceId: chunk.embedding_vector_space_id,
            profileHash: chunk.embedding_rag_profile_hash,
            provenance: chunk.embedding_rag_profile_snapshot_provenance,
            dimensions: chunk.dimensions,
            norm: chunk.norm,
            ...(chunk.vector_text
              ? { vector: JSON.parse(chunk.vector_text) as number[] }
              : {}),
          },
        })),
      };
    }

    const [tocCount, tocRows] = await Promise.all([
      client.query<{ total: number; mapped: number; unmapped: number }>(
        `select count(*)::int as total,
                count(*) filter (where mapping_status='MAPPED')::int as mapped,
                count(*) filter (where mapping_status<>'MAPPED')::int as unmapped
           from source_toc_entries
          where source_revision_id=$1`,
        [revision.id],
      ),
      client.query<{
        id: string;
        ordinal: number;
        title: string;
        level: number;
        printed_page: number | null;
        parent_id: string | null;
        mapping_status: string;
        mapping_confidence: number | null;
        mappings: unknown[];
      }>(
        `select entry.id,entry.ordinal,entry.title,entry.level,entry.printed_page,
                entry.parent_id,entry.mapping_status,entry.mapping_confidence,
                coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'chunkId',mapping.source_chunk_id,
                      'relation',mapping.relation,
                      'confidence',mapping.confidence
                    )
                    order by mapping.source_chunk_id
                  ) filter (where mapping.source_chunk_id is not null),
                  '[]'::jsonb
                ) as mappings
           from source_toc_entries entry
           left join source_chunk_toc_entries mapping
             on mapping.source_toc_entry_id=entry.id
            and mapping.source_revision_id=entry.source_revision_id
          where entry.source_revision_id=$1
            and entry.ordinal>$2
          group by entry.id
          order by entry.ordinal
          limit $3`,
        [revision.id, afterOrdinal, limit + 1],
      ),
    ]);
    const hasMore = tocRows.rows.length > limit;
    const toc = tocRows.rows.slice(0, limit);
    return {
      kind,
      source: source.rows[0],
      revision: { id: revision.id, revision: revision.revision },
      completeness: revision.toc_alignment_attempted_at
        ? 'COMPLETE'
        : 'LEGACY_PARTIAL',
      total: tocCount.rows[0]?.total ?? 0,
      mappingSummary: {
        mapped:tocCount.rows[0]?.mapped ?? 0,
        unmapped:tocCount.rows[0]?.unmapped ?? 0,
      },
      nextAfterOrdinal: hasMore ? toc.at(-1)?.ordinal ?? null : null,
      items: toc.map((entry) => ({
        id: entry.id,
        ordinal: entry.ordinal,
        title: entry.title,
        level: entry.level,
        printedPage: entry.printed_page,
        parentId: entry.parent_id,
        mappingStatus: entry.mapping_status,
        mappingConfidence: entry.mapping_confidence,
        mappings: entry.mappings,
      })),
    };
  });

  if (!result) {
    return NextResponse.json({ code: 'SOURCE_NOT_FOUND' }, { status: 404 });
  }
  if ('error' in result) {
    return NextResponse.json({ code: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}
