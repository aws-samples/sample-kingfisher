// 版本一致性矩阵的**格子语义**门禁(INTERACTION §3.1 + §2bis.4 + SPEC §1.3a-S1)。
//
// 🔴 这个纯函数是整张看板的正确性支点,而它最容易犯的错**不是漏报,是误报**。
// 用户原话:「**不是所有区域的计算任务都绝对一致,某些区域是特定的计算任务也是正常的**」。
// INTERACTION §2bis.4 因此立了规矩:`🔶已特化` / `—未绑定` / `⊘数据不可用`
// **三类格不参与红黄判定、不报警**。
// 一旦把"这个区本来就不该有"误抓成"漏了这个区" ⇒ 看板全屏黄 ⇒ 三天后没人看它 ⇒ 组件白做。
// 所以本文件对**七个态逐个**正向断 + 对三类"不该报警"的格子逐个**负向**断。
import { describe, it, expect } from "vitest";
import {
  deploymentCellState,
  needsAttention,
  rowAttentionCount,
  bindingShape,
  ATTENTION_STATES,
  type CellState,
  type DeploymentRecord,
} from "@/lib/exec-env/deployments";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";
const EU = "tgt_euw1_a";
const ok = (v: number): DeploymentRecord => ({ version: v, publishedAt: 1, status: "ok" });

describe("🔴 七个态逐个正向", () => {
  it("ok:绑了、下发过、版本与当前定义一致", () => {
    expect(
      deploymentCellState({ targetId: USW2, targets: [HOME, USW2], currentVersion: 5, deployments: { [USW2]: ok(5) } })
    ).toBe("ok");
  });

  it("stale:下发过但版本不是当前版本", () => {
    expect(
      deploymentCellState({ targetId: USW2, targets: [HOME, USW2], currentVersion: 5, deployments: { [USW2]: ok(4) } })
    ).toBe("stale");
  });

  it("🔴 下发版本**高于**当前定义(定义被回滚)也算 stale,不许判绿 —— 那是看板假绿", () => {
    expect(
      deploymentCellState({ targetId: USW2, targets: [HOME, USW2], currentVersion: 4, deployments: { [USW2]: ok(9) } })
    ).toBe("stale");
  });

  it("failed:下发失败", () => {
    expect(
      deploymentCellState({
        targetId: USW2,
        targets: [HOME, USW2],
        currentVersion: 5,
        deployments: { [USW2]: { version: 5, publishedAt: 1, status: "failed", error: "AccessDenied" } },
      })
    ).toBe("failed");
  });

  it("🔴 never-deployed:**绑了却从没下发过** —— 这就是「漏发」,整张看板存在的理由", () => {
    expect(deploymentCellState({ targetId: USW2, targets: [HOME, USW2], currentVersion: 5, deployments: {} })).toBe(
      "never-deployed"
    );
    // deployments 整个缺失(存量行)也一样
    expect(deploymentCellState({ targetId: USW2, targets: [HOME, USW2], currentVersion: 5 })).toBe("never-deployed");
  });

  it("unbound:没绑这个区(区域专属任务的正常形态)", () => {
    expect(deploymentCellState({ targetId: EU, targets: [HOME, USW2], currentVersion: 5 })).toBe("unbound");
  });

  it("specialized:该 (定义 × target) 已特化", () => {
    expect(
      deploymentCellState({
        targetId: USW2,
        targets: [HOME, USW2],
        currentVersion: 5,
        deployments: { [USW2]: ok(2) }, // 版本老,但已特化 ⇒ 不判不齐
        specializedTargets: [USW2],
      })
    ).toBe("specialized");
  });

  it("unavailable:数据异质 —— 该区没有它引用的数据", () => {
    expect(
      deploymentCellState({ targetId: USW2, targets: [HOME, USW2], currentVersion: 5, dataUnavailable: true })
    ).toBe("unavailable");
  });
});

describe("🔴🔴 五类「本就不该有值」的格子**绝不报警**(§2bis.4 三类 + §3.1b 两类;误报会把看板做废)", () => {
  it.each<CellState>(["unbound", "specialized", "unavailable", "residency-blocked", "credential-gap"])(
    "%s 不参与红黄判定",
    (s) => {
      expect(
        needsAttention(s),
        `${s} 被算进了「需要处理」⇒ 区域专属/已特化/数据不可用/跨法域/缺写入通道会天天误报`
      ).toBe(false);
    }
  );

  it.each<CellState>(["never-deployed", "stale", "failed", "drift"])("%s 必须参与判定(漏了就等于看板不报真问题)", (s) => {
    expect(needsAttention(s)).toBe(true);
  });

  it("ATTENTION_STATES 恰好是那四个(多一个 = 误报,少一个 = 漏报)", () => {
    // W3-d2 把建模产物混排进矩阵,`drift`(观测到结构不一致)加入判定;
    // 而 `residency-blocked` / `credential-gap` 属「本就不该有 / 平台还没通道」⇒ 坚决不进。
    expect([...ATTENTION_STATES].sort()).toEqual(["drift", "failed", "never-deployed", "stale"]);
  });

  it("🔴 `deploymentCellState()`(任务行)**结构上产不出**那三个建模专有态", () => {
    // 任务行不该出现 drift/⊘驻留/⊘缺通道:它们的语义只对"物理产物"成立。
    // 穷举一遍常见入参组合,断言产出永远落在任务行那 7 态里。
    const modelingOnly = new Set<CellState>(["drift", "residency-blocked", "credential-gap"]);
    const combos = [
      { targetId: HOME, targets: [HOME], currentVersion: 1, deployments: {} },
      { targetId: HOME, targets: [HOME], currentVersion: 1, deployments: { [HOME]: ok(1) } },
      { targetId: HOME, targets: [HOME], currentVersion: 2, deployments: { [HOME]: ok(1) } },
      { targetId: HOME, targets: [HOME], currentVersion: 1, deployments: { [HOME]: { version: 1, publishedAt: 1, status: "failed" as const } } },
      { targetId: USW2, targets: [HOME], currentVersion: 1, deployments: {} },
      { targetId: USW2, targets: [HOME, USW2], currentVersion: 1, deployments: {}, specializedTargets: [USW2] },
      { targetId: USW2, targets: [HOME, USW2], currentVersion: 1, deployments: {}, dataUnavailable: true },
    ];
    for (const c of combos) expect(modelingOnly.has(deploymentCellState(c))).toBe(false);
  });

  it("🔴 判定顺序不可重排:区域专属任务在别的区**只能**是 unbound,不能是 never-deployed", () => {
    // 一个只绑 usw2 的"区域专属"任务,在 home 与 eu 两列都必须是 unbound。
    for (const t of [HOME, EU]) {
      expect(deploymentCellState({ targetId: t, targets: [USW2], currentVersion: 3, deployments: {} })).toBe("unbound");
    }
  });

  it("🔴 已特化优先于版本不齐(否则每个特化格都会常年报黄)", () => {
    const s = deploymentCellState({
      targetId: USW2,
      targets: [HOME, USW2],
      currentVersion: 99,
      deployments: { [USW2]: ok(1) },
      specializedTargets: [USW2],
    });
    expect(s).toBe("specialized");
    expect(needsAttention(s)).toBe(false);
  });

  it("🔴 数据不可用优先于未绑定(两者处置不同:一个是正常,一个要去建数据源)", () => {
    expect(
      deploymentCellState({ targetId: EU, targets: [HOME], currentVersion: 1, dataUnavailable: true })
    ).toBe("unavailable");
  });
});

describe("行汇总", () => {
  it("只数需要处理的格子", () => {
    expect(rowAttentionCount(["ok", "unbound", "specialized", "unavailable"])).toBe(0);
    expect(rowAttentionCount(["ok", "stale", "failed", "never-deployed", "unbound"])).toBe(3);
  });
});

describe("🔴 台账是运行态,不许进版本快照(否则回滚会造出「假台账」)", () => {
  it("`getResourceConfig` 不含 deployments —— 回滚/晋升都不许把台账带过去", async () => {
    const { getResourceConfig } = await import("@/lib/versions/version-service");
    const cfg = getResourceConfig("etl-job", {
      userId: "default-user",
      jobId: "J1",
      name: "n",
      script: "SELECT 1;",
      targets: ["tgt_home", "tgt_usw2_a"],
      deployments: { tgt_usw2_a: { version: 3, publishedAt: 1, status: "ok" } },
    });
    expect(
      "deployments" in cfg,
      "台账进了快照 ⇒ ① 回滚会把旧台账写回资源行(矩阵显示「已发到 us-west-2」而其实没有);" +
        "② 晋升会把它复制给一个从没下发过的新资源。两者都是看板假绿"
    ).toBe(false);
    // 🔴 `targets` **是**配置(这个定义该在哪些区跑),必须留在快照里 —— 一起排掉就等于回滚丢绑定
    expect(cfg.targets).toEqual(["tgt_home", "tgt_usw2_a"]);
    expect(cfg.script).toBe("SELECT 1;");
  });
});

describe("绑定形态(INTERACTION §2bis.2:一眼可辨「是不是所有区域都跑」)", () => {
  it("绑 >1 = 共享;绑 1 = 区域专属(**一等公民,不是异常**);有特化 = 已特化", () => {
    expect(bindingShape([HOME, USW2])).toBe("shared");
    expect(bindingShape([USW2])).toBe("exclusive");
    expect(bindingShape([HOME])).toBe("exclusive");
    expect(bindingShape([HOME, USW2], [USW2])).toBe("specialized");
  });
});
