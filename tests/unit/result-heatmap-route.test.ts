import { beforeEach, expect, test, vi } from 'vitest';

const heatmap = vi.hoisted(() => ({
  getResultQuestionHeatmapPage:vi.fn(),
  defaultResultHeatmapPageSize:25,
  maxResultHeatmapPageSize:100,
}));

vi.mock('@/server/results/analytics', () => heatmap);

import { GET } from '@/app/api/results/[id]/heatmap/route';

beforeEach(() => {
  heatmap.getResultQuestionHeatmapPage.mockReset();
});

test('serves a bounded heatmap page for the selected purpose, modes, and models', async () => {
  heatmap.getResultQuestionHeatmapPage.mockResolvedValue({
    page:2,
    pageSize:100,
    total:245,
    rows:[{
      questionId:'question-101',
      publicId:'Q-101',
      questionText:'선수 개념을 설명하세요.',
      purpose:'선수 관계',
      scores:{ 'M01::VECTOR':0.9 },
    }],
  });

  const response = await GET(
    new Request('http://localhost/api/results/run-1/heatmap?purpose=%EC%84%A0%EC%88%98%20%EA%B4%80%EA%B3%84&modes=VECTOR,PIKE&models=M01,M02&page=2&pageSize=500'),
    { params:Promise.resolve({ id:'run-1' }) },
  );

  expect(heatmap.getResultQuestionHeatmapPage).toHaveBeenCalledWith('run-1', {
    purpose:'선수 관계',
    retrievalModes:['VECTOR', 'PIKE'],
    blindIds:['M01', 'M02'],
    page:2,
    pageSize:100,
  });
  await expect(response.json()).resolves.toMatchObject({
    total:245,
    rows:[{ publicId:'Q-101', scores:{ 'M01::VECTOR':0.9 } }],
  });
});
