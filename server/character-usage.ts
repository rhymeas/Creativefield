import type {Pool,PoolClient} from "pg";

export type CharacterUsage={referenceRuns:number;completedShots:number};
/** Historical provenance counts, not a claim of visible identity fidelity. */
export async function characterUsage(client:Pick<Pool,"query">|Pick<PoolClient,"query">,workspaceId:string,projectId:string,ids:string[]):Promise<Map<string,CharacterUsage>>{
  if(!ids.length)return new Map();
  const result=await client.query(`WITH RECURSIVE
    characters AS MATERIALIZED (
      SELECT id,element_id FROM character_records WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])
    ), successful AS MATERIALIZED (
      SELECT id,invocation,output_ids FROM runs WHERE workspace_id=$1 AND project_id=$2 AND state='succeeded'
        AND CASE WHEN jsonb_typeof(output_ids)='array' THEN jsonb_array_length(output_ids)>0 ELSE false END
    ), seeds AS MATERIALIZED (
      SELECT DISTINCT c.id AS character_id,r.id AS run_id FROM characters c
      JOIN character_reference_snapshots s ON s.workspace_id=$1 AND s.character_id=c.id
      CROSS JOIN successful r
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(r.invocation->'elementInputSnapshots')='object' THEN r.invocation->'elementInputSnapshots' ELSE '{}'::jsonb END) e
      WHERE e.value->'validationVersion'='1'::jsonb AND e.value->>'elementKind'='character'
        AND e.value->>'elementId'=c.element_id::text AND e.value->>'assetId'=s.asset_id::text
        AND e.value->>'assetSha256'=s.asset_sha256
    ), outputs AS MATERIALIZED (
      SELECT r.id AS run_id,o.asset_id FROM successful r CROSS JOIN LATERAL jsonb_array_elements_text(r.output_ids) o(asset_id)
    ), inputs AS MATERIALIZED (
      SELECT r.id AS run_id,i.asset_id FROM successful r
      CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(r.invocation->'inputs')='object' THEN r.invocation->'inputs' ELSE '{}'::jsonb END) i(port,asset_id)
    ), ancestry(run_id,asset_id) AS (
      SELECT run_id,asset_id FROM inputs
      UNION
      SELECT a.run_id,parent.id::text
      FROM ancestry a JOIN assets child ON child.workspace_id=$1 AND child.id::text=a.asset_id
      JOIN assets parent ON parent.workspace_id=$1 AND parent.id=child.parent_id
    ), lineage(character_id,run_id) AS (
      SELECT character_id,run_id FROM seeds
      UNION
      SELECT l.character_id,a.run_id FROM lineage l JOIN outputs o ON o.run_id=l.run_id JOIN ancestry a ON a.asset_id=o.asset_id
    ), shot_links AS (
      SELECT t.child_run_id AS run_id,t.storyboard_id,t.plan_key::text AS plan_key
      FROM storyboard_still_takes t JOIN storyboards b ON b.workspace_id=t.workspace_id AND b.id=t.storyboard_id
      WHERE t.workspace_id=$1 AND b.project_id=$2
      UNION
      SELECT s.child_run_id,r.storyboard_id,s.snapshot->>'planKey'
      FROM storyboard_render_shots s JOIN storyboard_renders r ON r.workspace_id=s.workspace_id AND r.id=s.render_id
      WHERE s.workspace_id=$1 AND r.project_id=$2 AND nullif(s.snapshot->>'planKey','') IS NOT NULL
    ), reference_counts AS (
      SELECT character_id,count(*)::int AS n FROM seeds GROUP BY character_id
    ), shot_counts AS (
      SELECT l.character_id,count(DISTINCT (s.storyboard_id,s.plan_key))::int AS n
      FROM lineage l JOIN shot_links s ON s.run_id=l.run_id GROUP BY l.character_id
    )
    SELECT c.id,coalesce(r.n,0) AS reference_runs,coalesce(s.n,0) AS completed_shots
    FROM characters c LEFT JOIN reference_counts r ON r.character_id=c.id LEFT JOIN shot_counts s ON s.character_id=c.id`,[workspaceId,projectId,ids]);
  return new Map(result.rows.map(row=>[row.id,{referenceRuns:Number(row.reference_runs),completedShots:Number(row.completed_shots)}]));
}
