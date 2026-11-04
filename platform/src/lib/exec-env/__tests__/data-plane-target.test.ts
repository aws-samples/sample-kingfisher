// @kf-batch 50-P50.3-dataplane
// 数据面 target 绑定的门禁(50 SPEC §3.1 / §3.4 / §3.8 / §6.7)。
//
// 🔴 本文件的承重只有一条:**region / workgroup / database / 凭证 四样必须同时是那个 target 的**。
// 只对上一两样是本模块最危险的失败形态 —— 它**不报错**,只是"看起来正常地连到了别的区域"
// (`warehouse-location.ts` 文件头记的就是这个;P50.1 收编 workgroup 兜底时的病根也是它)。
// 所以下面每条正向断言都配一条**负向**:别的三样不许还是 home 的。
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── registry:只桩准入(整包校验/新鲜度有它自己的测试)──
let targets: Record<string, Record<string, unknown>> = {};
const requireReadyTarget = vi.fn(async (id: string) => {
  const t = targets[id];
  if (!t) throw new Error(`target ${id} 不可用`);
  return t;
});
const listActiveTargets = vi.fn(async () => Object.values(targets));
vi.mock("@/lib/exec-env/registry", () => ({ requireReadyTarget, listActiveTargets }));

// ── §3.9 凭证工厂 ──
let credResult: unknown = null;
let credThrows: Error | null = null;
const getPrivilegedCred = vi.fn(async () => {
  if (credThrows) throw credThrows;
  return credResult;
});
vi.mock("@/lib/exec-env/privileged-cred", () => ({ getPrivilegedCred }));

// ── home 的 legacy 凭证出口 ──
const getRedshiftSecretArn = vi.fn(async () => "arn:aws:secretsmanager:us-east-1:1:secret:redshift!home");
vi.mock("@/lib/redshift/admin-secret", () => ({ getRedshiftSecretArn }));

const {
  resolveRedshiftBinding,
  redshiftClientForTarget,
  resolveGlueBinding,
  stampedTargetOf,
  assertBindableTarget,
  assertTargetComponent,
  listRedshiftCapableTargets,
  listComponentCapableTargets,
  TargetBindingRejected,
} = await import("@/lib/exec-env/data-plane-target");

const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const USW2 = {
  targetId: "tgt_usw2_a",
  region: "us-west-2",
  jurisdiction: "home",
  components: ["core", "redshift", "dms"],
  resources: { redshiftWorkgroup: "bgp-workgroup-tgt-usw2-a", redshiftDatabase: "dev" },
};

beforeEach(() => {
  vi.clearAllMocks();
  targets = { tgt_usw2_a: { ...USW2 } };
  credResult = {
    kind: "project-context",
    secretArn: "arn:aws:secretsmanager:us-west-2:1:secret:bgp/project/tgt-usw2-a/x",
    degradedToLegacyAdmin: true,
  };
  credThrows = null;
  getRedshiftSecretArn.mockResolvedValue("arn:aws:secretsmanager:us-east-1:1:secret:redshift!home");
  process.env.AWS_REGION = "us-east-1";
});

describe("🔴 home:逐字节等价,而且**根本不碰**新链路", () => {
  it("tgt_home ⇒ region=env / 落点走三级兜底 / 凭证走既有出口", async () => {
    const b = await resolveRedshiftBinding({ targetId: "tgt_home", projectId: PROJ });
    expect(b).toMatchObject({
      targetId: "tgt_home",
      region: "us-east-1",
      workgroup: "bgp-workgroup",
      database: "dev",
      home: true,
    });
    expect(b.secretArn).toContain("redshift!home");
    expect(getRedshiftSecretArn).toHaveBeenCalledWith({ project: PROJ });
    // 🔴 负向:home 不许去打注册表 / 不许走 §3.9 工厂 —— 那会把 home 的存量作业绑到
    //    一个处于 provisioning 且有 deadline 的状态机上(窗口过期后 home 全线 fail-closed)。
    expect(requireReadyTarget, "home 走了准入路径 ⇒ 每次运行多一次强一致读,且行为不再等价").not.toHaveBeenCalled();
    expect(getPrivilegedCred, "home 走了 §3.9 工厂 ⇒ provisioning 窗口过期会把存量作业打挂").not.toHaveBeenCalled();
  });

  // @kf-batch 50-WP31-place-first-class —— 原判据是「显式传 tgt_home 与不传等价」;WP-31 序 3 起落点必填,
  //   漏传 / 空串不再静默落主控区(类型挡住漏传,运行期挡住 any / 空串)
  it("🔴 不传 / 空串 ⇒ 拒,不再静默落主控区", async () => {
    await expect(resolveRedshiftBinding({ projectId: PROJ } as never)).rejects.toThrow(/非法 targetId/);
    await expect(resolveRedshiftBinding({ targetId: "", projectId: PROJ })).rejects.toThrow(/非法 targetId/);
    await expect(redshiftClientForTarget("")).rejects.toThrow(/非法 targetId/);
    await expect(resolveGlueBinding({ targetId: "" })).rejects.toThrow(/非法 targetId/);
    expect(getRedshiftSecretArn, "拒之前不许已经去取了主控区凭证").not.toHaveBeenCalled();
  });

  it("home 仍尊重执行体自带的 workgroup/database(三级兜底的第一级)", async () => {
    const b = await resolveRedshiftBinding({ targetId: "tgt_home", workgroupOverride: "wg-custom", databaseOverride: "db2" });
    expect(b.workgroup).toBe("wg-custom");
    expect(b.database).toBe("db2");
  });
});

// @kf-batch 50-WP31-place-first-class
describe("run 章 ⇒ targetId(唯一作者 targetOfStamp)", () => {
  it("有章用章;无章 = 存量主控区;章非法 ⇒ 可修的绑定拒绝(不许变成主控区)", () => {
    expect(stampedTargetOf({ targetId: "tgt_usw2_a" })).toBe("tgt_usw2_a");
    expect(stampedTargetOf({})).toBe("tgt_home");
    expect(stampedTargetOf({ targetId: "" })).toBe("tgt_home");
    expect(stampedTargetOf(undefined)).toBe("tgt_home");
    expect(() => stampedTargetOf({ targetId: "us-west-2" })).toThrow(TargetBindingRejected);
    expect(() => stampedTargetOf({ targetId: 7 })).toThrow(TargetBindingRejected);
  });
});

describe("🔴🔴 非 home:四样必须**同时**是那个 target 的", () => {
  it("region / workgroup / database / 凭证 四样都换了(逐条断,且逐条负向断不是 home 的)", async () => {
    const b = await resolveRedshiftBinding({ targetId: "tgt_usw2_a", projectId: PROJ });
    expect(b.region, "region 还是 home ⇒ 客户端打错区").toBe("us-west-2");
    expect(b.workgroup, "workgroup 还是 home ⇒ 静默连回 home 数仓(最难查的那种)").toBe("bgp-workgroup-tgt-usw2-a");
    expect(b.database).toBe("dev");
    expect(b.secretArn, "凭证还是 home 的 ⇒ 跨区认证必失败或落错属主").toContain("bgp/project/tgt-usw2-a");
    expect(b.home).toBe(false);
    // 四样各自的负向
    expect(b.region).not.toBe("us-east-1");
    expect(b.workgroup).not.toBe("bgp-workgroup");
    expect(b.secretArn).not.toContain("redshift!home");
    // 准入必须真过了(不是直接读描述符)
    expect(requireReadyTarget).toHaveBeenCalledWith("tgt_usw2_a");
    expect(getPrivilegedCred).toHaveBeenCalledWith("tgt_usw2_a", { purpose: "project-context", project: PROJ });
    // home 的 legacy 出口一次都不该被碰
    expect(getRedshiftSecretArn).not.toHaveBeenCalled();
  });

  it("🔴 缺 redshift 组件 ⇒ 拒,**不回落 home**(回落 = 你选了这个区、活在别的区干完了)", async () => {
    targets.tgt_usw2_a = { ...USW2, components: ["core", "dms"] };
    await expect(resolveRedshiftBinding({ targetId: "tgt_usw2_a", projectId: PROJ })).rejects.toThrow(
      /没有安装 redshift 组件/
    );
    expect(getPrivilegedCred, "组件没过就去取凭证了 ⇒ 顺序错(校验必须在取凭证之前)").not.toHaveBeenCalled();
  });

  it("🔴 落点冲突 ⇒ 拒,不静默取一个(用户看到 A、真跑在 B 是本模块要消灭的形态)", async () => {
    await expect(
      resolveRedshiftBinding({ targetId: "tgt_usw2_a", projectId: PROJ, workgroupOverride: "bgp-workgroup" })
    ).rejects.toThrow(/与目标 tgt_usw2_a 的实际 workgroup.*不一致/);
    await expect(
      resolveRedshiftBinding({ targetId: "tgt_usw2_a", projectId: PROJ, databaseOverride: "other" })
    ).rejects.toThrow(/database.*不一致/);
  });

  it("override 为空串 / 空白 / 与描述符等值 ⇒ 放行(界面清空即可,不必强迫用户填对)", async () => {
    for (const wg of ["", "   ", "bgp-workgroup-tgt-usw2-a"]) {
      const b = await resolveRedshiftBinding({ targetId: "tgt_usw2_a", projectId: PROJ, workgroupOverride: wg });
      expect(b.workgroup).toBe("bgp-workgroup-tgt-usw2-a");
    }
  });

  it("🔴 非 home 缺 projectId ⇒ 拒(§3.9b:project-context 不接受缺 projectId)", async () => {
    await expect(resolveRedshiftBinding({ targetId: "tgt_usw2_a" })).rejects.toThrow(/必须带 projectId/);
    expect(getPrivilegedCred).not.toHaveBeenCalled();
  });

  it("🔴 工厂给不出 secretArn ⇒ 拒(禁 IAM fallback,不许省略 SecretArn 退回联邦身份)", async () => {
    credResult = { kind: "project-context", secretArn: "", degradedToLegacyAdmin: true };
    await expect(resolveRedshiftBinding({ targetId: "tgt_usw2_a", projectId: PROJ })).rejects.toThrow(
      /禁 IAM fallback/
    );
    credResult = { kind: "governance-read", targetId: "tgt_usw2_a", readOnly: true };
    await expect(resolveRedshiftBinding({ targetId: "tgt_usw2_a", projectId: PROJ })).rejects.toThrow(
      /禁 IAM fallback/
    );
  });

  it("工厂抛(如 isolated 缺凭证)⇒ 原样抛,绝不 catch 回落 home", async () => {
    credThrows = new Error("no per-project credential — refuse (state=isolated)");
    await expect(resolveRedshiftBinding({ targetId: "tgt_usw2_a", projectId: PROJ })).rejects.toThrow(
      /state=isolated/
    );
    expect(getRedshiftSecretArn).not.toHaveBeenCalled();
  });

  it("描述符缺 workgroup ⇒ 拒(落点只能来自实名资源袋,不许猜)", async () => {
    targets.tgt_usw2_a = { ...USW2, resources: { redshiftDatabase: "dev" } };
    await expect(resolveRedshiftBinding({ targetId: "tgt_usw2_a", projectId: PROJ })).rejects.toThrow(
      /redshiftWorkgroup/
    );
  });
});

// @kf-batch 50-WP11b-shared-writer —— BindingOpts 是必填判别式(无默认值);per-project 的简写
const PP = (projectId: string | null) => ({ scope: "per-project" as const, projectId });

describe("🔴 写入路径的校验(`{...body}` 展开是 fail-open)", () => {
  it("空 / undefined ⇒ 归一到 tgt_home,且**不打库**", async () => {
    for (const v of [undefined, null, ""]) {
      expect(await assertBindableTarget(v, "redshift", PP(null))).toBe("tgt_home");
    }
    expect(requireReadyTarget).not.toHaveBeenCalled();
  });

  it("非法形态 ⇒ 拒(它决定 SQL 打到哪个区域的数仓,不能收任意串)", async () => {
    for (const v of ["home", "tgt_", "TGT_HOME", 42, {}, "tgt_usw2_a; DROP"]) {
      await expect(assertBindableTarget(v, "redshift", PP(null))).rejects.toThrow(/非法 targetId/);
    }
  });

  it("合法且装了 redshift ⇒ 放行", async () => {
    expect(await assertBindableTarget("tgt_usw2_a", "redshift", PP(null))).toBe("tgt_usw2_a");
  });

  it("🔴 缺组件 ⇒ 拒(落库那一刻就拦住,而不是下次运行才发作)", async () => {
    targets.tgt_usw2_a = { ...USW2, components: ["core"] };
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", PP(null))).rejects.toThrow(/没有安装 redshift 组件/);
  });

  // @kf-batch 50-W5-seg1-WP10a —— 🔴 反转:原「跨法域 ⇒ 本期拒」已作废(DESIGN §18 决策 6quinquies:不设法务门)。
  //    跨法域 target 与同法域走**同一条路**;它唯一的技术前置在准入内核(residencyPrerequisite,registry 侧单测),这里不再判法域。
  it("🔴🔴 跨法域 target ⇒ 与同法域同一条路(不因 jurisdiction 拒绑;不设法务门)", async () => {
    targets.tgt_usw2_a = { ...USW2, jurisdiction: "eu-sim" };
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", PP(null))).resolves.toBe("tgt_usw2_a");
  });

  it("🔴 项目白名单(通用):allowlist 之外的项目 ⇒ 拒 project-not-allowed;名单内 ⇒ 通;缺项目上下文 ⇒ 拒", async () => {
    targets.tgt_usw2_a = { ...USW2, access: { mode: "allowlist", projects: ["proj-a"] } };
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", PP("proj-a"))).resolves.toBe("tgt_usw2_a");
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", PP("proj-b"))).rejects.toThrow(/未授权给项目 proj-b/);
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", PP(null))).rejects.toThrow(/未授权给项目/);
    targets.tgt_usw2_a = { ...USW2, access: { mode: "all-projects" } };
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", PP("proj-b"))).resolves.toBe("tgt_usw2_a");
  });

  it("target 不可用(draining / stale / 未注册)⇒ 拒(准入的错误原样透出)", async () => {
    targets = {};
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", PP(null))).rejects.toThrow(/不可用/);
  });
});

describe("🔴 呈现与授权用**同一条判据**(防「下拉里有、选了却 409」)", () => {
  it("清单过滤 = 装了 redshift ∧ 项目白名单放行(与 assertBindableTarget 逐条对应;跨法域**照常列出**并带法域)", async () => {
    targets = {
      tgt_usw2_a: { ...USW2 },
      tgt_nordb: { targetId: "tgt_nordb", region: "eu-west-1", jurisdiction: "home", components: ["core"] },
      tgt_eu: { targetId: "tgt_eu", region: "eu-west-1", jurisdiction: "eu-sim", components: ["core", "redshift"] },
      tgt_vip: { targetId: "tgt_vip", region: "ap-south-1", jurisdiction: "home", components: ["core", "redshift"], access: { mode: "allowlist", projects: ["proj-x"] } },
    };
    const list = await listRedshiftCapableTargets(PP("proj-a"));
    expect(list.map((x) => x.targetId).sort()).toEqual(["tgt_eu", "tgt_usw2_a"]);
    expect(list.find((x) => x.targetId === "tgt_eu")?.jurisdiction).toBe("eu-sim");
    const listX = await listRedshiftCapableTargets(PP("proj-x"));
    expect(listX.map((x) => x.targetId).sort()).toEqual(["tgt_eu", "tgt_usw2_a", "tgt_vip"]);
  });

  it("清单里被留下的每一个,`assertBindableTarget` 都必须放行(两侧不许分叉)", async () => {
    targets = {
      tgt_usw2_a: { ...USW2 },
      tgt_b: { targetId: "tgt_b", region: "ap-southeast-1", jurisdiction: "home", components: ["core", "redshift"] },
      tgt_eu: { targetId: "tgt_eu", region: "eu-west-1", jurisdiction: "eu-sim", components: ["core", "redshift"] },
      tgt_vip: { targetId: "tgt_vip", region: "ap-south-1", jurisdiction: "home", components: ["core", "redshift"], access: { mode: "allowlist", projects: ["proj-a"] } },
    };
    const list = await listRedshiftCapableTargets(PP("proj-a"));
    expect(list.length).toBeGreaterThanOrEqual(3); // 数量断言防 filter 失效变恒空
    for (const x of list) {
      await expect(assertBindableTarget(x.targetId, "redshift", PP("proj-a"))).resolves.toBe(x.targetId);
    }
    // 反向:没进清单的(白名单外)在写入路径也必被拒 —— 两侧同一判据
    const listB = await listRedshiftCapableTargets(PP("proj-b"));
    expect(listB.map((x) => x.targetId)).not.toContain("tgt_vip");
    await expect(assertBindableTarget("tgt_vip", "redshift", PP("proj-b"))).rejects.toThrow(/未授权给项目/);
  });
});

describe("assertTargetComponent(纯函数)", () => {
  it("装了就过,没装就拒;components 缺失/非数组一律当没装(不是当有)", () => {
    expect(() => assertTargetComponent({ ...USW2 } as never, "redshift")).not.toThrow();
    expect(() => assertTargetComponent({ ...USW2, components: undefined } as never, "redshift")).toThrow(
      TargetBindingRejected
    );
    expect(() => assertTargetComponent({ ...USW2, components: "redshift" } as never, "redshift")).toThrow(
      /没有安装/
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// @kf-batch 50-WP11b-shared-writer —— E-233 / E-235(单测侧):scope 判别式(SPEC §3.9d.8,台账 B-17)
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴🔴 scope 必填判别式:platform-global **只**跳过项目白名单(成对判据)", () => {
  it("allowlist: [](最严那一态)⇒ platform-global 放行;🔴 同一状态下 per-project 仍拒 project-not-allowed", async () => {
    targets.tgt_usw2_a = { ...USW2, access: { mode: "allowlist", projects: [] } };
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", { scope: "platform-global" })).resolves.toBe("tgt_usw2_a");
    // 负向对照:缺了这条就等于「拆了白名单还说自己修好了」
    const err = await assertBindableTarget("tgt_usw2_a", "redshift", PP("proj-a")).catch((e) => e);
    expect(err?.reason ?? err?.code ?? String(err)).toMatch(/project-not-allowed/);
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", PP(null))).rejects.toThrow(/无项目上下文/);
  });

  it("🔴 platform-global 不跳准入与组件:缺组件照拒、target 不可用照拒(否则就是 fail-open)", async () => {
    targets.tgt_usw2_a = { ...USW2, components: ["core"], access: { mode: "allowlist", projects: [] } };
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", { scope: "platform-global" })).rejects.toThrow(
      /没有安装 redshift 组件/
    );
    targets = {};
    await expect(assertBindableTarget("tgt_usw2_a", "redshift", { scope: "platform-global" })).rejects.toThrow(/不可用/);
  });

  it("🔴 platform-global 的拒因里不会出现「未授权给项目(无项目上下文)」", async () => {
    targets.tgt_usw2_a = { ...USW2, components: ["core"], access: { mode: "allowlist", projects: [] } };
    const err = await assertBindableTarget("tgt_usw2_a", "redshift", { scope: "platform-global" }).catch((e) => e);
    expect(String(err?.message)).not.toMatch(/未授权给项目/);
  });

  it("🔴 类型层:BindingOpts 没有默认值 —— 源码里不许再出现 `opts: BindingOpts = {}` 或可选 projectId 形态", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../data-plane-target.ts"), "utf8");
    expect(src, "默认值回来了 ⇒「忘了传」与「建模没有项目」又分不开(silent-default 一类)").not.toMatch(/BindingOpts\s*=\s*\{\s*\}/);
    expect(src).toMatch(/export type BindingOpts = \{ scope: "per-project"; projectId: string \| null \} \| \{ scope: "platform-global" \}/);
  });
});

// @kf-batch 50-B109-exec-target-dims
describe("🔴 B-109 listComponentCapableTargets:维度 → 组件谓词是唯一作者,且与写路径同口径", () => {
  const opts = { scope: "per-project" as const, projectId: PROJ };
  it("airflow 列装了 airflow-serverless 或 mwaa 的,只有数仓的不列;redshift 反之;core 全列;旧名 listRedshiftCapableTargets 等价", async () => {
    targets = {
      tgt_usw2_a: { ...USW2, components: ["core", "redshift", "airflow-serverless"] },
      tgt_usw1_a: { ...USW2, targetId: "tgt_usw1_a", region: "us-west-1", components: ["core", "redshift"] },
      tgt_euc1_a: { ...USW2, targetId: "tgt_euc1_a", region: "eu-central-1", components: ["core", "mwaa"] },
    };
    const pick = async (dim: "redshift" | "airflow" | "core") => (await listComponentCapableTargets(dim, opts)).map((x) => x.targetId).sort();
    expect(await pick("airflow")).toEqual(["tgt_euc1_a", "tgt_usw2_a"]);
    expect(await pick("redshift")).toEqual(["tgt_usw1_a", "tgt_usw2_a"]);
    expect(await pick("core")).toEqual(["tgt_euc1_a", "tgt_usw1_a", "tgt_usw2_a"]);
    expect(await listRedshiftCapableTargets(opts)).toEqual(await listComponentCapableTargets("redshift", opts));
  });
  it("主控区在 airflow 维度恒列(写路径 requireMwaaForTargets 只核非 home;列表不许比写路径更严)", async () => {
    targets = { tgt_home: { targetId: "tgt_home", region: "us-east-1", jurisdiction: "home", components: ["core", "redshift"] } };
    expect((await listComponentCapableTargets("airflow", opts)).map((x) => x.targetId)).toEqual(["tgt_home"]);
    expect((await listComponentCapableTargets("airflow", opts))[0]).toMatchObject({ isHome: true, region: "us-east-1" });
  });
});
