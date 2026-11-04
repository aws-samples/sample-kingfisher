// 序 41 B-118 —— 同步任务「启动 / 停止」入口与状态文案的唯一判别(列表页与详情页共用;零服务端 import)。
//
// 【缺陷原形(2026-10-23 …9435 页面驱动段 wp24 首跑抓到)】DMS 通道「启动」后平台行是 `provisioning`(复制任务在建,分钟级),
//   列表与详情都只对 `status === "running"` 显示「停止」⇒ 这几分钟里用户**没有任何停止入口**,同一条链接显示的仍是「启动」,
//   再点一次 = 再发 start-realtime;状态格还显示英文裸值 `provisioning`。服务端的 /stop 本就支持这一态(复制任务还在 creating
//   时回 409 TEARDOWN_IN_PROGRESS 可重试)—— 缺的只是页面入口。
export const SYNC_STOPPABLE_STATUSES: readonly string[] = ["running", "provisioning"];

/** 行上该显示「停止」(true)还是「启动」(false)。 */
export function syncTaskCanStop(status: string | undefined | null): boolean {
  return SYNC_STOPPABLE_STATUSES.includes(String(status ?? ""));
}

/** 「启动 / 停止」要打的路由尾段:可停 ⇒ stop;DMS 通道的启动走 start-realtime;其余 start。 */
export function syncToggleAction(status: string | undefined | null, channel: string | undefined | null): "stop" | "start" | "start-realtime" {
  if (syncTaskCanStop(status)) return "stop";
  return channel === "dms" ? "start-realtime" : "start";
}

/** 列表状态格文案(含 provisioning「启动中」;没有的状态由调用方原样显示)。 */
export const SYNC_STATUS_META: Record<string, { color: string; text: string }> = {
  draft: { color: "default", text: "草稿" },
  provisioning: { color: "processing", text: "启动中" },
  running: { color: "processing", text: "运行中" },
  succeeded: { color: "success", text: "成功" },
  stopped: { color: "warning", text: "已停止" },
  error: { color: "error", text: "异常" },
  failed: { color: "error", text: "失败" },
};
