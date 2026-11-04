// @kf-batch 50-P50.3b-3-p0e-baseline
// 🔴 **P0-E 判据的跨边界 parity 门禁**:平台侧 `deploy-impact.ts` 与 build 侧 `infra/scripts/deploy-impact.mjs`
//    必须在**全交叉积**上逐格一致(含 planHash 逐字节相同)。
//
// 【为什么两份 + 门禁,而不是一份】判据要同时服务两侧:平台侧填 `operation.disruptive`、拦未审批的部署、给页面呈现;
//   build 侧是**最后一关**(真正能毁数据的那一步在 CodeBuild 里,且平台可能被绕 —— 有人直接 invoke broker)。
//   平台镜像只 COPY `platform/`,跨构建边界无法共享代码(与 broker `validate.mjs`、`naming.json` 双侧出口同处境)。
//   ⇒ 采仓内既有解法:两份实现 + **真 import 另一侧、跑穷举矩阵**的门禁(比文本锚点强:执行的是真实现)。
//   两侧一旦漂移,后果是"平台说只增不改、build 却在替换 Redshift namespace"这类**判据分叉级**事故。
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  classifyDeployImpact as tsClassify,
  canonicalPlanText as tsCanonical,
  classifyBaselineDrift as tsDrift,
  STATEFUL_RESOURCE_TYPES as TS_STATEFUL,
  type StackChangeSet,
  type BaselineRefs,
} from "@/lib/exec-env/deploy-impact";

const HERE = dirname(fileURLToPath(import.meta.url));
const MJS = resolve(HERE, "../../../../../infra/scripts/deploy-impact.mjs");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
/** 既有 840 格测的是 change-set 判据 ⇒ 固定"源零漂移",让基线判定不贡献 reason(语义与本批前一致)。 */
const NO_DRIFT: BaselineRefs = { sourceRef: "srcA", baselineRef: "srcA" };

type MjsModule = {
  classifyDeployImpact: (stacks: unknown[], hash?: (t: string) => string, refs?: unknown) => Record<string, unknown>;
  canonicalPlanText: (stacks: unknown[], refs?: unknown) => string;
  classifyBaselineDrift: (refs: unknown) => Record<string, unknown>;
  STATEFUL_RESOURCE_TYPES: string[];
  normalizeDescribeChangeSet: (stackName: string, raw: unknown) => Record<string, unknown>;
  IMPACT_MARKER: string;
};

const ACTIONS = [undefined, "Add", "Modify", "Remove", "Import", "Dynamic", "Frobnicate"];
const REPLACEMENTS = [undefined, "True", "False", "Conditional"];
const SCOPES: (string[] | undefined)[] = [undefined, [], ["Tags"], ["Metadata"], ["Properties"], ["Tags", "Properties"]];
/** 资源类型取样:有状态两个 + 非有状态两个 + 缺失(空串) */
const TYPES = ["AWS::RedshiftServerless::Namespace", "AWS::S3::Bucket", "AWS::IAM::Role", "AWS::EC2::SecurityGroup", ""];

describe("🔴 P0-E 判据跨边界 parity(平台 ↔ build 侧,全交叉积)", () => {
  it("有状态资源集两侧**逐字节一致**(漏一个 = 那个资源被替换时不会要求审批)", async () => {
    const mod = (await import(MJS)) as MjsModule;
    expect(mod.STATEFUL_RESOURCE_TYPES).toEqual([...TS_STATEFUL]);
  });

  it("(action × replacement × scope × resourceType)全交叉积:disruptive/requiresApproval/planHash/reasons 全一致", async () => {
    const mod = (await import(MJS)) as MjsModule;
    let cases = 0;
    const mismatches: string[] = [];

    for (const action of ACTIONS) {
      for (const replacement of REPLACEMENTS) {
        for (const scope of SCOPES) {
          for (const resourceType of TYPES) {
            const stacks: StackChangeSet[] = [
              {
                stackName: "BgpExecEnv-tgt-usw2-a-core",
                empty: false,
                changes: [{ action, replacement, resourceType, logicalResourceId: "R1", scope }],
              },
            ];
            const mine = tsClassify(stacks, sha, NO_DRIFT);
            const theirs = mod.classifyDeployImpact(stacks as unknown[], sha, NO_DRIFT) as unknown as ReturnType<typeof tsClassify>;
            cases++;
            if (
              mine.disruptive !== theirs.disruptive ||
              mine.requiresApproval !== theirs.requiresApproval ||
              mine.planHash !== theirs.planHash ||
              JSON.stringify(mine.reasons) !== JSON.stringify(theirs.reasons) ||
              mine.changeCount !== theirs.changeCount
            ) {
              mismatches.push(
                `action=${action} replacement=${replacement} scope=${JSON.stringify(scope)} type=${resourceType}: ` +
                  `TS ${JSON.stringify({ d: mine.disruptive, a: mine.requiresApproval, r: mine.reasons.length })} ≠ ` +
                  `MJS ${JSON.stringify({ d: theirs.disruptive, a: theirs.requiresApproval, r: theirs.reasons.length })}`
              );
            }
          }
        }
      }
    }
    // 数量断言防"循环失效变恒绿":7 action × 4 replacement × 6 scope × 5 type = 840
    expect(cases).toBe(ACTIONS.length * REPLACEMENTS.length * SCOPES.length * TYPES.length);
    expect(cases).toBe(840);
    expect(mismatches, "🔴 两侧 P0-E 判据分叉 ⇒ 平台说只增不改而 build 在替换有状态资源").toEqual([]);
  });

  it("🔴 P0-E ④ 基线/波次判定:(sourceRef × baselineRef × desiredTemplateVersion)**18 格全交叉积**两侧一致", async () => {
    const mod = (await import(MJS)) as MjsModule;
    const SRC = [undefined, "srcA"];
    const BASE = [undefined, "srcA", "srcB"];
    const WANT = [undefined, "srcA", "srcB"];
    let cases = 0;
    const mismatches: string[] = [];
    for (const sourceRef of SRC) {
      for (const baselineRef of BASE) {
        for (const desiredTemplateVersion of WANT) {
          const refs = { sourceRef, baselineRef, desiredTemplateVersion };
          const mine = tsDrift(refs);
          const theirs = mod.classifyBaselineDrift(refs);
          cases++;
          if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
            mismatches.push(`${JSON.stringify(refs)}: TS ${JSON.stringify(mine)} ≠ MJS ${JSON.stringify(theirs)}`);
          }
          // planHash 也要两侧一致(refs 进指纹 ⇒ 换源必须换 hash)
          const stacks: StackChangeSet[] = [{ stackName: "S", empty: true, changes: [] }];
          const h1 = tsClassify(stacks, sha, refs).planHash;
          const h2 = (mod.classifyDeployImpact(stacks as unknown[], sha, refs) as { planHash: string }).planHash;
          if (h1 !== h2) mismatches.push(`planHash ${JSON.stringify(refs)}: ${h1.slice(0, 12)} ≠ ${h2.slice(0, 12)}`);
        }
      }
    }
    expect(cases).toBe(SRC.length * BASE.length * WANT.length);
    expect(cases).toBe(18);
    expect(mismatches, "🔴 两侧基线判定分叉 ⇒ 平台说不用审批而 build 说要(或反过来)").toEqual([]);
  });

  it("🔴 P0-E ④ 判定语义(逐格钉死;两个方向都验:fail-open 与 **fail-closed 自锁**)", () => {
    // ① 全新 env:无源身份也无基线 ⇒ 阻断准入但**不要求审批**(否则首装被自己挡死)
    expect(tsDrift({})).toMatchObject({ state: "unknown-source-no-baseline", disruptive: true, requiresApproval: false });
    // ② 有基线却看不到本次源 ⇒ 无法证明没漂移 ⇒ 最严
    expect(tsDrift({ baselineRef: "srcA" })).toMatchObject({ state: "unknown-source", requiresApproval: true });
    // ③ 有源、无基线(首次成功前)⇒ 阻断但不审批
    expect(tsDrift({ sourceRef: "srcA" })).toMatchObject({ state: "no-baseline", disruptive: true, requiresApproval: false });
    // ④ 源零漂移 ⇒ 完全不加严(这才是「只增不改」结构成立的那一格)
    expect(tsDrift({ sourceRef: "srcA", baselineRef: "srcA" })).toMatchObject({
      state: "no-drift", disruptive: false, requiresApproval: false,
    });
    // ⑤ 漂移 + 无波次授权 ⇒ 必须审批
    expect(tsDrift({ sourceRef: "srcB", baselineRef: "srcA" })).toMatchObject({
      state: "drift-unauthorized", disruptive: true, requiresApproval: true,
    });
    // ⑥ 漂移 + 波次授权指向**本次源** ⇒ 不因漂移加严
    expect(tsDrift({ sourceRef: "srcB", baselineRef: "srcA", desiredTemplateVersion: "srcB" })).toMatchObject({
      state: "drift-authorized", disruptive: false, requiresApproval: false,
    });
    // ⑦ 🔴 负向:波次授权指向**另一份**源 ⇒ 不算授权(不许拿一个陈旧授权放行任意新源)
    expect(tsDrift({ sourceRef: "srcB", baselineRef: "srcA", desiredTemplateVersion: "srcC" })).toMatchObject({
      state: "drift-unauthorized", requiresApproval: true,
    });
  });

  it("🔴 planHash 含 sourceRef/baselineRef:同一组变更文本 + 不同源 ⇒ hash 必不同(旧审批自动失效)", () => {
    const stacks: StackChangeSet[] = [
      { stackName: "S", empty: false, changes: [{ action: "Add", resourceType: "AWS::IAM::Role", logicalResourceId: "R" }] },
    ];
    const a = tsClassify(stacks, sha, { sourceRef: "srcA", baselineRef: "srcA" }).planHash;
    const b = tsClassify(stacks, sha, { sourceRef: "srcB", baselineRef: "srcA" }).planHash;
    const c = tsClassify(stacks, sha, { sourceRef: "srcA", baselineRef: "srcZ" }).planHash;
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    // 同 refs 同计划 ⇒ 稳定(不能每次算出不同 hash,否则审批永远匹配不上)
    expect(tsClassify(stacks, sha, { sourceRef: "srcA", baselineRef: "srcA" }).planHash).toBe(a);
  });

  it("空计划 / 不可读 / 多栈混合:canonicalPlanText 与 planHash 两侧逐字节一致", async () => {
    const mod = (await import(MJS)) as MjsModule;
    const cases: StackChangeSet[][] = [
      [{ stackName: "A", empty: true, changes: [] }],
      [{ stackName: "A", empty: false, changes: [], unreadable: "AccessDenied" }],
      [
        { stackName: "B", empty: false, changes: [{ action: "Add", resourceType: "AWS::IAM::Role", logicalResourceId: "R" }] },
        { stackName: "A", empty: true, changes: [] },
        { stackName: "C", empty: false, changes: [], unreadable: "boom" },
      ],
    ];
    for (const stacks of cases) {
      expect(mod.canonicalPlanText(stacks as unknown[], NO_DRIFT)).toBe(tsCanonical(stacks, NO_DRIFT));
      expect((mod.classifyDeployImpact(stacks as unknown[], sha, NO_DRIFT) as { planHash: string }).planHash).toBe(
        tsClassify(stacks, sha, NO_DRIFT).planHash
      );
    }
  });
});

describe("🔴 normalizeDescribeChangeSet:CFN 的「没有变更」是正常空计划,其它 FAILED 一律不可读", () => {
  it("FAILED + didn't contain changes ⇒ 空计划(不是错误)", async () => {
    const mod = (await import(MJS)) as MjsModule;
    const r = mod.normalizeDescribeChangeSet("S", {
      Status: "FAILED",
      StatusReason: "The submitted information didn't contain changes.",
    });
    expect(r).toEqual({ stackName: "S", empty: true, changes: [] });
  });

  it("FAILED + 其它原因 ⇒ unreadable(看不清 = 最严,绝不当成空)", async () => {
    const mod = (await import(MJS)) as MjsModule;
    const r = mod.normalizeDescribeChangeSet("S", { Status: "FAILED", StatusReason: "Template format error" }) as {
      unreadable?: string;
      empty: boolean;
    };
    expect(r.empty).toBe(false);
    expect(r.unreadable).toMatch(/Template format error/);
  });

  it("状态不是 CREATE_COMPLETE(如 CREATE_IN_PROGRESS)⇒ unreadable", async () => {
    const mod = (await import(MJS)) as MjsModule;
    const r = mod.normalizeDescribeChangeSet("S", { Status: "CREATE_IN_PROGRESS" }) as { unreadable?: string };
    expect(r.unreadable).toMatch(/CREATE_IN_PROGRESS/);
  });

  it("CREATE_COMPLETE ⇒ 逐条摊平 ResourceChange 的五个字段", async () => {
    const mod = (await import(MJS)) as MjsModule;
    const r = mod.normalizeDescribeChangeSet("S", {
      Status: "CREATE_COMPLETE",
      Changes: [
        {
          Type: "Resource",
          ResourceChange: {
            Action: "Modify",
            Replacement: "True",
            ResourceType: "AWS::MWAA::Environment",
            LogicalResourceId: "Mwaa",
            Scope: ["Properties"],
          },
        },
      ],
    }) as StackChangeSet;
    expect(r.changes).toEqual([
      { action: "Modify", replacement: "True", resourceType: "AWS::MWAA::Environment", logicalResourceId: "Mwaa", scope: ["Properties"] },
    ]);
    // 该形状喂给判据 ⇒ 必须要求审批(端到端串一次,不只测归一化)
    expect(tsClassify([r], sha, NO_DRIFT).requiresApproval).toBe(true);
  });

  it("无输出 ⇒ unreadable(不猜成空)", async () => {
    const mod = (await import(MJS)) as MjsModule;
    expect((mod.normalizeDescribeChangeSet("S", null) as { unreadable?: string }).unreadable).toBeTruthy();
  });
});
