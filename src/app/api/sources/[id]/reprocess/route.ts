import { NextResponse } from 'next/server';
import { reprocessSourceWithCurrentProfiles } from '@/server/sources/reprocessing';

export async function POST(
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
