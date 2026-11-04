export const dynamic = "force-dynamic";
// POST /api/admin/metadata-mirror —— 手动触发一个 target 的元数据采集(〔立即同步〕/〔采集数仓目录〕)。
//
// 🔴 **写在 /api/admin 下是有意的**:采集会真去那个 region 打 API,数仓目录那一路还会
// **唤醒该区的 Serverless 数仓**(RPU 计费)。凡是"点一下就花钱"的动作都归管理面
// (读侧在 `GET /api/metadata-mirror`,viewer 就能看 —— 那条路由的文件头解释了为什么必须拆开)。
//
// 🔴 **`sources` 是允许列表**:客户端只能从 `glue` / `redshift` 里挑,不认识的一律 400。
// 缺省只采 `glue`(与定时同口径),要采数仓必须显式点 —— 免得一个"刷新"按钮悄悄把两个区的数仓都唤醒。
import { NextRequest, NextResponse } from "next/server";
// 落点只认点名(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getActiveProjectId } from "@/lib/projects/guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { mirrorMetadata } from "@/lib/exec-env/metadata-mirror";
import { warehousePuller } from "@/lib/exec-env/metadata-mirror-warehouse";
import { MIRROR_SOURCES, MIRROR_TIMER_SOURCES, type MirrorSource } from "@/lib/exec-env/metadata-mirror-shared";
import { TargetBindingRejected } from "@/lib/exec-env/data-plane-target";

export async function POST(req: NextRequest) {
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;

  let body: { targetId?: unknown; sources?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiError("请求体必须是 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  let targetId: string;
  try {
    targetId = requestedTargetId(body.targetId, "采集元数据镜像");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  let sources: readonly MirrorSource[] = MIRROR_TIMER_SOURCES;
  if (body.sources !== undefined) {
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      return apiError("sources 必须是非空数组", 400, { code: "VALIDATION_FAILED" });
    }
    const bad = body.sources.filter((s) => !(MIRROR_SOURCES as readonly unknown[]).includes(s));
    if (bad.length) {
      return apiError(
        `sources 只能是 ${MIRROR_SOURCES.join(" / ")}(收到 ${JSON.stringify(bad)})`,
        400,
        { code: "VALIDATION_FAILED" }
      );
    }
    sources = body.sources as MirrorSource[];
  }

  try {
    const r = await mirrorMetadata(targetId, {
      sources,
      // 🔴 数仓采集器由**本路由**注入 —— 采集层刻意不 import 它(编译边界 + 它要 projectId,
      //    见 `metadata-mirror-warehouse.ts` 文件头)。于是「定时唤醒各区数仓」在类型层不可能发生。
      pullers: { redshift: warehousePuller(getActiveProjectId(req)) },
    });
    // 采集本身是只读动作,但它会写中央镜像 ⇒ 留痕(谁在什么时候把哪个区的目录拉到了中央)。
    // 🔴 best-effort:审计写失败不回滚已写好的镜像(与"权限边界变更"不同,这里没有安全语义)。
    await recordAudit(req, "exec-env.mirror-metadata", {
      resourceType: "exec-env",
      resourceId: targetId,
      detail: { sources: r.sources, state: r.facet.state, tables: r.facet.tables },
    });
    // 🔴 逐来源结果原样回:一个来源失败 ⇒ HTTP 仍是 200,但 `facet.sources[].error` 有值。
    //    界面必须据此显示"部分失败",不许把 200 读成"全好了"(HTTP 200 ≠ 那一格是绿的,
    //    这条教训在矩阵一键处置那里已经吃过一次)。
    // 🔴 把「推进 OM 的结果」一起回
    //    目录页只读 OM ⇒ 推不进去 = 那个区的目录停在上一次的样子,而页面上**看不出来**。
    //    回出来,管理面与验收才能发现(errors > 0 / truncated 都必须可见)。
    return apiOk({ facet: r.facet, sources: r.sources, ...(r.om ? { om: r.om } : {}) });
  } catch (e: unknown) {
    if (e instanceof TargetBindingRejected) {
      // 用户可修(目标没装 redshift / 缺凭证 / 落点冲突)⇒ 409,不要混进 500
      return apiError(`采集被拒:${e.message}`, 409, { code: "CONFLICT" });
    }
    return apiError(`采集失败:${(e as Error)?.message ?? String(e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
