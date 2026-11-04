export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordSinkHit } from "@/lib/alerting/test-sink";

// PUBLIC(被 middleware /api/public/* 放行):告警自测 sink 的接收端。
// generic 通道的 webhookUrl 指向本端点(<平台域名>/api/public/alerting-sink)即可端到端无头验证
// 「规则命中→出站投递→sink 收到」。webhook 靶天然是开放 POST(第三方 IM 也不带我们的登录态),
// 故放 public;它只记录 payload、永远回 200,不做任何副作用。查看收到的投递走鉴权的 GET
// /api/alerting/test-sink。
export async function POST(req: NextRequest) {
  const payload = await req.json().catch(() => ({}));
  try {
    const { id, at } = await recordSinkHit(payload);
    return apiOk({ received: true, id, at });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
