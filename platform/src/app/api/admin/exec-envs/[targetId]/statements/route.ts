export const dynamic = "force-dynamic";
// GET /api/admin/exec-envs/[targetId]/statements?auditId=<ulid> —— 关联回查(50 SPEC v3.25 §2.1 / §3.2;bgp-admin)。
//
// 为什么必须有这个端点:跨法域 execute 的区域审计行在**提交之前**写(「写不成即拒」的前提),行内不可能有 statementId;
// 关联靠 Redshift 语句的 `StatementName == auditId`。但 Data API 的 ListStatements / DescribeStatement 按**调用者 IAM 身份**隔离
// (DescribeStatement 甚至不回 StatementName)⇒ 只有语句 owner(平台 TaskRole)看得到这层关联。没有本端点,合同里的关联就是
// 「谁也观测不到」的空话;审计方 / 验收从这里按 auditId 反查,不必假借 TaskRole。
// 🔴 只回 id / 状态 / 时间戳,**不回 SQL**(原文只在区域审计表;中央路径不碰原文)。home target ⇒ 空列表(home 不设 StatementName)。
import { NextRequest, NextResponse } from "next/server";
import { ListStatementsCommand } from "@aws-sdk/client-redshift-data";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isCrossJurisdiction, jurisdictionOf } from "@/lib/exec-env/residency";
import { requireTargetRegion } from "@/lib/exec-env/residency-store";
import { redshiftDataClientFor } from "@/lib/exec-env/target-clients";
import { isValidTargetId } from "@/lib/exec-env/target-id";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface StatementView {
  id: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function GET(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  const auditId = (req.nextUrl.searchParams.get("auditId") || "").trim();
  if (!ULID_RE.test(auditId)) {
    return apiError("auditId 必须是 26 位 ULID(区域审计行 / 直查响应 audit 映射里的 auditId)", 400, { code: "VALIDATION_FAILED" });
  }
  const t = await getTargetRaw(params.targetId);
  if (!t) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
  const statements: StatementView[] = [];
  if (isCrossJurisdiction(t)) {
    try {
      const client = redshiftDataClientFor(requireTargetRegion(t));
      let nextToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        // StatementName 是前缀匹配 ⇒ 结果再按全等过滤;RoleLevel=true 覆盖本角色的全部会话(ECS 多任务实例)
        const r = await client.send(new ListStatementsCommand({ StatementName: auditId, RoleLevel: true, Status: "ALL", MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) }));
        for (const s of r.Statements ?? []) {
          if (s.StatementName === auditId && s.Id) {
            statements.push({
              id: s.Id,
              status: String(s.Status ?? "UNKNOWN"),
              ...(s.CreatedAt ? { createdAt: new Date(s.CreatedAt).toISOString() } : {}),
              ...(s.UpdatedAt ? { updatedAt: new Date(s.UpdatedAt).toISOString() } : {}),
            });
          }
        }
        nextToken = r.NextToken;
        if (!nextToken) break;
      }
    } catch (e) {
      return apiError(`反查语句失败:${String((e as Error)?.message ?? e)}`, 503, { code: "UPSTREAM_ERROR" });
    }
  }
  return apiOk({ targetId: params.targetId, jurisdiction: jurisdictionOf(t), auditId, statements });
}
