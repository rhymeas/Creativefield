# Install, backup and recovery

Applies to the self-hosted single-user app started with `npm start`. The app is
the same codebase as the development studio; only the local download package
uses the embedded PostgreSQL path described here.

## 1. Install

Requirements: Windows 10/11 x64, Node.js 22+ (the official Comfy SDK requires
it) and free ports `55433` (PostgreSQL) and `8787` (app). No admin rights, no
separate PostgreSQL, no ComfyUI needed to open the app.

```bash
npm start
```

The first run installs dependencies, downloads the embedded PostgreSQL build,
initialises a cluster, writes secrets, builds the UI, starts both processes,
waits for `/api/v1/health` and opens http://127.0.0.1:8787. Later runs skip the
setup work. `Ctrl+C` stops server and database. The same steps can be run
separately: `npm install`, then `npm run setup`, then `npm start`.

Environment switches:

| Variable | Effect |
|---|---|
| `COMFYFIELD_HOME` | Data directory. Default: `<project>/.comfyfield` |
| `COMFYFIELD_PG_PORT` | PostgreSQL port. Default: `55433` |
| `COMFYFIELD_NO_BROWSER=1` | Do not open a browser on start |
| `PORT` | App port for `npm run server`. The one-command `npm start` always serves `127.0.0.1:8787` |
| `COMFYFIELD_IDLE_UNLOAD_MINUTES` | Minutes a worker may sit idle before its models unload. Default `5`; accepts `1`–`1440`. Raise it to keep models warm through a recording session |
| `COMFYFIELD_MIN_FREE_RAM_SHARE` | Share of system RAM that must stay free before a run starts. Default `0.15`; accepts `0.02`–`0.95` |
| `COMFYFIELD_MODEL_ROOT` | Your ComfyUI `models` folder. The app reads it for the model inventory and the licence checks; without it those checks report `WARN` |

### What the home directory holds

| Path | Content | Secret? |
|---|---|---|
| `app.env` | `DATABASE_URL`, `STORAGE_ROOT`, `MASTER_KEY`, `PUBLIC_ORIGIN` (the address you open, port included) | **Yes** - database password and master key |
| `postgres/` | Live PostgreSQL cluster (embedded build) | Contains all app data |
| `storage/` | Uploaded and generated media | User content |

`app.env` holds these keys (seven on a default install): `DATABASE_URL`,
`STORAGE_ROOT`, `MASTER_KEY`, `PUBLIC_ORIGIN`, `SERVE_UI`, `UI_ROOT` and
`LOCAL_SINGLE_USER`. Add `COMFYFIELD_MODEL_ROOT` as an eighth key: set it to the
`models` folder of your ComfyUI install (for example
`/path/to/ComfyUI/models`); the doctor and the model inventory read it from there. Leave the
rest as the setup wrote them unless you move the data directory or serve the app on a
different origin.

`app.env` is the only copy of the database password and master key. Deleting it
while `postgres/` exists makes the data unreadable; setup then stops with
instructions instead of overwriting anything. Back it up together with the
cluster, never separately.

### Verify the installation

Run the preflight from the project root:

```bash
npm run doctor
```

It checks Node 22+, the repository license and license inventory, installed
dependencies, the built UI, `app.env` keys (values are never printed), the model
root and asset storage, PostgreSQL, ComfyUI and the app server. A failing required
repository check exits non-zero. Missing services or model folders are
reported as `WARN` with the next command, so the same check works before the
first start and after `npm start`.


Verified on 2026-10-24: `npm run package:release` produced
`release/comfyfield-0.1.0-<timestamp>.tar.gz` with **870 files, 24 MB** and a printed
SHA-256. The archive holds `LICENSE`, `README.md`, `package.json`, `.env.example`,
`docs/` (93 files), `scripts/` (40) and `fixtures/` (26, the openly licensed test media),
and it leaves out `.comfyfield/`, `node_modules/` and `dist/` — so it contains no
database, no generated media and no secrets. `release/` is gitignored.
### Source release archive

Create a reproducible source archive from the current worktree:

```bash
npm run package:release
```

It writes `release/comfyfield-<version>-<UTC timestamp>.tar.gz` and a sibling
`.sha256` file. The archive contains tracked and non-ignored source files:
license, setup docs, native workflow manifests/templates, server, UI and scripts.
It excludes `node_modules/`, `dist/`, `.comfyfield/`, `release/`, renders,
screenshots, model weights and secret-looking files such as `app.env`, `.env`,
keys and certificates. Extract it, then run `npm install`, `npm run doctor`,
`npm start`. This is packaging, not a rehearsal on a fresh machine.

### Run the rendering somewhere else

The local 64 GB machine is the binding constraint here, not the GPU: the free-RAM gate holds
runs at about 9.6 GB free whatever the 3090/4090 is doing. You can move execution to a
ComfyUI that runs elsewhere — a rented GPU, another workstation, a colleague's box.

Nothing in the app assumes a local worker: a worker is just an HTTP(S) origin, and the free-
RAM check reads **that** worker's own `system_stats`. So offloading removes the local limit.

```bash
npm run worker:remote list
npm run worker:remote add "Rented 4090" https://<pod>-8188.proxy.runpod.net
npm run worker:remote probe <workerId>
npm run worker:remote point https://<pod>-8188.proxy.runpod.net   # repoint the default worker
```

`add` keeps the local worker beside the remote one, so both show in each panel's **Worker**
row and you choose per run. `point` rewrites the enabled worker and clears its inventory so
the app probes the new origin before trusting readiness.

**Freeing the worker by hand.** `npm run worker:remote free` asks the worker to unload its
models and prints the resulting free RAM. It refuses while the queue is busy, for the same
reason the app does: freeing a worker mid-job would kill the job. On this machine it returned
HTTP 200 and the free RAM stayed at **4 of 69 GB**, which is the honest result — the pressure
here is other software, not ComfyUI's loaded models.
**The full list for the remote box** — base image, third-party packs and all 34 model files, generated from the manifests — is in [OFFLOAD-GPU.md](OFFLOAD-GPU.md).

**Choosing it in the app.** Each panel has a **Worker** row that opens a dialog listing every
worker with its state — observed here with three rows: *Precision QA worker · Offline · The
selected execution service is not reachable*, *Local ComfyUI · Ready*, *Rented GPU · Ready*.
So picking where a run executes is one click, and a worker that cannot run the capability shows
Offline or asks you to choose rather than failing the run.
**What the remote box must have** — the same ComfyUI version, the same custom nodes (SCAIL-2,
SAM 3.1, Wan Animate, VACE, the Klein helpers) and the same model files, or the capability
shows `install_required` / `download_required` instead of ready. The app tells you which:
`npm run worker:remote probe` prints every capability that is not ready and why.

**What stays local** — the app, PostgreSQL, the library and FFmpeg assembly (trims, storyboard
assembly, exports). Those are light; the heavy model work is what leaves.

**Comfy Cloud / hosted APIs** are a different matter: the code only registers `local_comfy`
execution, and the policy refuses hosted execution on those routes.

## 2. Backup

`npm run backup` refuses while the app is running, and says so in one sentence: *"The app still
answers on 127.0.0.1:8787. Stop it first (Ctrl+C in its terminal) so the database closes
cleanly."* Set `COMFYFIELD_DEBUG=1` to see the stack as well.

The embedded PostgreSQL build ships `initdb`, `pg_ctl` and `postgres` only - no
`pg_dump`, `pg_restore` or `psql`. Logical dumps are therefore unavailable. The
supported backup is a **cold, file-level copy** of the whole home while the app
is stopped. This is consistent because PostgreSQL is shut down cleanly; it is
not a hot backup and offers no point-in-time recovery.

1. Stop the app (`Ctrl+C`). `npm run backup` refuses to run while
   `http://127.0.0.1:8787/api/v1/health` still answers.
2. Run:

   ```bash
   npm run backup                  # -> <project>/backups/comfyfield-backup-<UTC>/
   npm run backup -- --out /path/to/backups
   ```

3. The command copies `app.env`, `postgres/` and `storage/`, writes
   `manifest.json` (format version, timestamp, app version, per-entry file count
   and bytes) and verifies the copy against that manifest. A mismatch fails the
   command instead of leaving a silent partial backup.

Manual equivalent, if Node is unavailable: stop the app and copy the complete
home folder with Explorer or `robocopy <home> <target> /E /COPY:DAT`. Keep
`app.env` and `postgres/` together in one copy.

Rules:

- Store the backup protected: it contains the database password and master key.
- Keep at least one copy outside the machine.
- A backup is only as good as its last restore test. `npm run restore -- <dir>`
  into a scratch home verifies readability without touching the live one.
- Do not edit `manifest.json`; restore validates entries and sizes against it.

Verified on 2026-10-24 end to end: with the app stopped, `npm run backup` wrote
`backups/comfyfield-backup-2026-10-25T12-56-09Z` — **549 MB, 2273 files** — and the app
started again five seconds later with its data intact (assets listed, screens render).

While the app is running the command refuses politely instead of copying a live
cluster: *"The app still answers on 127.0.0.1:8787. Stop it first (Ctrl+C in its
terminal) so the database closes cleanly."* That refusal is the correct behaviour, and
it prints a warning that the folder contains `app.env` (database password and master
key) and must be stored protected.

### A restore used to produce a home that could not start (fixed 2026-10-24)

Restoring the backup into a *different* home failed with
*"PostgreSQL cluster ownership does not match this launcher."* The cause was a runtime
file: `postgres/postmaster.pid` travelled inside the backup and names the **old data
directory** and port, so the launcher read it, saw another path and refused.

Both halves are now verified: a fresh backup taken after the fix contains **no**
`postmaster.pid`, `postmaster.opts` or `launcher.log` (2272 files instead of 2273), and
restoring the older backup that still carried the pid file also starts. The backup test
suite passes (5 tests).
`scripts/local-backup-lib.mjs` now skips the PostgreSQL runtime files
(`postmaster.pid`, `postmaster.opts`, `launcher.log`) **both when writing a backup and
when restoring one**, so an existing backup taken before the fix also restores
correctly.

Verified end to end: the backup restored into `.comfyfield-restore-test`, its cluster
recovered and accepted connections, and `npm start` served that copy with real data —
3 assets (first `product-mug-white.jpg`), 53 catalogue manifests and 17 storyboards.
One environment note for anyone repeating this: the launcher starts PostgreSQL
detached, so stopping the app leaves the old postmaster holding port 55433; stop it
with `pg_ctl -D <home>/postgres -m fast stop` before starting a restored copy on the
same port.

The backup folder's own `manifest.json` records `formatVersion`, `createdAt`,
`appVersion`, `sourceServerPort` and the size of each entry: `app.env` 375 B,
`postgres/` 77 MB over 1621 files, `storage/` 499 MB over 651 files.

## 3. Restore

Stop the app first.

```bash
npm run restore -- <backup-dir>          # target home must be empty or absent
npm run restore -- <backup-dir> --force  # replace the existing home content
```

Restore validates the manifest and each entry's size before copying, then copies
`app.env`, `postgres/` and `storage/` into `COMFYFIELD_HOME` (default
`<project>/.comfyfield`). Afterwards run `npm start`.

Typical cases:

- **New machine:** install the package, copy the backup folder over, run
  `npm run restore -- <backup-dir>`, then `npm start`. Keep the same app version
  where possible; migrations run forward automatically on start.
- **Same machine, data damaged:** move the broken home aside (do not delete it
  before the restore worked), restore, start, verify a project and a video.
- **Rollback after a failed upgrade:** stop, restore the backup taken before the
  upgrade, start the previous app version. Database migrations are forward-only;
  an older app may refuse a newer schema, so restore is the supported rollback.

## 4. Recovery playbook

| Symptom | Cause | Action |
|---|---|---|
| `npm start` stops: `app.env` missing but data exists | Secrets file lost or moved | Restore `app.env` from backup. Without a backup the cluster cannot be decrypted; do not re-run setup over it |
| PostgreSQL will not start, `postmaster.pid` remains | Unclean shutdown or crash | Check that no `postgres.exe` runs, then restore the last cold backup. Removing `postmaster.pid` manually is not a supported repair for a damaged cluster |
| Database starts but migrations fail | Interrupted upgrade or corrupted schema | Stop, keep the home for diagnosis, restore the pre-upgrade backup |
| Media missing in the app | `storage/` deleted or moved | Restore `storage/` from backup; database rows alone do not contain media |
| Port `55433` or `8787` already in use | Another instance or service | Stop the other process; or choose other ports before the first setup: `COMFYFIELD_PG_PORT` for the database, and `PORT` only when you run `npm run server` yourself |
| App opens but shows an empty workspace | Wrong `COMFYFIELD_HOME` | Compare the configured home with the folder that holds the data |

## 5. Upgrade procedure

1. Stop the app.
2. `npm run backup`.
3. Replace the app files, keep the home folder (default `.comfyfield/`).
4. `npm start`; wait for the health check and migrations.
5. Open a project, a video and the Library. If anything is wrong, restore the
   backup from step 2 and return to the previous app version.

## 6. Limits

- No logical dump, no `pg_dump`/`pg_restore`, no point-in-time recovery.
- No hot backup; copying a running cluster is unsupported and can be corrupt.
- No selective restore: the command restores a complete backup, not single
  projects or assets.
- The backup does not include model files, ComfyUI, the generated `dist/` or
  `node_modules/`; those are rebuilt or reinstalled.
