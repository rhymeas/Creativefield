# Workflow loader

`loadServerCatalogue()` (`server/catalogue.ts`) is where the server learns which workflow
packs exist. It reads `pipelines/<pipeline>/<pack>/` and `native-workflows/<pack>/`, and
each folder must hold `manifest.json` and `template.api.json`.

A folder it cannot use is never dropped quietly:

- **Skipped, with a line in the server log.** A folder with no manifest and no template is
  named as skipped. A folder that holds a pack one level deeper and marks it
  `"comfyuiGraph": false` is skipped too, with the runtime it declares. The marketing pack
  is the shipped example: `Skipping native-workflows/marketing: static-ad-v1 is not a
  ComfyUI graph (runtime sharp-opentype)`. `server/marketing/service.ts` reads that pack
  directly, so it never needs a catalogue row.
- **Startup stops with a clear error.** Half a pack (`manifest.json` without
  `template.api.json`, or the other way round) stops startup. So does a pack that sits one
  folder too deep without `"comfyuiGraph": false`, because the loader would read its
  parent and the pack would be missing from every screen without anyone noticing.

`test/catalogue-loader.test.ts` covers both paths on throwaway folders, and checks that the
shipped tree still loads with the marketing pack named as skipped. `scripts/workflow-audit.mjs`
prints the same inventory from the command line, including the folders it skipped.
