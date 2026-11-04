// /sync 列表自动刷新的两个事实(用户 2026-10-15:「数据同步页面增加定时刷新」)。
//
// 🔴 为什么是独立模块而不是写在 `app/sync/page.tsx` 里:Next.js 的 page 文件只许标准导出
//   (default / metadata / dynamic …),多 `export const` 一个常量 ⇒ `next build` 直接失败
//   「"SYNC_IN_FLIGHT_STATUSES" is not a valid Page export field」—— tsc 与 vitest 都看不见这一类,
//   2026-10-15 重部署 …7698 就是这么挂的。页面只 import,不 export;守卫在 `app/__tests__/next-file-exports-guard.test.ts`。

/** 非终态:列表里只要还有一条处于这些状态,就值得自动刷新(与状态筛选项同一组词汇,终态 succeeded / stopped / error / draft 不在内)。 */
export const SYNC_IN_FLIGHT_STATUSES = ["running", "starting", "stopping"] as const;
export const SYNC_AUTO_REFRESH_MS = 8000;

/** 列表里是否还有非终态任务(状态按字符串比对;undefined / 未知状态不算在跑)。 */
export function anySyncInFlight(rows: ReadonlyArray<{ status?: unknown }>): boolean {
  return rows.some((x) => (SYNC_IN_FLIGHT_STATUSES as readonly string[]).includes(String(x.status)));
}
