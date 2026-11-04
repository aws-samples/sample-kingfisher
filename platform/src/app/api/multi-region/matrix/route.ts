export const dynamic = "force-dynamic";
// @kf-batch 50-P50.3-matrix
// **版本一致性矩阵**的读接口(50 INTERACTION §3.1 + §3.1a)。
//
// 客户痛点原话「怕操作漏掉某个 region 导致数据对不上」—— 这张看板就是那句话的正面回应。
//
// 🔴 **viewer 就能看**:一致性看板是"运维要不要管"的信息,锁在管理员手里等于没人看
//    (与 `/api/exec-targets` 同一条判据:呈现端点不该要管理员)。
// 🔴 **读失败绝不回空矩阵**:空矩阵在界面上等于"一切正常",那是这张看板最不能犯的错
//    (假绿)。所以任何异常都回 502 + 原因,由界面显示"算不出来",而不是显示"没问题"。

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { buildConsistencyMatrix, attentionTasks } from "@/lib/exec-env/consistency-matrix";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const m = await buildConsistencyMatrix(ctx.projectId);
    return apiOk({ ...m, attention: attentionTasks(m) });
  } catch (e: unknown) {
    return apiError(
      `算不出版本一致性矩阵:${(e as Error)?.message}。` +
        `🔴 这里刻意不回空矩阵 —— 空矩阵在界面上等于"一切正常",而真相是"算不出来"。`,
      502,
      { code: "UPSTREAM_ERROR" }
    );
  }
}
