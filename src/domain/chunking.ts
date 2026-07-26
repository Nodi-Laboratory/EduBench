import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

export type TextbookChunk = {
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  chapter: string | null;
  unit: string | null;
  kind: string;
  html: string;
  content: string;
  estimatedTokens: number;
};

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function splitText(text: string, maxCharacters: number): string[] {
  if (text.length <= maxCharacters) return [text];
  const sentences = text.split(/(?<=[.!?。]|다\.)\s+/u).filter(Boolean);
  const parts: string[] = [];
  let current = '';

  for (const sentence of sentences.length > 1 ? sentences : [text]) {
    if (sentence.length > maxCharacters) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let index = 0; index < sentence.length; index += maxCharacters) {
        parts.push(sentence.slice(index, index + maxCharacters).trim());
      }
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxCharacters) {
      parts.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts.filter(Boolean);
}

function semanticBlocks($: CheerioAPI, section: Cheerio<Element>): Element[] {
  return section
    .find('p, li, table, [data-kind]')
    .toArray()
    .filter((element) => {
      if ($(element).attr('data-kind')) return true;
      return $(element).parents('[data-kind]').length === 0;
    });
}

export function chunkTextbook(html: string, options: { maxTokens: number }): TextbookChunk[] {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 10) {
    throw new Error('maxTokens must be an integer of at least 10');
  }
  const $ = load(html);
  const sections = $('[data-page]').toArray().filter((element) => $(element).parents('[data-page]').length === 0);
  const chunks: TextbookChunk[] = [];
  const maxCharacters = options.maxTokens * 3;
  let carriedChapter: string | null = null;
  let carriedUnit: string | null = null;

  for (const sectionElement of sections) {
    const section = $(sectionElement);
    const pageStart = Number.parseInt(section.attr('data-page') ?? '', 10);
    const pageEndValue = Number.parseInt(section.attr('data-page-end') ?? '', 10);
    const explicitChapter = normalizedText(section.attr('data-chapter') ?? '')
      || normalizedText(section.find('h1').first().text())
      || null;
    const explicitUnit = normalizedText(section.attr('data-unit') ?? '')
      || normalizedText(section.find('h2').first().text())
      || null;
    if (explicitChapter) {
      if (normalizedText(carriedChapter ?? '') !== explicitChapter) carriedUnit = null;
      carriedChapter = explicitChapter;
    }
    if (explicitUnit) carriedUnit = explicitUnit;
    const chapter = carriedChapter;
    const unit = carriedUnit;
    const blocks = semanticBlocks($, section);

    for (const block of blocks) {
      const element = $(block);
      const content = normalizedText(element.text());
      if (!content) continue;
      const kind = element.attr('data-kind')
        ?? (block.tagName === 'table' ? 'table' : block.tagName === 'li' ? 'list-item' : 'paragraph');
      for (const part of splitText(content, maxCharacters)) {
        chunks.push({
          ordinal: chunks.length + 1,
          pageStart: Number.isNaN(pageStart) ? null : pageStart,
          pageEnd: Number.isNaN(pageEndValue) ? (Number.isNaN(pageStart) ? null : pageStart) : pageEndValue,
          chapter,
          unit,
          kind,
          html: $.html(block as AnyNode),
          content: part,
          estimatedTokens: Math.ceil(part.length / 3),
        });
      }
    }
  }
  return chunks;
}
