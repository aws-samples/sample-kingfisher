export const dynamic = "force-dynamic";
// @kf-batch 50-P50.3-mirror
// GET /api/metadata-mirror —— 跨地域一屏只读元数据总览的**读端点**(50 SPEC §3.13 / INTERACTION §4quater)。
//
// 🔴 **为什么不在 `/api/admin/` 下**(与 50 SPEC §2.1 原写法的订正,已回灌合同):
// `middleware.ts` 把 `/api/admin/**` 整段强制 `bgp-admin`。而"看一眼各个区各有多少资产"
// 是**普通开发者/数据分析师**的日常动作 —— 放进 /api/admin 就等于做了一个非管理员点不开的看板
// (`/api/exec-targets` 已经为同一条判据立过规矩:呈现端点不该要管理员)。
// ⇒ **读**在这里(viewer);**写**(〔立即同步〕/〔采集数仓目录〕,要花钱、要打那个区的 API)
//   仍在 `POST /api/admin/metadata-mirror`(bgp-admin)。
//
// 🔴 **响应里绝不含结果行**(§3.13 的硬边界 + INTERACTION §4quater 的验收判据):
// 镜像 payload 由 `metadata-mirror.ts` 的 `sanitize*` **重建**,只有库名/表名/列名与类型/计数
// 能进去。本路由不做任何"补一点数据行让页面好看"的事。

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { buildMirrorOverview, listMirrorEntries } from "@/lib/exec-env/metadata-mirror";
import { MIRROR_KINDS, type MirrorKind } from "@/lib/exec-env/metadata-mirror-shared";
import { isValidTargetId } from "@/lib/exec-env/target-id";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  const targetId = (req.nextUrl.searchParams.get("targetId") || "").trim();
  const kindRaw = (req.nextUrl.searchParams.get("kind") || "").trim();
  const kind = kindRaw ? (kindRaw as MirrorKind) : undefined;
  if (kind && !(MIRROR_KINDS as readonly string[]).includes(kind)) {
    return apiError(`kind 只能是 ${MIRROR_KINDS.join(" / ")}(收到 ${kindRaw})`, 400, {
      code: "VALIDATION_FAILED",
    });
  }

  try {
    if (targetId) {
      // 下钻:某个 target 的镜像条目。🔴 非法 targetId 直接 400 ——
      // 回空列表会被读成"那个区什么都没有"(与总览的 `never` 是两件完全不同的事)。
      if (!isValidTargetId(targetId)) {
        return apiError(`非法 targetId:${targetId}`, 400, { code: "VALIDATION_FAILED" });
      }
      const overview = await buildMirrorOverview();
      const facet = overview.facets.find((f) => f.targetId === targetId);
      if (!facet) {
        return apiError(
          `执行目标 ${targetId} 既不活跃、也没有过镜像 ⇒ 没有可下钻的内容(这不等于"那个区是空的")`,
          404,
          { code: "NOT_FOUND" }
        );
      }
      const entries = await listMirrorEntries(targetId, kind);
      return apiOk({ facet, entries, notCollected: overview.notCollected });
    }
    return apiOk(await buildMirrorOverview());
  } catch (e: unknown) {
    // 🔴 算不出来就说算不出来 —— 空总览在界面上等于"每个区都没资产"(假绿,与矩阵同一条判据)。
    return apiError(
      `跨地域元数据总览算不出来:${(e as Error)?.message ?? String(e)}。` +
        `🔴 这里刻意不回空分面 —— 空分面看起来像"那些区没有资产",而真相是"读不到"。`,
      502,
      { code: "UPSTREAM_ERROR" }
    );
  }
}
