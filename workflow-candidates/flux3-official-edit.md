# Official FLUX 3 Klein edit candidate

Adapted from the [ComfyUI workflow template](https://github.com/Comfy-Org/workflow_templates/blob/c067929d7e9cc0f3fd15be348fa1a1d85da15946/templates/image_flux3_klein_distilled_image_edit.json); the MIT license is in `flux3-official-edit.LICENSE.txt`. Model weights have separate licensing and are not included. This candidate is not registered or used by CreativeField.

The frontend template was converted to ComfyUI API form. The frontend-only comparison and unconnected preview were removed; bounding boxes and the example prompt were cleared. The prompt switch was reversed so `true` means use the prompt upsampler, matching the existing CreativeField control.

Proposed bindings: source image `11.image`, prompt `49.prompt`, megapixels `17.resolution.megapixels`, steps `7.steps`, seed `7.seed` (also bind `47.sampling_mode.seed` for repeatable upsampling), and prompt upsampler `51.switch`. These bindings are not connected to a manifest or UI yet.

ComfyUI core prompt validation accepted this API graph on CPU with an existing image fixture and the locally installed model names. No image was generated. Before replacing any existing workflow, verify actual output, seed and prompt behavior, image dimensions, and compatibility of each existing edit, angles, relight and text-to-image route. Preserve the upstream license notice when distributing an adaptation.
