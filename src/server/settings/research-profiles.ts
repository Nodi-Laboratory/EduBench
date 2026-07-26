import {
  hashResearchConfigDefinition,
  parseResearchConfigDefinition,
  type ResearchConfigDefinition,
  type ResearchConfigKind,
} from '@/domain/research-config';
import { DomainError } from '@/domain/errors';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';

type ResearchProfileRow = {
  id:string;
  kind:ResearchConfigKind;
  version:string;
  title:string;
  definition:unknown;
  content_hash:string;
  created_at:string | Date;
  active:boolean;
};

export type ResearchConfigProfile = {
  id:string;
  kind:ResearchConfigKind;
  version:string;
  title:string;
  definition:ResearchConfigDefinition;
  contentHash:string;
  createdAt:string;
  active:boolean;
};

function mapResearchProfile(row: ResearchProfileRow): ResearchConfigProfile {
  const definition = parseResearchConfigDefinition(row.definition);
  if (
    definition.kind !== row.kind
    || definition.version !== row.version
    || definition.title !== row.title
    || hashResearchConfigDefinition(definition) !== row.content_hash
  ) {
    throw new DomainError(
      'RESEARCH_PROFILE_INTEGRITY_ERROR',
      '저장된 연구 설정 프로필의 정의와 해시가 일치하지 않습니다.',
      { profileId:row.id },
    );
  }
  return {
    id:row.id,
    kind:row.kind,
    version:row.version,
    title:row.title,
    definition,
    contentHash:row.content_hash,
    createdAt:new Date(row.created_at).toISOString(),
    active:row.active,
  };
}

export async function listResearchConfigProfiles(
  kind?: ResearchConfigKind,
): Promise<{
  items:ResearchConfigProfile[];
  activeByKind:Partial<Record<ResearchConfigKind, string>>;
}> {
  const result = await db.query<ResearchProfileRow>(
    `select profile.id,profile.kind,profile.version,profile.title,
       profile.definition,profile.content_hash,profile.created_at,
       (active.profile_id is not null) active
     from research_config_profiles profile
     left join research_config_active_profiles active
       on active.kind=profile.kind and active.profile_id=profile.id
     where ($1::text is null or profile.kind=$1)
     order by profile.kind,profile.created_at desc,profile.version desc`,
    [kind ?? null],
  );
  const items = result.rows.map(mapResearchProfile);
  const activeByKind: Partial<Record<ResearchConfigKind, string>> = {};
  for (const item of items) {
    if (item.active) activeByKind[item.kind] = item.id;
  }
  return { items, activeByKind };
}

export async function createResearchConfigProfile(
  input: unknown,
): Promise<ResearchConfigProfile> {
  const definition = parseResearchConfigDefinition(input);
  const contentHash = hashResearchConfigDefinition(definition);
  const created = await db.query<ResearchProfileRow>(
    `insert into research_config_profiles(
       kind,version,title,definition,content_hash
     ) values($1,$2,$3,$4::jsonb,$5)
     returning id,kind,version,title,definition,content_hash,created_at,false active`,
    [
      definition.kind,
      definition.version,
      definition.title,
      JSON.stringify(definition),
      contentHash,
    ],
  );
  return mapResearchProfile(created.rows[0]!);
}

export async function activateResearchConfigProfile(
  kind: ResearchConfigKind,
  profileId: string,
): Promise<{ kind:ResearchConfigKind; profileId:string; activatedAt:string }> {
  return withTransaction(async (client) => {
    const profile = await client.query<{ id:string }>(
      `select id from research_config_profiles
       where id=$1 and kind=$2
       for key share`,
      [profileId, kind],
    );
    if (!profile.rowCount) {
      throw new DomainError(
        'RESEARCH_PROFILE_NOT_FOUND',
        '해당 종류에 속하는 연구 설정 프로필을 찾을 수 없습니다.',
        { profileId, kind },
      );
    }
    const activated = await client.query<{
      kind:ResearchConfigKind;
      profile_id:string;
      activated_at:string | Date;
    }>(
      `insert into research_config_active_profiles(kind,profile_id,activated_at)
       values($1,$2,now())
       on conflict(kind) do update set
         profile_id=excluded.profile_id,
         activated_at=excluded.activated_at
       returning kind,profile_id,activated_at`,
      [kind, profileId],
    );
    return {
      kind:activated.rows[0]!.kind,
      profileId:activated.rows[0]!.profile_id,
      activatedAt:new Date(activated.rows[0]!.activated_at).toISOString(),
    };
  });
}
