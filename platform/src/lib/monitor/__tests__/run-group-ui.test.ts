// @kf-batch 50-WP5-rungroup
// O2 前端门禁(判据 ACCEPTANCE 段 `o2` E-160 / E-162 / E-163 / E-165 / E-166 / E-168)。
//
// 🔴 为什么是文本门禁:这两个组件要 antd + ScopeProvider + fetch 一整套才跑得起来,
//    真行为由**无头页面级验收**(段 `o2`)覆盖;这里钉的是「机械可识别的形状」——
//    尤其是那几条一旦写错就会静默出错的:默认勾选跟随视角 / 绝不动顶栏范围 / 只看派生值。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RUN_GROUP_STATUSES } from "@/lib/monitor/run-group";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");

const PANEL = "components/monitor/RunGroupPanel.tsx";
// @kf-batch 50-WP18-workflow-fanout —— 运行对话框已搬进自己的文件(理由:`/workflow` 页只用弹窗,
// 却因为同文件里有 `/api/run-groups` 的读取而被读取级台账算成欠账)。判据跟着指到它现在住的地方。
const RUN_MODAL = "components/monitor/RunTargetsModal.tsx";
const PAGES: Array<[string, string]> = [
  ["app/etl-jobs/page.tsx", "etl-job"],
  ["components/engines/EmrJobPanel.tsx", "engine-job"],
];

describe("🔴 运行对话框:默认跟随视角(E-165),且**绝不**动顶栏的执行范围", () => {
  const src = strip(read(RUN_MODAL));

  it("target 视角 ⇒ 默认只勾本区;compare / global ⇒ 勾全部绑定", () => {
    expect(src).toContain('if (scope.kind === "target" && bindings.includes(scope.targetId)) setPicked([scope.targetId]);');
    expect(src).toContain("else setPicked(bindings);");
    // 每次打开都重算 —— 用户切了视角再点运行,默认值必须跟着变
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!open\) return;/);
    expect(src).toMatch(/\}, \[open, scope, bindings\]\)/);
  });

  it("🔴 全文件不许出现 `setScope`(那会静默移动顶栏的执行范围 —— INTERACTION §9 第 1 条)", () => {
    expect(src.includes("setScope")).toBe(false);
  });

  it("确认按钮必须**复述**跑几个区 / 跑哪个区(点下去之前要知道会发生什么)", () => {
    const i = src.indexOf("const okText =");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 420);
    expect(block).toContain("{n} 个区各跑一次");
    expect(block).toContain("{verb} · {where}");
    // 一个都没勾 ⇒ 按钮禁用(不许提交一个空运行)
    expect(src).toContain("okButtonProps={{ disabled: n === 0");
  });

  for (const [rel, kind] of PAGES) {
    it(`${rel}:只有绑定 >1 才弹对话框(单绑定动线逐字节不变),且重试链只由服务端计划驱动`, () => {
      const s2 = strip(read(rel));
      expect(s2).toMatch(/if \((bindingTargetsOf\(sel\)\.length|targets\.length) > 1\) setRunPick\(true\);/);
      expect(s2).toContain("else void doRun();");
      // 重试:必须把服务端给的 targets + retryOfRunGroupId 一起传回运行路由
      expect(s2).toContain("retryOfRunGroupId: plan.retryOfRunGroupId");
      expect(s2).toContain("targets: plan.targets");
      // 🔴 前端不许自己挑失败区(那可能把成功的区也重跑一遍)
      expect(s2, "前端自己算失败区 = 绕过服务端权威").not.toMatch(/filter\(\([^)]*\) => [^)]*status === "failed"\)/);
      expect(s2).toContain(`kind="${kind}"`);
    });
  }
});

describe("🔴 组行:只看服务端派生值 / 不折状态 / 逐区如实回报", () => {
  const src = strip(read(PANEL));

  it("状态取 `derivedStatus`,**不许**回落到表里的 `status`(那是缓存 = 第二真值源)", () => {
    const uses = src.match(/derived\[r\.runGroupId\] \?\? r\.derivedStatus/g) ?? [];
    expect(uses.length, "两处(状态列 + 操作列)都要用派生值").toBe(2);
    expect(src, "回落到 r.status 就是把缓存显示给用户").not.toContain("?? r.status");
  });

  it("状态词表与实现一致:六个态都有人话,不许把 partial-failed 和 failed 合并", () => {
    const i = src.indexOf("const GROUP_STATUS");
    const block = src.slice(i, src.indexOf("};", i));
    for (const st of RUN_GROUP_STATUSES) expect(block, `缺态 ${st}`).toContain(`${st.includes("-") ? `"${st}"` : st}:`);
    expect(block).toContain("部分成功");
    expect(block).toContain("全部失败");
    expect(block.indexOf("部分成功")).not.toBe(block.indexOf("全部失败"));
  });

  it("🔴 取消结果逐区点名:停不下来的必须单独说(不许把「2 个区停了 1 个」说成全部取消)", () => {
    const i = src.indexOf("const doCancel");
    const block = src.slice(i, src.indexOf("const doRetry", i));
    expect(block).toContain("res.filter((x) => x.cancelled)");
    expect(block).toContain("res.filter((x) => !x.cancelled)");
    expect(block).toContain("个区没停下来");
  });

  it("🔴 读不到列表**不当成「没有联动运行」**(读不到 ≠ 没有)", () => {
    expect(src).toContain('data-testid="run-groups-error"');
    expect(src).toContain("setRows(null)");
    expect(src, "把异常吞成空数组就是撒谎").not.toContain("setRows([])");
  });

  it("E-168:子行必须显示**定义版本**(跨区版本差要看得见,它刻意不进分组键)", () => {
    expect(src).toContain('dataIndex: "definitionVersion"');
    expect(src).toContain('data-testid="rg-child-defver"');
  });

  it("环境被删了 region 读不到 ⇒ 标注但**这一行照样列**(与卡片 GC-16 同一条纪律)", () => {
    expect(src).toContain('data-testid="rg-child-region-na"');
    expect(src, "按 region 过滤掉这一行 = 用户以为运行记录丢了").not.toMatch(/filter\(\([^)]*\) => [^)]*\.region\)/);
  });

  it("区数显示「真起了/请求了」两个数(只给后者会把「有一个区压根没提交」说成正常)", () => {
    expect(src).toContain("{r.childCount}/{(r.requestedTargets || []).length}");
  });

  it("平台不认识的子状态要弹出来(静默 = 有 run 的死活没人知道)", () => {
    expect(src).toContain("unknownChildStatuses");
    expect(src).toContain("状态平台不认识");
  });
});
