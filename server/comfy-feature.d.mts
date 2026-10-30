type FeatureNode = { inputs?: Record<string, unknown> } & Record<string, unknown>;

export function parseFeature(search: string): string | null;
export function renumberGraph(graph: Record<string, FeatureNode>): {
  graph: Record<string, FeatureNode>;
  original: Record<string, string>;
};
export function workspaceFromPath(pathname: string): string | null;
