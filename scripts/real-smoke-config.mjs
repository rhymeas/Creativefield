// Configure the shipped image graph from its manifest rather than node IDs.
export function configureImageSmoke(graph, manifest) {
  const values = {prompt: 'smoke test: a red cabin beside a frozen lake, photographic', seed: 20261018, aspect_ratio: '1:1 (Square)', megapixels: 1, improve_prompt: false};
  for (const [id, value] of Object.entries(values)) {
    const control = manifest.controls?.find((entry) => entry.id === id);
    if (!control?.binding) throw new Error(`Image smoke: missing ${id} binding`);
    for (const binding of [control.binding, ...(control.alsoBindings ?? [])]) {
      const inputs = graph[binding.node]?.inputs;
      if (!inputs || !Object.hasOwn(inputs, binding.field)) throw new Error(`Image smoke: missing ${id} graph input`);
      inputs[binding.field] = value;
    }
  }
  return graph;
}
