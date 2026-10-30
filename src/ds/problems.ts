export type ProblemEntry = { key: string; priority: number; consequence: boolean };

/** Keep distinct causes first. Consequences only stand alone when no cause is present. */
export function selectProblems(entries: ProblemEntry[]): number[] {
  const roots = entries.some(entry => !entry.consequence);
  const candidates = entries.map((entry, index) => ({ ...entry, index }))
    .filter(entry => !roots || !entry.consequence)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
  const seen = new Set<string>();
  return candidates.filter(entry => {
    const key = entry.key.trim().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(entry => entry.index);
}
