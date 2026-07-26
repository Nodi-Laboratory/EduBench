import { db } from '@/server/db/pool';

export type DashboardRunRow = {
  id:string;
  public_id:string;
  title:string;
  state:string;
  total_items:number;
  eligible_response_count:number;
  execution_completed_items:number;
  failed_items:number;
};

export type DashboardModelRow = {
  display_name:string;
  model_id:string;
  total:string;
  done:string;
  failed:string;
  latency:string | null;
  tokens:string | null;
  cost:string | null;
};

export async function getDashboardRunOverview(runId?: string): Promise<{
  latest:DashboardRunRow | null;
  models:DashboardModelRow[];
  recent:DashboardRunRow[];
}> {
  const target = await db.query<DashboardRunRow>(
    `select br.id,br.public_id,br.title,br.state,br.total_items,
       br.completed_items execution_completed_items,br.failed_items,
       (select count(*)::int
        from eligible_model_responses mr
        join run_items ri on ri.id=mr.run_item_id
        where ri.benchmark_run_id=br.id) eligible_response_count
     from benchmark_runs br
     where ($1::uuid is not null and br.id=$1::uuid)
        or ($1::uuid is null and br.id=(
          select id from benchmark_runs
          order by (parameters->>'sample_data')::boolean nulls first,created_at desc
          limit 1
        ))
     limit 1`,
    [runId ?? null],
  );
  const latest = target.rows[0] ?? null;
  if (!latest) return { latest:null, models:[], recent:[] };

  const [models, recent] = await Promise.all([
    db.query<DashboardModelRow>(
      `select rm.display_name,rm.model_id,count(ri.id)::text total,
         count(mr.id)::text done,
         count(ri.id) filter (where ri.state='TERMINAL_FAILED')::text failed,
         avg(mr.latency_ms)::text latency,
         (sum(mr.input_tokens)+sum(mr.output_tokens))::text tokens,
         sum(mr.cost_krw)::text cost
       from run_models rm
       left join run_items ri on ri.run_model_id=rm.id
       left join eligible_model_responses mr on mr.run_item_id=ri.id
       where rm.benchmark_run_id=$1
       group by rm.id order by rm.blind_id`,
      [latest.id],
    ),
    db.query<DashboardRunRow>(
      `select br.id,br.public_id,br.title,br.state,br.total_items,
         br.completed_items execution_completed_items,br.failed_items,
         (select count(*)::int
          from eligible_model_responses mr
          join run_items ri on ri.id=mr.run_item_id
          where ri.benchmark_run_id=br.id) eligible_response_count
       from benchmark_runs br
       where $1::uuid is null or br.id=$1::uuid
       order by br.created_at desc limit 5`,
      [runId ?? null],
    ),
  ]);
  return { latest, models:models.rows, recent:recent.rows };
}
