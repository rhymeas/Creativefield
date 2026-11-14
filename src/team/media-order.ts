/** Keep newest media first, including when older pages are loaded. */
export function newestMediaFirst<T extends {created_at:string;id:string}>(items:readonly T[]):T[]{
  return [...items].sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
}
