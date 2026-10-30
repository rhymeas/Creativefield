// Pure helpers for the fully automated local setup. No side effects here;
// scripts/setup-local.mjs and scripts/start-local.mjs do the actual work.

import { randomBytes } from "node:crypto";
import path from "node:path";

export const PG_PORT = 55433;
export const SERVER_PORT = 8787;
export const PG_DATABASE = "comfyfield";
export const PG_USER = "postgres";

export function resolveHomeDir(projectRoot, env = process.env) {
  if (env.COMFYFIELD_HOME) return path.resolve(env.COMFYFIELD_HOME);
  return path.join(projectRoot, ".comfyfield");
}

export function pgPort(env = process.env) {
  const port = Number(env.COMFYFIELD_PG_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : PG_PORT;
}

export function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

// The server requires MASTER_KEY to base64-decode to exactly 32 bytes
// (server/config.ts parseMasterKey).
export function generateMasterKey() {
  return randomBytes(32).toString("base64");
}

export function buildDatabaseUrl(password, port) {
  return `postgres://${PG_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${PG_DATABASE}`;
}

export function buildEnvContent({ databaseUrl, storageRoot, masterKey, serverPort = SERVER_PORT }) {
  return [
    `DATABASE_URL=${databaseUrl}`,
    `STORAGE_ROOT=${storageRoot}`,
    `MASTER_KEY=${masterKey}`,
    `PUBLIC_ORIGIN=http://127.0.0.1:${serverPort}`,
    "SERVE_UI=1",
    "UI_ROOT=dist",
    "LOCAL_SINGLE_USER=1",
    "",
  ].join("\n");
}

export function parseEnvContent(content) {
  const values = {};
  for (const line of String(content).split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function missingEnvKeys(content) {
  const values = parseEnvContent(content);
  return ["DATABASE_URL", "STORAGE_ROOT", "MASTER_KEY"].filter((key) => !values[key]);
}

// The official Comfy SDK 0.5.0 declares Node >=22.
export function requireSupportedNode(version=process.versions.node) {
  const major=Number(String(version).split(".")[0]);
  if(!Number.isInteger(major)||major<22)throw new Error("ComfyField requires Node.js 22 or later (official Comfy SDK requirement).");
}
