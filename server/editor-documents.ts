import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError,member} from "./auth";
import {transaction} from "./db";
import {DOCUMENT_FORMAT,documentKeys,validateDocument} from "../src/image/editor/document-format";

const base="/api/v1/workspaces/:workspaceId/projects/:projectId/editor-documents";
const params=z.object({workspaceId:z.uuid(),projectId:z.uuid()}),item=params.extend({id:z.uuid()});
const columns="id,name,kind,revision,created_by,created_at,updated_at";
export async function editorDocumentRoutes(app:FastifyInstance,pool:Pool){
  app.get(base,async request=>{const {workspaceId,projectId}=params.parse(request.params),user=await member(pool,request,workspaceId);
    return (await pool.query(`SELECT ${columns} FROM editor_documents WHERE workspace_id=$1 AND project_id=$2 AND (kind='saved' OR created_by=$3) ORDER BY updated_at DESC LIMIT 50`,[workspaceId,projectId,user.id])).rows;
  });
  app.get(`${base}/:id`,async request=>{const {workspaceId,projectId,id}=item.parse(request.params),user=await member(pool,request,workspaceId);
    const row=(await pool.query(`SELECT ${columns},document FROM editor_documents WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND (kind='saved' OR created_by=$4)`,[workspaceId,projectId,id,user.id])).rows[0];
    if(!row)throw new HttpError(404,"Editor document not found");return row;
  });
  app.put(`${base}/:id`,{bodyLimit:4*1024*1024},async request=>{
    const {workspaceId,projectId,id}=item.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const body=z.object({format:z.literal(DOCUMENT_FORMAT),name:z.string().trim().min(1).max(240),kind:z.enum(["saved","recovery"]),revision:z.number().int().min(0),document:z.unknown()}).strict().parse(request.body);
    let doc;try{doc=validateDocument(body.document);}catch{throw new HttpError(422,"The layered document is invalid or exceeds its editing budget.");}
    const ids=[...new Set(documentKeys(doc).map(k=>k.slice(6)))];
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`editor-document/${id}`]);
      if(!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE",[workspaceId,projectId])).rowCount)throw new HttpError(404,"Project not found");
      const assets=(await client.query("SELECT id,content_type FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[]) FOR KEY SHARE",[workspaceId,projectId,ids])).rows;
      if(assets.length!==ids.length||assets.some(a=>a.content_type!=="image/png"))throw new HttpError(422,"Document bitmaps must be PNG assets in this project.");
      const old=(await client.query("SELECT * FROM editor_documents WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(old&&(old.workspace_id!==workspaceId||old.project_id!==projectId||old.created_by!==user.id))throw new HttpError(409,"This document belongs to a different editing session.");
      if((old?.revision??0)!==body.revision)throw new HttpError(409,"This document has a newer saved revision. Reopen it before saving again.");
      return (await client.query(`INSERT INTO editor_documents(id,workspace_id,project_id,created_by,name,kind,document) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,kind=EXCLUDED.kind,document=EXCLUDED.document,revision=editor_documents.revision+1,updated_at=now() RETURNING ${columns}`,[id,workspaceId,projectId,user.id,body.name,body.kind,JSON.stringify(doc)])).rows[0];
    });
  });
}
