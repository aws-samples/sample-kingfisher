// 「一条 SLA 的一次运行算一次预测」只有一个作者(lib/baseline/sla-predict.ts):
//   预测接口与后台评估泵都调它;路由文件里不许再长出第二份预测逻辑(抄两份的下场是页面数字与后台推送的数字对不上)。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");

describe("🔴 SLA 预测单一作者", () => {
  it("POST /api/sla/predict 只调 predictSlaRun,不再自己 predictEta / 读基线 / 推送", () => {
    const src = read("app/api/sla/predict/route.ts");
    expect(src).toContain('from "@/lib/baseline/sla-predict"');
    for (const banned of ["predictEta", "confirmBreachMultiWindow", "getBaseline", "baselineFor", "pushBreachAlert", "saveLastPrediction", "normalizeRuntime"]) {
      expect(src, `route.ts 不许再出现 ${banned}`).not.toContain(banned);
    }
  });
  it("后台执行体对在途运行走 predictInFlightRuns(同一份 predictSlaRun),规则评估走 evaluate(与「立即评估」同一函数)", () => {
    const tick = read("lib/alerting/tick.ts");
    expect(tick).toContain('from "@/lib/baseline/sla-predict"');
    expect(tick).toMatch(/predictInFlightRuns\(/);
    expect(tick).toContain('from "@/lib/alerting/evaluate"');
    expect(tick).toMatch(/\bevaluate\(projectId/);
    const core = read("lib/baseline/sla-predict.ts");
    expect(core).toMatch(/export async function predictSlaRun/);
    expect(core).toMatch(/export async function predictInFlightRuns/);
    // 在途 = 运行台账的 running(与状态词单一口径)
    expect(core).toContain('":running": "running"');
  });
  it("告警中心与 SLA 面板的周期文案都从 types.ts 的常量换算(不另写数字)", () => {
    for (const rel of ["app/alerting/page.tsx", "components/alerting/SlaPanel.tsx"]) {
      const src = read(rel);
      expect(src, rel).toContain('import { ALERTING_PUMP_INTERVAL_MS } from "@/lib/alerting/types"');
      expect(src, rel).toMatch(/ALERTING_PUMP_INTERVAL_MS \/ 60_000/);
    }
  });
});
