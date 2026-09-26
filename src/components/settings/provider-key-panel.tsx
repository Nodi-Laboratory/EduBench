'use client';

import { useState, type FormEvent } from 'react';
import { ExternalLink, KeyRound, Trash2 } from 'lucide-react';
import { PROVIDER_KEY_CATALOG } from '@/domain/provider-key-catalog';
import { useProviderKeys } from '@/hooks/use-provider-keys';

export function ProviderKeyPanel({ mockMode }: { mockMode: boolean }) {
  const { setKey, clearAll, hasKey } = useProviderKeys();
  const [notice, setNotice] = useState('');

  function save(event: FormEvent<HTMLFormElement>, provider: string) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem('key') as HTMLInputElement | null;
    const value = input?.value.trim() ?? '';
    if (!value) return;
    setKey(provider, value);
    if (input) input.value = '';
    setNotice('이 브라우저에 키를 저장했습니다.');
  }

  return (
    <section className="panel settings-section" id="api-keys">
      <div className="panel-heading">
        <div><KeyRound size={16} /><h2>API 키</h2></div>
        <span className="count-label">브라우저 localStorage에만 저장</span>
      </div>
      <p className="provider-key-intro">
        키는 이 브라우저에만 저장됩니다. 교과서 파싱, 문항 생성, 벤치마크 실행을 시작할 때만 요청 헤더로 서버에 전달되며,
        서버는 해당 작업이 끝날 때까지 메모리에만 보관하고 DB나 로그에 쓰지 않습니다.
        {mockMode && ' 현재 MOCK_PROVIDERS=true 이므로 키 없이 모의 응답으로 동작합니다.'}
      </p>
      {notice && <p className="inline-notice provider-key-notice">{notice}</p>}
      <div className="provider-key-grid">
        {PROVIDER_KEY_CATALOG.map((entry) => {
          const saved = hasKey(entry.provider);
          return (
            <form className="provider-key-row" key={entry.provider} onSubmit={(event) => save(event, entry.provider)}>
              <div className="provider-key-meta">
                <span className={`status-dot ${saved ? '' : 'idle'}`} />
                <div>
                  <strong>{entry.label}</strong>
                  <small>{entry.usage}</small>
                  {entry.issueUrl
                    ? <a href={entry.issueUrl} target="_blank" rel="noreferrer">{entry.issueLabel}에서 발급 <ExternalLink size={11} aria-hidden="true" /></a>
                    : <small>{entry.issueLabel}</small>}
                </div>
              </div>
              <div className="provider-key-input">
                <input
                  name="key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={saved ? '저장됨 · 바꾸려면 새 키 입력' : 'API 키 입력'}
                  aria-label={`${entry.label} API 키`}
                />
                <button className="button" type="submit">저장</button>
                {saved && (
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`${entry.label} 키 삭제`}
                    onClick={() => { setKey(entry.provider, ''); setNotice('키를 삭제했습니다.'); }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </form>
          );
        })}
      </div>
      <div className="provider-key-footer">
        <button className="text-link" type="button" onClick={() => { clearAll(); setNotice('저장된 키를 모두 삭제했습니다.'); }}>
          저장된 키 모두 삭제
        </button>
      </div>
    </section>
  );
}
