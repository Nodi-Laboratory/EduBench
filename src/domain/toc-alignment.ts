import type { TocEntry } from '@/domain/toc';

export type TocAlignmentChunk = {
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  chapter: string | null;
  unit: string | null;
};

export type AlignedTocEntry = TocEntry & {
  parentOrdinal: number | null;
  mappingStatus: 'MAPPED' | 'UNMAPPED';
  mappingConfidence: number | null;
};

export type TocChunkMapping = {
  chunkOrdinal: number;
  tocOrdinal: number;
  relation: 'DIRECT' | 'ANCESTOR';
  confidence: number;
};

export type TocAlignment = {
  entries: AlignedTocEntry[];
  mappings: TocChunkMapping[];
};

type Anchor = {
  startOrdinal: number;
  confidence: number;
  headingKind: 'chapter' | 'unit' | null;
  headingValue: string | null;
  chapterValue: string | null;
};
type HeadingKind = Exclude<Anchor['headingKind'], null>;

export function normalizeTocHeading(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(/^\s*(?:(?:\d+(?:\s*[-.]\s*\d+)*)|(?:[ivxlcdm]+))(?:\s*[.)\-:·]\s*|\s+)/iu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

export function carryForwardTocChunkHeadings<T extends TocAlignmentChunk>(sourceChunks: readonly T[]): T[] {
  let carriedChapter: string | null = null;
  let carriedUnit: string | null = null;
  return [...sourceChunks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((chunk) => {
      const explicitChapter = chunk.chapter?.trim() || null;
      const explicitUnit = chunk.unit?.trim() || null;
      if (explicitChapter) {
        if (normalizeTocHeading(explicitChapter) !== normalizeTocHeading(carriedChapter ?? '')) {
          carriedUnit = null;
        }
        carriedChapter = explicitChapter;
      }
      if (explicitUnit) carriedUnit = explicitUnit;
      return {
        ...chunk,
        chapter: carriedChapter,
        unit: carriedUnit,
      };
    });
}

function headingScore(entry: TocEntry, value: string | null): number {
  const expected = normalizeTocHeading(entry.title);
  const actual = value ? normalizeTocHeading(value) : '';
  if (!expected || !actual) return 0;
  if (actual === expected) return 1;
  if (Math.min(actual.length, expected.length) >= 3
    && (actual.includes(expected) || expected.includes(actual))) return 0.9;
  return 0;
}

function headingValue(chunk: TocAlignmentChunk, kind: HeadingKind): string | null {
  return kind === 'unit' ? chunk.unit : chunk.chapter;
}

function isHeadingStart(chunks: TocAlignmentChunk[], index: number, kind: HeadingKind): boolean {
  const current = chunks[index]!;
  const currentHeading = normalizeTocHeading(headingValue(current, kind) ?? '');
  if (!currentHeading) return false;
  if (index === 0) return true;
  const previous = chunks[index - 1]!;
  const previousHeading = normalizeTocHeading(headingValue(previous, kind) ?? '');
  if (currentHeading !== previousHeading) return true;
  if (kind === 'unit') {
    return normalizeTocHeading(current.chapter ?? '') !== normalizeTocHeading(previous.chapter ?? '');
  }
  return false;
}

function parentOrdinals(entries: TocEntry[]): Map<number, number | null> {
  const parents = new Map<number, number | null>();
  const stack: TocEntry[] = [];
  for (const entry of entries) {
    while (stack.length && stack.at(-1)!.level >= entry.level) stack.pop();
    parents.set(entry.ordinal, stack.at(-1)?.ordinal ?? null);
    stack.push(entry);
  }
  return parents;
}

function monotonicPrintedPages(entries: TocEntry[]): boolean {
  let previous: number | null = null;
  for (const entry of entries) {
    if (entry.printedPage === null) continue;
    if (previous !== null && entry.printedPage < previous) return false;
    previous = entry.printedPage;
  }
  return true;
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2) return ordered[middle]!;
  return (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function alignTocEntriesToChunks(
  tocEntries: TocEntry[],
  sourceChunks: TocAlignmentChunk[],
): TocAlignment {
  const entries = [...tocEntries].sort((left, right) => left.ordinal - right.ordinal);
  const chunks = [...sourceChunks].sort((left, right) => left.ordinal - right.ordinal);
  const parents = parentOrdinals(entries);
  const anchors = new Map<number, Anchor>();
  const lastAnchorByLevel = new Map<number, number>();
  let lastAnchorOrdinal = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const kinds: HeadingKind[] = entry.level > 1 ? ['unit', 'chapter'] : ['chapter', 'unit'];
    let anchor: Anchor | null = null;
    for (const kind of kinds) {
      const sameLevelAnchor = lastAnchorByLevel.get(entry.level);
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.ordinal < lastAnchorOrdinal
          || (sameLevelAnchor !== undefined && chunk.ordinal <= sameLevelAnchor)
          || !isHeadingStart(chunks, index, kind)) continue;
        const confidence = headingScore(entry, headingValue(chunk, kind));
        if (!confidence) continue;
        anchor = {
          startOrdinal: chunk.ordinal,
          confidence,
          headingKind: kind,
          headingValue: normalizeTocHeading(headingValue(chunk, kind) ?? ''),
          chapterValue: normalizeTocHeading(chunk.chapter ?? '') || null,
        };
        break;
      }
      if (anchor) break;
    }
    if (anchor) {
      anchors.set(entry.ordinal, anchor);
      lastAnchorOrdinal = Math.max(lastAnchorOrdinal, anchor.startOrdinal);
      lastAnchorByLevel.set(entry.level, anchor.startOrdinal);
    }
  }

  if (chunks.length && monotonicPrintedPages(entries)) {
    const offsets = entries.flatMap((entry) => {
      const anchor = anchors.get(entry.ordinal);
      const matchedChunk = anchor && chunks.find((chunk) => chunk.ordinal === anchor.startOrdinal);
      return entry.printedPage !== null && matchedChunk?.pageStart !== null && matchedChunk?.pageStart !== undefined
        ? [matchedChunk.pageStart - entry.printedPage]
        : [];
    });
    if (offsets.length) {
      const pageOffset = Math.round(median(offsets));
      const documentPages = chunks.flatMap((chunk) => chunk.pageStart === null ? [] : [chunk.pageStart]);
      const minimumPage = documentPages.length ? Math.min(...documentPages) : null;
      const maximumPage = documentPages.length ? Math.max(...documentPages) : null;
      for (const entry of entries) {
        if (anchors.has(entry.ordinal) || entry.printedPage === null || minimumPage === null || maximumPage === null) continue;
        const documentPage = entry.printedPage + pageOffset;
        if (documentPage < minimumPage || documentPage > maximumPage) continue;
        const chunk = chunks.find((candidate) => candidate.pageStart !== null && candidate.pageStart >= documentPage);
        if (chunk) {
          const entryIndex = entries.findIndex((candidate) => candidate.ordinal === entry.ordinal);
          const previousAnchors = entries.slice(0, entryIndex)
            .flatMap((candidate) => anchors.get(candidate.ordinal)?.startOrdinal ?? []);
          const nextAnchors = entries.slice(entryIndex + 1)
            .flatMap((candidate) => anchors.get(candidate.ordinal)?.startOrdinal ?? []);
          const previousSameLevel = entries.slice(0, entryIndex).reverse()
            .find((candidate) => candidate.level === entry.level && anchors.has(candidate.ordinal));
          const nextSameLevel = entries.slice(entryIndex + 1)
            .find((candidate) => candidate.level === entry.level && anchors.has(candidate.ordinal));
          if ((previousAnchors.length && chunk.ordinal < Math.max(...previousAnchors))
            || (nextAnchors.length && chunk.ordinal > Math.min(...nextAnchors))
            || (previousSameLevel && chunk.ordinal <= anchors.get(previousSameLevel.ordinal)!.startOrdinal)
            || (nextSameLevel && chunk.ordinal >= anchors.get(nextSameLevel.ordinal)!.startOrdinal)) continue;
          anchors.set(entry.ordinal, {
            startOrdinal: chunk.ordinal,
            confidence: 0.7,
            headingKind: null,
            headingValue: null,
            chapterValue: null,
          });
        }
      }
    }
  }

  const endOrdinals = new Map<number, number>();
  for (const [index, entry] of entries.entries()) {
    const nextBoundary = entries.slice(index + 1).find((candidate) =>
      candidate.level <= entry.level && anchors.has(candidate.ordinal));
    const anchor = anchors.get(entry.ordinal);
    const isLeaf = !entries.some((candidate) => parents.get(candidate.ordinal) === entry.ordinal);
    const headingBoundary = anchor?.headingKind && anchor.headingValue && isLeaf
      ? chunks.find((chunk) => {
        if (chunk.ordinal <= anchor.startOrdinal) return false;
        const heading = anchor.headingKind === 'unit' ? chunk.unit : chunk.chapter;
        return heading === null
          || normalizeTocHeading(heading) !== anchor.headingValue
          || (anchor.headingKind === 'unit'
            && (normalizeTocHeading(chunk.chapter ?? '') || null) !== anchor.chapterValue);
      })?.ordinal
      : undefined;
    endOrdinals.set(
      entry.ordinal,
      Math.min(
        nextBoundary ? anchors.get(nextBoundary.ordinal)!.startOrdinal : Number.POSITIVE_INFINITY,
        headingBoundary ?? Number.POSITIVE_INFINITY,
      ),
    );
  }

  const mappings: TocChunkMapping[] = [];
  for (const chunk of chunks) {
    const direct = entries
      .filter((entry) => {
        const anchor = anchors.get(entry.ordinal);
        return anchor
          && anchor.startOrdinal <= chunk.ordinal
          && chunk.ordinal < (endOrdinals.get(entry.ordinal) ?? Number.POSITIVE_INFINITY);
      })
      .sort((left, right) => right.level - left.level || right.ordinal - left.ordinal)[0];
    if (!direct) continue;
    const confidence = anchors.get(direct.ordinal)!.confidence;
    mappings.push({ chunkOrdinal: chunk.ordinal, tocOrdinal: direct.ordinal, relation: 'DIRECT', confidence });
    let parentOrdinal = parents.get(direct.ordinal) ?? null;
    while (parentOrdinal !== null) {
      mappings.push({ chunkOrdinal: chunk.ordinal, tocOrdinal: parentOrdinal, relation: 'ANCESTOR', confidence });
      parentOrdinal = parents.get(parentOrdinal) ?? null;
    }
  }

  const alignedEntries = entries.map<AlignedTocEntry>((entry) => {
    const entryMappings = mappings.filter((mapping) => mapping.tocOrdinal === entry.ordinal);
    return {
      ...entry,
      parentOrdinal: parents.get(entry.ordinal) ?? null,
      mappingStatus: entryMappings.length ? 'MAPPED' : 'UNMAPPED',
      mappingConfidence: entryMappings.length
        ? Math.max(...entryMappings.map((mapping) => mapping.confidence))
        : null,
    };
  });

  return { entries: alignedEntries, mappings };
}
