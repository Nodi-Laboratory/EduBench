'use client';

import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { JsonBlock } from '@/components/ui/json-block';
import type { InspectorRecord } from './types';

type InspectorDockProps = {
  record: InspectorRecord;
  onClose: () => void;
};

function formatTimestamp(value: string | null) {
  if (!value) return '기록 시각 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function stringify(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

export function InspectorDock({ record, onClose }: InspectorDockProps) {
  const [copiedRecord, setCopiedRecord] = useState<InspectorRecord | null>(null);
  const copied = copiedRecord === record;

  async function copyPayload() {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(stringify(record.payload));
    setCopiedRecord(record);
  }

  return (
    <aside
      className="control-room-inspector"
      aria-label="Inspector Dock"
    >
      <header className="control-room-inspector-header">
        <div>
          <span className="control-room-eyebrow">INSPECTOR DOCK</span>
          <h2>{record.title}</h2>
        </div>
        <button
          type="button"
          className="control-room-icon-button"
          aria-label="Inspector 닫기"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <section className="control-room-inspector-summary">
        <h3>사람이 읽을 수 있는 요약</h3>
        <p>{record.summary}</p>
      </section>

      <dl className="control-room-inspector-facts">
        <div>
          <dt>유형</dt>
          <dd>{record.kind}</dd>
        </div>
        <div>
          <dt>단계</dt>
          <dd>{record.stage || '기록 없음'}</dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>{record.state || '기록 없음'}</dd>
        </div>
        <div>
          <dt>시각 (Asia/Seoul)</dt>
          <dd>{formatTimestamp(record.occurredAt)}</dd>
        </div>
      </dl>

      <section className="control-room-inspector-payload">
        <header>
          <div>
            <h3>실제 저장 payload</h3>
            <p>요약에 사용된 원본 값을 그대로 표시합니다.</p>
          </div>
          <button
            type="button"
            className="control-room-copy-button"
            onClick={() => void copyPayload()}
          >
            {copied
              ? <Check size={14} aria-hidden="true" />
              : <Copy size={14} aria-hidden="true" />}
            {copied ? '복사됨' : 'JSON 복사'}
          </button>
        </header>
        <JsonBlock value={record.payload} />
      </section>
    </aside>
  );
}
