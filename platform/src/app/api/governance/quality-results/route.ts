export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
// 🔴 治理记录按区。
// 目录 fqn 不含区(`redshift.<db>.<schema>.<table>`)⇒ 两个区的同名表**共用同一个 DDB 分区**:
// 一个区打的标签盖掉另一个区的、一个区跑绿另一个跑红的质量结果互相覆盖。
// 用户 2026-09-10 的原话是「同名表跨区会互相顶,按区出分会**串味**」。
// 修法:分区键加区前缀(`<targetId>::<fqn>`),**home 保持裸 fqn ⇒ 存量零迁移**。
import { scopedFqn, governanceTargetFrom } from "@/lib/governance/scoped-fqn";
import { resolveIdentity } from "@/lib/auth/identity";
import { getResults } from "@/lib/quality/service";

// 读一张表最近一次质量运行结果 + 评分/SLA；history=1 附最近若干次评分趋势。
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const fqn = req.nextUrl.searchParams.get("fqn");
  if (!fqn) return apiError("缺少 fqn");
  const history = req.nextUrl.searchParams.get("history") === "1";
  try {
    return apiOk(await getResults(scopedFqn(fqn, governanceTargetFrom(req.nextUrl.searchParams)), history));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
