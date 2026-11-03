import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

// The audit must list every pack and stay green when ComfyUI is down: a stopped
// server is not a broken pack, so readiness reads unknown and the exit code is 0.
// A cloud pack has no local route to probe, so it reads n/a and its transport says
// where the run goes instead: Comfy Cloud.
const CLOUD_PACKS = ["cloud-h3-character-swap", "cloud-kling-omni-edit", "cloud-seedance2-reference"];

function audit() {
  const stdout = execFileSync(process.execPath, ["scripts/workflow-audit.mjs"], {
    encoding: "utf8",
    env: { ...process.env, COMFY_URL: "http://127.0.0.1:9" },
  });
  const lines = stdout.trimEnd().split(/\r?\n/);
  const header = lines.findIndex(line => line.startsWith("id "));
  const table: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (!line.trim()) break;
    table.push(line);
  }
  return { stdout, rows: table.map(line => line.split(/\s{2,}/)) };
}

describe("workflow audit", () => {
  it("lists every pack with its readiness", () => {
    const { stdout, rows } = audit();
    expect(rows.length).toBeGreaterThanOrEqual(30);
    expect(stdout).toMatch(/\d+ packs: \d+ ready, \d+ not ready, \d+ unknown, \d+ without a local route/);
    expect(Number(/(\d+) packs:/.exec(stdout)?.[1])).toBe(rows.length);
    const cloud = rows.filter(row => CLOUD_PACKS.includes(row[0]));
    const local = rows.filter(row => !CLOUD_PACKS.includes(row[0]));
    expect(cloud.map(row => row[0]).sort()).toEqual([...CLOUD_PACKS].sort());
    expect(local.length).toBeGreaterThanOrEqual(30);
    for (const row of local) {
      expect(row).toHaveLength(6);
      expect(row[0]).not.toBe("");
      expect(row[1]).toMatch(/^(native-workflows|pipelines)\//);
      expect(row[2]).not.toBe("");
      expect(row[3]).toMatch(/^local/);
      expect(row[5]).toBe("unknown: ComfyUI is down");
    }
    for (const row of cloud) {
      expect(row).toHaveLength(6);
      expect(row[1]).toBe(`native-workflows/${row[0]}`);
      expect(row[2]).not.toBe("");
      expect(row[3]).toBe("comfy_cloud");
      expect(row[5]).toBe("n/a: no local route");
    }
    expect(Number(/(\d+) without a local route/.exec(stdout)?.[1])).toBe(cloud.length);
  });

  it("gives every pack one id", () => {
    const { rows } = audit();
    const ids = rows.map(row => row[0]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("chatterbox-tts");
    expect(ids).toContain("wan22-ti2v-5b-t2v");
  });
});
