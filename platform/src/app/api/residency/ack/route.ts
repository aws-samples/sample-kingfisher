export const dynamic = "force-dynamic";
// POST /api/residency/ack —— 用户对某个**跨法域**执行目标同意当前版本的免责告知(50 SPEC v3.23 §2.1 / §3.2;S13 同意留存)。
//
// 【谁能调】任何已登录用户(middleware 已验 JWT;同意是**个人**行为,不看项目角色 —— 一个 viewer 直查跨法域 target 也要先同意)。
// 【入参】`{ targetId, version, textHash }`:与向导注册时的 residencyAck 同形;服务端 `isCurrentDisclaimerAck` **逐字**核对,
//   不信客户端说的版本(用户看到的若不是这一版文案,就不算同意了这一版)。
// 【幂等】同一 (用户, target, 版本) 再调 ⇒ 200 `created:false`,原记录不动(表只追加)。
// 【审计】同意本身也进中央 bgp-audit(`residency.ack`);写不成 ⇒ 503(同意行已留存,重试即 created:false + 审计补上)。
import { NextRequest, NextResponse } from "next/server";
// 落点只认点名(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { writeAuditRecord } from "@/lib/audit";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isCrossJurisdiction, jurisdictionOf } from "@/lib/exec-env/residency";
import { putAck } from "@/lib/exec-env/residency-store";
import { currentDisclaimer } from "@/lib/exec-env/residency-audit";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { isCurrentDisclaimerAck } from "@/lib/residency/disclaimer";

const CLIENT_FIELDS = ["targetId", "version", "textHash"];

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401, { code: "UNAUTHENTICATED" });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  const extra = Object.keys(body ?? {}).filter((k) => !CLIENT_FIELDS.includes(k));
  if (extra.length > 0) {
    return apiError(`入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")})`, 400, { code: "VALIDATION_FAILED" });
  }
  let targetId: string;
  try {
    targetId = requestedTargetId(body.targetId, "确认跨法域告知");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  const disclaimer = currentDisclaimer();
  if (!isCurrentDisclaimerAck({ version: body.version, textHash: body.textHash })) {
    return apiError("回传的免责告知版本 / 文本哈希与当前版本不一致 —— 请刷新后重新阅读并同意", 400, {
      code: "VALIDATION_FAILED",
      detail: { disclaimer },
    });
  }
  const t = await getTargetRaw(targetId);
  if (!t) return apiError(`执行目标不存在:${targetId}`, 404, { code: "NOT_FOUND" });
  if (!isCrossJurisdiction(t)) {
    return apiError(`执行目标 ${targetId} 是 home 法域,不需要也不接受免责告知同意(告知只对跨法域 target 有意义)`, 400, {
      code: "VALIDATION_FAILED",
    });
  }

  const at = new Date().toISOString();
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined;
  const ua = req.headers.get("user-agent") || undefined;
  let created: boolean;
  try {
    ({ created } = await putAck({
      userSub: identity.sub,
      username: identity.email || identity.username || identity.sub,
      targetId,
      version: disclaimer.version,
      textHash: disclaimer.textHash,
      at,
      ip,
      ua,
    }));
  } catch (e) {
    return apiError(`同意记录写入失败,未留存:${String((e as Error)?.message ?? e)}`, 503, { code: "UPSTREAM_ERROR" });
  }
  try {
    await writeAuditRecord(
      { actor: identity.email || identity.username || identity.sub, actorSub: identity.sub, email: identity.email },
      "residency.ack",
      {
        resourceType: "exec-env",
        resourceId: targetId,
        detail: { version: disclaimer.version, textHash: disclaimer.textHash, jurisdiction: jurisdictionOf(t), created },
      },
      { method: req.method, path: req.nextUrl?.pathname || "" }
    );
  } catch (e) {
    return apiError(`同意已留存但中央审计写入失败,请重试:${String((e as Error)?.message ?? e)}`, 503, { code: "UPSTREAM_ERROR" });
  }
  return apiOk({ targetId, jurisdiction: jurisdictionOf(t), version: disclaimer.version, textHash: disclaimer.textHash, at, created });
}

export async function GET() {
  return NextResponse.json({ success: false, error: { message: "只接受 POST" } }, { status: 405 });
}
