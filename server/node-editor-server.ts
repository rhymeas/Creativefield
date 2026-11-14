import Fastify from "fastify";
import cookie from "@fastify/cookie";
import type {Pool} from "pg";
import {HttpError} from "./auth";
import type {ServerConfig} from "./config";
import {comfyProxyRoutes} from "./comfy-proxy";

/** Only ComfyUI routes live here. No app API, storage, or session creation. */
export async function buildNodeEditorServer(config:ServerConfig,pool:Pool){
  if(!config.nodeEditorOrigin||!config.nodeEditorPort)throw new Error("Isolated node-editor origin is required");
  const app=Fastify({logger:false,bodyLimit:config.maxUploadBytes});
  await app.register(cookie);
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof HttpError?error.statusCode:502)
    .send({error:error instanceof HttpError?error.message:"The node editor could not complete this request"}));
  app.addHook("onRequest",async(request,reply)=>{
    reply.header("X-Content-Type-Options","nosniff").header("Cache-Control","no-store");
    // Extension scripts are untrusted with respect to the application origin.
    // CORS is deliberately not enabled on either service.
    if(!["GET","HEAD","OPTIONS"].includes(request.method)&&request.headers.origin!==config.nodeEditorOrigin)
      throw new HttpError(403,"Request origin is not allowed");
  });
  await comfyProxyRoutes(app,pool,config.nodeEditorOrigin,config.publicOrigin);
  return app;
}
