/** The image-conditioned sibling used when a text shot has an approved still. */
export function storyboardImageSibling(id: string): string | undefined {
  if (id === "h3-t2v") return "h3-i2v";
  return id.endsWith("-t2v") ? id.slice(0, -4) : undefined;
}
