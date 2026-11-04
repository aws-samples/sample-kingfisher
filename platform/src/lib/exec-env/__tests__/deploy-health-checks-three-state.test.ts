/**
 * deploy-all.sh 第 13 步两个体检函数的**三态**门禁(2026-09-17)。
 *
 * 🔴 为什么在这里接一层:那两个函数只在真部署里执行,而它们各有一个真缺陷 ——
 *   `wiring_check` 把「没权限看 ECS」当成过关(fail-open),`mechanism_check` 把「权限被拒」
 *   误诊成「对象不存在」(白补发一次栈 + 记一笔假失败)。修完必须有人**离线**替它们跑,
 *   否则下一次改 bash 又只能靠一次 2.5 小时的真部署来发现(prod-only-layers 的病)。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

describe("部署体检函数:三态(正常 / 真缺 / 看不了)", () => {
  it("🔴 离线替身 20 例全绿,且**真的跑了** 20 例(空跑也算过是不行的)", () => {
    const r = spawnSync("bash", ["infra/test/deploy-all-checks/test_checks.sh"], {
      cwd: REPO,
      encoding: "utf8",
    });
    const all = `${r.stdout || ""}${r.stderr || ""}`;
    expect(r.status, all.slice(-1200)).toBe(0);
    expect(all).toContain("全部通过(20 例)");
    // 逐条点名:改坏任一条都会让这里少一行
    for (const needle of [
      "权限被拒 ⇒ **BLIND=1**",
      "真没有 TaskDef",
      "接线被冲回",
      "直连被拒但栈资源清单坐实",
      "环境/权限错误(2)⇒ **门未执行**(3)",
      // 资产自愈按目的地自己的区(2026-10-10 第二账号彩排:主控区 ≠ us-east-1 时 WAF 资产被全拒)
      "两个区的资产都预置,且各自用**自己的区**读写",
      "不在 bootstrap 清单里 ⇒ 拒绝且**一个请求都不往那个区发**",
      "零请求打到别人账号",
      "WAF 区单一真值",
      // 部署机环境里残留 AWS_REGION 不许把控制面带进别的区(2026-10-10 第二账号彩排:11 栈全建进 us-east-1)
      "deploy-all.sh:环境里残留 us-east-1 ⇒ 对齐成主控区",
      "redeploy-platform.sh:环境里残留 us-east-1 ⇒ 对齐成主控区",
      "10-bootstrap-cognito.sh:环境里残留 us-east-1 ⇒ 对齐成主控区",
      "之前做主控区比对",
      "homeRegionMismatch 四态",
    ]) {
      expect(all, `替身少跑了这条:${needle}`).toContain(needle);
    }
  }, 60_000); // 真 bash 跑 20 例;机器满载(并行 docker 构建)时 5s 默认超时会假红(2026-10-14 实测 5.49s)
});
