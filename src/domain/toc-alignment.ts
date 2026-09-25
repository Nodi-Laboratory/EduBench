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

export type PrintedPageLocation = {
  printedPage: number;
  documentPage: number;
};

export type PrintedPageArtifact = {
  documentPage: number;
  rawResponse: unknown;
};

type Anchor = {
  startOrdinal: number;
  confidence: number;
  headingKind: 'chapter' | 'unit' | null;
  headingValue: string | null;
  chapterValue: string | null;
};
type HeadingKind = Exclude<Anchor['headingKind'], null>;

type PageCalibration = {
  slope: number;
  intercept: number;
  inliers: PrintedPageLocation[];
};

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

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function footerText(element: Record<string, unknown>): string {
  const content = recordValue(element.content);
  const value = content?.text || content?.markdown || content?.html || element.text;
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function footerCenterX(element: Record<string, unknown>): number | null {
  if (!Array.isArray(element.coordinates)) return null;
  const coordinates = element.coordinates
    .map(recordValue)
    .flatMap((coordinate) => {
      const x = coordinate?.x;
      return typeof x === 'number' && Number.isFinite(x) ? [x] : [];
    });
  return coordinates.length ? coordinates.reduce((sum, x) => sum + x, 0) / coordinates.length : null;
}

/**
 * Upstage keeps the printed textbook page in footer elements. Landscape
 * textbook uploads commonly contain two printed pages in one PDF page, so the
 * footer coordinate determines whether the first (left) or last (right)
 * integer is the page number.
 */
export function extractPrintedPageLocations(
  artifacts: readonly PrintedPageArtifact[],
): PrintedPageLocation[] {
  const candidatesBySide = new Map<string, {
    documentPage: number;
    printedPages: Set<number>;
  }>();
  for (const artifact of artifacts) {
    if (!Number.isInteger(artifact.documentPage) || artifact.documentPage < 1) continue;
    const raw = recordValue(artifact.rawResponse);
    if (!Array.isArray(raw?.elements)) continue;
    for (const value of raw.elements) {
      const element = recordValue(value);
      if (!element || String(element.category ?? element.type ?? '').toLocaleLowerCase() !== 'footer') continue;
      const numbers = footerText(element).match(/(?<!\d)\d{1,4}(?!\d)/g)
        ?.map(Number)
        .filter((candidate) => candidate > 0) ?? [];
      if (!numbers.length) continue;
      const centerX = footerCenterX(element);
      if (centerX === null && numbers.length !== 1) continue;
      const printedPage = centerX !== null && centerX < 0.5 ? numbers[0]! : numbers.at(-1)!;
      const side = centerX === null ? 'unknown' : centerX < 0.5 ? 'left' : 'right';
      const key = `${artifact.documentPage}:${side}`;
      const candidate = candidatesBySide.get(key) ?? {
        documentPage: artifact.documentPage,
        printedPages: new Set<number>(),
      };
      candidate.printedPages.add(printedPage);
      candidatesBySide.set(key, candidate);
    }
  }
  return [...candidatesBySide.values()]
    .flatMap((candidate) => candidate.printedPages.size === 1
      ? [{
        printedPage: [...candidate.printedPages][0]!,
        documentPage: candidate.documentPage,
      }]
      : [])
    .sort((left, right) => left.documentPage - right.documentPage || left.printedPage - right.printedPage);
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

function leastSquaresCalibration(points: PrintedPageLocation[]): Omit<PageCalibration, 'inliers'> | null {
  if (points.length < 2) return null;
  const printedMean = points.reduce((sum, point) => sum + point.printedPage, 0) / points.length;
  const documentMean = points.reduce((sum, point) => sum + point.documentPage, 0) / points.length;
  const denominator = points.reduce(
    (sum, point) => sum + ((point.printedPage - printedMean) ** 2),
    0,
  );
  if (!denominator) return null;
  const slope = points.reduce(
    (sum, point) =>
      sum + ((point.printedPage - printedMean) * (point.documentPage - documentMean)),
    0,
  ) / denominator;
  if (!Number.isFinite(slope)
    || !((slope >= 0.38 && slope <= 0.62) || (slope >= 0.85 && slope <= 1.15))) return null;
  return { slope, intercept: documentMean - (slope * printedMean) };
}

function robustPageCalibration(locations: PrintedPageLocation[]): PageCalibration | null {
  const uniquePoints = [...new Map(
    locations.map((location) => [`${location.printedPage}:${location.documentPage}`, location]),
  ).values()];
  const documentPagesByPrintedPage = new Map<number, Set<number>>();
  for (const location of uniquePoints) {
    const documentPages = documentPagesByPrintedPage.get(location.printedPage) ?? new Set<number>();
    documentPages.add(location.documentPage);
    documentPagesByPrintedPage.set(location.printedPage, documentPages);
  }
  const points = uniquePoints.filter(
    (location) => documentPagesByPrintedPage.get(location.printedPage)?.size === 1,
  );
  if (points.length < 3) return null;

  let best: { slope: number; intercept: number; inliers: PrintedPageLocation[]; residual: number } | null = null;
  for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
      const left = points[leftIndex]!;
      const right = points[rightIndex]!;
      const printedDelta = right.printedPage - left.printedPage;
      if (Math.abs(printedDelta) < 2) continue;
      const slope = (right.documentPage - left.documentPage) / printedDelta;
      if (!((slope >= 0.38 && slope <= 0.62) || (slope >= 0.85 && slope <= 1.15))) continue;
      const intercept = left.documentPage - (slope * left.printedPage);
      const inliers = points.filter(
        (point) => Math.abs(point.documentPage - ((slope * point.printedPage) + intercept)) <= 1.25,
      );
      const residual = inliers.reduce(
        (sum, point) => sum + Math.abs(point.documentPage - ((slope * point.printedPage) + intercept)),
        0,
      );
      if (!best
        || inliers.length > best.inliers.length
        || (inliers.length === best.inliers.length && residual < best.residual)) {
        best = { slope, intercept, inliers, residual };
      }
    }
  }
  if (!best
    || best.inliers.length < 3
    || best.inliers.length / points.length < 0.6
    || new Set(best.inliers.map((point) => point.documentPage)).size < 3
    || Math.max(...best.inliers.map((point) => point.printedPage))
       - Math.min(...best.inliers.map((point) => point.printedPage)) < 4) return null;
  const fitted = leastSquaresCalibration(best.inliers);
  if (!fitted) return null;
  const inliers = points.filter(
    (point) =>
      Math.abs(point.documentPage - ((fitted.slope * point.printedPage) + fitted.intercept)) <= 1.25,
  );
  return inliers.length >= 3
    && inliers.length / points.length >= 0.6
    && new Set(inliers.map((point) => point.documentPage)).size >= 3
    ? { ...fitted, inliers }
    : null;
}

function alignUsingPrintedPages(
  entries: TocEntry[],
  chunks: TocAlignmentChunk[],
  parents: Map<number, number | null>,
  printedPageLocations: PrintedPageLocation[],
): TocAlignment | null {
  const calibration = robustPageCalibration(printedPageLocations);
  const documentPages = chunks.flatMap((chunk) => chunk.pageStart === null ? [] : [chunk.pageStart]);
  if (!calibration || !documentPages.length) return null;
  const minimumPage = Math.min(...documentPages);
  const maximumPage = Math.max(...documentPages);
  const inlierLocations = new Map<number, number[]>();
  for (const location of calibration.inliers) {
    const existing = inlierLocations.get(location.printedPage) ?? [];
    existing.push(location.documentPage);
    inlierLocations.set(location.printedPage, existing);
  }
  const minimumPrintedPage = Math.min(...calibration.inliers.map((location) => location.printedPage));
  const maximumPrintedPage = Math.max(...calibration.inliers.map((location) => location.printedPage));
  const spreadLayout = calibration.slope < 0.75;
  const spreadParityCounts = [0, 0];
  if (spreadLayout) {
    const printedPagesByDocument = new Map<number, number[]>();
    for (const location of calibration.inliers) {
      const existing = printedPagesByDocument.get(location.documentPage) ?? [];
      existing.push(location.printedPage);
      printedPagesByDocument.set(location.documentPage, existing);
    }
    for (const printedPages of printedPagesByDocument.values()) {
      const ordered = [...new Set(printedPages)].sort((left, right) => left - right);
      for (let index = 0; index < ordered.length - 1; index += 1) {
        if (ordered[index + 1] === ordered[index]! + 1) {
          spreadParityCounts[ordered[index]! % 2] += 1;
        }
      }
    }
  }
  const spreadStartParity = spreadParityCounts[1] > spreadParityCounts[0] ? 1 : 0;
  const spreadStart = (printedPage: number) =>
    printedPage - (((printedPage - spreadStartParity) % 2) + 2) % 2;

  const starts = new Map<number, { page: number; confidence: number }>();
  for (const entry of entries) {
    if (entry.printedPage === null) continue;
    const exactPages = [...new Set(inlierLocations.get(entry.printedPage) ?? [])];
    const extrapolationDistance = entry.printedPage < minimumPrintedPage
      ? minimumPrintedPage - entry.printedPage
      : entry.printedPage > maximumPrintedPage
        ? entry.printedPage - maximumPrintedPage
        : 0;
    if (extrapolationDistance > 4) continue;
    const projected = (calibration.slope * entry.printedPage) + calibration.intercept;
    const projectedPage = exactPages.length === 1
      ? exactPages[0]!
      : spreadLayout
        ? (() => {
          const targetSpreadStart = spreadStart(entry.printedPage!);
          const anchor = [...calibration.inliers].sort((left, right) =>
            Math.abs(spreadStart(left.printedPage) - targetSpreadStart)
              - Math.abs(spreadStart(right.printedPage) - targetSpreadStart))[0];
          return anchor
            ? anchor.documentPage
              + ((targetSpreadStart - spreadStart(anchor.printedPage)) / 2)
            : Math.round(projected);
        })()
        : Math.round(projected);
    if (projectedPage < minimumPage || projectedPage > maximumPage) continue;
    starts.set(entry.ordinal, {
      page: projectedPage,
      confidence: exactPages.length === 1 ? 0.98 : extrapolationDistance ? 0.7 : 0.82,
    });
  }
  if (!starts.size) return null;

  const mappings = new Map<string, TocChunkMapping>();
  const putMapping = (mapping: TocChunkMapping) => {
    const key = `${mapping.chunkOrdinal}:${mapping.tocOrdinal}`;
    const existing = mappings.get(key);
    if (!existing
      || (existing.relation === 'ANCESTOR' && mapping.relation === 'DIRECT')
      || (existing.relation === mapping.relation && mapping.confidence > existing.confidence)) {
      mappings.set(key, mapping);
    }
  };

  for (const entry of entries) {
    const start = starts.get(entry.ordinal);
    if (!start) continue;
    const nextPrintedStart = entries
      .filter((candidate) =>
        candidate.printedPage !== null
        && entry.printedPage !== null
        && candidate.printedPage > entry.printedPage
        && starts.has(candidate.ordinal))
      .sort((left, right) => left.printedPage! - right.printedPage!)[0];
    const nextPage = nextPrintedStart ? starts.get(nextPrintedStart.ordinal)!.page : null;
    const endPage = nextPage === null ? maximumPage + 1 : Math.max(start.page + 1, nextPage);
    for (const chunk of chunks) {
      if (chunk.pageStart === null || chunk.pageStart < start.page || chunk.pageStart >= endPage) continue;
      putMapping({
        chunkOrdinal: chunk.ordinal,
        tocOrdinal: entry.ordinal,
        relation: 'DIRECT',
        confidence: start.confidence,
      });
      let parentOrdinal = parents.get(entry.ordinal) ?? null;
      while (parentOrdinal !== null) {
        putMapping({
          chunkOrdinal: chunk.ordinal,
          tocOrdinal: parentOrdinal,
          relation: 'ANCESTOR',
          confidence: start.confidence,
        });
        parentOrdinal = parents.get(parentOrdinal) ?? null;
      }
    }
  }

  const orderedMappings = [...mappings.values()].sort(
    (left, right) =>
      left.chunkOrdinal - right.chunkOrdinal
      || (left.relation === right.relation ? 0 : left.relation === 'DIRECT' ? -1 : 1)
      || left.tocOrdinal - right.tocOrdinal,
  );
  const alignedEntries = entries.map<AlignedTocEntry>((entry) => {
    const entryMappings = orderedMappings.filter((mapping) => mapping.tocOrdinal === entry.ordinal);
    return {
      ...entry,
      parentOrdinal: parents.get(entry.ordinal) ?? null,
      mappingStatus: entryMappings.length ? 'MAPPED' : 'UNMAPPED',
      mappingConfidence: entryMappings.length
        ? Math.max(...entryMappings.map((mapping) => mapping.confidence))
        : null,
    };
  });
  return { entries: alignedEntries, mappings: orderedMappings };
}

function alignmentFromDirectMappings(
  entries: TocEntry[],
  parents: Map<number, number | null>,
  directMappings: TocChunkMapping[],
): TocAlignment {
  const mappings = new Map<string, TocChunkMapping>();
  const putMapping = (mapping: TocChunkMapping) => {
    const key = `${mapping.chunkOrdinal}:${mapping.tocOrdinal}`;
    const existing = mappings.get(key);
    if (!existing
      || (existing.relation === 'ANCESTOR' && mapping.relation === 'DIRECT')
      || (existing.relation === mapping.relation && mapping.confidence > existing.confidence)) {
      mappings.set(key, mapping);
    }
  };
  for (const direct of directMappings) {
    putMapping({ ...direct, relation: 'DIRECT' });
    let parentOrdinal = parents.get(direct.tocOrdinal) ?? null;
    while (parentOrdinal !== null) {
      putMapping({
        chunkOrdinal: direct.chunkOrdinal,
        tocOrdinal: parentOrdinal,
        relation: 'ANCESTOR',
        confidence: direct.confidence,
      });
      parentOrdinal = parents.get(parentOrdinal) ?? null;
    }
  }
  const orderedMappings = [...mappings.values()].sort(
    (left, right) =>
      left.chunkOrdinal - right.chunkOrdinal
      || (left.relation === right.relation ? 0 : left.relation === 'DIRECT' ? -1 : 1)
      || left.tocOrdinal - right.tocOrdinal,
  );
  return {
    entries: entries.map<AlignedTocEntry>((entry) => {
      const entryMappings = orderedMappings.filter((mapping) => mapping.tocOrdinal === entry.ordinal);
      return {
        ...entry,
        parentOrdinal: parents.get(entry.ordinal) ?? null,
        mappingStatus: entryMappings.length ? 'MAPPED' : 'UNMAPPED',
        mappingConfidence: entryMappings.length
          ? Math.max(...entryMappings.map((mapping) => mapping.confidence))
          : null,
      };
    }),
    mappings: orderedMappings,
  };
}

function mergePageAndHeadingAlignments(
  entries: TocEntry[],
  chunks: TocAlignmentChunk[],
  parents: Map<number, number | null>,
  pageAlignment: TocAlignment,
  headingAlignment: TocAlignment,
): TocAlignment {
  const chunkPages = new Map(chunks.map((chunk) => [chunk.ordinal, chunk.pageStart]));
  const pageDirect = pageAlignment.mappings.filter((mapping) => mapping.relation === 'DIRECT');
  const headingDirect = headingAlignment.mappings.filter(
    (mapping) => mapping.relation === 'DIRECT' && mapping.confidence >= 0.9,
  );
  const firstPageByEntry = (mappings: TocChunkMapping[]) => {
    const firstPages = new Map<number, number>();
    for (const mapping of mappings) {
      const page = chunkPages.get(mapping.chunkOrdinal);
      if (page === null || page === undefined) continue;
      const current = firstPages.get(mapping.tocOrdinal);
      if (current === undefined || page < current) firstPages.set(mapping.tocOrdinal, page);
    }
    return firstPages;
  };
  const pageStarts = firstPageByEntry(pageDirect);
  const headingStarts = firstPageByEntry(headingDirect);
  const preferredHeadingEntries = new Set(entries.flatMap((entry) => {
    const headingStart = headingStarts.get(entry.ordinal);
    if (headingStart === undefined) return [];
    const pageStart = pageStarts.get(entry.ordinal);
    return pageStart === undefined
      || entry.printedPage === null
      || headingStart === pageStart
      ? [entry.ordinal]
      : [];
  }));
  const entryByOrdinal = new Map(entries.map((entry) => [entry.ordinal, entry]));
  const preferredHeadings = headingDirect.filter(
    (mapping) => preferredHeadingEntries.has(mapping.tocOrdinal),
  );
  const preferredHeadingKeys = new Set(
    preferredHeadings.map((mapping) => `${mapping.chunkOrdinal}:${mapping.tocOrdinal}`),
  );
  const pageEntriesByChunk = new Map<number, Set<number>>();
  const unpagedHeadingEntriesByChunk = new Map<number, Set<number>>();
  for (const mapping of pageDirect) {
    const pageEntries = pageEntriesByChunk.get(mapping.chunkOrdinal) ?? new Set<number>();
    pageEntries.add(mapping.tocOrdinal);
    pageEntriesByChunk.set(mapping.chunkOrdinal, pageEntries);
  }
  for (const mapping of preferredHeadings) {
    const entry = entryByOrdinal.get(mapping.tocOrdinal);
    if (!entry || entry.printedPage !== null) continue;
    const unpagedEntries = unpagedHeadingEntriesByChunk.get(mapping.chunkOrdinal) ?? new Set<number>();
    unpagedEntries.add(mapping.tocOrdinal);
    unpagedHeadingEntriesByChunk.set(mapping.chunkOrdinal, unpagedEntries);
  }
  const directMappings = [
    ...pageDirect.filter(
      (mapping) => !(unpagedHeadingEntriesByChunk.get(mapping.chunkOrdinal)?.size)
        && !preferredHeadingKeys.has(`${mapping.chunkOrdinal}:${mapping.tocOrdinal}`),
    ),
    ...preferredHeadings.filter(
      (mapping) => {
        const unpagedEntries = unpagedHeadingEntriesByChunk.get(mapping.chunkOrdinal);
        if (unpagedEntries?.size) return unpagedEntries.has(mapping.tocOrdinal);
        const pageEntries = pageEntriesByChunk.get(mapping.chunkOrdinal);
        return !pageEntries?.size || pageEntries.has(mapping.tocOrdinal);
      },
    ),
  ];
  return alignmentFromDirectMappings(entries, parents, directMappings);
}

export function alignTocEntriesToChunks(
  tocEntries: TocEntry[],
  sourceChunks: TocAlignmentChunk[],
  printedPageLocations: PrintedPageLocation[] = [],
): TocAlignment {
  const entries = [...tocEntries].sort((left, right) => left.ordinal - right.ordinal);
  const chunks = [...sourceChunks].sort((left, right) => left.ordinal - right.ordinal);
  const parents = parentOrdinals(entries);
  const pageAlignment = alignUsingPrintedPages(entries, chunks, parents, printedPageLocations);
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

  const headingAlignment = { entries: alignedEntries, mappings };
  return pageAlignment
    ? mergePageAndHeadingAlignments(entries, chunks, parents, pageAlignment, headingAlignment)
    : headingAlignment;
}
