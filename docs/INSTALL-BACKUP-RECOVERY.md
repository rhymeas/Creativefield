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


### Source release archive

`npm run package:release` packages only the files listed with matching SHA-256 hashes in a manually reviewed local release manifest. It refuses packaging without that manifest. Review source, media and metadata before preparing a public export. The resulting archive and checksum are written under the ignored `release/` directory.

### Run rendering on another worker

A compatible ComfyUI worker can run on another machine. Configure a reachable HTTP(S) origin and required nodes and models; provider and model terms still apply.

```bash
npm run worker:remote list
npm run worker:remote add "Remote worker" https://example.com
npm run worker:remote probe <workerId>
npm run worker:remote point https://example.com
```

Adding a worker keeps the existing worker; pointing changes the enabled worker and clears its inventory until it is probed again. Some workflows also support optional cloud routes. Check the selected route and worker before submitting inputs. See [OFFLOAD-GPU.md](OFFLOAD-GPU.md) for remote setup.

## 2. Backup

`npm run backup` refuses while the app is running, and says so in one sentence: *"The app still
answers on 127.0.0.1:8787. Stop it first (Ctrl+C in its terminal) so the database closes
cleanly."* Set `COMFYFIELD_DEBUG=1` to see the stack as well.

The embedded PostgreSQL build ships `initdb`, `pg_ctl` and `postgres` only - no
`pg_dump`, `pg_restore` or `psql`. Logical dumps are therefore unavailable. The
supported backup is a **cold, file-level copy** of the whole home while the app
is stopped. This is consistent because PostgreSQL is shut down cleanly; it is
not a hot backup and offers no point-in-time recovery.

1. Stop the app (`Ctrl+C`) and confirm its PostgreSQL instance has stopped.
   The backup command checks the app health endpoint, but that check alone does
   not establish that a separately running database has stopped.
2. Run:

   ```bash
   npm run backup                  # -> <project>/backups/comfyfield-backup-<UTC>/
   npm run backup -- --out /path/to/backups
   ```

3. The command copies `app.env`, `postgres/` and `storage/`, writes
   `manifest.json` (format version, timestamp, app version, per-entry file count
   and bytes) and verifies file counts and sizes against that manifest. A mismatch
   fails the command; this is not a full data-integrity check.

Manual equivalent, if Node is unavailable: stop the app and copy the complete
home folder with Explorer or `robocopy <home> <target> /E /COPY:DAT`. Keep
`app.env` and `postgres/` together in one copy.

Rules:

- Store the backup protected: it contains the database password and master key.
- Keep at least one copy outside the machine.
- A backup is only as good as its last restore test. `npm run restore -- <dir>`
  into a scratch home verifies readability without touching the live one.
- Do not edit `manifest.json`; restore validates entries and sizes against it.

### Backup and restore notes

Create a cold backup while the app and database are stopped. Preserve the matching `app.env`, database and storage together; losing the master key can make saved provider credentials unavailable. The launcher requests database shutdown on a normal exit. After an unexpected interruption, check the owning process before recovery. Backup and restore skip transient PostgreSQL runtime files.

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
| `npm start` stops: `app.env` missing but data exists | Secrets file lost or moved | Restore the matching `app.env` from backup; do not re-run setup over existing data |
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
