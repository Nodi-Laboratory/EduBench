import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  researchConfigDefinitionSchema,
  researchConfigKinds,
} from '@/domain/research-config';
import { DomainError } from '@/domain/errors';
import {
  activateResearchConfigProfile,
  createResearchConfigProfile,
  listResearchConfigProfiles,
} from '@/server/settings/research-profiles';

const kindSchema = z.enum(researchConfigKinds);
const postgresUuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);
const activateSchema = z.object({
  kind:kindSchema,
  profileId:postgresUuidSchema,
}).strict();

function invalidInput(error: z.ZodError) {
  return NextResponse.json(
    { code:'INVALID_RESEARCH_PROFILE', issues:error.issues },
    { status:400 },
  );
}

export async function GET(request: Request) {
  const rawKind = new URL(request.url).searchParams.get('kind');
  const parsedKind = rawKind == null ? undefined : kindSchema.safeParse(rawKind);
  if (parsedKind && !parsedKind.success) return invalidInput(parsedKind.error);
  const result = await listResearchConfigProfiles(parsedKind?.data);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { code:'INVALID_RESEARCH_PROFILE', message:'JSON 요청 본문이 필요합니다.' },
      { status:400 },
    );
  }
  const parsed = researchConfigDefinitionSchema.safeParse(body);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    const item = await createResearchConfigProfile(parsed.data);
    return NextResponse.json({ item }, { status:201 });
  } catch (error) {
    if ((error as { code?:string }).code === '23505') {
      return NextResponse.json(
        { code:'RESEARCH_PROFILE_CONFLICT', message:'같은 버전 또는 정의의 프로필이 이미 있습니다.' },
        { status:409 },
      );
    }
    throw error;
  }
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { code:'INVALID_RESEARCH_PROFILE', message:'JSON 요청 본문이 필요합니다.' },
      { status:400 },
    );
  }
  const parsed = activateSchema.safeParse(body);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    const active = await activateResearchConfigProfile(
      parsed.data.kind,
      parsed.data.profileId,
    );
    return NextResponse.json({ active });
  } catch (error) {
    if (
      error instanceof DomainError
      && error.code === 'RESEARCH_PROFILE_NOT_FOUND'
    ) {
      return NextResponse.json(
        { code:error.code, message:error.message },
        { status:404 },
      );
    }
    throw error;
  }
}
