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

