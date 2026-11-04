// @kf-batch 50-B09-carrier-drift
// B-09 呈现面的**唯一判别作者**:把接口回的 `carrierDrift` 映射成「这一行该显示什么」。
//
// 🔴🔴 为什么非得抽成一个函数、还得单测:这里有**五**种情况,而它们在界面上长得很像,
//   随手写在 render 里必然把其中两种混成一种,而混掉的那一种就是**假绿**:
//     ① `n/a`           —— 这一行压根没有载体(手动触发 / 待发布)⇒ 不谈「落后」,那是另一态;
//     ② `unchecked`     —— 有载体,但这次**没查**(没带 `?withDrift=1`,或只查到一半)
//                          🔴 绝不许显示成「最新」。本仓的教训原话:「没查」与「查了=最新」必须能区分;
//     ③ `ok`            —— 真比过,且逐字节一致;
//     ④ `stale`         —— 真比过,不一致 ⇒ 用户有明确动作可做(重新发布);
//     ⑤ `indeterminate` —— 查了但**判不了**(missing / unknown / unsupported)⇒ 如实说判不了。
//
// 🔴 ② 里那半句「或只查到一半」是本函数最容易被写漏的一条:一行绑了两个区,接口只回了
//   其中一个区的结果时,`Object.values(...).every(ok)` 会**通过** —— 于是没查的那个区被
//   另一个区的绿标顺带放行了。这与本仓记过的「字符窗口跨行,拿邻居的『成功』给自己放行」
//   是同一个错误形态,所以这里改成**按 armed 的每一个区逐个要答案**。

/** 一行的载体产物:`deployments[targetId].workflowArn` 在才算真有载体(不看 `scheduleEnabled` 这个愿望字段)。 */
export interface CarrierDriftRow {
  deployments?: Record<string, { workflowArn?: string } | undefined> | null;
  carrierDrift?: Record<string, { state?: string; reason?: string } | undefined> | null;
}

export type CarrierDriftView =
  | { kind: "n/a" }
  | { kind: "unchecked"; armed: string[]; missingAnswerFor: string[] }
  | { kind: "ok"; armed: string[] }
  | { kind: "stale"; armed: string[]; staleTargets: string[]; states: Record<string, string> }
  | { kind: "indeterminate"; armed: string[]; states: Record<string, string>; reasons: string[] };

/** 「有载体」的定义:只认产物(`workflowArn`),与调度类型那一列同一个口径。 */
export function armedTargetsOf(row: CarrierDriftRow): string[] {
  const dep = row.deployments || {};
  return Object.keys(dep).filter((k) => Boolean(dep[k]?.workflowArn));
}

export function carrierDriftView(row: CarrierDriftRow): CarrierDriftView {
  const armed = armedTargetsOf(row);
  // ① 没有载体 ⇒ 「落后」这个问题不成立
  if (armed.length === 0) return { kind: "n/a" };

  const drift = row.carrierDrift || {};
  // ② 🔴 **逐个区**要答案:少一个区的答案就是「没查全」,不许让别的区替它绿
  const missingAnswerFor = armed.filter((t) => !drift[t]?.state);
  if (missingAnswerFor.length > 0) return { kind: "unchecked", armed, missingAnswerFor };

  const states: Record<string, string> = {};
  for (const t of armed) states[t] = String(drift[t]?.state);

  // ④ 有确定的坏消息就先报坏消息(用户有明确动作可做);完整状态一并带出去,不藏别的区
  const staleTargets = armed.filter((t) => states[t] === "stale");
  if (staleTargets.length > 0) return { kind: "stale", armed, staleTargets, states };

  // ③ 只有**每一个**区都真比过且一致,才允许说「最新」
  if (armed.every((t) => states[t] === "ok")) return { kind: "ok", armed };

  // ⑤ 其余(missing / unknown / unsupported)⇒ 如实说判不了
  const reasons = armed.map((t) => drift[t]?.reason).filter((x): x is string => Boolean(x));
  return { kind: "indeterminate", armed, states, reasons };
}
