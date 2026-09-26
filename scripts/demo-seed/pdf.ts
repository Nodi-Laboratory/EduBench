// Writes a minimal multi-page PDF (Helvetica, ASCII text only). The demo seed
// only needs real PDF bytes for the page renderer; the Korean page text is
// supplied by the fake Document Parse response.

function escapePdfText(value: string): string {
  return value.replace(/[\\()]/g, (character) => `\\${character}`);
}

export function buildDemoPdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const pageCount = pages.length;
  const fontId = 3;
  const firstPageId = 4;
  const pageIds = pages.map((_, index) => firstPageId + index * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, index) => {
    const pageId = pageIds[index]!;
    const contentId = pageId + 1;
    const text = lines
      .map((line, lineIndex) => `BT /F1 ${lineIndex === 0 ? 20 : 12} Tf 60 ${760 - lineIndex * 28} Td (${escapePdfText(line)}) Tj ET`)
      .join('\n');
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}
