import { describe, expect, test } from 'vitest';
import {
  alignTocEntriesToChunks,
  carryForwardTocChunkHeadings,
  extractPrintedPageLocations,
  normalizeTocHeading,
} from '@/domain/toc-alignment';

describe('TOC-to-chunk alignment', () => {
  test('normalizes Korean and Latin heading decoration without erasing the title', () => {
    expect(normalizeTocHeading('Ⅱ.  힘과 운동 (Force & Motion)')).toBe('힘과운동forcemotion');
    expect(normalizeTocHeading('2-1. 속도와 가속도')).toBe('속도와가속도');
    expect(normalizeTocHeading('Velocity and acceleration')).toBe('velocityandacceleration');
  });

  test('prefers parsed headings and maps every chunk to one leaf plus its ancestors', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: 'Ⅱ. 역학', level: 1, printedPage: 10 },
        { ordinal: 2, title: '2-1. 속도와 가속도', level: 2, printedPage: 12 },
        { ordinal: 3, title: '2-2. 힘과 운동', level: 2, printedPage: 20 },
      ],
      [
        { ordinal: 1, pageStart: 12, pageEnd: 12, chapter: '역학', unit: '속도와 가속도' },
        { ordinal: 2, pageStart: 13, pageEnd: 13, chapter: '역학', unit: '속도와 가속도' },
        { ordinal: 3, pageStart: 20, pageEnd: 20, chapter: '역학', unit: '힘과 운동' },
      ],
    );

    expect(aligned.entries).toEqual([
      expect.objectContaining({ ordinal: 1, parentOrdinal: null, mappingStatus: 'MAPPED', mappingConfidence: 1 }),
      expect.objectContaining({ ordinal: 2, parentOrdinal: 1, mappingStatus: 'MAPPED', mappingConfidence: 1 }),
      expect.objectContaining({ ordinal: 3, parentOrdinal: 1, mappingStatus: 'MAPPED', mappingConfidence: 1 }),
    ]);
    expect(aligned.mappings).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 2, relation: 'DIRECT', confidence: 1 },
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'ANCESTOR', confidence: 1 },
      { chunkOrdinal: 2, tocOrdinal: 2, relation: 'DIRECT', confidence: 1 },
      { chunkOrdinal: 2, tocOrdinal: 1, relation: 'ANCESTOR', confidence: 1 },
      { chunkOrdinal: 3, tocOrdinal: 3, relation: 'DIRECT', confidence: 1 },
      { chunkOrdinal: 3, tocOrdinal: 1, relation: 'ANCESTOR', confidence: 1 },
    ]);
  });

  test('does not trust monotonic printed pages until a heading anchor calibrates the document offset', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '첫째 단원', level: 1, printedPage: 5 },
        { ordinal: 2, title: '둘째 단원', level: 1, printedPage: 9 },
      ],
      [
        { ordinal: 1, pageStart: 5, pageEnd: 5, chapter: null, unit: null },
        { ordinal: 2, pageStart: 7, pageEnd: 7, chapter: null, unit: null },
        { ordinal: 3, pageStart: 9, pageEnd: 9, chapter: null, unit: null },
      ],
    );

    expect(aligned.mappings).toEqual([]);
    expect(aligned.entries.every((entry) => entry.mappingStatus === 'UNMAPPED')).toBe(true);
  });

  test('uses a heading/page calibration to map remaining monotonic printed pages at lower confidence', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '속도', level: 1, printedPage: 5 },
        { ordinal: 2, title: '힘 단원', level: 1, printedPage: 9 },
      ],
      [
        { ordinal: 1, pageStart: 15, pageEnd: 15, chapter: null, unit: '속도' },
        { ordinal: 2, pageStart: 19, pageEnd: 19, chapter: null, unit: null },
      ],
    );

    expect(aligned.entries).toEqual([
      expect.objectContaining({ ordinal: 1, mappingStatus: 'MAPPED', mappingConfidence: 1 }),
      expect.objectContaining({ ordinal: 2, mappingStatus: 'MAPPED', mappingConfidence: 0.7 }),
    ]);
    expect(aligned.mappings).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT', confidence: 1 },
      { chunkOrdinal: 2, tocOrdinal: 2, relation: 'DIRECT', confidence: 0.7 },
    ]);
  });

  test('stops a heading-anchored leaf before sibling chunks whose parsed unit is null', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '속도', level: 1, printedPage: null },
        { ordinal: 2, title: '힘', level: 1, printedPage: null },
      ],
      [
        { ordinal: 1, pageStart: 10, pageEnd: 10, chapter: null, unit: '속도' },
        { ordinal: 2, pageStart: 11, pageEnd: 11, chapter: null, unit: null },
        { ordinal: 3, pageStart: 12, pageEnd: 12, chapter: null, unit: null },
      ],
    );

    expect(aligned.mappings).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT', confidence: 1 },
    ]);
    expect(aligned.entries).toEqual([
      expect.objectContaining({ ordinal: 1, mappingStatus: 'MAPPED' }),
      expect.objectContaining({ ordinal: 2, mappingStatus: 'UNMAPPED' }),
    ]);
  });

  test('does not invent page ranges from non-monotonic printed-page anchors', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '첫째 단원', level: 1, printedPage: 20 },
        { ordinal: 2, title: '둘째 단원', level: 1, printedPage: 8 },
      ],
      [
        { ordinal: 1, pageStart: 8, pageEnd: 8, chapter: null, unit: null },
        { ordinal: 2, pageStart: 20, pageEnd: 20, chapter: null, unit: null },
      ],
    );

    expect(aligned.mappings).toEqual([]);
    expect(aligned.entries.every((entry) => entry.mappingStatus === 'UNMAPPED')).toBe(true);
  });

  test('uses document footers to align a two-page spread even when TOC rows are non-monotonic', () => {
    const printedPages = extractPrintedPageLocations([
      {
        documentPage: 7,
        rawResponse: {
          elements: [
            {
              category: 'footer',
              coordinates: [{ x: 0.04 }, { x: 0.12 }],
              content: { html: '<footer>12 I. 물질의 규칙성과 결합</footer>' },
            },
            {
              category: 'footer',
              coordinates: [{ x: 0.87 }, { x: 0.96 }],
              content: { html: '<footer>과학 역량 기르는 생각 열기 13</footer>' },
            },
          ],
        },
      },
      {
        documentPage: 8,
        rawResponse: {
          elements: [{
            category: 'footer',
            coordinates: [{ x: 0.04 }, { x: 0.12 }],
            content: { html: '<footer>14 I. 물질의 규칙성과 결합</footer>' },
          }],
        },
      },
      {
        documentPage: 14,
        rawResponse: {
          elements: [{
            category: 'footer',
            coordinates: [{ x: 0.04 }, { x: 0.12 }],
            content: { html: '<footer>26 I. 물질의 규칙성과 결합</footer>' },
          }],
        },
      },
      {
        documentPage: 58,
        rawResponse: {
          elements: [{
            category: 'footer',
            coordinates: [{ x: 0.04 }, { x: 0.12 }],
            content: { html: '<footer>114 IV. 지구 시스템</footer>' },
          }],
        },
      },
    ]);
    expect(printedPages).toEqual([
      { printedPage: 12, documentPage: 7 },
      { printedPage: 13, documentPage: 7 },
      { printedPage: 14, documentPage: 8 },
      { printedPage: 26, documentPage: 14 },
      { printedPage: 114, documentPage: 58 },
    ]);

    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '우주 초기에 만들어진 원소', level: 1, printedPage: 14 },
        { ordinal: 2, title: '지구 시스템의 구성', level: 1, printedPage: 114 },
        { ordinal: 3, title: '원소의 주기성', level: 1, printedPage: 26 },
      ],
      [
        { ordinal: 1, pageStart: 8, pageEnd: 8, chapter: null, unit: null },
        { ordinal: 2, pageStart: 9, pageEnd: 9, chapter: null, unit: null },
        { ordinal: 3, pageStart: 14, pageEnd: 14, chapter: null, unit: null },
        { ordinal: 4, pageStart: 15, pageEnd: 15, chapter: null, unit: null },
        { ordinal: 5, pageStart: 58, pageEnd: 58, chapter: null, unit: null },
      ],
      printedPages,
    );

    expect(aligned.entries).toEqual([
      expect.objectContaining({ ordinal: 1, mappingStatus: 'MAPPED' }),
      expect.objectContaining({ ordinal: 2, mappingStatus: 'MAPPED' }),
      expect.objectContaining({ ordinal: 3, mappingStatus: 'MAPPED' }),
    ]);
    expect(aligned.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT' }),
      expect.objectContaining({ chunkOrdinal: 3, tocOrdinal: 3, relation: 'DIRECT' }),
      expect.objectContaining({ chunkOrdinal: 5, tocOrdinal: 2, relation: 'DIRECT' }),
    ]));
  });

  test('keeps a direct page mapping when a higher-confidence child also maps the same spread', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '상위 단원', level: 1, printedPage: 15 },
        { ordinal: 2, title: '하위 단원', level: 2, printedPage: 14 },
      ],
      [{ ordinal: 1, pageStart: 8, pageEnd: 8, chapter: null, unit: null }],
      [
        { printedPage: 12, documentPage: 7 },
        { printedPage: 14, documentPage: 8 },
        { printedPage: 26, documentPage: 14 },
      ],
    );

    expect(aligned.mappings).toEqual(expect.arrayContaining([
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT', confidence: 0.82 },
      { chunkOrdinal: 1, tocOrdinal: 2, relation: 'DIRECT', confidence: 0.98 },
    ]));
  });

  test('keeps adjacent printed-page starts on one spread from sharing later PDF pages', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '왼쪽 쪽 단원', level: 1, printedPage: 12 },
        { ordinal: 2, title: '오른쪽 쪽 단원', level: 1, printedPage: 13 },
      ],
      [
        { ordinal: 1, pageStart: 7, pageEnd: 7, chapter: null, unit: null },
        { ordinal: 2, pageStart: 8, pageEnd: 8, chapter: null, unit: null },
        { ordinal: 3, pageStart: 13, pageEnd: 13, chapter: null, unit: null },
      ],
      [
        { printedPage: 12, documentPage: 7 },
        { printedPage: 13, documentPage: 7 },
        { printedPage: 14, documentPage: 8 },
        { printedPage: 26, documentPage: 14 },
      ],
    );

    expect(aligned.mappings.filter((mapping) => mapping.tocOrdinal === 1)).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT', confidence: 0.98 },
    ]);
    expect(aligned.mappings.filter((mapping) => mapping.tocOrdinal === 2)).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 2, relation: 'DIRECT', confidence: 0.98 },
      { chunkOrdinal: 2, tocOrdinal: 2, relation: 'DIRECT', confidence: 0.98 },
      { chunkOrdinal: 3, tocOrdinal: 2, relation: 'DIRECT', confidence: 0.98 },
    ]);
  });

  test('prefers a matching parsed heading for an entry without a printed page', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '앞 단원', level: 1, printedPage: 12 },
        { ordinal: 2, title: '후속 단원', level: 1, printedPage: null },
      ],
      [
        { ordinal: 1, pageStart: 7, pageEnd: 7, chapter: null, unit: null },
        { ordinal: 2, pageStart: 8, pageEnd: 8, chapter: null, unit: '후속 단원' },
        { ordinal: 3, pageStart: 9, pageEnd: 9, chapter: null, unit: '후속 단원' },
      ],
      [
        { printedPage: 12, documentPage: 7 },
        { printedPage: 14, documentPage: 8 },
        { printedPage: 26, documentPage: 14 },
      ],
    );

    expect(aligned.mappings).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT', confidence: 0.98 },
      { chunkOrdinal: 2, tocOrdinal: 2, relation: 'DIRECT', confidence: 1 },
      { chunkOrdinal: 3, tocOrdinal: 2, relation: 'DIRECT', confidence: 1 },
    ]);
  });

  test('keeps a later page-only entry when an earlier exact heading is carried forward', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '제목으로 찾은 단원', level: 1, printedPage: 12 },
        { ordinal: 2, title: '페이지만 있는 단원', level: 1, printedPage: 20 },
      ],
      [
        { ordinal: 1, pageStart: 7, pageEnd: 7, chapter: '제목으로 찾은 단원', unit: null },
        { ordinal: 2, pageStart: 8, pageEnd: 8, chapter: '제목으로 찾은 단원', unit: null },
        { ordinal: 3, pageStart: 11, pageEnd: 11, chapter: '제목으로 찾은 단원', unit: null },
        { ordinal: 4, pageStart: 12, pageEnd: 12, chapter: '제목으로 찾은 단원', unit: null },
      ],
      [
        { printedPage: 12, documentPage: 7 },
        { printedPage: 14, documentPage: 8 },
        { printedPage: 20, documentPage: 11 },
        { printedPage: 22, documentPage: 12 },
      ],
    );

    expect(aligned.mappings.filter((mapping) => mapping.tocOrdinal === 2)).toEqual([
      { chunkOrdinal: 3, tocOrdinal: 2, relation: 'DIRECT', confidence: 0.98 },
      { chunkOrdinal: 4, tocOrdinal: 2, relation: 'DIRECT', confidence: 0.98 },
    ]);
    expect(aligned.entries[1]).toMatchObject({ mappingStatus: 'MAPPED' });
  });

  test('keeps page boundaries authoritative when multi-column TOC OCR order is non-monotonic', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '페이지만 있는 뒤 단원', level: 1, printedPage: 20 },
        { ordinal: 2, title: '제목으로 찾은 앞 단원', level: 1, printedPage: 12 },
      ],
      [
        { ordinal: 1, pageStart: 7, pageEnd: 7, chapter: '제목으로 찾은 앞 단원', unit: null },
        { ordinal: 2, pageStart: 8, pageEnd: 8, chapter: '제목으로 찾은 앞 단원', unit: null },
        { ordinal: 3, pageStart: 11, pageEnd: 11, chapter: '제목으로 찾은 앞 단원', unit: null },
        { ordinal: 4, pageStart: 12, pageEnd: 12, chapter: '제목으로 찾은 앞 단원', unit: null },
      ],
      [
        { printedPage: 12, documentPage: 7 },
        { printedPage: 14, documentPage: 8 },
        { printedPage: 20, documentPage: 11 },
        { printedPage: 22, documentPage: 12 },
      ],
    );

    expect(aligned.mappings.filter((mapping) => mapping.tocOrdinal === 1)).toEqual([
      { chunkOrdinal: 3, tocOrdinal: 1, relation: 'DIRECT', confidence: 0.98 },
      { chunkOrdinal: 4, tocOrdinal: 1, relation: 'DIRECT', confidence: 0.98 },
    ]);
    expect(aligned.mappings).not.toContainEqual(
      expect.objectContaining({ chunkOrdinal: 3, tocOrdinal: 2, relation: 'DIRECT' }),
    );
  });

  test('projects a missing odd printed footer onto the preceding two-page spread', () => {
    const aligned = alignTocEntriesToChunks(
      [{ ordinal: 1, title: '오른쪽 쪽', level: 1, printedPage: 13 }],
      [
        { ordinal: 1, pageStart: 7, pageEnd: 7, chapter: null, unit: null },
        { ordinal: 2, pageStart: 8, pageEnd: 8, chapter: null, unit: null },
      ],
      [
        { printedPage: 12, documentPage: 7 },
        { printedPage: 14, documentPage: 8 },
        { printedPage: 26, documentPage: 14 },
      ],
    );

    expect(aligned.mappings).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT', confidence: 0.82 },
      { chunkOrdinal: 2, tocOrdinal: 1, relation: 'DIRECT', confidence: 0.82 },
    ]);
  });

  test('projects a missing even page correctly when only right-side odd footers were recognized', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '누락된 왼쪽 쪽', level: 1, printedPage: 14 },
        { ordinal: 2, title: '다음 단원', level: 1, printedPage: 27 },
      ],
      [
        { ordinal: 1, pageStart: 7, pageEnd: 7, chapter: null, unit: null },
        { ordinal: 2, pageStart: 8, pageEnd: 8, chapter: null, unit: null },
        { ordinal: 3, pageStart: 14, pageEnd: 14, chapter: null, unit: null },
      ],
      [
        { printedPage: 13, documentPage: 7 },
        { printedPage: 15, documentPage: 8 },
        { printedPage: 27, documentPage: 14 },
      ],
    );

    expect(aligned.mappings.filter((mapping) => mapping.tocOrdinal === 1)).toEqual([
      { chunkOrdinal: 2, tocOrdinal: 1, relation: 'DIRECT', confidence: 0.82 },
    ]);
  });

  test('ignores a repeated noisy footer number when calibrating page locations', () => {
    const aligned = alignTocEntriesToChunks(
      [{ ordinal: 1, title: '검증 단원', level: 1, printedPage: 14 }],
      [{ ordinal: 1, pageStart: 8, pageEnd: 8, chapter: null, unit: null }],
      [
        { printedPage: 1, documentPage: 7 },
        { printedPage: 1, documentPage: 8 },
        { printedPage: 1, documentPage: 9 },
        { printedPage: 13, documentPage: 7 },
        { printedPage: 15, documentPage: 8 },
        { printedPage: 17, documentPage: 9 },
      ],
    );

    expect(aligned.mappings).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT', confidence: 0.82 },
    ]);
  });

  test('rejects contradictory footer numbers from the same PDF-page side', () => {
    const locations = extractPrintedPageLocations([
      {
        documentPage: 1,
        rawResponse: {
          elements: [
            {
              category: 'footer',
              coordinates: [{ x: 0.04 }, { x: 0.12 }],
              content: { html: '<footer>10 첫 번째 후보</footer>' },
            },
            {
              category: 'footer',
              coordinates: [{ x: 0.05 }, { x: 0.13 }],
              content: { html: '<footer>12 충돌 후보</footer>' },
            },
          ],
        },
      },
      {
        documentPage: 2,
        rawResponse: {
          elements: [{
            category: 'footer',
            coordinates: [{ x: 0.04 }, { x: 0.12 }],
            content: { html: '<footer>14 교과서</footer>' },
          }],
        },
      },
    ]);

    expect(locations).toEqual([{ printedPage: 14, documentPage: 2 }]);
  });

  test('does not calibrate from a minority of coincidentally linear footer numbers', () => {
    const aligned = alignTocEntriesToChunks(
      [{ ordinal: 1, title: '검증 단원', level: 1, printedPage: 20 }],
      [{ ordinal: 1, pageStart: 10, pageEnd: 10, chapter: null, unit: null }],
      [
        { printedPage: 10, documentPage: 5 },
        { printedPage: 20, documentPage: 10 },
        { printedPage: 30, documentPage: 15 },
        { printedPage: 100, documentPage: 2 },
        { printedPage: 200, documentPage: 3 },
        { printedPage: 300, documentPage: 4 },
        { printedPage: 400, documentPage: 5 },
      ],
    );

    expect(aligned.mappings).toEqual([]);
    expect(aligned.entries[0]).toMatchObject({ mappingStatus: 'UNMAPPED' });
  });

  test('uses distinct heading starts for repeated normalized titles across chapters', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '1. 개념 정리', level: 1, printedPage: null },
        { ordinal: 2, title: '2. 개념정리', level: 1, printedPage: null },
      ],
      [
        { ordinal: 1, pageStart: 1, pageEnd: 1, chapter: '첫째 장', unit: '개념 정리' },
        { ordinal: 2, pageStart: 2, pageEnd: 2, chapter: '첫째 장', unit: '개념 정리' },
        { ordinal: 3, pageStart: 3, pageEnd: 3, chapter: '둘째 장', unit: '개념 정리' },
        { ordinal: 4, pageStart: 4, pageEnd: 4, chapter: '둘째 장', unit: '개념 정리' },
      ],
    );

    expect(aligned.mappings).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT', confidence: 1 },
      { chunkOrdinal: 2, tocOrdinal: 1, relation: 'DIRECT', confidence: 1 },
      { chunkOrdinal: 3, tocOrdinal: 2, relation: 'DIRECT', confidence: 1 },
      { chunkOrdinal: 4, tocOrdinal: 2, relation: 'DIRECT', confidence: 1 },
    ]);
  });

  test('leaves a repeated TOC title unmapped when there is no distinct second heading start', () => {
    const aligned = alignTocEntriesToChunks(
      [
        { ordinal: 1, title: '1. 개념 정리', level: 1, printedPage: null },
        { ordinal: 2, title: '2. 개념정리', level: 1, printedPage: null },
      ],
      [
        { ordinal: 1, pageStart: 1, pageEnd: 1, chapter: '첫째 장', unit: '개념 정리' },
        { ordinal: 2, pageStart: 2, pageEnd: 2, chapter: '첫째 장', unit: '개념 정리' },
      ],
    );

    expect(aligned.mappings).toEqual([
      { chunkOrdinal: 1, tocOrdinal: 1, relation: 'DIRECT', confidence: 1 },
      { chunkOrdinal: 2, tocOrdinal: 1, relation: 'DIRECT', confidence: 1 },
    ]);
    expect(aligned.entries[1]).toMatchObject({ ordinal: 2, mappingStatus: 'UNMAPPED' });
  });

  test('repairs legacy persisted continuation headings without carrying a unit across chapter changes', () => {
    const repaired = carryForwardTocChunkHeadings([
      { ordinal: 1, pageStart: 1, pageEnd: 1, chapter: '운동', unit: '속도' },
      { ordinal: 2, pageStart: 2, pageEnd: 2, chapter: null, unit: null },
      { ordinal: 3, pageStart: 3, pageEnd: 3, chapter: null, unit: '힘' },
      { ordinal: 4, pageStart: 4, pageEnd: 4, chapter: '에너지', unit: null },
    ]);

    expect(repaired.map((chunk) => ({ chapter: chunk.chapter, unit: chunk.unit }))).toEqual([
      { chapter: '운동', unit: '속도' },
      { chapter: '운동', unit: '속도' },
      { chapter: '운동', unit: '힘' },
      { chapter: '에너지', unit: null },
    ]);
  });
});
