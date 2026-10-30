/**
 * A manifest contract for one aligned still-image source/mask input pair.
 * It declares geometry and semantic-role requirements only. Server admission
 * proves them from upload validation receipts (a decoded PNG's dimensions and
 * semantic role); pixel contents such as grayscale mask values are not proven.
 * It intentionally does not share a discriminator with the video contracts.
 */
export type ImageInputContractV1 = {
  kind: "aligned_still_image_mask_v1";
  schemaVersion: 1;
  sourceInput: string;
  maskInput: string;
  semantics: "white_edits_black_preserves";
  /** Both widths and both heights must be divisible by this value. */
  dimensionMultiple: number;
};

type PortLike = { id: string; type: string; required: boolean; representation?: string };
type ManifestLike = { inputs: PortLike[]; mediaContract?: unknown; outputContract?: unknown };

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const isSafeId = (value: unknown): value is string => typeof value === "string" && SAFE_ID.test(value);
const prefix = "Invalid aligned still image/mask contract";

/** Runtime validation for trusted aligned-image input declarations in versioned manifests. */
export function validateImageInputContract(contract: ImageInputContractV1, manifest: ManifestLike): string[] {
  if (!contract || typeof contract !== "object" || contract.kind !== "aligned_still_image_mask_v1" || contract.schemaVersion !== 1) {
    return [`${prefix} identity or schema version`];
  }
  const errors: string[] = [];
  if (contract.semantics !== "white_edits_black_preserves") errors.push(`${prefix} semantics`);
  if (!Number.isSafeInteger(contract.dimensionMultiple) || contract.dimensionMultiple < 1 || contract.dimensionMultiple > 64) {
    errors.push(`${prefix} dimension multiple`);
  }
  if (!isSafeId(contract.sourceInput) || !isSafeId(contract.maskInput) || contract.sourceInput === contract.maskInput) {
    errors.push(`${prefix} input references`);
    return errors;
  }
  const source = manifest.inputs.find(port => port.id === contract.sourceInput);
  if (!source || !source.required || source.type !== "image" || (source.representation !== undefined && source.representation !== "image")) {
    errors.push(`${prefix} source input must be a required still image port`);
  }
  const mask = manifest.inputs.find(port => port.id === contract.maskInput);
  if (!mask || !mask.required || mask.type !== "mask" || mask.representation !== "image") {
    errors.push(`${prefix} mask input must be a required image-represented mask port`);
  }
  if (manifest.mediaContract !== undefined || manifest.outputContract !== undefined) {
    errors.push(`${prefix} cannot be combined with video media/output contracts`);
  }
  return errors;
}
