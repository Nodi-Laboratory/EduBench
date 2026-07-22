import { expect, test } from 'vitest';
import { extractTableOfContents } from '@/domain/toc';

test('extracts chapter and line-based table of contents entries from the first ten pages', () => {
  const html = `<section data-page="3"><h1>IX. 발전과 신재생 에너지</h1>
    <p data-category="index">01 전기 에너지의 생산 286<br>02 전력 수송 292<br>03 태양 에너지의 생성과 전환 298</p>
  </section><section data-page="11"><p data-category="index">제외할 단원 400</p></section>`;
  expect(extractTableOfContents(html)).toEqual([
    { ordinal: 1, title: 'IX. 발전과 신재생 에너지', level: 1, printedPage: 286 },
    { ordinal: 2, title: '01 전기 에너지의 생산', level: 2, printedPage: 286 },
    { ordinal: 3, title: '02 전력 수송', level: 2, printedPage: 292 },
    { ordinal: 4, title: '03 태양 에너지의 생성과 전환', level: 2, printedPage: 298 },
  ]);
});

test('joins wrapped table-of-contents lines before reading the printed page', () => {
  const html = `<section data-page="1"><p data-category="index">탐구 활동 I 자전거를 이용하여 어떻게 발전기를 만들 수<br>있을까? 288</p></section>`;
  expect(extractTableOfContents(html)[0]).toMatchObject({
    title: '탐구 활동 I 자전거를 이용하여 어떻게 발전기를 만들 수 있을까?', printedPage: 288,
  });
});
