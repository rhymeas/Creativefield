import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import proxy from "@fastify/http-proxy";
import type { Pool } from "pg";
import type { ClientOptions } from "ws";
import { HttpError, member } from "./auth";
import { loadServerCatalogue } from "./catalogue";
import { loadWorkspaceCatalogue } from "./workflow-imports";
import { featureFileName } from "./feature-edit";
import { runGraphRoutes } from "./comfy-editor";
import { apiToUi } from "../src/workflow/api-to-ui";
import type { ObjectInfo } from "../src/workflow/ui-to-api";

type ComfyRequest = FastifyRequest & { comfyOrigin?: string; comfyWorkspaceId?: string };

const NODE_HELP = new URL("./comfy-node-help.mjs", import.meta.url);
const THREE_D = new URL("./comfy-3d.mjs", import.meta.url);
const FEATURE = new URL("./comfy-feature.mjs", import.meta.url);
const THEMES = new URL("./comfy-theme.css", import.meta.url);
const TOKENS = new URL("../src/ds/tokens.css", import.meta.url);
const WORKSPACE_PATH = /^\/comfy\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i;

/**
 * The official ComfyUI frontend, mounted under /comfy/<workspaceId>.
 *
 * Workspace IDs are routing identifiers, never authorization. Every request,
 * including the WebSocket handshake, requires current creator membership.
 */
export async function comfyProxyRoutes(app: FastifyInstance, pool: Pool, publicOrigin: string, appOrigin=publicOrigin) {
  /* Read on every request: theme edits show up on the next reload of the node editor,
     without restarting the server. Both files are small. */
  async function themeCss() {
    const [tokens, theme] = await Promise.all([readFile(TOKENS, "utf8"), readFile(THEMES, "utf8")]);
    return `${tokens.replace(/@import[^\n]*\n/g, "")}\n${theme}`;
  }
  function forwardHeaders(headers: IncomingHttpHeaders, origin?: string) {
    /* Module scripts are fetched in CORS mode even when they are same-origin, so Chrome sends
       ComfyField's Origin. ComfyUI only accepts its own origin; without this rewrite every
       module import is answered with 403 and the editor stays at MODULE ERROR. */
    if (origin) headers.origin = origin;
    // The registered worker does not authenticate ComfyField sessions. Never
    // disclose any application cookie or authorization header to extensions.
    delete headers.cookie;
    delete headers.authorization;
    return headers;
  }

  app.get("/comfyfield-theme.css", async (_request, reply) =>
    reply.type("text/css; charset=utf-8").header("Cache-Control", "no-cache").send(await themeCss()));

  /* ComfyUI's frontend asks for a user stylesheet that often does not exist. Forwarded
     through the proxy it arrives with a non-CSS content type (or a 404 body), and the
     browser refuses to apply it — console errors and no custom theme. Answer both the
     root and the userdata path here: the upstream stylesheet when it really is CSS,
     otherwise an empty sheet. */
  const sendUserCss = (upstreamPath: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new HttpError(400, "Unknown workspace");
    await member(pool, request, workspaceId);
    const origin = (await pool.query("SELECT origin FROM workers WHERE workspace_id=$1 AND enabled=true AND kind='local' ORDER BY (COALESCE(inventory->>'online','false')='true') DESC,name,id LIMIT 1", [workspaceId])).rows[0]?.origin as string | undefined;
    let css = "";
    if (origin) {
      try {
        const response = await fetch(`${origin}${upstreamPath}`, { signal: AbortSignal.timeout(10_000) });
        const type = response.headers.get("content-type") ?? "";
        if (response.ok && (/text\/css/i.test(type) || !type)) css = await response.text();
      } catch { /* treat as no user stylesheet */ }
    }
    return reply.type("text/css; charset=utf-8").header("Cache-Control", "no-store").send(css);
  };
  app.get("/comfy/:workspaceId/user.css", sendUserCss("/user.css"));
  app.get("/comfy/:workspaceId/api/userdata/user.css", sendUserCss("/api/userdata/user.css"));

  app.get("/comfyfield-node-help.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-cache").send(await readFile(NODE_HELP, "utf8")));
  app.get("/comfyfield-3d.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-cache").send(await readFile(THREE_D, "utf8")));
  app.get("/comfyfield-feature.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-cache").send(await readFile(FEATURE, "utf8")));

  /* The graph a ComfyField feature runs in this workspace (an edited revision when one is in use), for opening it in the
     editor. Creators of the workspace only; it returns the workflow graph and nothing else. */
  app.get("/comfyfield-feature-graph/:workspaceId/:capabilityId", async (request, reply) => {
    const { workspaceId, capabilityId } = request.params as { workspaceId: string; capabilityId: string };
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(capabilityId)) throw new HttpError(400, "Unknown feature");
    await member(pool, request, workspaceId, "creator");
    const bundle = (await loadWorkspaceCatalogue(pool, await loadServerCatalogue(), workspaceId)).find((item) => item.manifest.id === capabilityId);
    if (!bundle?.template) throw new HttpError(404, "Unknown feature");
    // An editor workflow with every link in place, built from what this worker's nodes look like.
    const info = await (await fetch(`${await workerFor(workspaceId)}/object_info`, { signal: AbortSignal.timeout(30_000) })).json() as ObjectInfo;
    let workflow;
    try { workflow = apiToUi(bundle.template, info); }
    catch (error) { throw new HttpError(422, `This feature cannot be opened on this worker: ${(error as Error).message}`); }
    return reply.header("Cache-Control", "no-store").send({ name: featureFileName(capabilityId), title: bundle.manifest.title, workflow });
  });

  /* "Go to nodes workflow": the graph a run submitted, opened as a copy in the editor. */
  await runGraphRoutes(app, pool);

  async function workerFor(workspaceId: string) {
    const row = (await pool.query(
      "SELECT origin FROM workers WHERE workspace_id=$1 AND enabled=true AND kind='local' ORDER BY (COALESCE(inventory->>'online','false')='true') DESC,name,id LIMIT 1",
      [workspaceId],
    )).rows[0] as { origin?: string } | undefined;
    if (!row?.origin) throw new HttpError(503, "No enabled ComfyUI worker is registered for this workspace");
    return row.origin;
  }

  async function indexPage(reply: FastifyReply, origin: string) {
    let html: string;
    try {
      const response = await fetch(`${origin}/`, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = await response.text();
    } catch {
      throw new HttpError(502, "The ComfyUI node editor is not reachable");
    }
    /* Theme extensions installed in ComfyUI (Precision UI, niutonian node styles) style the same
       elements with !important and stronger selectors, so the studio theme lost to them. Inside
       ComfyField only, they are switched off: Precision is scoped to an attribute on <html>, and
       the other sheets are disabled as they load. ComfyUI opened directly keeps them. */
    const quietOtherThemes = 'var r=document.documentElement;function q(){if(r.hasAttribute("data-precision-ui"))r.removeAttribute("data-precision-ui");for(var i=0;i<document.styleSheets.length;i++){var s=document.styleSheets[i],n=s.ownerNode,k=((n&&n.id)||"")+(s.href||"");if(/niutonian|precision/i.test(k)&&!s.disabled)s.disabled=true}}q();new MutationObserver(q).observe(r,{attributes:true,attributeFilter:["data-precision-ui"]});new MutationObserver(q).observe(document.head,{childList:true});document.addEventListener("load",q,true);';
    const inject = `<link rel="stylesheet" href="/comfyfield-theme.css"><script type="module" src="/comfyfield-node-help.js"></script><script type="module" src="/comfyfield-3d.js"></script><script type="module" src="/comfyfield-feature.js"></script><script type="module" src="/comfyfield-run.js"></script><script>document.documentElement.classList.add("dark-theme");document.documentElement.dataset.comfyfield="1";${quietOtherThemes}</script>`;
    return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", `frame-ancestors 'self' ${appOrigin}; base-uri 'self'; object-src 'none'`)
      .send(html.replace("</head>", `${inject}</head>`));
  }

  const wsOptions:ClientOptions & {rewriteRequestHeaders:(headers:IncomingHttpHeaders,request:FastifyRequest)=>IncomingHttpHeaders}={
    rewriteRequestHeaders(_headers,request){return {origin:(request as ComfyRequest).comfyOrigin};},
  };
  await app.register(proxy, {
    prefix: "/comfy/:workspaceId",
    rewritePrefix: "/",
    // Empty upstream makes both HTTP and WebSocket use getUpstream below.
    // A fixed fallback would silently route another workspace to the first worker.
    upstream: "",
    websocket: true,
    preHandler(request, reply, done) {
      void (async () => {
        try {
          const path = (request.raw.url ?? "").split("?", 1)[0];
          const match = WORKSPACE_PATH.exec(path);
          const workspaceId = match?.[1];
          if (!workspaceId) throw new HttpError(401, "Open the node editor from a workspace");
          const root = path === `/comfy/${workspaceId}` || path === `/comfy/${workspaceId}/` || path === `/comfy/${workspaceId}/index.html`;
          await member(pool, request, workspaceId, "creator");
          if (request.headers.upgrade?.toLowerCase() === "websocket" && request.headers.origin !== publicOrigin)
            throw new HttpError(403, "WebSocket origin is not allowed");
          const origin = await workerFor(workspaceId);
          (request as ComfyRequest).comfyWorkspaceId = workspaceId;
          (request as ComfyRequest).comfyOrigin = origin;
          if (root) {
            /* The page uses relative asset paths. Without the trailing slash the browser
               resolves them one level too high, so the bare workspace URL redirects first. */
            if (path === `/comfy/${workspaceId}`) return reply.redirect(`/comfy/${workspaceId}/`);
            await indexPage(reply, origin);
            return;
          }
          done();
        } catch (error) {
          if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
          return reply.code(502).send({ error: "The ComfyUI node editor is not reachable" });
        }
      })();
    },
    replyOptions: {
      getUpstream(request) {
        const origin=(request as ComfyRequest).comfyOrigin;
        if(!origin)throw new HttpError(503,"No authorized workspace worker");
        return origin;
      },
      rewriteRequestHeaders(request, headers) {
        return forwardHeaders(headers, (request as ComfyRequest).comfyOrigin);
      },
      rewriteHeaders(headers) {
        delete headers["set-cookie"];
        return {...headers,"x-content-type-options":"nosniff"};
      },
    },
    wsClientOptions: wsOptions,
  });

  /* Absolute extension imports retain their workspace through a canonical redirect.
     No global fallback worker or mutable shared workspace cookie: two editor tabs
     must never switch each other's upstream. The redirected module URL also gives
     its subsequent imports a workspace-qualified Referer. */
  const redirectImport=async(request:FastifyRequest,reply:FastifyReply)=>{
      let referring:URL;
      try{referring=new URL(request.headers.referer??"");}catch{throw new HttpError(403,"Open extensions from the workspace node editor");}
      const workspaceId=referring.origin===publicOrigin?WORKSPACE_PATH.exec(referring.pathname)?.[1]:undefined;
      if(!workspaceId)throw new HttpError(403,"Open extensions from the workspace node editor");
      await member(pool,request,workspaceId,"creator");
      return reply.redirect(`/comfy/${workspaceId}${request.raw.url}`);
  };
  for (const prefix of ["/extensions", "/scripts"]) {
    app.route({method:["GET","HEAD"],url:`${prefix}/*`,handler:redirectImport});
    app.route({method:["GET","HEAD"],url:prefix,handler:redirectImport});
  }
}
