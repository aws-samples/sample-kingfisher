// @kf-batch 50-P50.1-workgroup-ssot
// 数仓落点收编的门禁(P50.1「收编兜底字面量」+「缺省逐字节等价」)。
//
// 三件事必须钉住:
// ① **等价性**:`homeWorkgroup()/homeDatabase()` 与改动前的 `process.env.X || "字面量"` 同值 ——
//    这是 P50.1「无损重构」宣称的全部内容,不能只在提交信息里说;
// ② **非 home fail-closed**:绝不 `?? home` 兜底(外部审核 P0-4 抓过的 fail-open 形状);
// ③ **反向覆盖**:全仓不许再出现新的 `"bgp-workgroup"` 兜底字面量 —— 收编一次不难,
//    难的是三个月后有人又写一个。所以门禁扫源码,并把**允许出现的地方**冻结成白名单。
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import {
  HOME_WORKGROUP,
  HOME_DATABASE,
  homeWorkgroup,
  homeDatabase,
  resolveWorkgroup,
  resolveDatabase,
  warehouseLocationSync,
  assertHomeOnly,
} from "@/lib/redshift/warehouse-location";
import { resourceName } from "@/lib/aws/naming";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";

describe("🔴 缺省逐字节等价(P50.1 的全部宣称)", () => {
  it("home 名来自命名 SSOT,且与被收编的字面量同值", () => {
    expect(HOME_WORKGROUP).toBe(resourceName("redshiftWorkgroup", { targetId: HOME_TARGET_ID }));
    expect(HOME_DATABASE).toBe(resourceName("redshiftDatabase", { targetId: HOME_TARGET_ID }));
    // 🔴 这两条是"存量字面量到底是什么"的锚:命名 SSOT 若被改动,这里立刻红,
    //    提醒改的人去核实"存量资源是不是也跟着改名了"(home 豁免的意义就在这)。
    expect(HOME_WORKGROUP).toBe("bgp-workgroup");
    expect(HOME_DATABASE).toBe("dev");
  });

  it("三级兜底的真值语义与 `a || b || c` 逐条一致(刻意不 trim)", () => {
    expect(resolveWorkgroup("my-wg")).toBe("my-wg");
    expect(resolveWorkgroup("")).toBe(homeWorkgroup());
    expect(resolveWorkgroup(null)).toBe(homeWorkgroup());
    expect(resolveWorkgroup(undefined)).toBe(homeWorkgroup());
    // 空白串在原实现里是 **truthy**,会被当成配置值用。收编时"顺手改好"会让等价性宣称变假。
    expect(resolveWorkgroup(" ")).toBe(" ");
    expect(resolveDatabase("")).toBe(homeDatabase());
    expect(resolveDatabase("mydb")).toBe("mydb");
  });

  it("env 覆盖仍是中间那一层(顺序:config → env → SSOT)", () => {
    const saved = process.env.REDSHIFT_WORKGROUP;
    try {
      process.env.REDSHIFT_WORKGROUP = "wg-from-env";
      expect(homeWorkgroup()).toBe("wg-from-env");
      expect(resolveWorkgroup(undefined)).toBe("wg-from-env");
      expect(resolveWorkgroup("wg-from-config")).toBe("wg-from-config"); // config 优先级最高
      delete process.env.REDSHIFT_WORKGROUP;
      expect(homeWorkgroup()).toBe(HOME_WORKGROUP); // env 缺失 → SSOT
    } finally {
      if (saved === undefined) delete process.env.REDSHIFT_WORKGROUP;
      else process.env.REDSHIFT_WORKGROUP = saved;
    }
  });
});

describe("🔴 非 home fail-closed(绝不 `?? home` 兜底)", () => {
  it("缺省 / 显式 home ⇒ 正常返回", () => {
    expect(warehouseLocationSync().workgroup).toBe(homeWorkgroup());
    expect(warehouseLocationSync({ targetId: HOME_TARGET_ID }).database).toBe(homeDatabase());
    expect(warehouseLocationSync({ workgroup: "w", database: "d" })).toMatchObject({ workgroup: "w", database: "d" });
  });

  it("非 home ⇒ 抛错并指向描述符(不能悄悄给 home 的落点)", () => {
    for (const tid of ["tgt_usw2_a", "tgt_euw1_a"]) {
      expect(() => warehouseLocationSync({ targetId: tid })).toThrow(/只解析 home|描述符/);
    }
  });
});

describe("🔴 `target?` 参数位:缺省等价、非 home 必抛(50 SPEC §3.4)", () => {
  // 🔴 这一组是**变异 M21 逼出来的**:第一版只测了 `warehouseLocationSync`,
  //    而 4 个原子函数走的是 `assertHomeOnly` —— 把它改成恒不抛(静默回落 home = 静默跨区执行)
  //    仍然全绿。「没有测试的 fail-closed 等于没有 fail-closed」。
  it("assertHomeOnly:缺省 / home 放行,非 home 抛错且文案说明为什么不回落", () => {
    expect(assertHomeOnly(undefined, "X")).toBe(HOME_TARGET_ID);
    expect(assertHomeOnly(HOME_TARGET_ID, "X")).toBe(HOME_TARGET_ID);
    expect(() => assertHomeOnly("tgt_usw2_a", "GenBI 查询")).toThrow(/GenBI 查询/);
    expect(() => assertHomeOnly("tgt_usw2_a", "X")).toThrow(/不回落 home/);
  });

  // @kf-batch 50-WP2-directquery / 50-WP4ter-coverage
  // 🔴🔴 **本条的口径按用户两次拍板改过两回**,每次都不是把判据放宽:
  //    ① 原契约「4 个原子函数传非 home 一律拒」—— 那时 per-target 客户端/凭证还没做,回落 home = 静默跨区;
  //    ② 用户 2026-09-09 拍板「连问数都可以切区」⇒ **Redshift 侧两个**改成按该 target 的数仓执行;
  //    ③ 用户 2026-09-10 拍板「全平台一个不许漏」⇒ **Athena / S3Tables 两个也按区**
  //       (`lib/athena/client.ts` 的 `resolveAthenaPlace` + `lib/athena/s3tables.ts` 的 `resolveS3TablesPlace`
  //        把 region / workgroup / 结果桶 / 联邦目录四样整体解析)⇒ 「一律拒」不再是正确行为。
  // 🔴 但 fail-closed **没有丢,只是换了位置**:落点解析不出来(资源袋里没有 workgroup / 表桶)
  //    必须拒,且拒因要明说「不会拿主控区的顶上」—— 那才是这条判据真正要守的东西
  //    (回落主控区 = 在别的区问出主控区的数据,而界面上看起来完全正常)。
  it("🔴 Athena / S3Tables 落点解析:资源袋缺 workgroup / 表桶 ⇒ 必须拒,且明说不拿主控区顶上", async () => {
    vi.resetModules();
    vi.doMock("@/lib/exec-env/registry", () => ({
      // 一个「装好了但资源袋里没有 Athena 工作组 / 表桶」的 target
      requireReadyTarget: vi.fn(async (id: string) => ({ targetId: id, region: "us-west-2", resources: {} })),
    }));
    const { resolveAthenaPlace } = await import("@/lib/athena/client");
    const { resolveS3TablesPlace } = await import("@/lib/athena/s3tables");
    await expect(resolveAthenaPlace("tgt_usw2_a")).rejects.toThrow(/不会拿主控区的工作组替它跑/);
    await expect(resolveS3TablesPlace("tgt_usw2_a")).rejects.toThrow(/不会拿主控区的表桶顶上/);
    vi.doUnmock("@/lib/exec-env/registry");
    vi.resetModules();
  });

  // @kf-batch 50-WP31-place-first-class —— 原判据是「缺省与显式 home 等价」;序 3 起落点必填 ⇒ 改成对:
  //   显式 home 走存量 env 值(逐字节等价)· 缺省 / 空串 / 非法 ⇒ 拒(不再静默 = 主控区)
  it("🔴 Athena / S3Tables 落点解析:显式 home 逐字节等价;缺省 / 空串 ⇒ 拒", async () => {
    const { resolveAthenaPlace } = await import("@/lib/athena/client");
    const { resolveS3TablesPlace } = await import("@/lib/athena/s3tables");
    await expect(resolveAthenaPlace(undefined as never)).rejects.toThrow(/非法 targetId/);
    await expect(resolveAthenaPlace("")).rejects.toThrow(/非法 targetId/);
    await expect(resolveS3TablesPlace(undefined as never)).rejects.toThrow(/非法 targetId/);
    const a1 = await resolveAthenaPlace(HOME_TARGET_ID);
    expect(a1.home).toBe(true);
    const s1 = await resolveS3TablesPlace(HOME_TARGET_ID);
    expect(s1.home).toBe(true);
    // 联邦目录引用在 home 下必须仍是存量那个(换了它,存量 SQL 里的三段名全部失效)
    expect(s1.catalogRef).toBe(`${process.env.S3TABLES_CATALOG || "s3tablescatalog"}/${process.env.S3TABLES_BUCKET || "bgp-table-bucket"}`);
  });

  it("🔴 Redshift 侧两个原子函数:非法 targetId 必须在发任何 SQL 之前被拒(fail-closed 没丢)", async () => {
    const { runSelect } = await import("@/lib/genbi/redshift");
    const { introspectSchema } = await import("@/lib/genbi/schema");
    const bad = { targetId: "tgt_BAD!" }; // 形态非法 ⇒ 落点解析立刻拒,不碰 AWS
    // `introspectSchema` 抛;`runSelect` 把异常收进它既有的错误通道(对调用方是同一件事:没执行、有原因)
    await expect(introspectSchema("wg", "db", bad)).rejects.toThrow(/非法 targetId/);
    const r = await runSelect("SELECT 1", "wg", "db", bad);
    expect(r.success).toBe(false);
    expect(r.error || "").toMatch(/非法 targetId/);
    expect(r.rows).toEqual([]);
  });

  it("四个函数的签名里 target 参数位**真的存在**(不是只写在注释里)", async () => {
    const { runSelect } = await import("@/lib/genbi/redshift");
    const { introspectSchema } = await import("@/lib/genbi/schema");
    const { runSelectAthena, introspectS3Tables } = await import("@/lib/genbi/athena");
    // ⚠️ 口径订正:TS 的 `opts?: T` 编译成**普通形参**(没有默认值)⇒ **计入** `Function.length`;
    //    只有带 `= 默认值` 的形参才截断计数(所以 introspectS3Tables 的 namespace 让它停在 0)。
    //    我第一版按"可选不计数"写,断言值全少 1 —— 记在这里,免得下次又按错的直觉写。
    expect(runSelect.length, "runSelect(sql, wg, db, opts?)").toBe(4);
    expect(introspectSchema.length, "introspectSchema(wg, db, opts?)").toBe(3);
    expect(runSelectAthena.length, "runSelectAthena(sql, opts)").toBe(2);
    // @kf-batch 50-B26-lake-place —— namespace 去掉默认值、opts 改必填键 ⇒ 2。
    // 🔴 本条当年只验「形参存在」,而问数主循环两处调用**都没传** —— 形参在、没人接 ⇒ 数据湖问数整条落回主控区。
    //    「接上了」由 `lake-target-required.test.ts` 在**调用位置**判,这里只留签名形状。
    expect(introspectS3Tables.length, "introspectS3Tables(namespace, opts)").toBe(2);
  });
});

describe("🔴 反向覆盖:全仓不许再长出新的兜底字面量", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC = resolve(HERE, "../../..");
  const INFRA = resolve(SRC, "../../infra/lib");

  /** 允许出现字面量的地方 —— **冻结名单**,加一项都要有理由。 */
  const ALLOWLIST = [
    // 收编出口自己的说明文字(它必须能引用被收编的形状)
    "lib/redshift/warehouse-location.ts",
    // 冻结破例的授权说明(legacy 引擎)
    "lib/workflow/dag-generator.ts",
    // 历史注释里引用了旧写法(不是活代码)
    "lib/engines/platform-env.ts",
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "cdk.out" || e.name === "__tests__") continue;
        walk(p, out);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  /** 🔴 先剥注释:说明文字里出现被禁的形状是正当的,不剥就会把说明当违规(已栽过多次)。 */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  }

  it("platform/src 里除白名单外,活代码中没有 `\"bgp-workgroup\"`", () => {
    const files = walk(SRC);
    expect(files.length, "一个文件都没扫到 ⇒ 路径错了,这条门禁等于没跑").toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(SRC, f);
      if (ALLOWLIST.includes(rel)) continue;
      if (/"bgp-workgroup"/.test(stripComments(readFileSync(f, "utf8")))) offenders.push(rel);
    }
    expect(
      offenders,
      `这些文件又写了 workgroup 兜底字面量,应改用 @/lib/redshift/warehouse-location:${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("白名单每一项都必须**真的**命中(防名单腐烂成永久豁免)", () => {
    for (const rel of ALLOWLIST) {
      const src = readFileSync(resolve(SRC, rel), "utf8");
      expect(src, `白名单项 ${rel} 已不含该字面量 ⇒ 应从名单里删掉`).toContain('"bgp-workgroup"');
    }
  });

  it("infra/lib 里也没有(部署侧同样只能走命名 SSOT)", () => {
    const offenders: string[] = [];
    for (const f of walk(INFRA)) {
      if (/"bgp-workgroup"/.test(stripComments(readFileSync(f, "utf8")))) offenders.push(relative(INFRA, f));
    }
    expect(offenders, `infra 侧应改用 resourceName("redshiftWorkgroup", …):${offenders.join(", ")}`).toEqual([]);
  });
});
