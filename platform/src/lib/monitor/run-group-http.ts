// 「运行分组台账写不进去」→ HTTP 的**唯一映射处**(与 `lib/exec-env/target-http.ts` 同一手法)。
//
// 🔴 为什么必须单一作者:同族的分类缺陷 2026-09-13 一天修了三次(落点冲突报 500、抢不到运行锁报 500、
//    执行目标不能承接报 500)—— 每次都是「某一处的 catch 自己判了一遍」。判据 = 全仓扫描只许这里构造。
// 🔴 归类理由:组表是**平台自己的**台账,写不进去是平台侧故障(不是用户能修的东西)⇒ **503**;
//    与同一路由里 `audit-unavailable` 那条 503 同一口径:**运行未提交**,重试是有意义的。
import { NextResponse, type NextRequest } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";
import { apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { getResourceMeta, isResourceType } from "@/lib/versions/version-service";
import { getRunGroup, type RunGroupView, RunGroupWriteFailed } from "@/lib/monitor/run-groups";

export function runGroupWriteErrorResponse(e: unknown): NextResponse | null {
  if (!(e instanceof RunGroupWriteFailed)) return null;
  return apiError(
    `运行未提交(多区联动台账写不进去,${e.op}):${e.message}`,
    503,
    { code: "UPSTREAM_ERROR", detail: { reason: "run-group-ledger-unavailable", op: e.op } }
  );
}

const USER_ID = "default-user";

/**
 * 三条 `/api/run-groups/[id]/**` 路由共用的前置:**读组 → 找到它的定义行 → 走既有 RBAC 守卫**。
 *
 * 🔴 权限判据不许自己发明:组本身没有成员表,它的权限**完全等于它那个定义的权限**
 * ⇒ 一律回落到 `guardResourceAccess(定义行)`(把 by-id 路由统一成「按资源归属项目判」,这里沿用同一条)。
 * 🔴 定义行去哪张表读也不自己写 switch:用 `getResourceMeta(definitionKind)`(单一作者)。
 */
export async function loadRunGroupForRequest(
  req: NextRequest,
  runGroupId: string,
  role: "viewer" | "editor"
): Promise<{ view: RunGroupView; job: Record<string, unknown> } | NextResponse> {
  const view = await getRunGroup(runGroupId);
  if (!view) return apiError("该联动运行不存在", 404, { code: "NOT_FOUND" });
  const kind = view.group.definitionKind;
  if (!isResourceType(kind)) {
    return apiError(`组行的 definitionKind 非法:${String(kind)}`, 500, { code: "UPSTREAM_ERROR" });
  }
  const meta = getResourceMeta(kind);
  const { Item } = await docClient.send(
    new GetCommand({ TableName: meta.table, Key: { userId: USER_ID, [meta.sk]: view.group.definitionId } })
  );
  if (!Item) {
    return apiError(
      `这次联动运行所属的${meta.label}(${view.group.definitionId})已被删除 —— 运行历史仍在,但无法再对它做操作`,
      404,
      { code: "NOT_FOUND", detail: { reason: "definition-deleted" } }
    );
  }
  const guard = await guardResourceAccess(req, Item, role);
  if (guard instanceof NextResponse) return guard;
  return { view, job: Item as Record<string, unknown> };
}
