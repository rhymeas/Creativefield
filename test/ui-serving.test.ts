import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { serveTeamUi } from "../server/ui";

describe("trusted production UI assets", () => {
  const scratchRoot = path.resolve((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/ui-serving");
  let app: FastifyInstance | undefined;
  let root: string | undefined;
  afterEach(async () => {
    await app?.close();
    if (root) {
      if (path.dirname(path.resolve(root)) !== scratchRoot) throw new Error("Unexpected test cleanup path");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves model-card reels with range requests without exposing other files", async () => {
    await mkdir(scratchRoot, { recursive: true });
    root = await mkdtemp(path.join(scratchRoot, "case-"));
    await mkdir(path.join(root, "assets"));
    await mkdir(path.join(root, "reels"));
    await writeFile(path.join(root, "index.html"), "<!doctype html><head></head><body>Studio</body>");
    await writeFile(path.join(root, "reels", "preview.mp4"), Buffer.from("0123456789"));
    await writeFile(path.join(root, "private-config.json"), '{"private":true}');
    app = Fastify();
    await serveTeamUi(app, root,"http://127.0.0.1:8788");
    const policy=(await app.inject("/")).headers["content-security-policy"];
    expect(policy).toContain("frame-src http://127.0.0.1:8788;");
    expect(policy).toContain("connect-src 'self';");
    const full = await app.inject("/reels/preview.mp4");
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toContain("video/mp4");
    expect(full.body).toBe("0123456789");
    const range = await app.inject({ url: "/reels/preview.mp4", headers: { range: "bytes=2-5" } });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe("2345");
    expect((await app.inject("/private-config.json")).statusCode).toBe(404);
    expect((await app.inject("/reels/%2e%2e/private-config.json")).statusCode).toBe(404);
  });
  it("loads rebuilt entry assets without restarting the API and recovers from an incomplete build", async () => {
    await mkdir(scratchRoot,{recursive:true});
    root=await mkdtemp(path.join(scratchRoot,"rebuild-"));
    await mkdir(path.join(root,"assets"));await mkdir(path.join(root,"reels"));
    const index=path.join(root,"index.html");
    await writeFile(index,'<html><head></head><body><script type="module" src="/assets/old.js"></script></body></html>');
    await writeFile(path.join(root,"assets","old.js"),"/* old entry */");
    app=Fastify();await serveTeamUi(app,root,"http://127.0.0.1:8788");
    const before=await app.inject("/");expect(before.body).toContain("/assets/old.js");expect(before.headers["cache-control"]).toBe("no-store");
    await rm(index);await rm(path.join(root,"assets","old.js"));
    const rebuilding=await app.inject("/");
    expect(rebuilding.statusCode).toBe(503);expect(rebuilding.headers["retry-after"]).toBe("1");expect(rebuilding.body).not.toContain("/assets/old.js");
    expect(rebuilding.headers["content-security-policy"]).toBe(before.headers["content-security-policy"]);
    await writeFile(index,'<html><head></head><body><script type="module" src="/assets/new.js"></script></body></html>');
    await writeFile(path.join(root,"assets","new.js"),"/* new entry */");
    const after=await app.inject("/");
    expect(after.statusCode).toBe(200);expect(after.body).toContain("/assets/new.js");expect(after.body).not.toContain("/assets/old.js");
    expect(after.body.match(/name="comfyfield-mode"/g)).toHaveLength(1);
    expect((await app.inject("/assets/new.js")).statusCode).toBe(200);expect((await app.inject("/assets/old.js")).statusCode).toBe(404);
    await writeFile(index,"<!doctype html>");expect((await app.inject("/")).statusCode).toBe(503);
  });
});
