export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
// 落点只认点名(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE)
import { requestedRegisteredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { apiOk } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { FLINK, flinkVersionLabel, flinkEngineLabel } from "@/lib/realtime/flink-config";
// 🔴 `subnetIds` 是**区域事实**:回主控区的子网给别的区看,
// 用户照着它填,写进去的就是一个那个区不存在的子网 id(与 /settings 那次硬撒谎同一类)。
import { resolveFlinkPlace } from "@/lib/realtime/flink-place";

// GET /api/flink/meta — 实时计算引擎元信息(版本/运行时/源流),前端动态展示,避免写死。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  // 后一半(2026-10-11 真环境坐实 `?targetId=tgt_nope_zz` ⇒ 200 且 region = 主控区):
  //   原来只验格式,解析失败后 `region` 仍是 `FLINK.region`(主控区)、`subnetIds=[]` + `placeError` ⇒ 页面拿到一份「看起来正常」的
  //   主控区元信息。现在:点名必须是已注册且装好的执行环境(否则 409),Flink 落点解析不开(没装 flink / 缺资源)同样 409 ——
  //   **任何情况下都不回主控区的 region / 子网**。前端(实时计算页)拿到失败信封时版本标签走自身的缺省文案,不展示任何区域事实。
  let place;
  try {
    const registered = await requestedRegisteredPlace(req.nextUrl.searchParams.get("targetId"), "取实时引擎元信息");
    place = await resolveFlinkPlace(registered.targetId);
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  return apiOk({
    runtimeEnvironment: FLINK.runtimeEnvironment,
    versionLabel: flinkVersionLabel(),
    engineLabel: flinkEngineLabel(),
    sourceStream: FLINK.sourceStream,
    region: place.region,
    targetId: place.targetId,
    // 自定义 sink VPC 接入的默认私有子网(用户留空时回退到这些),供前端展示参考。
    subnetIds: place.subnetIds,
  });
}
