import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('provides a valid root app icon for browser favicon metadata', () => {
  const iconPath = join(process.cwd(), 'src', 'app', 'icon.svg');

  expect(existsSync(iconPath), 'src/app/icon.svg must exist').toBe(true);
  const icon = readFileSync(iconPath, 'utf8');
  expect(icon).toMatch(/^<svg\b/);
  expect(icon).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(icon).toMatch(/viewBox="0 0 \d+ \d+"/);
});
