import {readFile} from "node:fs/promises";
import path from "node:path";
import type {FastifyInstance} from "fastify";
import fastifyStatic from "@fastify/static";

/** Only trusted build assets are public. Disk media stays behind workspace authorization. */
export async function serveTeamUi(app:FastifyInstance,root:string,nodeEditorOrigin?:string) {
  const readHtml=async()=>{
    const source=await readFile(path.join(root,"index.html"),"utf8");
    if(!/<head(?:\s[^>]*)?>/i.test(source))throw new Error("Team UI build has no head element");
    return source.replace(/<head(?:\s[^>]*)?>/i,head=>`${head}<meta name="comfyfield-mode" content="team">`);
  };
  // Fail fast for a wrong build directory, but do not retain its hashed entry names.
  // A later build replaces index.html while this API process may still have active jobs.
  await readHtml();
  await app.register(fastifyStatic,{root:path.join(root,"assets"),prefix:"/assets/",decorateReply:false,redirect:false,index:false});
  // Vite copies the reviewed model-card reels beside assets, not inside it.
  // Expose only that build directory; never the workspace storage or build root.
  await app.register(fastifyStatic,{root:path.join(root,"reels"),prefix:"/reels/",decorateReply:false,redirect:false,index:false});
  // Example pictures for the tool cards (public/examples, listed in its index.json).
  await app.register(fastifyStatic,{root:path.join(root,"examples"),prefix:"/examples/",decorateReply:false,redirect:false,index:false});
  /* Browsers ask for the icon at the site root, not under /assets. Without this every page load
     logged a 404 and the tab fell back to a generic globe. */
  const favicon=async(_request:unknown,reply:any)=>{
    try{
      const svg=await readFile(path.join(root,"favicon.svg"));
      return reply.header("Cache-Control","public, max-age=86400").type("image/svg+xml").send(svg);
    }catch{
      return reply.code(204).send();
    }
  };
  app.get("/favicon.svg",favicon);
  app.get("/favicon.ico",favicon);
  app.get("/",async(_request,reply)=>{
    reply.header("Cache-Control","no-store")
      .header("Content-Security-Policy",`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-src ${nodeEditorOrigin??"'none'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    let html:string;
    try{html=await readHtml();}
    catch{return reply.code(503).header("Retry-After","1").type("text/plain; charset=utf-8").send("ComfyField is rebuilding. Keep existing editor tabs open. Try loading this page again shortly.");}
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
