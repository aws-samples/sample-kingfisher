// @kf-batch 42-ux-feedback —— 数据源弹窗成功提示的单一作者是页面:编辑 ⇒「已更新」,新建 ⇒ 报落点。
// 修前编辑成功弹两条(弹窗「已更新」+ 页面「已在主控区建好这条数据源」),第二条说错了事。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("编辑 / 新建成功提示", () => {
  const modal = read("DataSourceModal.tsx");
  const page = read("page.tsx");
  it("弹窗 onSuccess 带 mode:编辑成功 onSuccess(\"updated\")、向导「完成」onSuccess(\"created\");弹窗自己不弹「已更新」", () => {
    expect(modal).toMatch(/onSuccess: \(mode: "created" \| "updated"\) => void;/);
    expect(modal).toMatch(/if \(isEdit\) onSuccess\("updated"\);/);
    expect(modal).toContain('onClick={() => onSuccess("created")}');
    expect(modal).not.toMatch(/message\.success\(t\("已更新"\)\)/);
  });
  it("页面按 mode 分流:updated ⇒ 只「已更新」;created ⇒ 报落点(主控区 / 某区)", () => {
    expect(page).toMatch(/onSuccess=\{\(mode\) => \{[\s\S]*?if \(mode === "updated"\) message\.success\(t\("已更新"\)\);\s*else message\.success\(createRegion \? t\("已在 \{r\} 建好这条数据源"/);
  });
});
