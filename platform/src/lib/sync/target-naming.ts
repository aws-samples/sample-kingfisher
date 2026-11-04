// SYNC-07 — target table name mapping.
//
// By default a source table syncs to a target of the same name. A task may customize this
// with a uniform prefix/suffix and/or an explicit per-table override. Resolution order:
//   1. explicit override  (task.targetTableNames[source])
//   2. `${prefix}${source}${suffix}`
//   3. source name unchanged

export interface TargetNamingConfig {
  targetTablePrefix?: string;
  targetTableSuffix?: string;
  targetTableNames?: Record<string, string>;
}

export function resolveTargetTableName(source: string, task: TargetNamingConfig | undefined | null): string {
  if (!task) return source;
  const override = task.targetTableNames?.[source];
  if (override && override.trim()) return override.trim();
  const prefix = task.targetTablePrefix || "";
  const suffix = task.targetTableSuffix || "";
  return `${prefix}${source}${suffix}`;
}

// Build a { source -> target } map for a list of source tables.
export function buildTargetNameMap(sources: string[], task: TargetNamingConfig | undefined | null): Record<string, string> {
  const map: Record<string, string> = {};
  for (const s of sources) map[s] = resolveTargetTableName(s, task);
  return map;
}
