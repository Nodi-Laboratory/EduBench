import { NextResponse } from 'next/server';
import { withRequestProviderKeys } from '@/server/providers/credentials';
import { reprocessSourceWithCurrentProfiles } from '@/server/sources/reprocessing';

async function handlePost(
  _request:Request,
  context:{ params:Promise<{ id:string }> },
) {
  const { id } = await context.params;
  const result = await reprocessSourceWithCurrentProfiles(id);
  if (!result) {
    return NextResponse.json(
      {
        code:'SOURCE_NOT_FOUND',
        message:'현재 설정으로 다시 처리할 교과서를 찾을 수 없습니다.',
      },
      { status:404 },
    );
  }
  return NextResponse.json(result);
}

export function POST(...args: Parameters<typeof handlePost>) {
  return withRequestProviderKeys(args[0], () => handlePost(...args));
}
