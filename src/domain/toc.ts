import { load } from 'cheerio';

export type TocEntry = { ordinal: number; title: string; level: number; printedPage: number | null };

function clean(value: string) {
  return value.replace(/\s+/g, ' ').replace(/[.…·]{2,}/g, ' ').trim();
}

function linesFromHtml(html: string): string[] {
  const $ = load(`<div id="toc-root">${html.replace(/<br\s*\/?\s*>/gi, '\n')}</div>`);
  return $('#toc-root').text().split(/\n+/).map(clean).filter(Boolean);
}

function parseLines(lines: string[]): Array<{ title: string; printedPage: number }> {
  const parsed: Array<{ title: string; printedPage: number }> = [];
  let pending = '';
  for (const line of lines) {
    const combined = clean(pending ? `${pending} ${line}` : line);
    const match = /^(.*?\D)\s+(\d{1,3})$/.exec(combined);
    if (!match) { pending = combined; continue; }
    const title = clean(match[1]!);
    const printedPage = Number(match[2]);
    if (title.length >= 2 && title.length <= 180) parsed.push({ title, printedPage });
    pending = '';
  }
  return parsed;
}

export function extractTableOfContents(html: string, maxDocumentPages = 10): TocEntry[] {
  const $ = load(html);
  const entries: TocEntry[] = [];
  const seen = new Set<string>();
  const add = (title: string, level: number, printedPage: number | null) => {
    const normalized = clean(title);
    if (!normalized || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    entries.push({ ordinal: entries.length + 1, title: normalized, level, printedPage });
  };

  $('[data-page]').toArray().forEach((section) => {
    const documentPage = Number($(section).attr('data-page'));
    if (!Number.isFinite(documentPage) || documentPage > maxDocumentPages) return;
    const chapter = clean($(section).find('h1, h2').first().text());
    const indexNodes = $(section).find('[data-category="index"], .toc, .table-of-contents').toArray();
    const details = indexNodes.flatMap((node) => parseLines(linesFromHtml($(node).html() ?? '')));
    if (chapter && details.length) add(chapter, 1, details[0]!.printedPage);
    for (const detail of details) add(detail.title, 2, detail.printedPage);
  });
  return entries;
}
