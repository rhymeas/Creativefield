# Using a remote ComfyUI worker

Register a worker in **Settings > Workers** and probe it before selecting it in a workspace. A successful connection alone does not confirm that the models or custom nodes required by a workflow are installed.

Install ComfyUI and the specific models and nodes declared by the workflow manifests in `native-workflows/` and `pipelines/`. Model weights are not included in this repository. For sources and terms, see [the license inventory](LICENSE-INVENTORY.md) and the individual workflow manifests.

Remote workers receive the media and prompts submitted to them. Check their access controls, model licenses and service charges before use.
