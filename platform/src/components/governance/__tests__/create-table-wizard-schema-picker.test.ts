// UX ③ —— 「新建表」向导 schema / 命名空间从手打改为「下拉已有 + 可输新」(调用点判据)。
//   用户 2026-10-20 走查:建表向导 schema 要手打 ⇒ 拍板「改下拉已有 schema + 可输新」。
//   钉的事实:① 选定执行区后按类型读该区清单(带 targetId;Redshift 用 mode=schemas 只列名,S3 Tables 读 namespaces)
//   ② 项目私有 proj_* 不进候选 ③ AutoComplete 包着原来的 input,testid 仍是 ct-schema(页面驱动判据 / 用户照旧能直接输入)
//   ④ 候选数量暴露在 DOM(ct-schema-hint data-count)便于页面判据读事实。真环境那一半由 p47c / p49 页面驱动段盯。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("🔴 UX ③ CreateTableWizard schema 下拉可输新", () => {
  const src = strip(read("components/governance/CreateTableWizard.tsx"));

  it("按执行区 + 表类型读已有清单:Redshift → /api/redshift/schemas?targetId=…&mode=schemas;S3 Tables → /api/athena/tables?targetId=…;没选区不读", () => {
    expect(src).toContain("`/api/redshift/schemas?targetId=${encodeURIComponent(targetId)}&mode=schemas`");
    expect(src).toContain("`/api/athena/tables?targetId=${encodeURIComponent(targetId)}`");
    expect(src).toMatch(/if \(!open \|\| !targetId\) \{ setSchemaOptions\(\[\]\); return; \}/);
    expect(src).toMatch(/\}, \[open, kind, targetId\]\);/);
  });

  it("项目私有 schema(proj_*)不进候选;候选去重排序", () => {
    expect(src).toContain('names.filter((n) => n && !n.startsWith("proj_"))');
    expect(src).toMatch(/Array\.from\(new Set\([\s\S]*?\)\)\.sort\(\)/);
  });

  it("AutoComplete 包着 input:testid 仍是 ct-schema(可直接输入新名),候选按已输前缀过滤;原裸 Input 写法不留", () => {
    expect(src).toMatch(/<AutoComplete[\s\S]*?options=\{schemaOptions\.filter\(\(n\) => !schema \|\| n\.toLowerCase\(\)\.includes\(schema\.toLowerCase\(\)\)\)[\s\S]*?<Input data-testid="ct-schema"/);
    expect(src).not.toMatch(/<Input data-testid="ct-schema" style=\{\{ marginTop: 6 \}\} value=\{schema\}/);
  });

  it("候选数量与读取态暴露到 DOM(ct-schema-hint data-count),文案按类型整句(schema / 命名空间各三态)", () => {
    expect(src).toContain('data-testid="ct-schema-hint" data-count={schemaOptions.length}');
    for (const zh of ["正在读取该区已有的 schema…", "该区已有 {n} 个 schema 可直接选,也可输入新名称", "该区还没有可选的 schema,输入新名称即可",
      "正在读取该区已有的命名空间…", "该区已有 {n} 个命名空间可直接选,也可输入新名称", "该区还没有可选的命名空间,输入新名称即可"]) {
      expect(src, zh).toContain(`t("${zh}"`);
    }
  });
});
