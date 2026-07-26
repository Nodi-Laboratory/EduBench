// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { JsonBlock } from '@/components/ui/json-block';

afterEach(cleanup);

test('renders structured values as inspectable JSON instead of an object placeholder', () => {
  render(<JsonBlock value={{ request: { model: 'gemini', chunks: [1, 2] } }} />);

  const block = screen.getByTestId('json-block');
  expect(block).toHaveTextContent('"model": "gemini"');
  expect(block).toHaveTextContent('"chunks"');
  expect(block).not.toHaveTextContent('[object Object]');
});

test('preserves raw text and labels absent values explicitly', () => {
  const { rerender } = render(<JsonBlock value={'원본 응답'} />);
  expect(screen.getByTestId('json-block')).toHaveTextContent('원본 응답');

  rerender(<JsonBlock value={undefined} />);
  expect(screen.getByTestId('json-block')).toHaveTextContent('기록 없음');
});
