export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { ListWorkgroupsCommand } from "@aws-sdk/client-redshift-serverless";
// 「服务状态」里的 Redshift 一行原来恒查主控区,
// 于是在 us-west-2 视角下它显示的是主控区的工作组数 —— 那正是这一页整体撒谎的一部分。
// 🔴 客户端一律经工厂按 region 建(门禁 `no-bare-redshift-client` 只管 Data API,
// 但同一条纪律适用:region 不许从进程环境里猜)。
import { redshiftServerlessClientFor } from "@/lib/exec-env/target-clients";
import { getTargetRaw } from "@/lib/exec-env/registry";
// 区从「targetId → 区」的唯一作者取(它记落点决策;第四十轮 observe 里
//   本路由的 redshift-serverless.ListWorkgroups 是未归因榜的一项 —— 客户端区对了,但直接读 t.region 没有任何一笔决策)。
import { regionOfTarget } from "@/lib/exec-env/data-plane-target";
import { apiError } from "@/lib/api-response";

export async function GET(req: NextRequest) {
  // 读路由:执行目标由 `?targetId=` 显式点名(与 `/api/redshift/schemas` 同款);缺省 = 主控区。
  // 原来「没给 = 主控区」;现在只认点名(缺 / 非法 ⇒ 400)
  let targetId: string;
  try {
    targetId = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "列数仓工作组");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  try {
    const t = await getTargetRaw(targetId);
    if (!t) {
      return apiError(`执行环境 ${targetId} 不存在或尚未初始化完成`, 404, { code: "TARGET_NOT_FOUND" });
    }
    // 🔴 该区没装数仓 ⇒ 明确回空 + 说明,而不是去查主控区凑一个数出来。
    const components: string[] = Array.isArray(t.components) ? (t.components as string[]) : [];
    if (!components.includes("redshift")) {
      return NextResponse.json([]);
    }
    const client = await redshiftServerlessClientFor(await regionOfTarget(targetId));
    const { workgroups = [] } = await client.send(new ListWorkgroupsCommand({}));
    return NextResponse.json(
      workgroups.map((w) => ({
        workgroupName: w.workgroupName,
        status: w.status,
        endpoint: w.endpoint?.address,
        port: w.endpoint?.port,
        namespaceName: w.namespaceName,
      }))
    );
  } catch (err: unknown) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
