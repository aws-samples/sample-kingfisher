// @kf-batch 50-SEQ47c-catalog-ddl —— 数据目录建表 / 改表四条路由共用的「错误 ⇒ HTTP」映射(单一作者;与 target-http / decommission-http 同款)。
import { apiError } from "@/lib/api-response";
import { CatalogDdlInvalid } from "./catalog-ddl";
import { AlterRejected, AlterDecisionRequired, AlterNothingToDo } from "@/lib/modeling/alter-service";
import { CatalogTypeUnsupported } from "@/lib/modeling/alter";
import { AdminDdlDenied } from "@/lib/exec-env/admin-ddl-executor";
import { residencyErrorResponse } from "@/lib/exec-env/residency-audit";
import { targetNotReadyResponse } from "@/lib/exec-env/target-http";
import { placeErrorResponse } from "@/lib/place/route";

export function catalogDdlErrorResponse(e: unknown): Response | null {
  if (e instanceof CatalogDdlInvalid || e instanceof CatalogTypeUnsupported || e instanceof AlterNothingToDo) return apiError(e.message, 400);
  if (e instanceof AlterRejected) return apiError(e.message, 400, { code: "ALTER_REJECTED", rejected: e.rejected } as never);
  if (e instanceof AlterDecisionRequired) {
    return apiError(e.message, 409, { code: "DECISION_REQUIRED", physicalTable: e.physicalTable, dropColumns: e.dropColumns } as never);
  }
  if (e instanceof AdminDdlDenied) return apiError(e.message, 403, { code: "RBAC_DENIED" } as never);
  const r = residencyErrorResponse(e);
  if (r) return r;
  const nr = targetNotReadyResponse(e);
  if (nr) return nr;
  const pr = placeErrorResponse(e);
  if (pr) return pr;
  const msg = String((e as Error)?.message ?? e);
  // 建模侧的入参校验是裸 Error(「非法数据类型」「缺少目标 schema」「不许落进项目私有 schema」…)⇒ 400,不冒 500
  if (/非法|不支持|缺少|不许|不能|至少需要|已有/.test(msg)) return apiError(msg, 400);
  return null;
}
