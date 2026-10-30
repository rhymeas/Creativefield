export type SwapCheckRecord = {
  source: string;
  reference: string;
  result: string;
  label: string;
  run: string;
};

export type SwapCheckScope = {
  workspaceId: string;
  projectId: string;
  createdAt?: string;
};

/** Machine-readable receipt for the human review shown in the Swap check dialog. */
export function swapCheckProvenance(record: SwapCheckRecord, scope: SwapCheckScope) {
  return {
    schemaVersion: 1,
    kind: "comfyfield-swap-check",
    createdAt: scope.createdAt ?? new Date().toISOString(),
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    label: record.label,
    runId: record.run,
    assets: {
      source: record.source,
      reference: record.reference,
      result: record.result,
    },
    review: "Human comparison of source, reference and result for identity, pose, scale and lighting. This is not an identity score.",
  };
}

export function swapCheckProvenanceName(run: string) {
  return `swap-check-${run}.json`;
}
