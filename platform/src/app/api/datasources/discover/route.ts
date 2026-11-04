export const dynamic = "force-dynamic";
// 序 31 二刀 ⑤:从 RDS 发现实例要**点名落点**(`?targetId=`,与新建数据源同一个章;缺 ⇒ 400,不默认主控区 —— 工程纪律 1 / 2)。
//   之前无参数 ⇒ 永远在主控区列实例(「没传 = 主控区」的 B-26 原形),observe 把它记成未归因
//   (`rds.DescribeDBInstances / secretsmanager.ListSecrets /api/datasources/discover`);落点经 `resolveDsPlace` 解析并记账。
import { NextRequest } from "next/server";
import { discoverRdsInstances } from "@/lib/aws/datasource-service";
import { apiOk, apiError } from "@/lib/api-response";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { resolveDsPlace } from "@/lib/datasource/ds-place";

export async function GET(req: NextRequest) {
  try {
    const place = await resolveDsPlace(requestedTargetId(req.nextUrl.searchParams.get("targetId"), "从 RDS 发现实例"));
    const instances = await discoverRdsInstances(place.region);
    return apiOk(instances);
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return apiError(e.message, 500);
  }
}
