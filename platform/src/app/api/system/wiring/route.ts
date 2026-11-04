export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
// @kf-batch 50-W5-seg2-WP8 — 模块 51:AI 模型运行时配置 / FAULT seam 启用状态 / AgentCore 模型回执 三项。
import { resolveModelRuntime } from "@/lib/ai/model";
import { faultSeamStatus } from "@/lib/ai/fault-seam";
import { getAgentCoreMetaStatus } from "@/lib/ai/agentcore-contract";
// @kf-batch 50-init-deploy-mechanism —— 执行环境部署机制(broker + CodeBuild)真在否
import { probeDeployMechanism } from "@/lib/exec-env/deploy-control";

// 接线健康体检(防回归根治 · 可观测层)。
//   GET → 报告所有关键接线项的红黄绿状态,把"静默降级"变成一眼可见。
//
// 为什么存在:平台的 AI 接线(OM URL / GenBI·顾问的 backend+runtime-arn)靠部署时的 -c 注入,
// 一旦某次裸部署把它冲回默认空值,页面不会白屏、只是 AI 退化 / OM 变空 —— 人肉发现不了。
// 本端点让接线状态可主动巡检(设置页卡片 + contract-guard 正向契约都读它)。
// 只读、best-effort、绝不抛错;平台管理员可见(含明文 env,故限管理员)。

type WiringStatus = "ok" | "warn" | "down";
interface WiringItem {
  key: string;
  label: string;
  status: WiringStatus;
  detail: string;
}

const env = (k: string) => (process.env[k] || "").trim();

// 一个"AI 能力"的接线三要素:backend 必须 = agentcore、runtime-arn 非空(否则会静默回落进程内)。
function agentItem(label: string, backendVar: string, arnVar: string): WiringItem {
  const backend = env(backendVar);
  const arn = env(arnVar);
  if (backend === "agentcore" && arn) {
    return { key: backendVar, label, status: "ok", detail: `agentcore · ${arn.split("/").pop()}` };
  }
  if (backend === "agentcore" && !arn) {
    return { key: backendVar, label, status: "down", detail: "backend=agentcore 但 runtime-arn 为空(接线被冲掉?)" };
  }
  return { key: backendVar, label, status: "warn", detail: `回落进程内(backend=${backend || "未设"})` };
}

export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("需要平台管理员", 403);

  const items: WiringItem[] = [];

  // ① OpenMetadata:URL 是否配置 + 是否真的可达(best-effort 探活)。
  const omUrl = env("OPENMETADATA_URL");
  if (!omUrl) {
    items.push({ key: "OPENMETADATA_URL", label: "OpenMetadata 接线", status: "down", detail: "OPENMETADATA_URL 未配置(血缘/元数据页会报错)" });
  } else {
    let reachable = false;
    try {
      // /api/v1/system/version 无需鉴权,是最轻的探活(与 /api/openmetadata/url 同款,5s 超时)。
      const res = await fetch(`${omUrl}/api/v1/system/version`, { signal: AbortSignal.timeout(5000) });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    items.push({
      key: "OPENMETADATA_URL",
      label: "OpenMetadata 接线",
      status: reachable ? "ok" : "warn",
      detail: reachable ? `已接线且可达 · ${omUrl}` : `已配置但探活失败(服务未就绪?) · ${omUrl}`,
    });
  }

  // ② 三个 AI 能力的 AgentCore 接线。
  items.push(agentItem("GenBI 问数", "GENBI_BACKEND", "GENBI_RUNTIME_ARN"));
  items.push(agentItem("网络连通性顾问", "NETADVISOR_BACKEND", "NETADVISOR_RUNTIME_ARN"));
  items.push(agentItem("参数辅助顾问", "PARAMADVISOR_BACKEND", "PARAMADVISOR_RUNTIME_ARN"));

  // ③ GenBI 记忆后端(多轮/长期记忆;非致命,仅提示)。
  const memBackend = env("GENBI_MEMORY_BACKEND");
  const memId = env("GENBI_MEMORY_ID");
  items.push({
    key: "GENBI_MEMORY_BACKEND",
    label: "GenBI 记忆后端",
    status: memBackend === "agentcore" && memId ? "ok" : "warn",
    detail: memBackend === "agentcore" && memId ? `agentcore 托管记忆 · ${memId}` : `自管记忆(backend=${memBackend || "未设"})`,
  });

  // ④ @kf-batch 50-W5-seg2-WP8 模块 51:当前生效模型 + 来源层(配置面挂了 ⇒ runtime-stale 标 down,让「AI 模型」卡与本卡同红)。
  try {
    const m = await resolveModelRuntime("genbi");
    items.push({
      key: "AI_MODEL_CONFIG",
      label: "AI 模型运行时配置",
      status: m.stale ? "down" : "ok",
      detail: m.stale ? `配置面读取失败,沿用 last-good ${m.modelId}(runtime-stale)` : `${m.modelId} · 来源 ${m.source}`,
    });
  } catch (e) {
    items.push({ key: "AI_MODEL_CONFIG", label: "AI 模型运行时配置", status: "down", detail: `解析失败: ${e instanceof Error ? e.message : String(e)}` });
  }
  // ⑤ 故障注入缝启用状态(51 SPEC §3.4a③:运行期 env 门 + 仅非生产标记;打开即 warn,生产不该出现)。
  const seam = faultSeamStatus();
  items.push({
    key: "FAULT_THROTTLE_MODEL",
    label: "故障注入缝(模型限流)",
    status: seam.armed ? "warn" : "ok",
    detail: seam.armed
      ? `已打开:对 ${seam.throttleModel} 强制限流(BGP_NONPROD_TARGET=1,仅非生产)`
      : seam.throttleModel
        ? `FAULT_THROTTLE_MODEL 已设但缺 BGP_NONPROD_TARGET=1 ⇒ 惰性(fail-closed)`
        : "未启用",
  });
  // ⑥ AgentCore 模型回执(51 SPEC §6.1⑤):最近一次不匹配即 down —— 容器没按 payload 切模型 / 镜像陈旧。
  const ac = getAgentCoreMetaStatus();
  items.push({
    key: "AGENTCORE_MODEL_META",
    label: "AgentCore 模型回执",
    status: ac.lastMismatch && (!ac.lastOk || ac.lastMismatch.at >= ac.lastOk.at) ? "down" : "ok",
    detail: ac.lastMismatch && (!ac.lastOk || ac.lastMismatch.at >= ac.lastOk.at)
      ? `${ac.lastMismatch.capability}: 回执 ${ac.lastMismatch.actual ?? "(缺 _meta)"} ≠ 期望 ${ac.lastMismatch.expected} @ ${new Date(ac.lastMismatch.at).toISOString()}`
      : ac.lastOk
        ? `${ac.lastOk.capability}: ${ac.lastOk.modelId} @ ${new Date(ac.lastOk.at).toISOString()}`
        : "本进程尚无 AgentCore 调用(inprocess 路径不经此)",
  });

  // ⑦ @kf-batch 50-init-deploy-mechanism 执行环境部署机制:缺它 ⇒ 向导「开始部署」必报 Function not found,而其余全绿
  //    (2026-09-06 新账号真撞:deploy-all 老版本从未发 BgpExecEnvDeployStack)。只读探测,不 invoke broker。
  try {
    const m = await probeDeployMechanism();
    items.push({
      key: "EXEC_ENV_DEPLOY_MECHANISM",
      label: "执行环境部署机制",
      status: m.ok ? "ok" : "down",
      detail: m.ok ? m.detail : `${m.detail} —— 运维:bash scripts/redeploy-platform.sh <profile> <region>(§2b 部署 BgpExecEnvDeployStack)`,
    });
  } catch (e) {
    items.push({ key: "EXEC_ENV_DEPLOY_MECHANISM", label: "执行环境部署机制", status: "down", detail: `探测失败: ${e instanceof Error ? e.message : String(e)}` });
  }

  const summary = {
    ok: items.filter((i) => i.status === "ok").length,
    warn: items.filter((i) => i.status === "warn").length,
    down: items.filter((i) => i.status === "down").length,
  };
  const overall: WiringStatus = summary.down > 0 ? "down" : summary.warn > 0 ? "warn" : "ok";

  return apiOk({ overall, summary, items });
}
