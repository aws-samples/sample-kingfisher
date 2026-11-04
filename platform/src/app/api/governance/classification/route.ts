export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
// 🔴 治理记录按区。
// 目录 fqn 不含区(`redshift.<db>.<schema>.<table>`)⇒ 两个区的同名表**共用同一个 DDB 分区**:
// 一个区打的标签盖掉另一个区的、一个区跑绿另一个跑红的质量结果互相覆盖。
// 用户 2026-09-10 的原话是「同名表跨区会互相顶,按区出分会**串味**」。
// 修法:分区键加区前缀(`<targetId>::<fqn>`),**home 保持裸 fqn ⇒ 存量零迁移**。
import { scopedFqn, governanceTargetFrom, parseScopedFqn } from "@/lib/governance/scoped-fqn";
import { resolveIdentity } from "@/lib/auth/identity";
import {
  getClassificationsForTable,
  listAllClassifications,
  upsertClassification,
  removeClassification,
  isSensitivityLevel,
  isMaskStrategy,
} from "@/lib/governance/classification";
import { recordAudit } from "@/lib/audit";
// 后一半:点名必须是**已注册且装好**的执行环境(不存在 ⇒ 409,不再写孤儿记录 / 回降级结果)
import { requestedRegisteredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";

// data classification control-plane.
//   GET   ?fqn=<table FQN>  → that table's column classifications; no fqn → all (catalog/overview)
//   PUT   {fqn, column?, level, category?, maskStrategy?}  → upsert (platform admin only)
//   DELETE ?fqn=&column=    → remove (platform admin only)

export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const fqn = req.nextUrl.searchParams.get("fqn");
  try {
    const key = fqn ? scopedFqn(fqn, governanceTargetFrom(req.nextUrl.searchParams)) : "";
    return apiOk(key ? await getClassificationsForTable(key) : await listAllClassifications());
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function PUT(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可设置数据分级", 403);
  const body = await req.json().catch(() => ({}));
  if (!body?.fqn) return apiError("缺少 fqn");
  if (!isSensitivityLevel(body.level)) return apiError("level 必须是 L1/L2/L3/L4");
  if (body.maskStrategy !== undefined && !isMaskStrategy(body.maskStrategy)) return apiError("maskStrategy 非法");
  try {
    // 🔴 写侧必须用**同一个键**:写裸 fqn 而读按区键 ⇒ 永远读不到自己刚写的那条,
    //    而界面上表现为「设了级别但不生效」——这类错最难查。
    // 🔴 写入的落点必须**点名**(缺 / 非法 ⇒ 400)。原来没给就读 `?scope=`、再没有就主控区
    //   ⇒ 页面保存分级两样都不带 ⇒ us-west-2 视角设的级别写进主控区那张表(「设了级别但不生效」)。
    const wKey = scopedFqn(body.fqn, (await requestedRegisteredPlace(body.targetId, "设置数据分级")).targetId);
    const saved = await upsertClassification({
      fqn: wKey,
      column: body.column,
      level: body.level,
      category: body.category,
      maskStrategy: body.maskStrategy,
      classifiedBy: identity.username,
    });
    recordAudit(req, "classification.set", {
      resourceType: "classification",
      resourceId: `${wKey}#${saved.column}`,
      // 审计也带区(审计的区维派生规则见 lib/audit.ts;这里显式传更准)
      ...(parseScopedFqn(wKey).targetId !== "tgt_home" ? { targetId: parseScopedFqn(wKey).targetId } : {}),
      detail: { level: saved.level, maskStrategy: saved.maskStrategy },
    }).catch(() => {});
    return apiOk(saved);
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return apiError(e.message, 500);
  }
}

export async function DELETE(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可删除数据分级", 403);
  const fqn = req.nextUrl.searchParams.get("fqn");
  const column = req.nextUrl.searchParams.get("column") || "";
  if (!fqn) return apiError("缺少 fqn");
  try {
    const dKey = scopedFqn(fqn, governanceTargetFrom(req.nextUrl.searchParams));
    await removeClassification(dKey, column);
    recordAudit(req, "classification.remove", {
      resourceType: "classification",
      resourceId: `${dKey}#${column || "__table__"}`,
    }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
