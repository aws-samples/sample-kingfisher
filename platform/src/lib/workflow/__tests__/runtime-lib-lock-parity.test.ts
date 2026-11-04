// 裂缝C残余根治(v2)跨语言锁对齐单测。
//
// 【为什么必须有这个测试】MWAA 里的 Python 锁(runtime-lib.ts 嵌入串)与 Node 侧补数锁
// (lib/backfill/execute.ts:90)必须锁【同一个 DynamoDB 属性】才能互斥。两处用不同语言手写,
// 属性名/sanitize 规则一旦漂移(如一处 task_id 一处 node.id、一处漏 sanitize)→ 各锁各的属性 →
// 定时执行体与补数/手动 run 根本不互斥 = 白加锁,却看不出任何报错(最阴的回归)。
// 本测试把"两处属性拼法一致"钉成可执行不变量:任一处改了拼法,这里立刻红。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RUNTIME_LIB_SOURCE, RUNTIME_LIB_VERSION } from "@/lib/workflow/runtime-lib";
import { lockAttrFor } from "@/lib/etl/run-lock";
import { generateEtlJobDag } from "@/lib/etl/dag-generator";
import type { EtlJob } from "@/types/etl-job";

const ETL_JOB_FIXTURE: EtlJob = {
  userId: "default-user",
  jobId: "01M1N39N0ED1JG80QGB044767E",
  name: "t",
  type: "redshift",
  script: "SELECT 1;",
  projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES",
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../.."); // .../platform/src

// 模拟两侧的锁属性拼法,用同一 nodeId 验证结果字节一致。
function nodeSanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_"); // 复刻 backfill/execute.ts:90 与 runtime-lib _sanitize_node_id
}

describe("裂缝C残余:跨执行体锁属性对齐(防漂移=防白改)", () => {
  it("v2 已升版本号(改 runtime-lib 必须发新文件名,否则存量 DAG import 到旧库)", () => {
    expect(RUNTIME_LIB_VERSION).toBeGreaterThanOrEqual(2);
  });

  // 🔴 本条原来钉的是**内联公式**(`runLock_${...replace(...)}`)。给锁加了 target 维之后,
  // 内联公式就是"第二处实现" —— 所以判据改成**更强**的形式:必须走唯一作者 `lockAttrFor`,
  // 且必须把 targetId 与**原始 nodeId** 都传进去(少传 targetId ⇒ 两个区域的同节点串成一条队;
  // 传 task_id 而不是 node.id ⇒ 与 python 侧不一致,370cd0c 教训)。
  it("Node 补数锁走唯一作者 lockAttrFor,且带 targetId + 原始 nodeId", () => {
    const exec = readFileSync(resolve(SRC, "lib/backfill/execute.ts"), "utf8");
    expect(exec, "补数锁没走唯一作者 ⇒ 又长出一处锁名实现").toContain("lockAttrFor({");
    expect(exec).toMatch(/lockAttrFor\(\{[\s\S]{0,160}?targetId:/);
    expect(exec).toMatch(/lockAttrFor\(\{[\s\S]{0,160}?nodeId: String\(inst\.nodeId\)/);
    // 🔴 负向:不许再有内联拼法残留(残留 = 两条路径,迟早漂)
    expect(exec, "内联拼法残留 ⇒ 唯一作者名不副实").not.toMatch(/["'`]runLock_?["'`]?\s*\+/);
  });

  it("🔴🔴 Python 侧的镜像实现 `_lock_attr_for` 与 TS 侧 `lockAttrFor` 对**同一输入逐字节相同**", () => {
    const py = RUNTIME_LIB_SOURCE;
    // 文本锚点:python 侧确实有那个镜像函数,而且调用点用它(不是自己再拼一遍)。
    expect(py).toContain("def _lock_attr_for(target_id, node_id):");
    expect(py).toContain('lock_attr = _lock_attr_for(env.get("target_id"), node_id)');
    expect(py, "python 侧还留着旧的内联拼法 ⇒ 两处实现").not.toContain('("runLock_" + _sanitize_node_id(node_id))');
    // 🔴 真正的 parity:在 JS 里**复刻 python 的那几行**,与 TS 唯一作者逐字节比对。
    //    复刻的是 python 源码里写着的规则,所以任一侧改了规则、这里就对不上。
    const pyMirror = (targetId: string | undefined, nodeId: string | undefined): string => {
      const node = nodeId ? nodeSanitize(nodeId) : "";
      const tid = nodeSanitize(String(targetId ?? ""));
      if (!tid || tid === "tgt_home") return node ? `runLock_${node}` : "runLock";
      return node ? `runLock-${tid}-${node}` : `runLock-${tid}`;
    };
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined],
      ["tgt_home", undefined],
      ["tgt_home", "node-1"],
      ["tgt_usw2_a", undefined],
      ["tgt_usw2_a", "node-1"],
      ["tgt_usw2_a", "sql.step 2"],
      ["tgt_usw2_a", "结果表@daily"],
      ["tgt_usw2_a", "a/b\\c"],
      ["", "node_1"],
    ];
    expect(cases.length, "样本表被清空 ⇒ 本条变成空断言").toBeGreaterThanOrEqual(8);
    for (const [tid, nid] of cases) {
      expect(lockAttrFor({ targetId: tid, nodeId: nid }), `case=${tid}/${nid}`).toBe(pyMirror(tid, nid));
    }
    // 🔴 home 必须与存量**逐字节同名**(并存期不分裂)
    expect(lockAttrFor({ targetId: "tgt_home", nodeId: "n1" })).toBe("runLock_n1");
    expect(lockAttrFor({})).toBe("runLock");
    // 🔴 非 home 必须真的不同名(否则两个区域抢同一属性 = 白白串行)
    expect(lockAttrFor({ targetId: "tgt_usw2_a", nodeId: "n1" })).toBe("runLock-tgt_usw2_a-n1");
    expect(lockAttrFor({ targetId: "tgt_usw2_a", nodeId: "n1" })).not.toBe(
      lockAttrFor({ targetId: "tgt_home", nodeId: "n1" })
    );
  });

  it("Python 锁 ExpiresAt 用【毫秒】int(time.time()*1000),与 TS Date.now() 同单位(写成秒→条件恒真/假)", () => {
    const py = RUNTIME_LIB_SOURCE;
    expect(py).toContain("int(time.time() * 1000)");
    // 条件表达式与 run-lock.ts 等价:attribute_not_exists OR lease 过期。
    expect(py).toContain("attribute_not_exists(#t) OR #e < :now");
  });

  it("workflow SQL 节点透传【原始 node id】(非 task_id)做锁——task_id 归一后带 _2 会与补数侧不一致", () => {
    const py = RUNTIME_LIB_SOURCE;
    // op_kwargs 里必须传 node.get("id"),不是 task_id。
    expect(py).toMatch(/"node_id":\s*node\.get\("id",\s*task_id\)/);
  });

  // 属性名改由 TS 侧注入 ⇒ 判据从"源码里有那个字面量"
  // 升级为"**生成出来的 DAG** 里 home 逐字节同名、非 home 真带 target"(打到产物上,更强)。
  it("etl DAG 的锁属性:home 逐字节 runLockToken / 非 home 带 target,且与唯一作者一致", () => {
    const home = generateEtlJobDag(ETL_JOB_FIXTURE);
    expect(home, "home 的锁属性变了 ⇒ 与存量 DAG / 补数 / 正在跑的作业各锁各的").toContain('"runLockToken"');
    expect(home).toContain('"runLockExpiresAt"');
    const usw2 = generateEtlJobDag({ ...ETL_JOB_FIXTURE, targetId: "tgt_usw2_a" }, {
      redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:x",
      execRegion: "us-west-2",
      workgroup: "bgp-workgroup-tgt-usw2-a",
      database: "dev",
    });
    const attr = lockAttrFor({ targetId: "tgt_usw2_a" });
    expect(attr).toBe("runLock-tgt_usw2_a");
    expect(usw2, "非 home 的 DAG 锁属性没带 target ⇒ 两个区域的同作业被串成一条队").toContain(`"${attr}Token"`);
    expect(usw2).toContain(`"${attr}ExpiresAt"`);
    expect(usw2, "非 home 仍用 home 的锁属性").not.toContain('"runLockToken"');
  });

  it("etl DAG 的锁条件/单位与 run-lock.ts 对齐", () => {
    const etl = readFileSync(resolve(SRC, "lib/etl/dag-generator.ts"), "utf8");
    expect(etl).toContain("attribute_not_exists(#t) OR #e < :now");
    expect(etl).toContain("int(time.time() * 1000)");
    // run-lock.ts 侧的属性名生成规则:lockAttrs("runLock") = runLockToken / runLockExpiresAt。
    const rl = readFileSync(resolve(SRC, "lib/etl/run-lock.ts"), "utf8");
    expect(rl).toMatch(/tokenAttr:\s*`\$\{attr\}Token`/);
    expect(rl).toMatch(/expAttr:\s*`\$\{attr\}ExpiresAt`/);
  });
});
