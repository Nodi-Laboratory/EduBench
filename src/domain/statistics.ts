function quantile(values: number[], probability: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(probability * sorted.length)));
  return sorted[index] ?? Number.NaN;
}

export function pairedBootstrap(a: number[], b: number[], options: { samples?: number; confidence?: number; random?: () => number } = {}) {
  if (!a.length || a.length !== b.length) throw new Error('paired samples must have the same non-zero length');
  const samples = options.samples ?? 10_000; const confidence = options.confidence ?? 0.95; const random = options.random ?? Math.random;
  const differences = Array.from({ length: samples }, () => {
    let sum = 0;
    for (let index = 0; index < a.length; index += 1) { const draw = Math.floor(random() * a.length); sum += a[draw]! - b[draw]!; }
    return sum / a.length;
  });
  const difference = a.reduce((sum, value, index) => sum + value - b[index]!, 0) / a.length;
  const alpha = (1 - confidence) / 2;
  return { difference, low: quantile(differences, alpha), high: quantile(differences, 1 - alpha), samples };
}

function combination(n: number, k: number): number {
  let value = 1; for (let index = 1; index <= k; index += 1) value = value * (n - index + 1) / index; return value;
}

export function mcnemar(a: Array<0 | 1>, b: Array<0 | 1>) {
  if (!a.length || a.length !== b.length) throw new Error('paired binary samples must have the same non-zero length');
  let aOnly = 0; let bOnly = 0;
  for (let index = 0; index < a.length; index += 1) { if (a[index] === 1 && b[index] === 0) aOnly += 1; if (a[index] === 0 && b[index] === 1) bOnly += 1; }
  const n = aOnly + bOnly; const tail = Math.min(aOnly, bOnly);
  const cumulative = n === 0 ? 1 : Array.from({ length: tail + 1 }, (_, k) => combination(n, k) * (0.5 ** n)).reduce((sum, value) => sum + value, 0);
  return { aOnly, bOnly, n, pValue: Math.min(1, 2 * cumulative) };
}
