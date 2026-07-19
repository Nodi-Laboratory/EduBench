import { notFound } from 'next/navigation';
import { db } from '@/server/db/pool';
import { RunController } from '@/components/runs/run-controller';

export const dynamic = 'force-dynamic';

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [run, models] = await Promise.all([
    db.query(`select br.*, dv.version as dataset_version, sp.version as score_version
      from benchmark_runs br join dataset_versions dv on dv.id = br.dataset_version_id
      join score_profiles sp on sp.id = br.score_profile_id where br.id = $1`, [id]),
    db.query(`select id, display_name, blind_id, model_id, protocol, concurrency from run_models where benchmark_run_id = $1 order by blind_id`, [id]),
  ]);
  if (!run.rows[0]) notFound();
  return <RunController initialRun={run.rows[0]} models={models.rows} />;
}
