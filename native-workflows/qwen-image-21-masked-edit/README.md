# Qwen Image 2.1 masked canvas edit

This adapts the existing `qwen-image-21-edit` graph and uses the installed
`KleinEditComposite` node to align the generated edit and composite it into
the original crop using the editor's actual white-edit selection mask. The
generated image is resized to the original crop dimensions before alignment.
No new model is introduced. The Qwen model and encoder licenses and the
existing worker scheduling rules remain applicable.

The alignment node is an external dependency, not vendored here. The locally
inspected revision is `1505bc58d38abf5411457804ed4923e83f986eee` from
https://github.com/supermansundies/comfyui-klein-edit-composite; its source
license and redistribution status require independent review.

The graph has a structural regression test. A local run from FotoField with a
rectangle selection replaced a cat with a pumpkin; all 1,944 pixels outside
the exact editor mask in the workflow crop remained byte-for-byte unchanged.
Edge quality still depends on the image, the selection, and model output.
