// 语义层 P1+P2 单测:业务口径注入(inprocess systemPrompt)+ 可观测契约(usedContext)。
// 验证顶层设计三条契约:① contextToPromptText 唯一格式化 ② systemPrompt 注入口径 ③ contextToUsedItems 转前端展示项。
import { describe, it, expect } from "vitest";
import { contextToPromptText, contextToUsedItems, CONTEXT_SECTION_TITLE, type ContextEntry } from "../context";
import { filterAndRankContext, contextToGroundingItems } from "../core/context-format";
import { systemPrompt } from "../prompt";
import { buildCatalogText } from "../core/catalog";

const entries: ContextEntry[] = [
  { projectId: "global", entryId: "1", kind: "term", title: "大R", body: "高付费玩家，累计充值 Top 分位", enabled: true, createdAt: "", updatedAt: "" },
  { projectId: "global", entryId: "2", kind: "caliber", title: "ROAS", body: "归因收入 / 广告花费", scope: "本项目", enabled: true, createdAt: "", updatedAt: "" },
  { projectId: "global", entryId: "3", kind: "rule", title: "收入统一美元", body: "一律用 amount_usd", enabled: true, createdAt: "", updatedAt: "" },
];

describe("语义层:业务口径格式化(唯一事实源)", () => {
  it("contextToPromptText 按 [类型] 标题（适用：scope）：正文 拼行", () => {
    const txt = contextToPromptText(entries);
    expect(txt).toContain("[术语/别名] 大R：高付费玩家");
    expect(txt).toContain("[口径/指标定义] ROAS（适用：本项目）：归因收入");
    expect(txt).toContain("[规则/注意事项] 收入统一美元");
    // 三条各一行
    expect(txt.split("\n")).toHaveLength(3);
  });

  it("空口径 → 空串(不注入)", () => {
    expect(contextToPromptText([])).toBe("");
  });
});

describe("语义层:可观测契约 usedContext", () => {
  it("contextToUsedItems 转前端展示项(标题/本地化类型/范围,不含正文)", () => {
    const items = contextToUsedItems(entries);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ title: "大R", kindLabel: "术语/别名" });
    expect(items[1]).toEqual({ title: "ROAS", kindLabel: "口径/指标定义", scope: "本项目" });
    // 不泄露正文 body
    expect(JSON.stringify(items)).not.toContain("高付费玩家");
  });
});

describe("语义层:口径 grounding 检索(core 单一算法,platform 与 Lambda 共用)", () => {
  const mixed: ContextEntry[] = [
    { projectId: "p", entryId: "1", kind: "term", title: "大R", body: "高付费玩家", scope: "payments", tags: ["VIP"], enabled: true, createdAt: "", updatedAt: "" },
    { projectId: "p", entryId: "2", kind: "caliber", title: "ROAS", body: "收入/广告成本", enabled: true, createdAt: "", updatedAt: "" },
    { projectId: "p", entryId: "3", kind: "rule", title: "禁用项", body: "被禁用", enabled: false, createdAt: "", updatedAt: "" },
  ];

  it("filterAndRankContext 过滤 enabled=false 条目", () => {
    const r = filterAndRankContext(mixed);
    expect(r.map((e) => e.title)).toEqual(["大R", "ROAS"]); // 禁用项被剔除
  });

  it("无关键词 → 保序返回全部启用条目", () => {
    expect(filterAndRankContext(mixed, "").map((e) => e.entryId)).toEqual(["1", "2"]);
  });

  it("关键词命中 → 相关项稳定排前,不丢弃任何启用条目", () => {
    // 关键词串含 "roas" → ROAS 相关排前,大R 不相关排后,但都保留。
    const r = filterAndRankContext(mixed, "roas 广告");
    expect(r.map((e) => e.title)).toEqual(["ROAS", "大R"]);
    expect(r).toHaveLength(2);
  });

  it("limit 截断", () => {
    expect(filterAndRankContext(mixed, "", 1)).toHaveLength(1);
  });

  it("contextToGroundingItems body→definition 映射 + 本地化 kind(Lambda wire 契约)", () => {
    const items = contextToGroundingItems(filterAndRankContext(mixed));
    expect(items[0]).toEqual({ kind: "术语/别名", title: "大R", definition: "高付费玩家", scope: "payments", tags: ["VIP"] });
    // scope 缺省 → null;tags 缺省 → []
    expect(items[1]).toEqual({ kind: "口径/指标定义", title: "ROAS", definition: "收入/广告成本", scope: null, tags: [] });
  });
});

describe("语义层:inprocess systemPrompt 注入口径(根治默认后端零注入)", () => {
  it("传入 businessContext → systemPrompt 含「必须遵循」段 + 口径正文", () => {
    const biz = contextToPromptText(entries);
    const sp = systemPrompt("### mytable\n  - id int", "dev", "redshift", biz);
    expect(sp).toContain(CONTEXT_SECTION_TITLE); // 统一 section 头
    expect(sp).toContain("大R：高付费玩家");
    expect(sp).toContain("归因收入 / 广告花费");
    // 口径块在数据目录【内容】之前(先建立业务语义再看表)。注意"【数据目录】"四字在引导文里也出现过一次,
    // 故用目录内容(catalog 传入的 ### mytable)判位,而非用标题字样。
    expect(sp.indexOf(CONTEXT_SECTION_TITLE)).toBeLessThan(sp.indexOf("### mytable"));
  });

  it("不传 businessContext → systemPrompt 无口径段(向后兼容,零回归)", () => {
    const sp = systemPrompt("### mytable", "dev", "redshift");
    expect(sp).not.toContain(CONTEXT_SECTION_TITLE);
    expect(sp).toContain("【数据目录】"); // 其余结构不变
  });
});

// 阶段3 归一:core systemPrompt 增强支持 agentcore 容器专属可选块(skillsCatalog/published/memory)。
// inprocess 不传 opts → 行为零变化;容器传 opts → 注入对应块。功能全保留。
describe("语义层:systemPrompt opts 可选块(容器/inprocess 共用一份 core)", () => {
  it("不传 opts → 无技能/固化表/记忆段(inprocess 向后兼容零变化)", () => {
    const sp = systemPrompt("### t", "dev", "redshift", "");
    expect(sp).not.toContain("已注册业务技能");
    expect(sp).not.toContain("已固化结果表");
    expect(sp).not.toContain("历史记忆");
  });

  it("传 skillsCatalog → 注入技能清单块 + 【工作方式】强调技能优先", () => {
    const sp = systemPrompt("### t", "dev", "redshift", "", {
      skillsCatalog: [{ name: "roas_by_channel", description: "各渠道ROAS", params: [{ name: "days", required: true }] }],
    });
    expect(sp).toContain("已注册业务技能");
    expect(sp).toContain("roas_by_channel");
    expect(sp).toContain("days*"); // required 参数带 *
    expect(sp).toContain("run_registered_skill");
  });

  it("传 published → 注入固化结果表段", () => {
    const sp = systemPrompt("### t", "dev", "redshift", "", {
      published: [{ schema: "public", table: "dws_roi", title: "渠道ROI" }],
    });
    expect(sp).toContain("已固化结果表");
    expect(sp).toContain("dws_roi");
  });

  it("传 memory → 注入历史记忆段", () => {
    const sp = systemPrompt("### t", "dev", "redshift", "", { memory: "用户偏好用美元" });
    expect(sp).toContain("历史记忆");
    expect(sp).toContain("用户偏好用美元");
  });
});

describe("语义层:buildCatalogText 归一(容器/inprocess/codegen 共用)", () => {
  it("不传 opts → 原 Redshift 版逐字不变(codegen 零影响)", () => {
    const t = buildCatalogText([{ schema: "public", table: "players", columns: [{ name: "id", type: "int" }] }], "dev");
    expect(t).toContain("Amazon Redshift");
    expect(t).toContain("### public.players");
    expect(t).not.toContain("s3tablescatalog"); // 无 Athena 前缀
  });

  it("engine=athena → 三段式联邦目录限定名", () => {
    const t = buildCatalogText([{ schema: "gamedata", table: "players", columns: [{ name: "id", type: "int" }] }], "gamedata", { engine: "athena", athenaRef: "s3tablescatalog/bgp-table-bucket" });
    expect(t).toContain("Amazon Athena");
    expect(t).toContain('"s3tablescatalog/bgp-table-bucket"."gamedata"."players"');
  });

  it("published/description 行内标注(inprocess 检索场景)", () => {
    const t = buildCatalogText([{ schema: "public", table: "dws", columns: [{ name: "x", type: "int" }], published: { title: "汇总", question: "各渠道" }, description: "渠道汇总表" }], "dev", { engine: "redshift", retrievalHeader: true });
    expect(t).toContain("【已固化结果表，来源问题：各渠道】");
    expect(t).toContain("描述：渠道汇总表");
    expect(t).toContain("本次问题已检索出");
  });
});
