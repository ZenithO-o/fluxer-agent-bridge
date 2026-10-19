/** Thread tags as [{id, name}] from the thread's applied_tags and the forum's available_tags; [] when unknown. */
export function appliedTags(ch: any, parent: any): { id: string; name: string | null }[] {
  const ids: unknown[] = Array.isArray(ch?.applied_tags) ? ch.applied_tags : [];
  const avail: any[] = Array.isArray(parent?.available_tags) ? parent.available_tags : [];
  return ids.map((id) => ({ id: String(id), name: avail.find((t) => String(t.id) === String(id))?.name ?? null }));
}
