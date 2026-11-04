// @kf-batch 50-live-row
// 「选中项的状态必须从**刷新后的列表**派生,不许读自己那份陈旧副本」的唯一作者。
//
// 🔴 2026-09-19 无头验收抓到:`/etl-jobs` 点「发布到 MWAA 调度」成功(toast 出了、卡片上的
//   `⏱ cron` 也变了),但同一页右侧面板里的「触发一次调度 / 下线调度」**始终不出现** ——
//   因为发布后只 `fetchJobs()` 刷新了列表,而面板读的是 `sel`(选中时拷的一份快照)。
//   于是**同一个作业的同一个事实**在同一屏上有两个说法,用户以为没发成功。
//   EMR 面板(`job={selEmr}`)是同一个形状的第二处。
//
// 🔴 为什么不是「发布后顺手 setSel 一下」:那是给每个写操作都加一次「记得同步副本」的义务,
//   漏一个就复发(本仓的元 bug:机制建好了只是那条路径没接)。改成**派生**:副本只用来记
//   「选中了谁 / 编辑器里正在改什么」,而**状态一律现查**。这样新增写操作不必再记得同步。
export function liveRowOf<T extends Record<string, any>>(
  list: readonly T[] | null | undefined,
  picked: T | null | undefined,
  idKey: keyof T
): T | null {
  if (!picked) return null;
  const id = picked[idKey];
  if (id === undefined || id === null || id === "") return picked;
  const found = (list ?? []).find((x) => x && x[idKey] === id);
  return (found as T | undefined) ?? picked;
}
