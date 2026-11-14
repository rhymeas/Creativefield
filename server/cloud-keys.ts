/* A visitor's own Comfy Cloud key. The key lives in that person's browser; every request from it
   carries the key in one header, and the server keeps it in memory only, for the workspace it came
   with, so runs that are still working can poll and download. Nothing here writes it to the
   database, a file or a log, and a restart forgets it until the browser's next request. The key
   from the environment (COMFY_CLOUD_API_KEY) stays the fallback for a server with its own key. */

import {comfyCloudKey} from "./config";

/** The header a browser sends its own key in. */
export const CLOUD_KEY_HEADER = "x-comfy-cloud-key";

const browserKeys = new Map<string, string>();

/** A key as Comfy hands it out: one token, no spaces, of a sane length. */
export function plausibleCloudKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 512 && !/\s/.test(value);
}

export function rememberBrowserCloudKey(workspaceId: string, key: string) { browserKeys.set(workspaceId, key); }
export function forgetBrowserCloudKey(workspaceId: string) { browserKeys.delete(workspaceId); }
export function browserCloudKey(workspaceId: string | undefined): string | undefined {
  return workspaceId ? browserKeys.get(workspaceId) : undefined;
}

/** A hosted try-out (GUEST_PER_BROWSER=1) never lends the server's own key to a guest. */
export const guestsOnly = () => process.env.GUEST_PER_BROWSER === "1";

/** A Router run that uses the visitor's browser key, not a stored provider credential, is pinned to revision 0 of this id. */
export const BROWSER_KEY_CONNECTION = "00000000-0000-0000-0000-000000000000";

/** On a hosted try-out a signed-in guest's own key also runs Comfy Router models, which bill the same Comfy credits. */
export function guestRouterKey(workspaceId: string | undefined): string | undefined {
  return guestsOnly() ? browserCloudKey(workspaceId) : undefined;
}

/** The key a workspace's cloud worker uses: the visitor's own, else (not on a hosted try-out) the server's. */
export function cloudKeyFor(workspaceId: string | undefined): string | undefined {
  return browserCloudKey(workspaceId) ?? (guestsOnly() ? undefined : comfyCloudKey());
}
