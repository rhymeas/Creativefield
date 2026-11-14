import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/* On a public try-out the shared guest is an administrator, and a worker address makes the server send requests.
   COMFYFIELD_PUBLIC_TRYOUT=1 therefore refuses addresses that lead inside the host: loopback, private ranges,
   link-local (cloud metadata), carrier-grade NAT and internal names. The name is resolved here and checked again
   right before a probe, so a name that later points inward is stopped as well (a tiny window remains between check and request). */
export const publicTryout = (env: NodeJS.ProcessEnv = process.env) => env.COMFYFIELD_PUBLIC_TRYOUT === "1";

const blocked = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) blocked.addSubnet(net, prefix, "ipv4");
/* IPv6: loopback, unspecified, the IPv4-compatible and IPv4-mapped blocks (whatever form they are written in), NAT64, 6to4, unique-local, link-local, multicast. */
for (const [net, prefix] of [["::", 96], ["64:ff9b::", 96], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(net, prefix, "ipv6");

export function isInternalAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(a);
  return family === 0 ? true : blocked.check(a, family === 4 ? "ipv4" : "ipv6"); // not an address: refuse
}

export function isInternalName(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || !h.includes(".") && isIP(h) === 0 || /\.(internal|local|localhost|lan|home|corp)$/.test(h);
}

/** Throws when the host is, or resolves to, an address inside the deployment. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) { if (isInternalAddress(host)) throw new Error("This address is inside the host and not allowed on a public try-out"); return; }
  if (isInternalName(host)) throw new Error("This name is inside the host and not allowed on a public try-out");
  const answers = await lookup(host, { all: true });
  if (!answers.length || answers.some((answer) => isInternalAddress(answer.address))) throw new Error("This name resolves to an address inside the host and is not allowed on a public try-out");
}

/** The only worker origins a public try-out accepts: COMFYFIELD_WORKER_ALLOWLIST, comma separated. Empty means none. */
export function allowedWorkerOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.COMFYFIELD_WORKER_ALLOWLIST ?? "").split(",").map((v) => v.trim()).filter(Boolean).map((v) => { try { return new URL(v).origin; } catch { return ""; } }).filter(Boolean);
}
