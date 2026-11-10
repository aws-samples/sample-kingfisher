// 2026-11-09 代码扫描抓到:编排 DAG 生成器把用户 SQL / 脚本写进 Python 源码时只换引号与换行、不转义反斜杠
//   ⇒ 含 `\\` 的 SQL 会把 DAG 写坏(`\\"` 提前收尾、`\\n` 变真换行)。这里用真 python3 解析生成的 DAG,
//   把 op_kwargs 里的字面量 literal_eval 回来,必须与用户原文逐字相等。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { generateAirflowDag } from "../dag-generator";
import type { Workflow } from "@/types/workflow";

const NASTY_SQL = "SELECT '\\d+' AS re, \"q\" FROM t WHERE x = 'it''s' AND y LIKE '%\\\\%'\n  AND z = 'a\\\"b' -- tail\\n(not a newline)";
const NASTY_PY = "import re\nprint(re.sub(r\"\\s+\", ' ', \"a\\tb\"))\n# 反斜杠 \\ 与引号 \" 都在";

const wf = (): Workflow =>
  ({
    workflowId: "W1",
    name: "w",
    airflowDagId: "bgp_W1",
    projectId: "proj-default",
    targets: ["tgt_usw2_a"],
    dagDefinition: {
      nodes: [
        { id: "s1", type: "sql", data: { sql: NASTY_SQL } },
        { id: "p1", type: "python", data: { script: NASTY_PY } },
      ],
      edges: [{ source: "s1", target: "p1" }],
    },
  } as unknown as Workflow);

const PLACE = {
  targetId: "tgt_usw2_a",
  execRegion: "us-west-2",
  workgroup: "bgp-workgroup-tgt-usw2-a",
  database: "dev",
  redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:redshift!bgp-namespace-tgt-usw2-a-admin-x",
};

/** 真 python3:解析整份 DAG,收集每个 op_kwargs 字典里 sql / script 的字面量值。 */
const PY = [
  "import ast, sys, json",
  "src = sys.stdin.read()",
  "tree = ast.parse(src)",
  "out = {}",
  "for node in ast.walk(tree):",
  "    if isinstance(node, ast.keyword) and node.arg == 'op_kwargs' and isinstance(node.value, ast.Dict):",
  "        for k, v in zip(node.value.keys, node.value.values):",
  "            kk = ast.literal_eval(k)",
  "            if kk in ('sql', 'script'):",
  "                out[kk] = ast.literal_eval(v)",
  "print(json.dumps(out))",
].join("\n");

describe("编排 DAG 里的用户文本是合法 Python 字面量", () => {
  it("python3 能解析整份 DAG,且 op_kwargs 的 sql / script 逐字等于用户原文", () => {
    const dag = generateAirflowDag(wf(), PLACE);
    const out = JSON.parse(execFileSync("python3", ["-c", PY], { input: dag, encoding: "utf8" }));
    expect(out.sql).toBe(NASTY_SQL);
    expect(out.script).toBe(NASTY_PY);
  });
  it("源码里不再有「只换引号和换行」的手写转义", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const src = readFileSync(resolve(process.cwd(), "src/lib/workflow/dag-generator.ts"), "utf8");
    expect(src).not.toMatch(/replace\(\/"\/g, '\\\\"'\)/);
    expect(src).toContain("pyStringLiteral(");
  });
});
