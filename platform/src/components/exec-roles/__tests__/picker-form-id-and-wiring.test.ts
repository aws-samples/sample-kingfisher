// ExecutionRolePicker:
//   ① 服务端真渲染(renderToStaticMarkup + 真 I18nProvider):三个 testid(下拉 / 刷新 / 手填开关)与「检查权限」都在,平台默认文案在;
//   ② Form.Item 注入的 id 透传到控件(教训:漏传 ⇒ 字段 id 消失);负向对照:不在 Form.Item 里就没有;
//   ③ 四处表单都换成了选择器(源码字面:import + <ExecutionRolePicker engine=…);旧的「执行角色 ARN」自由文本 Input 不许回来(DMS 通道除外);
//   ④ 候选接口 URL 带 targetId=(执行范围读取守卫认它);英文词典含本组件全部 t() 键由 en-coverage-guard 另钉。
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Form } from "antd";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import I18nProvider from "@/lib/i18n/I18nProvider";
import ExecutionRolePicker from "@/components/exec-roles/ExecutionRolePicker";

const h = React.createElement;
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");

const ADVISOR = { engine: "glue" as const, resources: { needsS3Tables: true, needsGlueCatalog: true, needsRedshift: true, needsCloudWatchLogs: true } };

function render(withItem: boolean): string {
  const picker = h(ExecutionRolePicker, { engine: "glue", targetId: "tgt_home", advisorRequest: ADVISOR });
  const body = withItem ? h(Form.Item, { name: ["glueConfig", "executionRoleArn"], label: "执行角色" }, picker) : picker;
  return renderToStaticMarkup(h(I18nProvider, null, h(Form, null, body)));
}

describe("ExecutionRolePicker 服务端真渲染", () => {
  it("三个控件 testid + 检查权限 + 平台默认文案都在;下拉是 antd Select(不是自由文本)", () => {
    const html = render(false);
    expect(html).toContain('data-testid="exec-role-picker-glue"');
    expect(html).toContain('data-testid="exec-role-select"');
    expect(html).toContain('data-testid="exec-role-refresh"');
    expect(html).toContain('data-testid="exec-role-manual-toggle"');
    expect(html).toContain('data-testid="exec-role-check"');
    expect(html).toContain("刷新");
    expect(html).toContain("手动输入 ARN");
    expect(html).toContain("检查权限");
    expect(html).toContain("glue.amazonaws.com");
    expect(html).toMatch(/class="[^"]*ant-select[^"]*"/);
  });
  it("Form.Item 注入的 id = glueConfig_executionRoleArn 透传到 Select 的输入控件;负向对照:不在 Form.Item 里就没有", () => {
    expect(render(true)).toMatch(/\bid="glueConfig_executionRoleArn"/);
    expect(render(false)).not.toContain('id="glueConfig_executionRoleArn"');
  });
});

describe("四处表单接线(源码字面)", () => {
  const sites: Array<[string, string]> = [
    ["app/etl-jobs/page.tsx", 'engine="glue"'],
    ["components/engines/EmrJobPanel.tsx", 'engine="emr"'],
    ["app/sync/SyncTaskModal.tsx", 'engine="glue"'],
    ["app/realtime-compute/page.tsx", 'engine="flink"'],
  ];
  for (const [file, engineAttr] of sites) {
    it(`${file}:import ExecutionRolePicker 且放了 <ExecutionRolePicker ${engineAttr}`, () => {
      const src = strip(read(file));
      expect(src).toContain('import ExecutionRolePicker from "@/components/exec-roles/ExecutionRolePicker"');
      expect(src).toMatch(new RegExp(`<ExecutionRolePicker[\\s\\S]{0,200}${engineAttr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    });
  }
  it("旧的「执行角色 ARN」自由文本 Input 只许留在数据同步 DMS 通道(DMS 角色不在本刀),其余三处不许回来", () => {
    for (const f of ["app/etl-jobs/page.tsx", "components/engines/EmrJobPanel.tsx", "app/realtime-compute/page.tsx"]) {
      expect(strip(read(f)), `${f} 又出现自由文本执行角色输入`).not.toMatch(/<Input[^>]*addonBefore=\{t\("执行角色 ARN"\)\}/);
    }
    const sync = strip(read("app/sync/SyncTaskModal.tsx"));
    expect(sync).toMatch(/watchChannel === "glue" \?/);
    expect(sync).toMatch(/watchChannel === "dms" \? <RoleAdvisorPanel/);
  });
  it("候选接口 URL 带 targetId=(执行范围读取守卫认它),检查权限走 POST /api/exec-roles/preflight", () => {
    const src = read("components/exec-roles/ExecutionRolePicker.tsx");
    expect(src).toMatch(/\/api\/exec-roles\/candidates\?engine=\$\{encodeURIComponent\(engine\)\}&targetId=\$\{encodeURIComponent\(targetId\)\}/);
    expect(src).toContain('fetch("/api/exec-roles/preflight", {');
    expect(src).toMatch(/method: "POST"/);
  });
});

describe("离线计算页保存被拒时的拒因可见(R5 / R8 的友好半边;子代理读码抓到:原一句「保存失败」吞掉预检原话)", () => {
  const src = strip(read("app/etl-jobs/page.tsx"));
  it("doSave 返回布尔并把 d.error.message 原话给用户看(长文走 Modal.error pre-wrap,带 etl-save-rejection testid;短文走 message.error)", () => {
    expect(src).toMatch(/const doSave = async \(\): Promise<boolean> =>/);
    expect(src).toMatch(/const reason = String\(d\?\.error\?\.message \|\| ""\)\.trim\(\);/);
    expect(src).toContain('data-testid="etl-save-rejection"');
    expect(src).toMatch(/Modal\.error\(\{/);
    expect(src).toMatch(/message\.error\(reason \? t\("保存失败:\{reason\}", \{ reason \}\) : t\("保存失败"\)\)/);
    expect(src, "旧写法「else message.error(t(\"保存失败\"))」不许回来").not.toMatch(/else message\.error\(t\("保存失败"\)\)/);
  });
  it("运行 / 试运行 / 补数 / 下发预览 / 发布五处都在保存被拒时停下(不再拿旧定义往下提交)", () => {
    const calls = src.match(/await doSave\(\)/g) || [];
    expect(calls.length).toBe(5);
    expect((src.match(/if \(!\(await doSave\(\)\)\) return;/g) || []).length).toBe(5);
  });
});
