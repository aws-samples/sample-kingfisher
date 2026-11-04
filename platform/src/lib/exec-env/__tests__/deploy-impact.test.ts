// 🔴 P0-E 影响分类的**穷举门禁**(SPEC §3.5c ②)。这是"唯一能毁数据的洞"的判据 ——
//    它判错一次的后果是 REPLACE 掉 Redshift namespace / MWAA env / S3 桶,即**不可逆丢数据**。
//
// 【本文件的四条承重】
// ① **看不清 = 最严**:未知 action / 缺 resourceType / change set 不可读 ⇒ disruptive ∧ requiresApproval;
//    绝不出现"解析不出来就当没变更"(那正是 fail-open 的经典形状)。
// ② **有状态资源的替换/删除必须要审批**,非有状态的只阻断准入不要审批(分工清楚,免得审批疲劳)。
// ③ **Conditional 与 True 同等**:CFN 自己都说不准会不会替换,我们不许比 CFN 更乐观。
// ④ **planHash 绑计划**:计划变一个字节 ⇒ hash 变 ⇒ 旧审批自动失效;而**纯文案变化不该**让审批失效。
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  classifyDeployImpact,
  canonicalPlanText,
  summarizeImpact,
  STATEFUL_RESOURCE_TYPES,
  type StackChangeSet,
  type BaselineRefs,
  type ChangeSetChange,
} from "@/lib/exec-env/deploy-impact";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
// 🔴 P0-E ④:`refs` 是**必填**参数(刻意不给默认值 —— 忘了传就编译不过,而不是静默 fail-open)。
//    既有这批用例测的是 **change-set 判据**,所以固定给"源零漂移"(基线 === 本次源)⇒ 基线判定不贡献任何
//    reason,这些用例的期望值保持原语义。基线判定本身由 component/refs 专项用例与 parity 交叉积覆盖。
const NO_DRIFT: BaselineRefs = { sourceRef: "srcA", baselineRef: "srcA" };
const classify = (stacks: StackChangeSet[], refs: BaselineRefs = NO_DRIFT) => classifyDeployImpact(stacks, sha, refs);

const CORE = "BgpExecEnv-tgt-usw2-a-core";
const NEW = "BgpExecEnv-tgt-usw2-a-flink";

const stack = (name: string, changes: ChangeSetChange[], over: Partial<StackChangeSet> = {}): StackChangeSet => ({
  stackName: name,
  empty: changes.length === 0,
  changes,
  ...over,
});
const add = (type: string, id = "R1"): ChangeSetChange => ({ action: "Add", resourceType: type, logicalResourceId: id });
const modify = (type: string, replacement: string, scope: string[] = ["Properties"], id = "R1"): ChangeSetChange => ({
  action: "Modify",
  replacement,
  resourceType: type,
  logicalResourceId: id,
  scope,
});
const remove = (type: string, id = "R1"): ChangeSetChange => ({ action: "Remove", resourceType: type, logicalResourceId: id });

describe("🔴 ⑤ 只增不改(add-components 承诺的那条路)才允许 disruptive=false", () => {
  it("全 Add ⇒ 不打断、不需审批", () => {
    const r = classify([
      stack(CORE, []),
      stack(NEW, [add("AWS::IAM::Role", "FlinkRole"), add("AWS::KinesisAnalyticsV2::Application", "App")]),
    ]);
    expect(r.disruptive).toBe(false);
    expect(r.requiresApproval).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(summarizeImpact(r)).toMatch(/只增不改/);
  });

  it("空 change set(CFN 说没变更)⇒ 不打断", () => {
    const r = classify([stack(CORE, []), stack(NEW, [])]);
    expect(r.disruptive).toBe(false);
    expect(r.requiresApproval).toBe(false);
  });

  it("只改 Tags/Metadata ⇒ 不算打断(改标签不影响在跑作业)", () => {
    const r = classify([stack(CORE, [modify("AWS::S3::Bucket", "Never", ["Tags"], "Lake")])]);
    expect(r.disruptive).toBe(false);
    expect(r.requiresApproval).toBe(false);
  });

  it("Tags + Properties 混合 ⇒ 仍算打断(不是「只碰无害 scope」)", () => {
    const r = classify([stack(CORE, [modify("AWS::S3::Bucket", "Never", ["Tags", "Properties"], "Lake")])]);
    expect(r.disruptive).toBe(true);
    expect(r.requiresApproval).toBe(false);
  });
});

describe("🔴 ② 删除:非有状态只阻断准入,有状态必须审批", () => {
  it("删非有状态资源 ⇒ disruptive,但不要求审批", () => {
    const r = classify([stack(CORE, [remove("AWS::IAM::Policy", "P1")])]);
    expect(r.disruptive).toBe(true);
    expect(r.requiresApproval).toBe(false);
    expect(r.reasons[0].why).toMatch(/打断在跑的作业/);
  });

  it("删有状态资源 ⇒ **必须审批**", () => {
    const r = classify([stack(CORE, [remove("AWS::RedshiftServerless::Namespace", "Ns")])]);
    expect(r.disruptive).toBe(true);
    expect(r.requiresApproval).toBe(true);
    expect(r.reasons[0].why).toMatch(/丢数据/);
    expect(r.reasons[0].stateful).toBe(true);
  });
});

describe("🔴 ③ 替换:Conditional 与 True 同等对待(不许比 CFN 更乐观)", () => {
  for (const replacement of ["True", "Conditional"]) {
    it(`有状态资源 Replacement=${replacement} ⇒ 必须审批`, () => {
      const r = classify([stack(CORE, [modify("AWS::MWAA::Environment", replacement, ["Properties"], "Mwaa")])]);
      expect(r.disruptive).toBe(true);
      expect(r.requiresApproval).toBe(true);
    });
    it(`非有状态资源 Replacement=${replacement} ⇒ 阻断准入但不要求审批`, () => {
      const r = classify([stack(CORE, [modify("AWS::EC2::SecurityGroup", replacement, ["Properties"], "Sg")])]);
      expect(r.disruptive).toBe(true);
      expect(r.requiresApproval).toBe(false);
    });
  }

  it("Replacement=False ∧ Scope=Properties ⇒ 打断但不审批(原地改属性)", () => {
    const r = classify([stack(CORE, [modify("AWS::RedshiftServerless::Workgroup", "False", ["Properties"], "Wg")])]);
    expect(r.disruptive).toBe(true);
    expect(r.requiresApproval).toBe(false);
  });
});

describe("🔴 ① 看不清 = 最严(绝不当成没变更)", () => {
  it("change set 不可读 ⇒ disruptive ∧ requiresApproval", () => {
    const r = classify([stack(CORE, [], { unreadable: "AccessDenied" })]);
    expect(r.disruptive).toBe(true);
    expect(r.requiresApproval).toBe(true);
    expect(r.reasons[0].why).toMatch(/看不清就是不安全/);
  });

  for (const bad of [undefined, "", "Frobnicate", "add", "ADD"]) {
    it(`未知/畸形 action=${JSON.stringify(bad)} ⇒ 最严(不许被当成 Add)`, () => {
      const r = classify([stack(CORE, [{ action: bad, resourceType: "AWS::S3::Bucket", logicalResourceId: "B" }])]);
      expect(r.disruptive).toBe(true);
      expect(r.requiresApproval).toBe(true);
    });
  }

  it("缺 resourceType ⇒ 最严(判不了是否有状态,就不许放行)", () => {
    const r = classify([stack(CORE, [{ action: "Add", logicalResourceId: "X" }])]);
    expect(r.disruptive).toBe(true);
    expect(r.requiresApproval).toBe(true);
  });

  it("Modify 但 CFN 没给 Scope ⇒ 按打断处理(不猜「大概只是标签」)", () => {
    const r = classify([stack(CORE, [{ action: "Modify", replacement: "Never", resourceType: "AWS::S3::Bucket", logicalResourceId: "B" }])]);
    expect(r.disruptive).toBe(true);
    expect(r.requiresApproval).toBe(false);
  });
});

describe("🔴 取最严:一条要审批就整体要审批", () => {
  it("大量 Add + 一条有状态替换 ⇒ requiresApproval", () => {
    const r = classify([
      stack(NEW, [add("AWS::IAM::Role", "A"), add("AWS::Logs::LogGroup", "B")]),
      stack(CORE, [add("AWS::IAM::Policy", "C"), modify("AWS::KMS::Key", "True", ["Properties"], "Key")]),
    ]);
    expect(r.requiresApproval).toBe(true);
    expect(r.disruptive).toBe(true);
    // 🔴 只把"真有问题"的那条列进理由(别把 Add 也塞进去淹没重点)
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0].resourceType).toBe("AWS::KMS::Key");
    expect(r.changeCount).toBe(4); // 统计口径仍数全部变更
  });
});

describe("🔴 ④ planHash 绑计划(审批不可跨计划复用)", () => {
  const plan = [stack(CORE, [modify("AWS::MWAA::Environment", "True", ["Properties"], "Mwaa")])];

  it("同一计划 ⇒ hash 稳定;顺序不同 ⇒ hash 仍相同(canonical 排序)", () => {
    const a = classify([stack(CORE, [add("AWS::IAM::Role", "A"), add("AWS::IAM::Role", "B")])]);
    const b = classify([stack(CORE, [add("AWS::IAM::Role", "B"), add("AWS::IAM::Role", "A")])]);
    expect(a.planHash).toBe(b.planHash);
  });

  it("计划变一个字节(replacement True→Conditional)⇒ hash 变 ⇒ 旧审批失效", () => {
    const h1 = classify(plan).planHash;
    const h2 = classify([stack(CORE, [modify("AWS::MWAA::Environment", "Conditional", ["Properties"], "Mwaa")])]).planHash;
    expect(h1).not.toBe(h2);
  });

  it("多一条变更 ⇒ hash 变", () => {
    const h1 = classify(plan).planHash;
    const h2 = classify([stack(CORE, [...plan[0].changes, add("AWS::IAM::Role", "New")])]).planHash;
    expect(h1).not.toBe(h2);
  });

  it("不可读也进指纹(从「不可读」变成「可读且空」必须换 hash)", () => {
    const unreadable = classify([stack(CORE, [], { unreadable: "AccessDenied" })]).planHash;
    const empty = classify([stack(CORE, [])]).planHash;
    expect(unreadable).not.toBe(empty);
  });

  it("canonicalPlanText 不含 why 文案 ⇒ 改文案不会让已批准的计划失效", () => {
    const text = canonicalPlanText(plan, NO_DRIFT);
    expect(text).not.toMatch(/丢数据|审批|打断/);
    expect(text).toContain(CORE);
    expect(text).toContain("AWS::MWAA::Environment");
  });
});

describe("🔴 有状态资源集:漏一个可能就是一次不可逆丢数据", () => {
  it("覆盖数据/密钥/托管环境/目录/网络底座五类的关键成员", () => {
    for (const t of [
      "AWS::RedshiftServerless::Namespace",
      "AWS::MWAA::Environment",
      "AWS::S3::Bucket",
      "AWS::S3Tables::TableBucket",
      "AWS::MSK::Cluster",
      "AWS::KMS::Key",
      "AWS::DynamoDB::Table",
      "AWS::Glue::Database",
      "AWS::EC2::VPC",
      "AWS::SecretsManager::Secret",
    ]) {
      expect([...STATEFUL_RESOURCE_TYPES], `${t} 不在有状态集里 ⇒ 它被替换时不会要求审批`).toContain(t);
    }
  });

  it("每个有状态类型被替换时都要求审批(逐个真跑,不靠「集合里有」推断)", () => {
    for (const t of STATEFUL_RESOURCE_TYPES) {
      const r = classify([stack(CORE, [modify(t, "True", ["Properties"], "X")])]);
      expect(r.requiresApproval, `${t} 替换却不要求审批`).toBe(true);
    }
  });
});
