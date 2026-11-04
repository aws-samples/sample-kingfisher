export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { CancelStatementCommand, DescribeStatementCommand } from "@aws-sdk/client-redshift-data";
import { apiOk, apiError } from "@/lib/api-response";
import { requireQueryHandle } from "@/lib/security/query-handle";
import { recordAudit } from "@/lib/audit";
import { redshiftDataClientFor } from "@/lib/exec-env/target-clients";
import { regionOfTarget } from "@/lib/exec-env/data-plane-target";

// S0(50 SPEC §0/§3.7)— 本端点原先**全程无鉴权**:任一登录用户凭 statementId 即可取消他人
// 正在跑的查询(拒服务式越权)。定案:**按 handle 归属判**;拿不到 handle 或不匹配 → 403。
//
// 🔴🔴 **legacy 兜底已删除(2026-08-29 外部审核 P0-1 坐实的绕过)**:原实现是
// `if (handleId) { 校验 } else { requireProject(editor) 放行 }` —— 判据取自**客户端是否愿意带参数**,
// 于是任何项目 editor 只要**主动省略** `?handleId=` 就直接落进兜底,照样能取消他人查询:洞没堵住,
// 只是换了个入口。服务端也无从证明"该语句确实是 S0 上线前提交、本来就没有 handle"。
// ⇒ 定案:**handle 无条件必需**。代价是 S0 上线瞬间正在跑的存量语句无法经 API 取消(语句本身短命,
// 最坏情况是跑到自然结束),这个代价远小于留一个"少传一个参数即可绕过"的授权口。
export async function POST(req: NextRequest) {
  const { statementId } = await req.json();
  if (!statementId) return apiError("缺少 statementId");

  const chk = await requireQueryHandle(req, statementId, "redshift");
  if (chk instanceof NextResponse) return chk;

  try {
    // 🔴 **只取消这一个 target 的语句**(INTERACTION §4septies.4:超时不连坐其它区)。
    // region 取自**句柄**里的 targetId —— 客户端无从指定,拿 home 的客户端去 cancel 非 home
    // 的语句只会静默无效(那比报错更坏:界面显示"已取消"而那个区还在跑还在计费)。
    const region = await regionOfTarget(chk.handle?.targetId || "");
    const client = redshiftDataClientFor(region);
    await client.send(new CancelStatementCommand({ Id: statementId }));
    recordAudit(req, "redshift.cancel", { resourceType: "redshift-statement", resourceId: statementId });
    return apiOk({ cancelled: true });
  } catch (e: any) {
    // 🔴 **「语句已经跑完了」不是平台故障,不许报 500**(与 W3a-9 教过的同一类错误分类:
    // 500 会把人引去查平台健康,而真相是"你按取消的时候它已经结束了" —— 用户可理解的正常情形)。
    // 🔴 判据取**权威状态**(再 Describe 一次),不靠匹配 AWS 的错误文案 ——
    // 文案匹配是最脆的判据,SDK 一改措辞就静默错分类。
    try {
      const region2 = await regionOfTarget(chk.handle?.targetId || "");
      const d = await redshiftDataClientFor(region2).send(new DescribeStatementCommand({ Id: statementId }));
      if (d.Status && ["FINISHED", "FAILED", "ABORTED"].includes(d.Status)) {
        return apiError(`该语句已结束(${d.Status}),无需取消`, 409, {
          code: "CONFLICT",
          detail: { cancelled: false, status: d.Status },
        });
      }
    } catch {
      /* Describe 也失败 ⇒ 落到下面按真故障处理(不猜) */
    }
    return apiError(e.message, 500);
  }
}
