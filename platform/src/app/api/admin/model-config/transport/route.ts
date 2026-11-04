// @kf-batch 50-W5-seg2-WP8
// 模块 51 — GPT 传输门控端点(P51.2 代码侧;51 SPEC §2 `PUT /transport` + §3.4 补强①–④)。
//
//   GET  → 现状:DDB 项 + 真实现判定(readTransportGate)+ 硬闸当前值(gptTransportReady,本波恒 false)
//   PUT  { gptReady, branch } →
//        gptReady=true 的**前置**:本 target 上至少一个 `openai.gpt-5.6-*` 在 24h 内探测通过且 `toolUseOk===true`,
//        否则 400 `TransportNotVerified`(M13)。写 `ai-model#__transport`(含 probeModelId/probedAt 证据)+ bump。
//   ⚠️ 诚实边界:置位只是**开关**、不是**证据**(单次 tiny probe 弱于 4 个 tool 循环无头验);且本波硬闸恒关,
//      即使置位成功 PUT openai.* 仍 400 NotAllowedFamily(M13a)—— 放行由主会话在 D9 真探测后改 transport-gate.ts 一行。
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk } from "@/lib/api-response";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { auditActorFromRequest } from "@/lib/audit";
import { isOpenAIFamily } from "@/lib/ai/capabilities";
import { gptTransportReady, readTransportItem, readTransportGate, _resetTransportCacheForTests } from "@/lib/ai/transport-gate";
import { requirePlatformAdmin, modelConfigError } from "@/lib/settings/admin-guard";
import { isProbeFresh, listProbes, putTransport } from "@/lib/settings/model-store";

export async function GET(req: NextRequest) {
  const guard = await requirePlatformAdmin(req);
  if (!("identity" in guard)) return guard;
  const item = await readTransportItem();
  return apiOk({
    item: item ? { gptReady: item.gptReady, branch: item.branch, decidedAt: item.decidedAt, decidedBy: item.decidedBy, probeModelId: item.probeModelId ?? null, probedAt: item.probedAt ?? null } : null,
    ready: await readTransportGate(),
    hardGate: await gptTransportReady(),
  });
}

export async function PUT(req: NextRequest) {
  const guard = await requirePlatformAdmin(req);
  if (!("identity" in guard)) return guard;

  let body: { gptReady?: unknown; branch?: unknown };
  try {
    body = await req.json();
  } catch {
    return modelConfigError("ValidationFailed", 400, { message: "请求体无效" });
  }
  if (typeof body.gptReady !== "boolean") return modelConfigError("ValidationFailed", 400, { message: "gptReady 须为 boolean" });
  const branch = body.branch === "A" || body.branch === "B" ? body.branch : null;
  if (body.gptReady && !branch) return modelConfigError("ValidationFailed", 400, { message: "gptReady=true 时 branch 须为 A 或 B" });

  let evidence: { probeModelId: string; probedAt: number } | undefined;
  if (body.gptReady) {
    // 前置证据:24h 内、openai 系、ok 且 toolUseOk===true 的探测缓存(fail-closed:读失败视为无证据)。
    const probes = await listProbes(HOME_TARGET_ID).catch(() => []);
    const now = Date.now();
    const hit = probes
      .filter((p) => isOpenAIFamily(p.modelId) && p.probeOk === true && p.toolUseOk === true && isProbeFresh(p, now))
      .sort((a, b) => b.probedAt - a.probedAt)[0];
    if (!hit) {
      return modelConfigError("TransportNotVerified", 400, {
        detail: "放开 GPT 传输前须先对至少一个 openai.gpt-5.6-* 探测通过且 tool-use 可用(24h 内)。请先 POST /probe。",
      });
    }
    evidence = { probeModelId: hit.modelId, probedAt: hit.probedAt };
  }

  try {
    await putTransport(
      {
        gptReady: body.gptReady,
        branch,
        decidedAt: Date.now(),
        decidedBy: guard.identity.email || guard.identity.username || guard.identity.sub,
        ...(evidence ?? {}),
      },
      auditActorFromRequest(req),
      { method: req.method, path: req.nextUrl?.pathname || "" }
    );
    _resetTransportCacheForTests(); // 本进程立即可见(其它实例靠 5s TTL + __version bump)
    return apiOk({ ok: true, gptReady: body.gptReady, branch, evidence: evidence ?? null, hardGate: await gptTransportReady() });
  } catch (e) {
    return modelConfigError("StoreUnavailable", 503, { message: e instanceof Error ? e.message : String(e) });
  }
}
