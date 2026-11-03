type FeatureNode = { inputs?: Record<string, unknown> } & Record<string, unknown>;

export function parseFeature(search: string): string | null;
export function renumberGraph(graph: Record<string, FeatureNode>): {
  graph: Record<string, FeatureNode>;
  original: Record<string, string>;
};
export function workspaceFromPath(pathname: string): string | null;
export function loadedFeatureMatches(serialized: unknown, workflow: unknown): boolean;
export function loadFeatureGraph<T>(
  app: { graph: { serialize(): unknown }; loadGraphData(workflow: T, clean: boolean, restore: boolean, name: string): Promise<unknown> },
  workflow: T,
  name: string,
  pause?: (ms: number) => Promise<unknown>,
): Promise<void>;
export function showFeatureError<T extends { style: object; setAttribute(name: string, value: string): void; textContent?: string | null }>(
  doc: { createElement(tag: string): T; body: { append(node: T): void } },
  message: string,
): void;
