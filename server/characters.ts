import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { HttpError, member } from "./auth";
import { hashToken, newId } from "./crypto";
import { transaction } from "./db";
import {characterUsage} from "./character-usage";

const base = "/api/v1/workspaces/:workspaceId/projects/:projectId/characters";
const projectParams = z.object({ workspaceId: z.uuid(), projectId: z.uuid() }).strict();
const characterParams = projectParams.extend({ characterId: z.uuid() }).strict();
const referenceAssetIds = z.array(z.uuid()).min(1).max(16)
  .refine(ids => new Set(ids).size === ids.length, "Duplicate reference asset");
export const createCharacterSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(20000).default(""),
  referenceAssetIds,
}).strict();

type CharacterRow = {
  id: string;
  project_id: string;
  element_id: string;
  name: string;
  description: string;
  created_at: Date | string;
};

type ReferenceRow = {
  character_id: string;
  ordinal: number;
  asset_id: string;
  asset_project_id: string | null;
  asset_sha256: string;
  asset_media_type: string;
  asset_content_type: string;
  asset_bytes: string | number;
  asset_metadata: Record<string, unknown>;
};

type AssetRow = {
  id: string;
  project_id: string | null;
  sha256: string;
  media_type: string;
  content_type: string;
  bytes: string | number;
  metadata: Record<string, unknown> | null;
};

function characterRecord(row: CharacterRow, references: ReferenceRow[]) {
  return {
    id: row.id,
    projectId: row.project_id,
    elementId: row.element_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    referencePack: {
      version: 1 as const,
      references: references.map(reference => ({
        ordinal: reference.ordinal,
        assetId: reference.asset_id,
        assetProjectId: reference.asset_project_id,
        assetSha256: reference.asset_sha256,
        assetMediaType: reference.asset_media_type,
        assetContentType: reference.asset_content_type,
        assetBytes: reference.asset_bytes,
        assetMetadata: reference.asset_metadata ?? {},
      })),
    },
  };
}

async function readCharacterRecords(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  workspaceId: string,
  projectId: string,
  characterId?: string,
) {
  const rows = (await client.query(
    `SELECT id,project_id,element_id,name,description,created_at
       FROM character_records
      WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL AND ($3::uuid IS NULL OR id=$3)
      ORDER BY created_at DESC,id DESC`,
    [workspaceId, projectId, characterId ?? null],
  )).rows as CharacterRow[];
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const references = (await client.query(
    `SELECT s.character_id,s.ordinal,s.asset_id,s.asset_project_id,s.asset_sha256,
            s.asset_media_type,s.asset_content_type,s.asset_bytes,s.asset_metadata
       FROM character_reference_snapshots s
       JOIN character_records c
         ON c.workspace_id=s.workspace_id AND c.id=s.character_id
      WHERE c.workspace_id=$1 AND c.project_id=$2 AND c.id=ANY($3::uuid[])
      ORDER BY s.character_id,s.ordinal`,
    [workspaceId, projectId, ids],
  )).rows as ReferenceRow[];
  const byCharacter = new Map<string, ReferenceRow[]>();
  for (const reference of references) {
    const values = byCharacter.get(reference.character_id) ?? [];
    values.push(reference);
    byCharacter.set(reference.character_id, values);
  }
  const usage=await characterUsage(client,workspaceId,projectId,ids);
  return rows.map(row => ({...characterRecord(row, byCharacter.get(row.id) ?? []),usage:usage.get(row.id)??{referenceRuns:0,completedShots:0}}));
}

export async function characterRoutes(app: FastifyInstance, pool: Pool) {
  app.get(base, async request => {
    const { workspaceId, projectId } = projectParams.parse(request.params);
    await member(pool, request, workspaceId);
    return readCharacterRecords(pool, workspaceId, projectId);
  });

  app.get(`${base}/:characterId`, async request => {
    const { workspaceId, projectId, characterId } = characterParams.parse(request.params);
    await member(pool, request, workspaceId);
    const record = (await readCharacterRecords(pool, workspaceId, projectId, characterId))[0];
    if (!record) throw new HttpError(404, "Character not found");
    return record;
  });

  /* A character can now be removed from the cast. It cannot be deleted outright: reference snapshots
     are append-only, because they are the provenance of every shot the character appeared in. Removing
     it therefore sets `archived_at`, which hides it from the list and keeps the history intact. */
  app.delete(`${base}/:characterId`, async request => {
    const { workspaceId, projectId, characterId } = characterParams.parse(request.params);
    await member(pool, request, workspaceId, "creator");
    const updated = await pool.query(
      `UPDATE character_records SET archived_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL
        RETURNING id`,
      [workspaceId, projectId, characterId]);
    if (!updated.rowCount) throw new HttpError(404, "Character not found");
    return { archived: characterId };
  });

  app.post(base, async request => {
    const { workspaceId, projectId } = projectParams.parse(request.params);
    const user = await member(pool, request, workspaceId, "creator");
    const body = createCharacterSchema.parse(request.body);
    const requestHash = hashToken(JSON.stringify(body));

    return transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `character/${workspaceId}/${projectId}/${body.idempotencyKey}`,
      ]);
      if (!(await client.query(
        "SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",
        [workspaceId, projectId],
      )).rowCount) throw new HttpError(404, "Project not found");

      const previous = (await client.query(
        `SELECT id,request_hash FROM character_records
          WHERE workspace_id=$1 AND project_id=$2 AND idempotency_key=$3`,
        [workspaceId, projectId, body.idempotencyKey],
      )).rows[0] as { id: string; request_hash: string } | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash) {
          throw new HttpError(409, "Idempotency key already used for a different character");
        }
        const record = (await readCharacterRecords(client, workspaceId, projectId, previous.id))[0];
        if (!record) throw new HttpError(409, "Character retry could not be resolved");
        return { ...record, repeated: true };
      }

      const assets = (await client.query(
        `SELECT id,project_id,sha256,media_type,content_type,bytes,metadata
           FROM assets
          WHERE workspace_id=$1 AND (project_id=$2 OR project_id IS NULL)
            AND id=ANY($3::uuid[])`,
        [workspaceId, projectId, body.referenceAssetIds],
      )).rows as AssetRow[];
      if (assets.length !== body.referenceAssetIds.length) {
        throw new HttpError(404, "Reference asset not found for this project");
      }
      const assetsById = new Map(assets.map(asset => [asset.id, asset]));
      const orderedAssets = body.referenceAssetIds.map(id => assetsById.get(id)!);
      if (orderedAssets.some(asset => !["image", "reference"].includes(asset.media_type))) {
        throw new HttpError(400, "Character references must be image assets");
      }

      const characterId = newId();
      const elementId = newId();
      await client.query(
        `INSERT INTO elements(id,workspace_id,name,kind,description,created_by)
         VALUES($1,$2,$3,'character',$4,$5)`,
        [elementId, workspaceId, body.name, body.description, user.id],
      );
      const created = (await client.query(
        `INSERT INTO character_records(
           id,workspace_id,project_id,element_id,name,description,idempotency_key,request_hash,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id,project_id,element_id,name,description,created_at`,
        [characterId, workspaceId, projectId, elementId, body.name, body.description,
          body.idempotencyKey, requestHash, user.id],
      )).rows[0] as CharacterRow;

      const snapshots: ReferenceRow[] = [];
      for (const [ordinal, asset] of orderedAssets.entries()) {
        await client.query(
          `INSERT INTO element_assets(workspace_id,element_id,asset_id) VALUES($1,$2,$3)`,
          [workspaceId, elementId, asset.id],
        );
        const snapshot = (await client.query(
          `INSERT INTO character_reference_snapshots(
             workspace_id,character_id,ordinal,asset_id,asset_project_id,asset_sha256,
             asset_media_type,asset_content_type,asset_bytes,asset_metadata
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING character_id,ordinal,asset_id,asset_project_id,asset_sha256,
                     asset_media_type,asset_content_type,asset_bytes,asset_metadata`,
          [workspaceId, characterId, ordinal, asset.id, asset.project_id, asset.sha256,
            asset.media_type, asset.content_type, asset.bytes, JSON.stringify(asset.metadata ?? {})],
        )).rows[0] as ReferenceRow;
        snapshots.push(snapshot);
      }
      return { ...characterRecord(created, snapshots), usage:{referenceRuns:0,completedShots:0}, repeated: false };
    });
  });
}
