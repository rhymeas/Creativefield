# Try-out on Railway (no GPU)

This puts the app, its database and FotoField online so anyone can open it in a browser. **Railway has no GPU**, so generating
(pictures, video, 3D, AI edits) does not run there. Everything that is editing, browsing and organising does: the interface, All
tools, the Library, FotoField (layers, masks, selections, brushes, crop, download), the model pages and the settings. To
generate, connect a ComfyUI worker later under *Team settings → Workers* (a Runpod pod, a Comfy Cloud key of a plan that allows
API use, or your own machine).

## Steps (about ten minutes)

1. In Railway: **New Project → Deploy from GitHub repo** and choose this repository. Railway finds `Dockerfile` and `railway.json`.
2. Add the database: **New → Database → PostgreSQL**.
3. In the app service, **Variables**: `DATABASE_URL` as a reference `${{Postgres.DATABASE_URL}}`. Then choose one:
   - **Open:** set `OPEN_ACCESS=1`. Every visitor is signed in automatically to one shared demo workspace, no account needed. Anyone can upload, change
     settings and delete in it, so use it for a short demo and redeploy or reset the volume afterwards.
   - **With a sign-in wall:** leave `OPEN_ACCESS` unset and set `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` (a long password you choose, at least 12
     characters) and give the guest those details.
4. **Volumes:** add a volume to the app service mounted at `/data` (uploads and generated files, plus the generated `master.key`).
5. **Settings → Networking → Generate domain.** On the first start the service fills the Library with the example pictures and clips
   (and, with the sign-in wall, creates the guest account first). Open the domain.

## Notes

- Worker addresses that point inside the host (localhost, private ranges, `*.railway.internal`, cloud metadata) are refused (`COMFYFIELD_PUBLIC_TRYOUT=1`, set in the Dockerfile), so a visitor cannot make the server reach your database or other services. New workers are refused altogether unless their origin is in `COMFYFIELD_WORKER_ALLOWLIST` (comma separated); to connect a GPU worker later, set that variable to its address first.
- The ComfyUI node editor listens on its own port and cannot be reached through one public domain; it stays unavailable here.
- With the sign-in wall, you can delete `BOOTSTRAP_PASSWORD` from the variables after the first start; the account stays.
