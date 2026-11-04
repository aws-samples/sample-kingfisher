// 🔴🔴🔴 闭合判据:**引擎必备基线 ⊆ 权限边界**。
//
// 【它挡的是什么】(2026-09-22 真环境当场撞到,B-21 的第七层)
//   一键建出来的角色 = **内联策略 ∩ PermissionsBoundary**。当天的实测:
//   对账补齐把 8 条语句(含 `BaselineEmrVpcEni`)都写进了角色,而启动前预检仍报
//     `ec2:CreateNetworkInterface → *(implicitDeny)`
//   —— 因为边界 `bgp-job-role-boundary` 的 `AllowedJobActions` 里**一条 `ec2:*` 都没有**,
//   也没有分片上传三件套。⇒ **「权限补齐了」与「这个角色真能用」是两件事**,中间卡着这个上限。
//
// 【为什么必须做成判据而不是「记住要同步改」】
//   这两份清单天然会分开演进:必备基线在 `platform/src`,边界在 `infra/lib/platform-stack.ts`。
//   本仓已有同形的老账:「两份清单必须逐字相等」只靠人记 ⇒ 只改一处 = 另一处静默失效
//   (`capability-matrix-lists.test.ts` 就是为这个立的)。
//   ⇒ 这里把「基线里每一个动作都必须被边界允许」做成机械判据:加一条必备权限而忘了放宽边界,当场红。
//
// 🔴 判据只判**方向**:基线 ⊆ 边界。反向不判 —— 边界可以更宽(它是上限,给别的引擎/别的作业留空间)。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { engineBaseline } from "../engine-baseline";
import type { RoleEngine } from "../types";

const REPO = resolve(__dirname, "../../../../..");
const STACK = "infra/lib/platform-stack.ts";
const CTX = { region: "us-east-1", accountId: "123456789012" };

/**
 * 从 CDK 源码里抽出权限边界允许的动作清单。
 * 🔴 **锚定到它要判的那个对象**:先切到 `sid: "AllowedJobActions"` 那个语句,再取它的 `actions: [...]`
 *   —— 整文件正则会把别的角色(Glue/EMR/TaskRole)的动作一并吃进来,那样判据就永远是绿的。
 */
function boundaryActions(): string[] {
  const src = readFileSync(resolve(REPO, STACK), "utf8");
  const sidAt = src.indexOf('sid: "AllowedJobActions"');
  expect(sidAt, `${STACK} 里找不到 sid: "AllowedJobActions" —— 边界被改名了?判据必须跟着改`).toBeGreaterThan(-1);
  const actAt = src.indexOf("actions: [", sidAt);
  const end = src.indexOf("]", actAt);
  expect(actAt).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(actAt);
  const block = src.slice(actAt, end);
  // 只取**字符串字面量**里形如 `service:Action` 的东西(注释里的说明文字不会命中这个形状)
  return Array.from(block.matchAll(/"([a-z0-9-]+:[A-Za-z0-9*]+)"/g)).map((m) => m[1]);
}

/** 边界里的一条动作(可能带 `*`)是否覆盖基线里那条具体动作。 */
function covers(boundary: string, want: string): boolean {
  if (boundary === want || boundary === "*") return true;
  if (!boundary.includes("*")) return false;
  const re = new RegExp("^" + boundary.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(want);
}

describe("🔴🔴 权限边界必须覆盖引擎必备基线(否则「补齐了权限」≠「角色真能用」)", () => {
  const allowed = boundaryActions();

  it("判据自己先有判别力:真的抽到了边界的动作清单(抽到 0 条 ⇒ 这条判据形同不存在)", () => {
    expect(allowed.length, `从 ${STACK} 的 AllowedJobActions 里一条动作都没抽到`).toBeGreaterThan(10);
    // 反向控制:抽到的必须是那份边界,而不是别的角色的清单 —— 边界里刻意**没有** `glue:*` 这种全放开
    expect(allowed, "抽错对象了:这看起来像 Glue 角色的清单,不是作业角色边界").not.toContain("glue:*");
  });

  it("🔴🔴 EMR / Glue 必备基线里的每一个动作,边界都必须允许", () => {
    const missing: string[] = [];
    for (const eng of ["emr", "glue"] as RoleEngine[]) {
      for (const need of engineBaseline(eng, CTX)) {
        for (const act of need.actions) {
          if (!allowed.some((b) => covers(b, act))) missing.push(`${eng} · ${need.sid} · ${act}`);
        }
      }
    }
    expect(missing,
      `这些必备动作**不在**权限边界里 ⇒ 角色即便写上了也是 implicitDeny\n  ${missing.join("\n  ")}\n`
      + `🔴 2026-09-22 实测就是这么撞到的:对账补齐写进了 BaselineEmrVpcEni,而预检仍报\n`
      + `   ec2:CreateNetworkInterface = implicitDeny(边界里一条 ec2:* 都没有)。\n`
      + `⇒ 要么把动作加进 ${STACK} 的 AllowedJobActions,要么说明为什么它不该是「必备」。`
    ).toEqual([]);
  });

  it("🔴 提权链仍被硬封(加放行不许顺手把这条 Deny 削掉)", () => {
    const src = readFileSync(resolve(REPO, STACK), "utf8");
    const at = src.indexOf('sid: "DenyPrivilegeEscalation"');
    expect(at, "边界里必须还有那条显式 Deny").toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("}", src.indexOf("resources:", at)));
    for (const a of ["iam:*", "sts:AssumeRole"]) {
      expect(block, `Deny 里必须还有 ${a}`).toContain(a);
    }
    expect(block).toMatch(/effect:\s*iam\.Effect\.DENY/);
  });
});
