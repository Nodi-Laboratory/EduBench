import type { Metadata } from 'next';
import { DashboardOverview } from '@/components/dashboard/dashboard-overview';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '운영 현황' };

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [approved, sources, attention, latest, models, recent] = await Promise.all([
    db.query<{ count: string }>("select count(*) from questions where status = 'APPROVED' and deleted_at is null and public_id not like 'SAMPLE-Q-%'"),
    db.query<{ count: string }>("select count(*) from source_files where status = 'READY' and deleted_at is null"),
    db.query<{ count: string }>("select (select count(*) from source_files where status='FAILED') + (select count(*) from questions where status in ('IN_REVIEW','HELD') and public_id not like 'SAMPLE-Q-%') + (select count(*) from run_items where state='TERMINAL_FAILED') as count"),
    db.query<{ id: string; public_id: string; title: string; state: string; total_items: number; completed_items: number; failed_items: number }>("select id,public_id,title,state,total_items,completed_items,failed_items from benchmark_runs order by (parameters->>'sample_data')::boolean nulls first, created_at desc limit 1"),
    db.query<{ display_name: string; model_id: string; total: string; done: string; failed: string; latency: string | null; tokens: string | null; cost: string | null }>(`select rm.display_name,rm.model_id,count(ri.id)::text total,count(ri.id) filter (where ri.state='SUCCEEDED')::text done,count(ri.id) filter (where ri.state='TERMINAL_FAILED')::text failed,avg(mr.latency_ms)::text latency,(sum(mr.input_tokens)+sum(mr.output_tokens))::text tokens,sum(mr.cost_krw)::text cost from run_models rm join benchmark_runs br on br.id=rm.benchmark_run_id left join run_items ri on ri.run_model_id=rm.id left join model_responses mr on mr.run_item_id=ri.id where br.id=(select id from benchmark_runs order by (parameters->>'sample_data')::boolean nulls first, created_at desc limit 1) group by rm.id order by rm.blind_id`),
    db.query<{ id: string; public_id: string; title: string; state: string; completed_items: number; total_items: number }>('select id,public_id,title,state,completed_items,total_items from benchmark_runs order by created_at desc limit 5'),
  ]);
  return <DashboardOverview approved={Number(approved.rows[0]?.count ?? 0)} readySources={Number(sources.rows[0]?.count ?? 0)} attention={Number(attention.rows[0]?.count ?? 0)} latest={latest.rows[0] ?? null} models={models.rows} recent={recent.rows} />;
}
