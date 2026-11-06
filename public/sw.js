/* A hosted guest's files stay in their own browser. Every picture, clip and sound the app asks for
   is answered from this browser's copy first; the first request stores it. Nothing here runs on a
   local install, which registers no worker. Cached by asset id, so a copy outlives the guest's
   server workspace. */
const CACHE = "creativefield-library-v1";
const CONTENT = /^\/api\/v1\/workspaces\/[^/]+\/assets\/([0-9a-f-]{36})\/content$/i;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const match = url.origin === self.location.origin && url.pathname.match(CONTENT);
  if (match) event.respondWith(serve(event.request, url, match[1].toLowerCase()));
});

async function serve(request, url, id) {
  const cache = await caches.open(CACHE), key = `/browser-library/file/${id}`;
  let stored = await cache.match(key);
  if (!stored) {
    /* Always the whole file: the Cache API refuses a partial answer, and a video asks in ranges. */
    const fresh = await fetch(url.pathname, { credentials: "same-origin" });
    if (!fresh.ok) return fresh;
    try { await cache.put(key, fresh.clone()); stored = await cache.match(key); } catch { return fresh; }
    if (!stored) return fresh;
  }
  const headers = new Headers(stored.headers);
  if (url.searchParams.has("download")) headers.set("Content-Disposition", (headers.get("Content-Disposition") ?? "attachment").replace(/^inline/, "attachment"));
  headers.set("Accept-Ranges", "bytes");
  const range = request.headers.get("range");
  if (!range) return new Response(stored.body, { status: 200, headers });
  const blob = await stored.blob(), size = blob.size, parts = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  const suffix = parts && !parts[1] && parts[2] ? Number(parts[2]) : 0;
  const start = parts ? (suffix ? Math.max(size - suffix, 0) : Number(parts[1] || 0)) : NaN;
  const end = parts && parts[1] && parts[2] ? Math.min(Number(parts[2]), size - 1) : size - 1;
  if (!(start <= end) || start >= size) { headers.set("Content-Range", `bytes */${size}`); headers.delete("Content-Length"); return new Response(null, { status: 416, headers }); }
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(blob.slice(start, end + 1), { status: 206, headers });
}
