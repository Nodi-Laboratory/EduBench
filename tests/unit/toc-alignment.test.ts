import { describe, expect, test } from 'vitest';
import {
  alignTocEntriesToChunks,
  carryForwardTocChunkHeadings,
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
