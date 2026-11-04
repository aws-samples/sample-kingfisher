export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { ListDatabasesCommand } from "@aws-sdk/client-redshift-data";
// @kf-batch 50-WP2-directquery
// 🔴 裸客户端收编:`ListDatabases` 是**region 内**的调用 —— 用主控区客户端去列非 home 工作组的库,
//    最好的情况是报 ResourceNotFound、最坏的情况是列出主控区的库并冒充那个区的(静默串味)。
// 🔴 `?targetId=` 跟 SQL 编辑器自己的执行目标选择走(W3-c1 已有那个选择器),**不读 `?scope=`**:
//    这条端点服务的是「我在编辑器里选了哪个数仓」,不是页面视角。
import { resolveDirectQueryPlaceSafe } from "@/lib/redshift/direct-query";
import { redshiftDataClientFor } from "@/lib/exec-env/target-clients";
import { getActiveProjectId } from "@/lib/projects/guard";
// @kf-batch 50-WP31-place-first-class
// @kf-batch 50-WP31-place-first-class —— B-35 后一半:点名必须是**已注册且装好**的执行环境(不存在 ⇒ 409,不再写孤儿记录 / 回降级结果)
import { requestedRegisteredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  // @kf-batch 50-WP31-place-first-class —— 🔴 落点必须点名(缺 / 非法 ⇒ 400):原来「没给 = 主控区」⇒ 漏传就列主控区的库。
  //   放在 try 之外:下面那个兜底 catch 会把一切错误吞成 `dev`,落点错误不许被它吞掉。
  let targetId: string;
  try {
    targetId = (await requestedRegisteredPlace(sp.get("targetId"), "列数仓库")).targetId;
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  try {
    const pre = await resolveDirectQueryPlaceSafe({
      targetId,
      projectId: getActiveProjectId(req),
      workgroupOverride: sp.get("workgroup"),
    });
    // 该 target 没装数仓 ⇒ 如实回能力态(而不是回一个假的 `[{name:"dev"}]`,
    // 那会让编辑器显示一个连不上的库名 —— 用户会以为是自己 SQL 写错了)。
    if (pre.capability === "unavailable") return NextResponse.json(pre, { status: 200 });
    const place = pre.place;
    const client = redshiftDataClientFor(place.region);
    const { Databases = [] } = await client.send(
      new ListDatabasesCommand({
        WorkgroupName: place.workgroup,
        Database: place.database,
        ...(place.secretArn ? { SecretArn: place.secretArn } : {}),
      })
    );
    return NextResponse.json(Databases.map((d) => ({ name: d })));
  } catch {
    // 原状保留:列不出来就给一个 `dev` 兜底(编辑器至少能用)。
    return NextResponse.json([{ name: "dev" }]);
  }
}
