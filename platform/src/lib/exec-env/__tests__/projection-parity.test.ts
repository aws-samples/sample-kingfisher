// @kf-batch 50-P50.3b-2b-failure-recovery
// 🔴 **跨构建边界的投影 parity 门禁**:平台 `lifecycle.deriveStatusProjection`/`deriveReady`
//    与 broker `validate.mjs#materializedBrokerProjection` 必须**逐格一致**(全交叉积穷举)。
//
// 【为什么必须有这条(实测教训)】两侧是同一份"顶层兼容投影"的镜像,但跨构建边界无法共享代码,
//   于是各写了一份。`ready` 分支曾分叉:
//     平台  `health === "healthy" ? "active" : "degraded"`   ⇒ ready+unknown ⇒ degraded
//     broker `health === "degraded" ? "degraded" : "active"` ⇒ ready+unknown ⇒ **active**
//   而 broker 自己又断言"顶层投影必须与 spec/observed 一致",于是平台写出的 `degraded`
//   会被 broker 判 `bad-descriptor`(HTTP 500)⇒ **该 target 再也无法发起部署**。
//   这条分叉此前"不可达",只因另一条断言把 `ready+unknown` 当损坏数据先挡了;
//   P50.3b-2a 让 health 变成独立轴之后它就可达了 —— 典型的"两份实现 + 一个过期不变量"复合坑。
//   ⇒ 用**真 import broker 源码 + 全交叉积**钉死,让下一次分叉在门禁上立刻红。
//
// (validate.mjs 是零依赖纯 ESM(不 import AWS SDK),可以被 vitest 直接 import —— 这比文本锚点强得多:
//  它执行的是**真实的另一侧实现**,而不是它的字符串影子。)
import { describe, it, expect } from "vitest";
import { TARGET_COMPONENTS } from "@/lib/exec-env/registry";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  deriveStatusProjection,
  deriveReady,
  materializedProjection,
  TARGET_PHASES,
  TARGET_HEALTHS,
  TARGET_INTENTS,
  type TargetSpec,
  type TargetObserved,
} from "@/lib/exec-env/lifecycle";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROKER_VALIDATE = resolve(HERE, "../../../../../infra/lambda/exec-env-broker/validate.mjs");
// @kf-batch 50-WP15-airflow-serverless:validate.mjs 的组件全集来自 env(部署期 deploy-stack.ts 从 context.ts 注入;缺即加载抛)。
//   测试侧用平台枚举 TARGET_COMPONENTS 灌入 —— 两侧枚举同源由 implemented-components.test 另钉。
process.env.EXEC_ENV_COMPONENT_ENUM = TARGET_COMPONENTS.join(",");
// @kf-batch 50-PROD-B-seq33 ②:broker 的完整组件集同样由部署期注入(deploy-stack.ts ← context.ts)
process.env.EXEC_ENV_REQUIRED_COMPONENTS = "core,redshift,dms,flink,airflow-serverless";

type BrokerProjection = (
  spec: unknown,
  observed: unknown
) => { status: string; ready: boolean; components: string[] };

describe("🔴 跨边界投影 parity:平台 lifecycle ↔ broker validate.mjs(全交叉积逐格一致)", () => {
  it("materializedBrokerProjection 已从 validate.mjs 导出(没导出就无法真跑另一侧实现)", async () => {
    const mod = (await import(BROKER_VALIDATE)) as { materializedBrokerProjection?: BrokerProjection };
    expect(typeof mod.materializedBrokerProjection, "validate.mjs 未导出 materializedBrokerProjection").toBe(
      "function"
    );
  });

  it("(intent × phase × health × operation? × lastError?)全交叉积:status/ready/components 三项逐格相等", async () => {
    const mod = (await import(BROKER_VALIDATE)) as { materializedBrokerProjection: BrokerProjection };
    const brokerProject = mod.materializedBrokerProjection;

    const operations = [
      undefined,
      { kind: "deploy" as const, operationId: "op_x", lockEpoch: 1, startedAt: "2026-09-01T00:00:00.000Z", disruptive: true },
    ];
    const lastErrors = [undefined, "boom"];
    let cases = 0;
    const mismatches: string[] = [];

    for (const intent of TARGET_INTENTS) {
      for (const phase of TARGET_PHASES) {
        for (const health of TARGET_HEALTHS) {
          for (const operation of operations) {
            for (const lastError of lastErrors) {
              const spec: TargetSpec = { intent, desiredComponents: ["core"] };
              const observed: TargetObserved = {
                phase,
                health,
                components: ["core"],
                ...(operation ? { operation } : {}),
                ...(lastError ? { lastError } : {}),
              };
              const mine = {
                status: deriveStatusProjection(spec, observed),
                ready: deriveReady(observed),
                components: observed.components,
              };
              const theirs = brokerProject(spec, observed);
              cases++;
              if (
                mine.status !== theirs.status ||
                mine.ready !== theirs.ready ||
                JSON.stringify(mine.components) !== JSON.stringify(theirs.components)
              ) {
                mismatches.push(
                  `intent=${intent} phase=${phase} health=${health} op=${operation ? "yes" : "no"} ` +
                    `lastError=${lastError ? "yes" : "no"}:平台 ${JSON.stringify(mine)} ≠ broker ${JSON.stringify(theirs)}`
                );
              }
            }
          }
        }
      }
    }
    // 数量断言防"循环失效变恒绿"(3 intent × 7 phase × 3 health × 2 op × 2 lastError = 252)
    expect(cases).toBe(TARGET_INTENTS.length * TARGET_PHASES.length * TARGET_HEALTHS.length * 4);
    expect(cases).toBe(252);
    expect(mismatches, "🔴 两侧投影分叉 ⇒ broker 会把平台写的顶层投影判 bad-descriptor(500),该 target 再也无法部署").toEqual([]);
  });

  it("🔴 承重个案:ready + health=unknown(2a 的 fail-closed 健康态 / 2b 失败恢复写的形状)两侧都必须是 degraded,绝不 active", async () => {
    const mod = (await import(BROKER_VALIDATE)) as { materializedBrokerProjection: BrokerProjection };
    const spec: TargetSpec = { intent: "serve", desiredComponents: ["core"] };
    const observed: TargetObserved = { phase: "ready", health: "unknown", components: ["core"] };
    expect(materializedProjection(spec, observed).status).toBe("degraded");
    expect(mod.materializedBrokerProjection(spec, observed).status).toBe("degraded");
  });

  it("🔴 broker 不再把 ready+health=unknown 当损坏数据拒 —— 否则探活变红/部署失败的 region 连「重新部署去修」都做不了", async () => {
    const mod = (await import(BROKER_VALIDATE)) as {
      planDeployOpen: (item: unknown, req: unknown, epoch: number, nowIso: string) => unknown;
    };
    const now = "2026-09-03T00:00:00.000Z";
    const item = {
      targetId: "tgt_usw2_a",
      version: 9,
      region: "us-west-2",
      accountId: "123456789012",
      partition: "aws",
      jurisdiction: "home",
      status: "degraded", // = 两侧投影对 ready+unknown 的一致结论
      ready: true,
      components: ["core"],
      lockEpoch: 3,
      spec: { intent: "serve", desiredComponents: ["core"] },
      observed: {
        phase: "ready",
        health: "unknown", // 🔴 失败恢复/连红 2 tick 后的真实形状
        components: ["core"],
        lastFailure: { at: now, operationId: "op_prev0001", lockEpoch: 3, buildStatus: "STOPPED", checkedAt: now, stacks: [], decisionId: "d-1", decidedBy: "admin" },
        lastError: "上一次部署会话失败",
      },
    };
    // @kf-batch 50-PROD-B-seq33 ②:重新部署 = 下发完整组件集(这正是「补齐」修复路径)
    const req = { targetId: "tgt_usw2_a", components: ["core", "redshift", "dms", "flink", "airflow-serverless"], operationId: "op_next0001" };
    // 不抛 = 放行开新部署会话(修复路径存在)。抛 bad-descriptor 就是"永久卡死"回归。
    expect(() => mod.planDeployOpen(item, req, 4, now)).not.toThrow();
    // 🔴🔴 纵深锁:下发集不完整(精简形态)⇒ broker 拒 bad-components
    expect(() => mod.planDeployOpen(item, { ...req, components: ["core"] }, 4, now)).toThrow(/缺少完整组件集里的 redshift,dms,flink,airflow-serverless/);
    // 跨法域 ⇒ 完整集另含 residency-api
    expect(() => mod.planDeployOpen({ ...item, jurisdiction: "eu-sim" }, req, 4, now)).toThrow(/缺少完整组件集里的 residency-api/);
  });
});

describe("🔴 投影必须反映 spec.intent(真环境 P0 回归:本函数收了 spec 却从不读它)", () => {
  // 【怎么发现的】2026-09-03 页面级验排空:点完「排空」后 `spec.intent=drain` 生效、准入确实被拒了,
  //   但顶层 `status` **仍是 `active`** ⇒ 页面显示「运行中」。
  // 【为什么这不只是显示问题】兼容投影**本来就是给老 readers 用的**(它们按 `status ∈ {active,degraded}`
  //   判可用)⇒ 对**已排空**的环境 fail-open。真正的准入 `serviceabilityReason` 是对的,
  //   但一个"投影在骗人"的系统迟早被某个 reader 咬到。
  // 【为什么 252 格 parity 没逮到】parity 证的是**两侧一致**,不是**判得对** —— 当时两侧一起漏读 intent。
  //   ⇒ 正确性必须由本节这样的断言守,不能指望 parity。
  const observedReady: TargetObserved = { phase: "ready", health: "healthy", components: ["core"] };

  it("intent=drain ∧ phase 仍在服务中类 ⇒ status 一律 draining,绝不写 active/testing/initializing", () => {
    for (const phase of ["registered", "provisioning", "verifying", "ready"] as const) {
      const proj = materializedProjection(
        { intent: "drain", desiredComponents: ["core"] },
        { ...observedReady, phase }
      );
      expect(proj.status, `phase=${phase} 时排空却投影成 ${proj.status}`).toBe("draining");
    }
  });

  it("intent=serve 时行为逐字不变(本次修改是加法,不许动既有语义)", () => {
    expect(materializedProjection({ intent: "serve", desiredComponents: ["core"] }, observedReady).status).toBe("active");
    expect(
      materializedProjection({ intent: "serve", desiredComponents: ["core"] }, { ...observedReady, health: "unknown" })
        .status
    ).toBe("degraded");
    expect(
      materializedProjection({ intent: "serve", desiredComponents: ["core"] }, { ...observedReady, phase: "verifying" })
        .status
    ).toBe("testing");
  });

  it("已进入退役类 phase 时,phase 自身的投影不被 intent 分支盖掉", () => {
    for (const [phase, want] of [["draining", "draining"], ["decommissioning", "decommissioning"], ["gone", "deleted"]] as const) {
      expect(
        materializedProjection({ intent: "delete", desiredComponents: ["core"] }, { ...observedReady, phase }).status
      ).toBe(want);
    }
  });

  it("🔴 负向:intent=delete 在**还没销毁**时不许投影成 decommissioning(那暗示正在销毁 = 谎)", () => {
    expect(
      materializedProjection({ intent: "delete", desiredComponents: ["core"] }, observedReady).status
    ).toBe("draining");
  });
});
