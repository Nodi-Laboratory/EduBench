import { NextResponse } from 'next/server';
import { DocumentLabError, DocumentPageParseError, parseDocumentLabFile } from '@/server/documents/lab';

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ code: 'FILE_REQUIRED', message: 'A document file is required.' }, { status: 400 });
    }
    return NextResponse.json(await parseDocumentLabFile(file));
  } catch (error) {
    if (error instanceof DocumentLabError) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
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
}
