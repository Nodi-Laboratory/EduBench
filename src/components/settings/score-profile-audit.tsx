import Link from 'next/link';
import { Bot, Braces, Calculator, CheckCircle2, FileSearch, Scale } from 'lucide-react';
import { describeScoreMetrics } from '@/domain/score-metrics';
import { prerequisiteScoreMetrics } from '@/domain/prerequisite-benchmark';

export type ScoreProfileRun = { id: string; publicId: string; title: string; state: string; createdAt: string };
export type ScoreProfileAuditData = {
  version: string;
  title: string;
  metrics: string[];
  rubric_prompt: string | null;
  judge_provider: string | null;
  judge_model: string | null;
  content_hash: string;
  created_at: string;
  run_count?: number;
  recent_runs?: ScoreProfileRun[];
};

const methodLabel = { deterministic: '결정론적 검사', judge: 'Judge 모델 절대평가' } as const;

export function ScoreProfileAudit({ profile }: { profile: ScoreProfileAuditData }) {
  const definitions = describeScoreMetrics(['exact_match', 'response_present', ...profile.metrics, ...prerequisiteScoreMetrics]);
  const recentRuns = Array.isArray(profile.recent_runs) ? profile.recent_runs : [];
  return <details className="score-profile-audit">
    <summary>
      <strong className="mono">{profile.version}</strong>
      <span>{profile.title}</span>
      <small>{profile.judge_provider ? `${profile.judge_provider} · ${profile.judge_model ?? '모델 미지정'}` : '결정론적 채점'}</small>
      <b>{profile.run_count ?? 0}회 사용</b>
    </summary>
    <div className="score-profile-audit-body">
      <div className="profile-manifest">
        <div><small>프로필 버전</small><strong className="mono">{profile.version}</strong></div>
        <div><small>Judge 제공자</small><strong>{profile.judge_provider ?? '사용하지 않음'}</strong></div>
        <div><small>Judge 모델</small><strong className="mono">{profile.judge_model ?? '—'}</strong></div>
        <div><small>생성 시각</small><strong className="mono">{profile.created_at.slice(0, 19).replace('T', ' ')}</strong></div>
        <div className="profile-hash"><small>내용 해시</small><code>{profile.content_hash}</code></div>
      </div>

      <section className="score-audit-section">
        <h3><Scale size={16}/> 평가 처리 흐름</h3>
        <ol className="score-pipeline">
          <li><FileSearch size={15}/><b>01</b><div><strong>평가 입력 고정</strong><span>데이터셋에 고정된 질문 revision, 교과서 근거, 모범 답안, 채점 기준과 모델 응답을 읽습니다.</span></div></li>
          <li><Calculator size={15}/><b>02</b><div><strong>결정론적 검사</strong><span>응답 존재 여부와 정규화된 허용 답안 완전 일치를 코드로 계산합니다.</span></div></li>
          <li><Bot size={15}/><b>03</b><div><strong>블라인드 Judge 절대평가</strong><span>모델 식별 편향을 줄인 입력에 프로필 루브릭과 문항별 선수관계 청사진을 적용합니다.</span></div></li>
          <li><CheckCircle2 size={15}/><b>04</b><div><strong>판정 근거 보존</strong><span>지표별 점수, 라벨, 판정 이유, 인용 근거, Judge 모델과 요청 ID를 실행 상세에 저장합니다.</span></div></li>
        </ol>
      </section>

      <section className="score-audit-section">
        <h3><Braces size={16}/> 지표 정의와 판정 기준</h3>
        <p>결정론적 지표는 모든 응답에 자동 적용됩니다. 프로필 고정 지표는 이 프로필을 선택한 실행에 적용되고, 선수관계 지표 6개는 문항의 benchmarkDesign이 `PREREQUISITE_RELATIONSHIP`일 때 동적으로 추가됩니다.</p>
        <div className="metric-definition-list">{definitions.map((metric) => <article key={metric.key}>
          <header><div><strong>{metric.label}</strong><code>{metric.key}</code></div><div className="metric-definition-tags"><span>{metric.category}</span><em>{profile.metrics.includes(metric.key) ? '프로필 고정' : prerequisiteScoreMetrics.includes(metric.key as (typeof prerequisiteScoreMetrics)[number]) ? '선수관계 문항 동적 적용' : '모든 응답 자동 적용'}</em></div></header>
          <dl>
            <div><dt>판정 방식</dt><dd>{methodLabel[metric.method]}</dd></div>
            <div><dt>점수 범위</dt><dd>{metric.range}</dd></div>
            <div><dt>방향</dt><dd>{metric.direction}</dd></div>
          </dl>
          <p><strong>정의</strong>{metric.definition}</p>
          <p><strong>평가 대상</strong>{metric.evaluates}</p>
          <p><strong>점수 해석</strong>{metric.interpretation}</p>
          <div className="metric-rubric"><strong>상세 루브릭</strong><span>{metric.rubric}</span></div>
        </article>)}</div>
      </section>

      <section className="score-audit-section">
        <h3>전체 Judge 루브릭 프롬프트</h3>
        <p>Judge 호출 시 지표 정의와 함께 적용되는 프로필 수준 지시입니다. 사용자 정의 지표는 이 원문을 최종 판정 기준으로 해석해야 합니다.</p>
        <pre className="profile-rubric-prompt">{profile.rubric_prompt || '별도 Judge 루브릭 프롬프트 없음'}</pre>
      </section>

      <section className="score-audit-section">
        <h3>이 프로필을 사용한 실행</h3>
        <p>실제 전송 질문, 모델 응답, 실패 원인, 지표 점수와 Judge 판정 근거는 실행 상세에서 확인할 수 있습니다.</p>
        {recentRuns.length ? <div className="profile-run-links">{recentRuns.map((run) => <Link key={run.id} href={`/runs/${run.id}`}><strong className="mono">{run.publicId}</strong><span>{run.title}</span><small>{run.state} · {run.createdAt.slice(0, 16).replace('T', ' ')}</small></Link>)}</div> : <p className="empty-copy">아직 이 프로필을 사용한 실행이 없습니다.</p>}
      </section>
    </div>
  </details>;
}
