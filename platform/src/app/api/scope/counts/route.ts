export const dynamic = "force-dynamic";
// @kf-batch 50-WP4-o1-scope
// GET /api/scope/counts?resource=<kind> —— 护栏 1「永远不让用户丢东西」的数据源。
//
// 合同:SPEC v3.34 §2.6.6;交互 INTERACTION §9.3-1 与 §9.6 口径 3;判据 ACCEPTANCE E-151。
//
// 回答的问题:「我现在只看 us-west-2,别的执行范围里还有多少条?」
// ⇒ 返回**按 target 分的条数**(含 `tgt_home`),界面据此常驻一条淡提示 + 空态文案。
//
// 🔴 **不加缓存**:这个数字必须与列表页同一时刻一致,缓存会让 E-151 因「数字对不上」假红。
// 🔴 **不按 target 可见性过滤**:统计的是**本项目自己的行**,一行绑到哪个区就往那个 key 上计 1。
//    若按可见性裁剪,N 就与 DDB 对不上(而 E-151 正是拿 DDB 逐行核对的)—— 那才是真的「丢东西」。
// 🔴 **数仓直查 / 治理元数据类不进本接口**:它们的真值在各区数仓里,数一遍要唤醒每个区的
//    Serverless 数仓(点一下就花钱)。那些页面的护栏 1 改为「不给数字、只给切到全部入口」。

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, getActiveEnv } from "@/lib/projects/guard";
import { COUNTABLE_KINDS, KIND_INDEX, isCountableKind, listRowsForCount } from "@/lib/scope/resource-index";
import { countRowsByBinding, countRowsByScalar } from "@/lib/exec-env/scope";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  const resource = req.nextUrl.searchParams.get("resource") || "";
  if (!isCountableKind(resource)) {
    // 刻意报「不支持」而不是回空对象:空对象在界面上等于「别的区什么都没有」,
    // 而真相是「这个维度还没做」—— 两件事的处置完全不同(与 `/api/exec-targets` 同口径)。
    return apiError(
      `resource=${resource || "(空)"} 不支持;可用值:${COUNTABLE_KINDS.join(" / ")}` +
        `(数仓直查 / 治理元数据类不进本接口,理由见 50 SPEC §2.6.6)`,
      400,
      { code: "VALIDATION_FAILED" }
    );
  }

  try {
    const rows = await listRowsForCount(resource, { projectId: ctx.projectId, env: getActiveEnv(req) });
    const spec = KIND_INDEX[resource];
    const counts =
      spec.attribution === "binding"
        ? countRowsByBinding(rows, spec.bindingAttr)
        : countRowsByScalar(rows, spec.scalarKind!);
    return apiOk({
      resource,
      attribution: spec.attribution,
      counts,
      total: rows.length,
      // 🔴 一行可以绑多个区 ⇒ 各 key 之和可能**大于** total。界面别拿它们做等式断言。
      sumMayExceedTotal: spec.attribution === "binding",
    });
  } catch (e: unknown) {
    // 读失败**不许**回空计数:空计数在界面上等于「别的区没东西」,用户会以为自己没丢东西。
    return apiError(`统计执行范围条数失败:${(e as Error)?.message ?? String(e)}`, 502, {
      code: "UPSTREAM_ERROR",
    });
  }
}
