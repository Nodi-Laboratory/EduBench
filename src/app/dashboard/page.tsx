import type { Metadata } from 'next';
import { DashboardOverview } from '@/components/dashboard/dashboard-overview';
import { db } from '@/server/db/pool';
import { getDashboardRunOverview } from '@/server/dashboard/overview';

export const metadata: Metadata = { title: '운영 현황' };

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [approved, sources, attention, runOverview] = await Promise.all([
    db.query<{ count: string }>("select count(*) from questions where status = 'APPROVED' and deleted_at is null and public_id not like 'SAMPLE-Q-%'"),
    db.query<{ count: string }>("select count(*) from source_files where status = 'READY' and deleted_at is null"),
    db.query<{ count: string }>("select (select count(*) from source_files where status='FAILED') + (select count(*) from questions where status in ('IN_REVIEW','HELD') and public_id not like 'SAMPLE-Q-%') + (select count(*) from run_items where state='TERMINAL_FAILED') as count"),
    getDashboardRunOverview(),
  ]);
  return <DashboardOverview approved={Number(approved.rows[0]?.count ?? 0)} readySources={Number(sources.rows[0]?.count ?? 0)} attention={Number(attention.rows[0]?.count ?? 0)} latest={runOverview.latest} models={runOverview.models} recent={runOverview.recent} />;
}
