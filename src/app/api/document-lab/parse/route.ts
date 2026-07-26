import { NextResponse } from 'next/server';
import { DomainError } from '@/domain/errors';
import {
  DocumentLabError,
  DocumentPageParseError,
  parseDocumentLabFile,
  type DocumentLabProfileConfig,
} from '@/server/documents/lab';
import { listResearchConfigProfiles } from '@/server/settings/research-profiles';

type ListResearchConfigProfiles = typeof listResearchConfigProfiles;

export async function loadActiveDocumentParseProfile(
  listProfiles: ListResearchConfigProfiles = listResearchConfigProfiles,
): Promise<DocumentLabProfileConfig> {
  const profiles = await listProfiles('document_parse');
  const activeId = profiles.activeByKind.document_parse;
  if (!activeId) {
    throw new DocumentLabError(
      'DOCUMENT_PARSE_PROFILE_NOT_CONFIGURED',
      409,
      '활성 문서 파싱 연구 프로필이 없습니다.',
    );
  }
  const activeProfiles = profiles.items.filter((profile) => profile.active);
  const active = activeProfiles.length === 1
    && activeProfiles[0]?.id === activeId
    ? activeProfiles[0]
    : null;
  if (!active || active.kind !== 'document_parse' || active.definition.kind !== 'document_parse') {
    throw new DocumentLabError(
      'DOCUMENT_PARSE_PROFILE_INTEGRITY_ERROR',
      500,
      '활성 문서 파싱 연구 프로필의 무결성을 확인하지 못했습니다.',
    );
  }
  return {
    id: active.id,
    version: active.version,
    contentHash: active.contentHash,
    settings: active.definition.settings,
  };
}

type DocumentLabPostDependencies = {
  loadActiveProfile?: () => Promise<DocumentLabProfileConfig>;
  parseFile?: typeof parseDocumentLabFile;
};

export function createDocumentLabPostHandler(
  dependencies: DocumentLabPostDependencies = {},
) {
  return async function post(request: Request) {
    try {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ code: 'FILE_REQUIRED', message: 'A document file is required.' }, { status: 400 });
      }
      const profile = await (
        dependencies.loadActiveProfile ?? loadActiveDocumentParseProfile
      )();
      return NextResponse.json(await (
        dependencies.parseFile ?? parseDocumentLabFile
      )(file, { profile, signal:request.signal }));
    } catch (error) {
      if (error instanceof DocumentLabError) {
        return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
      }
      if (
        error instanceof DomainError
        && error.code === 'RESEARCH_PROFILE_INTEGRITY_ERROR'
      ) {
        return NextResponse.json({
          code: 'DOCUMENT_PARSE_PROFILE_INTEGRITY_ERROR',
          message: '활성 문서 파싱 연구 프로필의 무결성을 확인하지 못했습니다.',
        }, { status: 500 });
      }
      if (error instanceof DocumentPageParseError) {
        return NextResponse.json({
          code: error.code,
          message: error.message,
          pageNumber: error.pageNumber,
          provider: error.provider,
          category: error.category,
          status: error.providerStatus,
          requestId: error.requestId,
        }, { status: 502 });
      }
      return NextResponse.json({ code: 'DOCUMENT_LAB_PARSE_FAILED', message: 'Unable to parse the document.' }, { status: 502 });
    }
  };
}

export const POST = createDocumentLabPostHandler();
