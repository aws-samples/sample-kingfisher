"use strict";
// @genbi/core — GenBI 语义表检索的引擎无关核心逻辑（LLM 重排序）。
//
// 显式的"表检索"阶段:每次提问先从数据目录中语义检索最相关的表,再据此 grounded 生成 SQL。
//   1) 构建语义目录(表名 + 字段 + OpenMetadata 业务描述 + 已固化结果表的来源问题/口径);
//   2) 关键词预筛(表多时先粗筛,控制喂给模型的候选量);
//   3) LLM 重排序(经注入的 ModelClient)按问题相关性选出 Top-K,固化表口径匹配时优先;
//   4) 健壮回退:解析失败/异常一律回退到"全部表",绝不让问数中断。
//
// 【core 契约】模型调用经 ModelClient 注入(不直连 Bedrock SDK);OM 描述由调用方(platform
// 适配器)预取后传入(omDesc 参数),core 本身零 AWS SDK / 零 OM 依赖。
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOPK = exports.PREFILTER_CAP = void 0;
exports.buildSemanticCatalog = buildSemanticCatalog;
exports.selectRelevantTables = selectRelevantTables;
exports.PREFILTER_CAP = 40; // 喂给重排序模型的最大候选表数（超过则先关键词粗筛）
exports.TOPK = 6;
// ── 构建语义目录 ──
function buildSemanticCatalog(tables, omDesc, published) {
    const pubByTable = new Map();
    for (const p of published)
        if (p.targetTable)
            pubByTable.set(p.targetTable.toLowerCase(), p);
    return tables.map((t) => {
        const key = t.table.toLowerCase();
        const pub = pubByTable.get(key);
        return {
            schema: t.schema,
            table: t.table,
            columns: t.columns,
            ...(omDesc[key] ? { description: omDesc[key] } : {}),
            ...(pub ? { published: { title: pub.title, question: pub.question } } : {}),
        };
    });
}
// ── 关键词粗筛（表多时控制候选量） ──
function tokenize(s) {
    return (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 2);
}
function prefilter(question, entries, cap) {
    if (entries.length <= cap)
        return entries;
    const qts = new Set(tokenize(question));
    const scored = entries.map((e) => {
        const hay = [
            e.table,
            e.schema,
            e.description || "",
            e.published?.question || "",
            e.published?.title || "",
            ...e.columns.map((c) => c.name),
        ].join(" ");
        const hts = tokenize(hay);
        let score = 0;
        for (const t of hts)
            if (qts.has(t))
                score++;
        if (e.published)
            score += 2; // 固化表加权（高价值、口径已固定）
        return { e, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, cap).map((x) => x.e);
}
// ── LLM 重排序：选出最相关的表 ──
function entryBrief(e) {
    const cols = e.columns.slice(0, 16).map((c) => c.name).join(", ");
    const tags = [];
    if (e.published)
        tags.push(`已固化结果表（来源问题：${e.published.question || e.published.title}）`);
    const desc = e.description ? `描述：${e.description}。` : "";
    return `- ${e.schema}.${e.table}${tags.length ? `【${tags.join("；")}】` : ""}：${desc}字段：${cols}`;
}
function extractJson(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m)
        return null;
    try {
        return JSON.parse(m[0]);
    }
    catch {
        return null;
    }
}
// selectRelevantTables:纯逻辑 + 一次模型调用(经注入的 ModelClient,不直连 Bedrock)。
async function selectRelevantTables(question, tables, published, omDesc, model) {
    const catalog = buildSemanticCatalog(tables, omDesc, published);
    if (catalog.length === 0)
        return { selected: [], matches: [], usedFallback: true };
    if (catalog.length === 1) {
        const e = catalog[0];
        return { selected: catalog, matches: [{ schema: e.schema, table: e.table, reason: "唯一可用表", preferred: !!e.published }], usedFallback: false };
    }
    const candidates = prefilter(question, catalog, exports.PREFILTER_CAP);
    const byKey = new Map(candidates.map((e) => [`${e.schema}.${e.table}`.toLowerCase(), e]));
    const system = `你是数据目录检索助手。根据用户的分析问题，从候选数据表中选出**最相关**的表（用于后续生成 SQL 回答）。规则：
- 优先选择标注"已固化结果表"的表：若其口径与用户问题一致，直接选它（结果已预计算，更快、口径统一）。
- 只在确有必要时才选多张表（如需 JOIN）；通常选 1-3 张，最多 ${exports.TOPK} 张。
- 不要选与问题无关的表。
- 严格只输出 JSON，格式：{"tables":[{"schema":"public","table":"xxx","reason":"为何相关(简短中文)","preferred":true|false}],"note":"可选总体说明"}。preferred 表示是否为已固化结果表。`;
    const user = `用户问题：${question}\n\n候选表：\n${candidates.map(entryBrief).join("\n")}`;
    try {
        const resp = await model.converse({
            system,
            messages: [{ role: "user", content: user }],
            maxTokens: 700,
            temperature: 0,
        });
        const text = resp.text;
        const parsed = extractJson(text);
        const picks = Array.isArray(parsed?.tables) ? parsed.tables : [];
        const matches = [];
        const selected = [];
        for (const p of picks) {
            const tbl = String(p?.table || "").toLowerCase();
            const sch = String(p?.schema || "public").toLowerCase();
            const e = byKey.get(`${sch}.${tbl}`) || candidates.find((c) => c.table.toLowerCase() === tbl);
            if (e && !selected.includes(e)) {
                selected.push(e);
                // preferred 只认"真正登记过的固化表"(e.published)，不轻信模型自报的 p.preferred，避免假固化标记。
                matches.push({ schema: e.schema, table: e.table, reason: String(p?.reason || "相关").slice(0, 120), preferred: !!e.published });
            }
        }
        if (selected.length === 0) {
            // 模型没选出有效表 → 回退全部，保证问数不中断。
            return { selected: catalog, matches: [], note: "未检索到明确匹配，使用全部表", usedFallback: true };
        }
        return { selected, matches, note: typeof parsed?.note === "string" ? parsed.note : undefined, usedFallback: false };
    }
    catch {
        return { selected: catalog, matches: [], note: "检索异常，回退全部表", usedFallback: true };
    }
}
