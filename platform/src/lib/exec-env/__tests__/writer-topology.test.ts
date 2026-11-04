// @kf-batch 50-P50.3b-2b-failure-recovery
// 🔴 把**写点拓扑门禁**接进 vitest 全量门禁(外部审核 §24.3;此前仓内没有这道门)。
//
// 【为什么这条比"再多写十个单测"值钱】P50.3b 的整个根治都压在一句话上:"能写 observed/spec/投影/部署锁的
//   地方只有那几个函数"。没有门禁时它只是**注释** —— 下一个人在别处再加一个 UpdateCommand,
//   1400+ 单测照样全绿,而 bug#9/#11 那类"每长一条业务路径必漏一个前态"的病原地复发。
// 🔴 本文件同时**证明门禁会咬**:塞一个未登记写点进去必须红(否则又是一道"死门禁恒绿")。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = "scripts/execution-env-writer-gate.mjs";

function runGate(probe?: string): { code: number; out: string } {
  try {
    const out = execFileSync("node", [GATE], {
      encoding: "utf8",
      env: { ...process.env, ...(probe ? { EXEC_ENV_WRITER_GATE_PROBE: probe } : {}) },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("🔴 执行环境注册表的写点拓扑门禁", () => {
  it("当前仓库通过:零未登记写点、零动态表名写点", () => {
    const { code, out } = runGate();
    expect(out).toContain("写点拓扑门禁通过");
    expect(code, `门禁红了:\n${out}`).toBe(0);
  });

  it("🔴 门禁会咬:新增一个未登记的执行环境表写点 ⇒ 必须红并指名道姓", () => {
    const dir = mkdtempSync(join(tmpdir(), "writer-gate-"));
    const probe = join(dir, "rogue-writer.ts");
    writeFileSync(
      probe,
      [
        'import { UpdateCommand } from "@aws-sdk/lib-dynamodb";',
        'import { docClient, TABLES } from "@/lib/aws/dynamodb";',
        "export async function sneakyStatusWrite(targetId: string) {",
        "  await docClient.send(",
        "    new UpdateCommand({",
        "      TableName: TABLES.EXECUTION_ENVS,",
        '      Key: { pk: "env", sk: targetId },',
        '      UpdateExpression: "SET #s = :active REMOVE deployLockToken",',
        "    })",
        "  );",
        "}",
      ].join("\n"),
      "utf8"
    );
    try {
      const { code, out } = runGate(probe);
      expect(code, "塞了未登记写点门禁却绿了 = 死门禁").toBe(1);
      expect(out).toContain("未登记的执行环境表写点");
      expect(out).toContain("sneakyStatusWrite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
