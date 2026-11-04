// 🔴 **L1 扫描门禁**(52 SPEC §3.5 / DESIGN §11.4 的"硬验收门:巡检扫全仓 == 0"的代码侧)。
//
// 【为什么必须有这条,而不是"改完 8 处就完事"】L1 撤掉的 8 处里有 **6 处是生成侧**
// (LLM 提示词 / cookbook 配方 / ETL 默认模板 / 编译副本)。生成侧的特点是:
// 你把授权语句从执行路径删了,但只要提示词还在教,**下一次 AI 生成又会把它写回来** ——
// 而那份新生成的代码是用户的作业,没人会来 review 它。这正是 memory `bug-fix-dual-track-cookbook`
// 记的教训:执行侧 + 配方双管齐下,少一管等于白改。
// 本门禁 = 第三管:让"再出现一次"在**提交前**就红,而不是在某个客户的数仓里被发现。
//
// 【扫描面刻意包含 `infra/agent/genbi/core-dist`(编译副本)】—— 施工时逮到的真事:
// 该目录**被 git 跟踪**,里面是 cookbook seed 的编译产物,GenBI AgentCore 容器加载的是**它**。
// 只改 TS 源不重跑 `scripts/core-prebuild.sh all`,远程 GenBI 路径就还是老规则 = 隐性 no-op。
// 上一轮台账曾误记"编译副本不存在也未被跟踪",本门禁顺手把那类误判钉死:源与产物必须同时干净。
//
// 【刻意不扫 `docs/`】设计文档(52 SPEC/DESIGN、本模块台账)必须能**逐字讨论**这条禁令,
// 扫文档只会逼出一堆豁免。文档不被执行,不构成敞口。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";
import { GRANT_TO_PUBLIC_PATTERN, noGrantToPublicRule } from "@/lib/cookbook/seed/shared-rules";
import { guard } from "@/lib/cookbook";
import { sqlSkeleton, assertNoCrossProjectMove } from "@/lib/exec-env/admin-ddl-guards";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");

/** 扫描面:平台源码 + infra(含**被跟踪的编译副本**)+ 仓根部署脚本。 */
const ROOTS = [
  "platform/src",
  "infra/lib",
  "infra/lambda",
  "infra/scripts",
  "infra/bin",
  "infra/buildspec",
  "infra/agent", // 🔴 含 genbi/core-dist —— 容器真正加载的那份
  "scripts",
];

const SCANNED_EXT = /\.(ts|tsx|mjs|cjs|js|py|sh|sql|yml|yaml)$/;

/**
 * 🔴 **豁免名单 = 禁令自身的定义与它的测试,仅此**(4 项,冻结)。
 *
 * 名单每多一项,禁令就少一分绝对性 ⇒ 加项必须改本文件 = 在 review 里可见。
 * 另有一条"名单不许腐烂"的反向断言:名单里的文件**必须真的命中**,
 * 否则说明该豁免已经没有理由存在,必须删掉(照 writer-topology 门禁的先例:白名单腐烂也拒)。
 */
const ALLOWLIST: readonly string[] = [
  "platform/src/lib/exec-env/admin-ddl-guards.ts", // 那条禁令正则的人读标签
  "platform/src/lib/exec-env/admin-ddl-templates.ts", // 模板文件里"绝不这么写"的注释
  "platform/src/lib/exec-env/__tests__/admin-ddl-guards.test.ts", // 审核给的 payload
  "platform/src/lib/projects/__tests__/l1-no-grant-to-public.test.ts", // 本文件的样本
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === "cdk.out" || e === "__pycache__") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SCANNED_EXT.test(e)) out.push(p);
  }
  return out;
}

/** 逐行扫(不整文件扫):`[^;]*` 跨行会把"上一句的 GRANT + 十行后的 public"连成假命中。 */
function hits(file: string): string[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (GRANT_TO_PUBLIC_PATTERN.test(lines[i])) {
      out.push(`${relative(REPO, file)}:${i + 1}  ${lines[i].trim().slice(0, 120)}`);
    }
  }
  return out;
}

function allFiles(): string[] {
  return ROOTS.flatMap((r) => walk(resolve(REPO, r)));
}

describe("🔴 L1 门禁:全仓不许再出现「把数仓对象授权给 PUBLIC」", () => {
  it("扫描面有效(目录改名/搬走不许静默扫 0 个文件)", () => {
    const files = allFiles();
    expect(files.length, "一个文件都没扫到 = 门禁失效").toBeGreaterThan(400);
    // 编译副本必须在扫描面里 —— 否则"改源没重分发"这类漂移逃过门禁。
    expect(
      files.some((f) => relative(REPO, f).startsWith("infra/agent/genbi/core-dist/cookbook/seed/")),
      "编译副本(core-dist/cookbook/seed)不在扫描面 = 容器那份可以偷偷带着老规则"
    ).toBe(true);
  });

  it("全仓 0 命中(豁免名单外一处都不许有;逐文件逐行报位置)", () => {
    const offenders: string[] = [];
    for (const f of allFiles()) {
      const rel = relative(REPO, f);
      if (ALLOWLIST.includes(rel)) continue;
      offenders.push(...hits(f));
    }
    expect(
      offenders,
      "🔴 又出现了把数仓对象授权给 PUBLIC 的形态 —— 它让库内所有身份读写该表,击穿项目隔离。" +
        "平台各路径统一数仓身份,建完表本就可见,不需要任何补授权;要授权请给具体项目角色。"
    ).toEqual([]);
  });

  it("豁免名单不许腐烂:每项都必须存在且真的命中(否则该豁免已无理由,删掉)", () => {
    expect(ALLOWLIST.length, "豁免名单长度变了 —— 加/删豁免必须是显式动作").toBe(4);
    const rotten: string[] = [];
    for (const rel of ALLOWLIST) {
      const abs = resolve(REPO, rel);
      if (!existsSync(abs)) {
        rotten.push(`${rel} 不存在(文件已删/改名 ⇒ 豁免项该跟着删)`);
        continue;
      }
      if (hits(abs).length === 0) rotten.push(`${rel} 已无命中 ⇒ 该豁免多余,必须从名单删掉`);
    }
    expect(rotten, "豁免名单腐烂").toEqual([]);
  });

  it("门禁会咬:8 处历史站点的原文逐条命中", () => {
    // 与 52 DESIGN §11.4 的清单一一对应(2026-09-03 撤除前的真实文本)。
    const historical: Array<[string, string]> = [
      ["①execute-ddl 运行时", "await rs.send(new ExecuteStatementCommand({ Sql: `GRANT ALL ON ${grantTarget} TO PUBLIC`, WorkgroupName: wg }));"],
      ["②glue 脚本生成器", '        run_stmt(f"GRANT ALL ON {rs_table} TO PUBLIC", "GRANT", fatal=False)'],
      ["③codegen 提示词", "建表后建议 `GRANT ALL ... TO PUBLIC` 以便平台查询。"],
      ["④cookbook 模板", '      "GRANT ALL ON public.dws_channel_roi TO PUBLIC;   -- 建表后 GRANT,否则平台查询页看不到",'],
      ["⑤cookbook dialectNotes", '      "建结果表后 GRANT ALL ... TO PUBLIC,否则平台查询页/GenBI 查不到该表。",'],
      ["⑥ETL 默认模板", "GRANT SELECT ON public.sales_by_region TO PUBLIC;"],
      ["⑦编译副本 template", '            "GRANT ALL ON public.dws_channel_roi TO PUBLIC;   -- 建表后 GRANT,否则平台查询页看不到",'],
      ["⑧编译副本 dialectNotes", '            "建结果表后 GRANT ALL ... TO PUBLIC,否则平台查询页/GenBI 查不到该表。",'],
    ];
    for (const [where, line] of historical) {
      expect(GRANT_TO_PUBLIC_PATTERN.test(line), `${where} 这一行没被咬住 = 门禁形同不存在`).toBe(true);
    }
  });

  it("不误咬:提到 public schema / REVOKE / 授权给项目角色都不该红", () => {
    const benign = [
      // 真实误咬源(i18n 文案):句子里同时有 "to public." —— 但没有 GRANT。
      "e.g. compute sales by product category and write the result to public.dws_category_sales (category, sales).",
      "例如:统计每个商品分类的销售额,结果写入 public.dws_category_sales。",
      // 撤销授权(L1 存量清理要用的正是它)不该被自己的门禁拦。
      "REVOKE ALL ON public.orders FROM PUBLIC;",
      // 正解形态:授权给具体项目角色(供给层要生成的就是这个)。
      "GRANT SELECT ON ALL TABLES IN SCHEMA shared TO ROLE role_proj_abc;",
      "GRANT USAGE ON SCHEMA proj_abc TO ROLE role_proj_abc;",
      // 同一行里 GRANT 与 public 之间**隔着分号**(两条语句)⇒ 不是同一条语句,不该咬。
      "GRANT USAGE ON SCHEMA s TO ROLE r; SELECT * FROM public.t;",
    ];
    for (const line of benign) {
      expect(GRANT_TO_PUBLIC_PATTERN.test(line), `误咬:${line}`).toBe(false);
    }
  });

  it("与 admin-DDL 通道那条禁令**判定一致**(两处同形,不靠人记得)", () => {
    // admin-ddl-guards.ts 的 cross-project-move 名单里也有一条拦"授权给 PUBLIC";
    // 两处如果漂移,就会出现"一条通道拦、另一条放"的裂缝。用同一组样本钉住一致性。
    const samples = [
      "GRANT ALL ON public.t TO PUBLIC",
      "grant all on schema proj_a to public",
      "GRANT SELECT ON public.t TO PUBLIC;",
      "GRANT SELECT ON public.t TO ROLE role_proj_a",
      "REVOKE ALL ON public.t FROM PUBLIC",
    ];
    for (const s of samples) {
      const mine = GRANT_TO_PUBLIC_PATTERN.test(sqlSkeleton(s));
      let theirs = false;
      try {
        assertNoCrossProjectMove(s);
      } catch (e) {
        theirs = String((e as Error).message).includes("PUBLIC");
      }
      expect(mine, `两处判定不一致(样本:${s})`).toBe(theirs);
    }
  });
});

describe("🔴 L1 生成侧护栏:三引擎方言硬规则真的挂上并且会拦执行", () => {
  const ENGINES = ["redshift", "glue", "emr"] as const;

  it.each(ENGINES)("%s:规则在册、error 级、无 fix(⇒ guard 判 blocked 而不是悄悄改代码)", (engine) => {
    const r = noGrantToPublicRule(engine);
    expect(r.id).toBe(`${engine}.no-grant-to-public`);
    expect(r.severity).toBe("error");
    expect(r.fix, "禁止给 fix:机械删语句会制造新 bug,命中即拦让人改").toBeUndefined();
    expect(r.antiPattern, "没有 antiPattern 就只是提示词,拦不住运行").toBe(GRANT_TO_PUBLIC_PATTERN);
  });

  it.each(ENGINES)("%s:guard 对真实违规样本 blocked,并报出规则 id", (engine) => {
    const violating =
      engine === "redshift"
        ? "CREATE TABLE public.t AS SELECT 1;\nGRANT ALL ON public.t TO PUBLIC;"
        : "rs.execute_statement(WorkgroupName='bgp-workgroup', Database='dev', Sql='GRANT ALL ON public.t TO PUBLIC')";
    const g = guard(engine, violating);
    expect(g.blocked, `${engine} 的违规样本没被拦 = 双管齐下少了一管`).toBe(true);
    expect(g.violations.some((v) => v.ruleId === `${engine}.no-grant-to-public`)).toBe(true);
    // 本规则无 fix ⇒ 绝不能机械改写用户代码(target=code 的引擎更是 §4.3 明令禁止)。
    // 只断"这条规则没改东西"(别的规则可能有自己的 fix,不该由本测试绑死)。
    expect(g.fixed.some((f) => f.ruleId === `${engine}.no-grant-to-public`)).toBe(false);
    expect(g.code.toUpperCase(), "违规语句被本规则悄悄删掉了 = 在替用户改语义").toContain("TO PUBLIC");
  });

  it.each(ENGINES)("%s:合规样本不误拦(不能为了安全把功能判死)", (engine) => {
    const ok =
      engine === "redshift"
        ? "CREATE TABLE IF NOT EXISTS public.t (a int);"
        : "rs.execute_statement(WorkgroupName='bgp-workgroup', Database='dev', Sql='CREATE TABLE IF NOT EXISTS public.t (a int)')";
    const g = guard(engine, ok);
    expect(
      g.violations.some((v) => v.ruleId === `${engine}.no-grant-to-public`),
      "误拦了合规样本"
    ).toBe(false);
  });

  it("规则文本单作者:三份实例的 antiPattern 是**同一个**正则对象(不是三份拷贝)", () => {
    const [a, b, c] = ENGINES.map((e) => noGrantToPublicRule(e));
    expect(a.antiPattern).toBe(b.antiPattern);
    expect(b.antiPattern).toBe(c.antiPattern);
    // 规则正文也必须同源(只有开头那句"怎么做"按引擎不同)。
    const tail = (s: string) => s.slice(-120);
    expect(tail(a.rule)).toBe(tail(b.rule));
    expect(tail(b.rule)).toBe(tail(c.rule));
  });
});
