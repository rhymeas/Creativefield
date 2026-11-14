import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError, member} from "./auth";
import {transaction} from "./db";
import {placementDraftSchema, type PlacementDraft} from "../src/image/editor/placement-draft";

const base = "/api/v1/workspaces/:workspaceId/projects/:projectId/placement-drafts/:assetId";
const params = z.object({workspaceId: z.uuid(), projectId: z.uuid(), assetId: z.uuid()});

type PlacementDraftRow = {
  draft: PlacementDraft;
  created_at: Date;
  updated_at: Date;
};

/** Cross-device recovery for one user's character-placement draft. */
export async function placementDraftRoutes(app: FastifyInstance, pool: Pool) {
  app.get(base, async request => {
    const {workspaceId, projectId, assetId} = params.parse(request.params);
    const user = await member(pool, request, workspaceId);
    const row = (await pool.query<PlacementDraftRow>(
      "SELECT draft, created_at, updated_at FROM placement_drafts WHERE workspace_id=$1 AND user_id=$2 AND project_id=$3 AND asset_id=$4",
      [workspaceId, user.id, projectId, assetId],
    )).rows[0];
    if (!row) throw new HttpError(404, "Placement draft not found");
    return row;
  });

  app.put(base, {bodyLimit: 4 * 1024 * 1024}, async request => {
    const {workspaceId, projectId, assetId} = params.parse(request.params);
    const user = await member(pool, request, workspaceId, "creator");
    const draft = placementDraftSchema.parse(request.body);
    if (
      draft.workspaceId !== workspaceId ||
      draft.projectId !== projectId ||
      draft.assetId !== assetId ||
      draft.userId !== user.id
    ) {
      throw new HttpError(422, "The placement draft does not match this project, image or user.");
    }
    return transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `placement-draft/${workspaceId}/${user.id}/${projectId}/${assetId}`,
      ]);
      const project = await client.query(
        "SELECT id FROM projects WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE",
        [workspaceId, projectId],
      );
      if (!project.rowCount) throw new HttpError(404, "Project not found");
      const asset = (await client.query(
        "SELECT id, project_id, media_type, content_type FROM assets WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE",
        [workspaceId, assetId],
      )).rows[0];
      if (!asset || asset.project_id !== projectId || asset.media_type !== "image" || asset.content_type !== "image/png") {
        throw new HttpError(422, "Placement recovery requires a PNG image in this project.");
      }
      const character = await client.query(
        "SELECT id FROM character_records WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
        [workspaceId, projectId, draft.characterId],
      );
      if (!character.rowCount) throw new HttpError(422, "The character is not available in this project.");
      return (await client.query<PlacementDraftRow>(
        `INSERT INTO placement_drafts (workspace_id, user_id, project_id, asset_id, draft)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (workspace_id, user_id, project_id, asset_id)
         DO UPDATE SET draft=EXCLUDED.draft, updated_at=now()
         RETURNING draft, created_at, updated_at`,
        [workspaceId, user.id, projectId, assetId, JSON.stringify(draft)],
      )).rows[0];
    });
  });

  app.delete(base, async (request, reply) => {
    const {workspaceId, projectId, assetId} = params.parse(request.params);
    const user = await member(pool, request, workspaceId, "creator");
    await pool.query(
      "DELETE FROM placement_drafts WHERE workspace_id=$1 AND user_id=$2 AND project_id=$3 AND asset_id=$4",
      [workspaceId, user.id, projectId, assetId],
    );
    return reply.code(204).send();
  });
}
