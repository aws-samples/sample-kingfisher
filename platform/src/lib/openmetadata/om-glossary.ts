// 数据标准 / 指标 → OpenMetadata Glossary 推送(best-effort,失败不阻断)。
//
// 数据标准天然对应 OM 的 Glossary Term(业务术语);指标同理(口径=术语定义)。
// 若 OM 未配置(isOmConfigured()=false)直接跳过。所有调用 fire-and-forget,永不抛到调用方。
// FQN/命名:glossary 名固定;term 用业务编码或指标名,避免重复实体(PUT = createOrUpdate)。

import { omRequest, getEntityByName, isOmConfigured } from "./om-client";

const STD_GLOSSARY = "bgp-data-standards"; // 数据标准术语表
const METRIC_GLOSSARY = "bgp-metrics"; // 指标术语表

// 建 glossary(create-if-absent,不 clobber)。
async function ensureGlossary(name: string, displayName: string, description: string): Promise<boolean> {
  const existing = await getEntityByName("glossaries", name);
  if (existing?.id) return true;
  const res = await omRequest("PUT", "/api/v1/glossaries", { name, displayName, description });
  return !!res;
}

// PUT 一个 glossary term(createOrUpdate)。OM 要求 name 不含点/特殊符,做一次清洗。
function termName(raw: string): string {
  const n = (raw || "").trim().replace(/[.<>]/g, "_");
  return n || "term";
}

async function putTerm(glossary: string, name: string, displayName: string, description: string): Promise<void> {
  await omRequest("PUT", "/api/v1/glossaryTerms", {
    glossary,
    name: termName(name),
    displayName: displayName || name,
    description: description || displayName || name,
  });
}

/**
 * 数据标准 → Glossary Term。best-effort,永不抛。
 * term 用标准编码(唯一、稳定),description 拼口径/类型/单位。
 */
export async function pushStandardGlossary(std: {
  code?: string; name?: string; dataType?: string; unit?: string; description?: string; constraint?: string;
}): Promise<void> {
  try {
    if (!isOmConfigured()) return;
    const ok = await ensureGlossary(STD_GLOSSARY, "数据标准", "平台数据标准字典自动同步");
    if (!ok) return;
    const desc = [
      std.description || std.name || "",
      std.dataType ? `类型: ${std.dataType}` : "",
      std.unit ? `单位: ${std.unit}` : "",
      std.constraint ? `约束: ${std.constraint}` : "",
    ].filter(Boolean).join("\n");
    await putTerm(STD_GLOSSARY, std.code || std.name || "standard", std.name || std.code || "", desc);
  } catch {
    /* best-effort */
  }
}

/**
 * 指标 → Glossary Term。best-effort,永不抛。
 * term 用指标名,description 拼口径/类型/单位。
 */
export async function pushMetricGlossary(m: {
  name?: string; metricType?: string; caliber?: string; unit?: string; description?: string;
}): Promise<void> {
  try {
    if (!isOmConfigured()) return;
    const ok = await ensureGlossary(METRIC_GLOSSARY, "指标体系", "平台指标体系自动同步");
    if (!ok) return;
    const desc = [
      m.caliber || m.description || m.name || "",
      m.metricType ? `类型: ${m.metricType === "derived" ? "派生指标" : "原子指标"}` : "",
      m.unit ? `单位: ${m.unit}` : "",
    ].filter(Boolean).join("\n");
    await putTerm(METRIC_GLOSSARY, m.name || "metric", m.name || "", desc);
  } catch {
    /* best-effort */
  }
}
