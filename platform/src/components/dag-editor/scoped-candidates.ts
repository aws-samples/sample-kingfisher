// 工作流页面上「按这条工作流的执行区取候选清单」的唯一作者。
//   节点面板(关联同步任务 / 离线作业 / EMR 作业)与「下游依赖」下拉(运行成功后触发的同步任务 / 工作流)都用它:
//   四条读接口(/api/sync · /api/etl-jobs · /api/engines/emr-serverless · /api/workflow)只认 URL `?scope=`,**不带 = 「全部」视角**(readScope 的正常态)——
//   2026-11-03 勘查:下游依赖下拉裸 fetch("/api/sync") / fetch("/api/workflow") 就是全部视角 ⇒ 列出**所有区**的同步任务 / 工作流,与节点面板(按落点过滤)口径不一致,
//   用户能把别的区的任务挂成这条工作流的下游。
//   读失败要抛给调用方显示原话(红字),不许静默回空。

/**
 * 按工作流的执行区取候选:每个区各取一次 `?scope=<tid>`,工作流绑多个区时只留**每个区都绑了**的
 * (发布期判定是「绑定含工作流的每个落点」,面板只列发得出去的)。
 */
export async function fetchScoped(base: string, targets: string[], idOf: (x: any) => string): Promise<any[]> {
  const lists = await Promise.all(
    targets.map(async (tid) => {
      const res = await fetch(`${base}?scope=${encodeURIComponent(tid)}`);
      const d = await res.json().catch(() => null);
      if (!res.ok || d?.success === false) throw new Error(d?.error?.message || `HTTP ${res.status}`);
      return (Array.isArray(d) ? d : d?.data || []) as any[];
    })
  );
  const [first, ...rest] = lists;
  return (first || []).filter((x) => rest.every((l) => l.some((y) => idOf(y) === idOf(x))));
}

/** 工作流记录上的执行区(行上的章 `targets[]`;无章的存量工作流 = 主控区),与发布期落点一致性判定同一口径。 */
export function workflowTargetsOf(workflow: { targets?: unknown; targetId?: unknown } | null | undefined, targetOfStamp: (v: unknown) => string): string[] {
  const targets = Array.isArray(workflow?.targets) ? workflow!.targets : [];
  return targets.length ? targets.map((x: unknown) => String(x)) : [targetOfStamp(workflow?.targetId)];
}
