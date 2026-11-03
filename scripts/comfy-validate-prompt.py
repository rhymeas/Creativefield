"""Validate ComfyUI API graphs on CPU without submitting or executing them.

Run with the Python environment belonging to COMFY_ROOT. JSON on stdin is a
list of {id, prompt} objects. Results are emitted as JSON on stdout; ComfyUI
startup messages go to stderr. Custom nodes are enabled unless explicitly
disabled, because a successful core-only check cannot verify custom workflows.
"""
import argparse
import asyncio
import contextlib
import json
import os
import re
import sys
from pathlib import Path


# ComfyUI has legacy directory aliases in addition to canonical category names.
# Keep this restricted to model categories: a model root must never add code to
# the custom node search path.
MODEL_DIRECTORIES = {
    "checkpoints": ("checkpoints",), "loras": ("loras",), "vae": ("vae",),
    "text_encoders": ("text_encoders", "clip"),
    "diffusion_models": ("diffusion_models", "unet"),
    "clip_vision": ("clip_vision",), "controlnet": ("controlnet", "t2i_adapter"),
    "upscale_models": ("upscale_models",), "latent_upscale_models": ("latent_upscale_models",),
    "style_models": ("style_models",), "embeddings": ("embeddings",),
    "diffusers": ("diffusers",), "vae_approx": ("vae_approx",), "gligen": ("gligen",),
    "hypernetworks": ("hypernetworks",), "photomaker": ("photomaker",),
    "classifiers": ("classifiers",), "model_patches": ("model_patches",),
    "audio_encoders": ("audio_encoders",), "background_removal": ("background_removal",),
    "frame_interpolation": ("frame_interpolation",), "geometry_estimation": ("geometry_estimation",),
    "optical_flow": ("optical_flow",), "detection": ("detection",),
}


def add_model_directories(folder_paths, model_root):
    for category, names in MODEL_DIRECTORIES.items():
        if category not in folder_paths.folder_names_and_paths:
            continue
        for name in names:
            directory = model_root / name
            if directory.is_dir():
                folder_paths.add_model_folder_path(category, str(directory))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-root", required=True)
    parser.add_argument("--no-custom-nodes", action="store_true")
    parser.add_argument("--input-directory")
    parser.add_argument("--base-directory")
    parser.add_argument("--models-directory", action="append", default=[])
    parser.add_argument("--partner-schema", action="append", default=[])
    options = parser.parse_args()
    root = Path(options.comfy_root).resolve()
    if not (root / "execution.py").is_file():
        parser.error("--comfy-root must contain execution.py")
    graphs = json.load(sys.stdin)
    if not isinstance(graphs, list):
        parser.error("stdin must contain a list of graphs")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    sys.path.insert(0, str(root))
    sys.argv = [str(root / "main.py"), "--cpu", "--disable-assets", "--offline"]
    if options.base_directory:
        sys.argv.extend(["--base-directory", options.base_directory])
    if options.no_custom_nodes:
        sys.argv.append("--disable-all-custom-nodes")
    with contextlib.redirect_stdout(sys.stderr):
        print("Loading ComfyUI on CPU...", file=sys.stderr, flush=True)
        import comfy.options
        comfy.options.enable_args_parsing()
        import nodes
        import execution
        if options.input_directory or options.models_directory:
            import folder_paths
        if options.input_directory:
            input_directory = Path(options.input_directory).resolve()
            if not input_directory.is_dir():
                parser.error("--input-directory must be an existing directory")
            folder_paths.set_input_directory(str(input_directory))
        for model_directory in options.models_directory:
            model_root = Path(model_directory).resolve()
            if not model_root.is_dir():
                parser.error("--models-directory must be an existing directory")
            add_model_directories(folder_paths, model_root)

        async def validate():
            # ComfyUI extensions register routes and node replacements against
            # this instance. Construct it without starting an HTTP listener.
            import server
            from app.assets.manager import default_asset_manager
            server.PromptServer(asyncio.get_running_loop(), default_asset_manager())
            print("Initializing ComfyUI nodes...", file=sys.stderr, flush=True)
            failures = []
            original_load = nodes.load_custom_node

            async def tracked_load(module_path, *args, **kwargs):
                loaded = await original_load(module_path, *args, **kwargs)
                if not loaded:
                    failures.append(str(module_path))
                return loaded

            nodes.load_custom_node = tracked_load
            try:
                builtin_failures = await nodes.init_extra_nodes(init_custom_nodes=not options.no_custom_nodes, init_api_nodes=False)
                # Register explicitly selected partner schemas for local graph
                # validation only. No prompt is submitted or node executed.
                for name in options.partner_schema:
                    if not re.fullmatch(r"nodes_[a-z0-9_]+\.py", name):
                        raise ValueError(f"Invalid partner schema name: {name}")
                    schema = root / "comfy_api_nodes" / name
                    if not schema.is_file():
                        raise ValueError(f"Partner schema not found: {name}")
                    await nodes.load_custom_node(str(schema), module_parent="comfy_api_nodes")
            finally:
                nodes.load_custom_node = original_load
            for name in builtin_failures or []:
                if not any(Path(path).name == name for path in failures):
                    failures.append(str(name))
            print("Validating graphs...", file=sys.stderr, flush=True)
            results = []
            for item in graphs:
                try:
                    valid, error, outputs, node_errors = await execution.validate_prompt(
                        str(item["id"]), item["prompt"], None
                    )
                    results.append({"id": item["id"], "valid": valid, "error": error,
                                    "outputs": outputs, "node_errors": node_errors})
                except Exception as error:
                    results.append({"id": item.get("id"), "valid": False,
                                    "error": {"message": str(error)}})
            return {"node_import_failures": failures, "results": results}

        report = asyncio.run(validate())
    json.dump(report, sys.stdout)
    sys.stdout.write("\n")
    if any(not result["valid"] for result in report["results"]):
        return 1
    return 2 if report["node_import_failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
