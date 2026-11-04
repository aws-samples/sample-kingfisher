"use strict";
// @genbi/core — 业务口径（语义层）的格式化纯逻辑，零 IO。
// context.ts 的格式化部分下沉:DynamoDB 读写(listContext/getContextForGrounding 等)
// 留 platform 适配器,此处只放"口径条目 → 提示文本 / 可观测展示项"的纯转换,
// 供 platform 各消费方(GenBI/codegen/诊断/Copilot)+ 容器 / Lambda 共用同一份格式化。
Object.defineProperty(exports, "__esModule", { value: true });
exports.GROUNDING_MAX_ENTRIES = exports.CONTEXT_SECTION_TITLE = exports.CONTEXT_KIND_LABEL = void 0;
exports.contextToPromptText = contextToPromptText;
exports.contextToUsedItems = contextToUsedItems;
exports.filterAndRankContext = filterAndRankContext;
exports.contextToGroundingItems = contextToGroundingItems;
// 口径 kind → 展示标签(语义层单一事实源:prompt 文本与前端可观测项共用同一份 label)。
exports.CONTEXT_KIND_LABEL = {
    caliber: "口径/指标定义", term: "术语/别名", rule: "规则/注意事项",
};
// 注入提示块的统一 section 头(语义层单一事实源:codegen / GenBI / 诊断 共用同一措辞,
// 避免各消费方各写各的"## 业务口径..."导致模型遵循口径的强度不一致)。
exports.CONTEXT_SECTION_TITLE = "业务口径与规则（必须遵循）";
// 拼成注入提示的文本块(唯一格式化器:所有把口径拼进 prompt 的消费方都应走这里)。
function contextToPromptText(entries) {
    if (!entries.length)
        return "";
    const lines = entries.map((e) => `- [${exports.CONTEXT_KIND_LABEL[e.kind] || e.kind}] ${e.title}${e.scope ? `（适用：${e.scope}）` : ""}：${e.body}`);
    return lines.join("\n");
}
function contextToUsedItems(entries) {
    return entries.map((e) => ({
        title: e.title,
        kindLabel: exports.CONTEXT_KIND_LABEL[e.kind] || e.kind,
        ...(e.scope ? { scope: e.scope } : {}),
    }));
}
// ── 口径 grounding 检索(纯逻辑,零 IO)：过滤启用 + 关键词相关性排序 + 截断 ──
// 【为什么进 core】platform(context.ts getContextForGrounding)与 Lambda
// (genbi-skills index.js lookupBusinessContext)此前各写一份"过滤+排序+slice",
// 且措辞已漂移(relevant vs score)。收敛于此,两个 JS/TS 运行时共用同一算法。
// 语义(与两版历史行为一致):关键词只用于"相关项排前",绝不丢弃任何启用条目。
// 单条条目对关键词的相关性:标题/正文/标签/范围分词后,任一词被关键词串包含即相关。
// (沿用历史实现的"kw.includes(w)"方向 —— 关键词串包含条目的词,非条目包含关键词。)
function isRelevantTo(e, kwLower) {
    return `${e.title || ""} ${e.body || ""} ${(e.tags || []).join(" ")} ${e.scope || ""}`
        .toLowerCase()
        .split(/[\s,，、]+/)
        .some((w) => w && kwLower.includes(w));
}
// grounding 检索的默认返回上限(与两版历史 slice(0,40) 一致)。
exports.GROUNDING_MAX_ENTRIES = 40;
// 过滤启用条目 + (可选)按关键词相关性稳定排序 + 截断上限。纯函数,不做 IO。
// entries 由调用方先从存储读出(platform 走 docClient、Lambda 走裸 @aws-sdk),
// 本函数只做引擎无关的筛选/排序/截断。
function filterAndRankContext(entries, keywords, limit = exports.GROUNDING_MAX_ENTRIES) {
    const enabled = entries.filter((e) => e.enabled !== false);
    const kw = (keywords || "").trim().toLowerCase();
    if (kw) {
        // 稳定排序:相关项(0)排在不相关项(1)前,同档保持原相对顺序。
        enabled.sort((a, b) => (isRelevantTo(a, kw) ? 0 : 1) - (isRelevantTo(b, kw) ? 0 : 1));
    }
    return enabled.slice(0, limit);
}
function contextToGroundingItems(entries) {
    return entries.map((e) => ({
        kind: exports.CONTEXT_KIND_LABEL[e.kind] || e.kind,
        title: e.title,
        definition: e.body,
        scope: e.scope || null,
        tags: e.tags || [],
    }));
}
