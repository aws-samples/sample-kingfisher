// UX ④ —— 系统设置「更换全局默认模型」下拉:显示「系列 + 友好名」,完整 id 退成次要文字(调用点判据)。
//   用户 2026-10-20 走查:下拉直接露完整模型 id(us.anthropic.claude-opus-4-5-…)⇒ 拍板「显示系列 + 友好名」。
//   钉的事实:① 分组仍按服务端 families[](系列)② 每项友好名 = 目录 displayName(Bedrock modelName / inferenceProfileName),
//   不编造;完整 id 仍在选项里(次要小字)且可搜(searchText = 友好名 + id)③ 「当前生效」三处带友好名,
//   `ai-model-effective` 的文本仍是 id(页面驱动判据 / 升级对账按 id 读)。真环境那一半由 p51b / p43g 页面驱动段盯。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("🔴 UX ④ AiModelCard 模型下拉友好名", () => {
  const src = strip(read("components/settings/AiModelCard.tsx"));

  it("选项 label:友好名在前(displayName,目录没给时退回 id),推理配置 / 一期未开放标签,完整 id 次要小字;data-model-id 暴露事实", () => {
    const opt = src.slice(src.indexOf('data-testid="ai-model-option"'), src.indexOf("disabled: gated,"));
    expect(opt).toContain("data-model-id={m.modelId}");
    expect(opt).toContain("{m.displayName || m.modelId}");
    expect(opt).toContain('{m.kind === "profile" ? <Tag style={{ marginLeft: 6 }}>{t("推理配置")}</Tag> : null}');
    expect(opt).toMatch(/<Text type="secondary" style=\{\{ marginLeft: 8, fontSize: 12 \}\}>\{m\.modelId\}<\/Text>/);
    // 旧的纯字符串 label(裸 id)不留
    expect(src).not.toMatch(/label: `\$\{m\.modelId\}/);
  });

  it("搜索按 searchText(友好名 + 完整 id,小写)匹配 —— 老用户 / 判据按 id 搜仍命中;不再 optionFilterProp=label(label 已是节点)", () => {
    expect(src).toContain("searchText: `${m.displayName} ${m.modelId}`.toLowerCase()");
    expect(src).toMatch(/filterOption=\{\(input, opt\) => String\(\(opt as \{ searchText\?: string \} \| undefined\)\?\.searchText \|\| ""\)\.includes\(input\.trim\(\)\.toLowerCase\(\)\)\}/);
    expect(src).not.toContain('optionFilterProp="label"');
  });

  it("分组仍由 families[] 驱动(系列 = 分组标题,前端不硬编码)", () => {
    expect(src).toContain("options={familyGroups.map((f) => {");
    expect(src).toContain("label: t(f.label),");
  });

  it("「当前生效」三处(卡片 / 弹窗 / 影响预览)都带 friendlyName;友好名只来自目录,找不到不编造;ai-model-effective 文本仍是 id", () => {
    expect((src.match(/\{friendlyName\(/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(src).toMatch(/const entry = modelId \? catalog\?\.find\(\(m\) => m\.modelId === modelId\) : undefined;/);
    expect(src).toContain("entry?.displayName && entry.displayName !== modelId");
    expect(src).toContain('<Text code data-testid="ai-model-effective">{current.modelId}</Text>');
  });
});
