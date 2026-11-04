// 信任策略解析(纯函数,候选分组与预检共用)。

/** 信任策略(IAM 回的是 URL 编码 JSON)是否允许 `service` 承担:Effect Allow · Action 含 sts:AssumeRole(或 sts:*)· Principal.Service 含它。 */
export function trustsService(assumeRolePolicyDocument: string | undefined, service: string): boolean {
  if (!assumeRolePolicyDocument) return false;
  let doc: unknown;
  try {
    doc = JSON.parse(decodeURIComponent(assumeRolePolicyDocument));
  } catch {
    try { doc = JSON.parse(assumeRolePolicyDocument); } catch { return false; }
  }
  const statements = ([] as unknown[]).concat((doc as { Statement?: unknown })?.Statement ?? []);
  for (const st of statements) {
    const s = st as { Effect?: unknown; Action?: unknown; Principal?: { Service?: unknown } };
    if (s.Effect !== "Allow") continue;
    const actions = ([] as unknown[]).concat(s.Action ?? []).map(String);
    if (!actions.some((a) => a === "sts:AssumeRole" || a === "sts:*" || a === "*")) continue;
    const svc = ([] as unknown[]).concat(s.Principal?.Service ?? []).map(String);
    if (svc.includes(service)) return true;
  }
  return false;
}
