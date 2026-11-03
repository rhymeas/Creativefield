import { describe, expect, test } from "vitest";
// @ts-expect-error plain-JS setup helpers ship with the downloadable package
import { requireSupportedNode, buildDatabaseUrl, buildEnvContent, generateMasterKey, generateSecret, missingEnvKeys, parseEnvContent, pgPort, resolveHomeDir } from "../scripts/local-setup-lib.mjs";

describe("automated local setup helpers", () => {
  test("rejects runtimes older than the installed official SDK requires",()=>{
    expect(()=>requireSupportedNode("20.19.0")).toThrow(/Node.js 22/);expect(()=>requireSupportedNode("invalid")).toThrow();expect(()=>requireSupportedNode("22.14.0")).not.toThrow();
  });
  test("builds a loopback-only database url with an encoded password", () => {
    expect(buildDatabaseUrl("p@ss word", 55433)).toBe("postgres://postgres:p%40ss%20word@127.0.0.1:55433/comfyfield");
  });

  test("env content carries every key the server needs and enables local mode", () => {
    const content = buildEnvContent({ databaseUrl: "postgres://x", storageRoot: (process.cwd() + "/public-fixtures/da3a1676"), masterKey: "abc" });
    expect(missingEnvKeys(content)).toEqual([]);
    const values = parseEnvContent(content);
    expect(values.LOCAL_SINGLE_USER).toBe("1");
    expect(values.SERVE_UI).toBe("1");
    expect(values.PUBLIC_ORIGIN).toBe("http://127.0.0.1:8787");
  });

  test("missing keys are reported so setup never writes a half config", () => {
    expect(missingEnvKeys("DATABASE_URL=postgres://x\n")).toEqual(["STORAGE_ROOT", "MASTER_KEY"]);
  });

  test("master key base64-decodes to exactly 32 bytes like the server requires", () => {
    expect(Buffer.from(generateMasterKey(), "base64").length).toBe(32);
  });

  test("secrets are unique hex strings", () => {
    const a = generateSecret(16);
    const b = generateSecret(16);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  test("home dir defaults under the project and the pg port is validated", () => {
    expect(resolveHomeDir((process.cwd() + "/public-fixtures/5702d917"), {})).toContain(".comfyfield");
    expect(resolveHomeDir((process.cwd() + "/public-fixtures/5702d917"), { COMFYFIELD_HOME: (process.cwd() + "/public-fixtures/cf-home") })).toContain("cf-home");
    expect(pgPort({})).toBe(55433);
    expect(pgPort({ COMFYFIELD_PG_PORT: "60000" })).toBe(60000);
    expect(pgPort({ COMFYFIELD_PG_PORT: "nope" })).toBe(55433);
  });
});
