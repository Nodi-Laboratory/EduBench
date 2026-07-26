import { expect, test } from 'vitest';
import { chunkTextbook } from '@/domain/chunking';

const fixtureHtml = `
  <section data-page="35" data-chapter="2. 물질" data-unit="물질의 구성">
    <h2>물질의 구성</h2>
    <p>${'원자는 물질을 이루는 기본 입자이다. '.repeat(20)}</p>
    <div data-kind="example"><h3>탐구 예제</h3><p>${'모형을 사용하여 원자의 배열을 설명한다. '.repeat(8)}</p></div>
  </section>
`;

test('keeps page, unit, and semantic block metadata while splitting a long section', () => {
  const chunks = chunkTextbook(fixtureHtml, { maxTokens: 45 });

  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.every((chunk) => chunk.pageStart === 35 && chunk.unit === '물질의 구성')).toBe(true);
  expect(chunks.map((chunk) => chunk.kind)).toContain('example');
  expect(chunks.every((chunk) => chunk.content.length > 0)).toBe(true);
});

test('returns no chunks for markup without meaningful text', () => {
  expect(chunkTextbook('<section data-page="1"><div></div></section>', { maxTokens: 50 })).toEqual([]);
});

test('carries chapter and unit through continuation pages and resets unit when chapter changes', () => {
  const chunks = chunkTextbook(`
    <section data-page="1" data-chapter="1. 운동" data-unit="속도">
      <p>속도의 뜻을 설명한다.</p>
    </section>
    <section data-page="2">
      <p>앞 페이지의 속도 설명이 이어진다.</p>
    </section>
    <section data-page="3">
      <h2>가속도</h2>
      <p>새 단원인 가속도를 설명한다.</p>
    </section>
    <section data-page="4" data-chapter="2. 에너지">
      <p>새 장의 도입 내용이다.</p>
    </section>
  `, { maxTokens: 50 });

  expect(chunks.map((chunk) => ({
    page: chunk.pageStart,
    chapter: chunk.chapter,
    unit: chunk.unit,
  }))).toEqual([
    { page: 1, chapter: '1. 운동', unit: '속도' },
    { page: 2, chapter: '1. 운동', unit: '속도' },
    { page: 3, chapter: '1. 운동', unit: '가속도' },
    { page: 4, chapter: '2. 에너지', unit: null },
  ]);
});

