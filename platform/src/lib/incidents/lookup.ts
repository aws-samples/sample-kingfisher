// 运维知识库检索(供诊断编排 grounding + /api/incidents/lookup 端点复用)。
//
// 复利闭环的"读"半环:诊断发起前,用故障指纹去 bgp-incidents 查"这个客户上次这么修好的"——
// 命中且【人工已验证】的修复手册,注入进喂给 DevOps Agent 的证据 prompt,让 RCA 带着历史修复
// 与业务口径去调查(见 evidence.ts)。
//
// 安全铁律(设计 §8):只在人工 verified 时返回修复手册全文,防未确认的 AI 建议被当"已验证"套用。
// 纯读、无副作用;取不到/表不存在时返回 found=false,绝不抛(诊断是"锦上添花",不能因它报错)。

import { computeSignature } from "./signature";
import { getMaster } from "./store";
import type { FixKind } from "./types";

export interface IncidentLookupResult {
  signature: string;
  found: boolean;
  title?: string;
  engine?: string;
  status?: string;
  occurrenceCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  rootCauseSummary?: string;
  // 是否有【人工已验证】的修复手册(仅此时才返回 resolution 全文)。
  hasVerifiedFix: boolean;
  resolution: {
    markdown: string;
    verifiedBy?: string;
    verifiedAt?: string;
    fixKind?: FixKind;
    backfillHint?: { taskId: string; dateRange?: string };
  } | null;
}

// 给定 signature(或由 taskType+errorText 现算)→ 查主档,返回归并态 + 已验证修复手册。
// projectId 决定知识库归属(每部署/项目独立沉淀)。
export async function lookupIncident(input: {
  projectId: string;
  signature?: string;
  taskType?: string;
  errorText?: string;
}): Promise<IncidentLookupResult> {
  let signature = (input.signature || "").trim();
  if (!signature) {
    const errorText = String(input.errorText || "");
    // 无 signature 也无 errorText:无从归并,直接 not found(空错误文本会归到 no-error-text 桶,
    // 那类桶不含可套用的历史修复语义,故此处直接短路)。
    if (!errorText) return { signature: "", found: false, hasVerifiedFix: false, resolution: null };
    signature = computeSignature(input.taskType || "", errorText).signature;
  }

  try {
    const master = await getMaster(input.projectId, signature);
    if (!master) return { signature, found: false, hasVerifiedFix: false, resolution: null };
    const verified = !!master.resolution?.verified;
    return {
      signature,
      found: true,
      title: master.title,
      engine: master.engine,
      status: master.status,
      occurrenceCount: master.occurrenceCount || 0,
      firstSeenAt: master.firstSeenAt,
      lastSeenAt: master.lastSeenAt,
      rootCauseSummary: master.rootCauseSummary || "",
      hasVerifiedFix: verified,
      // 仅在人工已验证时返回修复手册(防未确认 AI 建议被当"已验证"套用,见设计 §8)。
      resolution: verified
        ? {
            markdown: master.resolution?.markdown || "",
            verifiedBy: master.resolution?.verifiedBy,
            verifiedAt: master.resolution?.verifiedAt,
            fixKind: master.resolution?.fixKind,
            backfillHint: master.resolution?.backfillHint,
          }
        : null,
    };
  } catch {
    // 表不存在/读失败:诊断不因知识库读取失败而中断。
    return { signature, found: false, hasVerifiedFix: false, resolution: null };
  }
}
