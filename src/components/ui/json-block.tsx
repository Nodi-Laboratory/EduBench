type JsonBlockProps = {
  value: unknown;
  className?: string;
  emptyLabel?: string;
};

function displayValue(value: unknown, emptyLabel: string): string {
  if (value === undefined) return emptyLabel;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? emptyLabel;
  } catch {
    return String(value);
  }
}

export function JsonBlock({
  value,
  className = '',
  emptyLabel = '기록 없음',
}: JsonBlockProps) {
  return (
    <pre
      className={`json-block ${className}`.trim()}
      data-testid="json-block"
    >
      {displayValue(value, emptyLabel)}
    </pre>
  );
}
