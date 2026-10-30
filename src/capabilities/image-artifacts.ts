import type { ApiGraph } from "../workflow/build";

export type ImageArtifactRole = "image" | "layer" | "mask";
export type ImageArtifactParentRole = "source" | "mask" | "layer" | "reference";
export type ImageArtifactAlphaPolicy = "allow" | "require" | "forbid";

export type ImageArtifactDeclarationV1 = {
  /** Stable manifest-local identity. Artifact batches retain this declaration order. */
  id: string;
  /** Capability output port populated by this declaration. */
  outputPort: string;
  /** A reviewed SaveImage node in the API graph. */
  node: string;
  /** SaveImage's IMAGE output index. Core SaveImage exposes index zero. */
  nodeOutput: 0;
  role: ImageArtifactRole;
  contentType: "image/png";
  cardinality: { min: number; max: number };
  indexing: { strategy: "history_array"; start: 0 };
  dimensions: {
    mode: "bounded" | "match_input";
    inputPort?: string;
    maxWidth: number;
    maxHeight: number;
    maxPixels: number;
  };
  maxBytes: number;
  alpha: ImageArtifactAlphaPolicy;
  /** Ordered semantic lineage. This is independent of the compatibility parent_id. */
  parents: Array<{ order: number; inputPort: string; role: ImageArtifactParentRole }>;
};

/**
 * A manifest contract for one or more PNG artifacts emitted by reviewed SaveImage nodes.
 * It intentionally does not share a discriminator with video outputContract/mediaContract.
 */
export type ImageArtifactsContractV1 = {
  kind: "image_artifacts_v1";
  schemaVersion: 1;
  maxArtifacts: number;
  artifacts: ImageArtifactDeclarationV1[];
};

type PortLike = { id: string; type: string; required: boolean };
type ManifestLike = { inputs: PortLike[]; outputs: PortLike[] };

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const POSITIVE_INT = (value: number) => Number.isSafeInteger(value) && value > 0;
const isSafeId = (value: unknown): value is string => typeof value === "string" && SAFE_ID.test(value);

/** Runtime validation for trusted image-artifact declarations in versioned manifests. */
export function validateImageArtifacts(
  contract: ImageArtifactsContractV1,
  manifest: ManifestLike,
  template: ApiGraph | undefined,
): string[] {
  const errors: string[] = [];
  if (!contract || contract.kind !== "image_artifacts_v1" || contract.schemaVersion !== 1) {
    return ["Invalid image artifact contract identity or schema version"];
  }
  if (!POSITIVE_INT(contract.maxArtifacts) || contract.maxArtifacts > 32) {
    errors.push("Invalid image artifact batch limit");
  }
  if (!Array.isArray(contract.artifacts) || contract.artifacts.length === 0) {
    errors.push("Image artifact contract has no declarations");
    return errors;
  }

  const ids = new Set<string>();
  const outputPorts = new Set<string>();
  const nodeOutputs = new Set<string>();
  let maximumBatch = 0;

  for (const candidate of contract.artifacts as unknown[]) {
    if (!candidate || typeof candidate !== "object") {
      errors.push("Invalid image artifact declaration");
      continue;
    }
    const artifact = candidate as ImageArtifactDeclarationV1;
    const label = artifact?.id || "<unknown>";
    if (!isSafeId(artifact.id) || ids.has(artifact.id)) {
      errors.push(`Invalid or duplicate image artifact id: ${label}`);
    }
    ids.add(artifact.id);

    if (!isSafeId(artifact.outputPort) || outputPorts.has(artifact.outputPort)) {
      errors.push(`Invalid or duplicate image artifact output port: ${artifact.outputPort}`);
    }
    outputPorts.add(artifact.outputPort);
    const output = manifest.outputs.find(port => port.id === artifact.outputPort);
    if (!(["image", "layer", "mask"] as string[]).includes(artifact.role)
      || !output || !output.required || output.type !== artifact.role) {
      errors.push(`Image artifact ${label} does not match a required ${artifact.role} output port`);
    }

    if (!isSafeId(artifact.node) || artifact.nodeOutput !== 0) {
      errors.push(`Invalid image artifact node reference: ${label}`);
    }
    const nodeOutput = `${artifact.node}:${artifact.nodeOutput}`;
    if (nodeOutputs.has(nodeOutput)) errors.push(`Duplicate image artifact node output: ${nodeOutput}`);
    nodeOutputs.add(nodeOutput);
    if (!template || template[artifact.node]?.class_type !== "SaveImage") {
      errors.push(`Image artifact ${label} must reference a SaveImage node`);
    }

    if (artifact.contentType !== "image/png") errors.push(`Image artifact ${label} must declare image/png`);
    if (!POSITIVE_INT(artifact.cardinality?.min) || !POSITIVE_INT(artifact.cardinality?.max)
      || artifact.cardinality.min > artifact.cardinality.max || artifact.cardinality.max > 32) {
      errors.push(`Invalid image artifact cardinality: ${label}`);
    } else {
      maximumBatch += artifact.cardinality.max;
    }
    if (artifact.indexing?.strategy !== "history_array" || artifact.indexing.start !== 0) {
      errors.push(`Invalid image artifact indexing: ${label}`);
    }
    if (!POSITIVE_INT(artifact.maxBytes) || artifact.maxBytes > 256 * 1024 * 1024) {
      errors.push(`Invalid image artifact byte limit: ${label}`);
    }
    if (!artifact.dimensions || !["bounded", "match_input"].includes(artifact.dimensions.mode)
      || !POSITIVE_INT(artifact.dimensions.maxWidth) || !POSITIVE_INT(artifact.dimensions.maxHeight)
      || !POSITIVE_INT(artifact.dimensions.maxPixels)
      || artifact.dimensions.maxWidth > 32768 || artifact.dimensions.maxHeight > 32768
      || artifact.dimensions.maxPixels > 268435456
      || artifact.dimensions.maxPixels > artifact.dimensions.maxWidth * artifact.dimensions.maxHeight) {
      errors.push(`Invalid image artifact dimension policy: ${label}`);
    }
    if (artifact.dimensions?.mode === "match_input") {
      const input = manifest.inputs.find(port => port.id === artifact.dimensions.inputPort);
      if (!input || !input.required || !["image", "layer", "reference"].includes(input.type)) {
        errors.push(`Image artifact ${label} has an invalid dimension source input`);
      }
    } else if (artifact.dimensions?.inputPort !== undefined) {
      errors.push(`Bounded image artifact ${label} cannot declare a dimension source input`);
    }
    if (!(["allow", "require", "forbid"] as string[]).includes(artifact.alpha)) {
      errors.push(`Invalid image artifact alpha policy: ${label}`);
    }

    const parentPorts = new Set<string>();
    if (!Array.isArray(artifact.parents)) {
      errors.push(`Invalid image artifact parents: ${label}`);
      continue;
    }
    for (let index = 0; index < artifact.parents.length; index += 1) {
      const parent = artifact.parents[index];
      const input = manifest.inputs.find(port => port.id === parent?.inputPort);
      if (!parent || parent.order !== index || !isSafeId(parent.inputPort) || parentPorts.has(parent.inputPort)) {
        errors.push(`Invalid image artifact parent order or input: ${label}`);
        continue;
      }
      parentPorts.add(parent.inputPort);
      if (!(["source", "mask", "layer", "reference"] as string[]).includes(parent.role)) {
        errors.push(`Invalid image artifact parent role: ${label}`);
        continue;
      }
      const typeMatches = parent.role === "mask" ? input?.type === "mask"
        : parent.role === "layer" ? input?.type === "layer"
          : parent.role === "reference" ? input?.type === "reference" || input?.type === "image"
            : input?.type === "image" || input?.type === "layer" || input?.type === "reference";
      if (!input || !input.required || !typeMatches) {
        errors.push(`Image artifact ${label} parent ${parent.inputPort} does not match role ${parent.role}`);
      }
    }
  }

  if (maximumBatch > contract.maxArtifacts) errors.push("Image artifact declarations exceed the batch limit");
  return errors;
}
