// 🔴🔴 (单测):**落点 / 窄权写者身份唯一作者**的闭合式门禁(SPEC §3.9d.3)。
//
// 为什么必须是闭合式:码表物理落点曾经有两个作者各写一个名字(`public.dim_code_<code>` 与
// `shared.code_<id>`),两者没有任何机械关系 —— 而它们各自的单测都是绿的。「枚举违规写法」的门禁
// 一定漏第 N+1 种拼法(记忆 gate-enumerates-violations-not-legal-form),所以这里反过来写:
// 列出**唯一允许出现**那几个字面量的文件(只有 SSOT 自己),其它任何生产文件出现即红;
// 并且四个消费者必须在**调用位置**用 SSOT(剥掉 import 行再查,import 不算接上 —— 记忆 wiring-criteria-must-check-call-site)。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPlatformGlobalSchema,
  codeTableLandingFqn,
  sharedWriterSecretName,
  sharedWriterUserName,
  LandingSchemaRejected,
} from "@/lib/modeling/landing-fqn";
import { buildLandStatements, buildCodeTableCreateStatement, buildCodeTableWriteStatements, codeTableName } from "@/lib/modeling/redshift";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OWNER = "lib/modeling/landing-fqn.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
/** 剥注释(块注释 + 行注释);判据只看代码,注释里讲历史不算第二个作者。 */
function code(p: string): string {
  return readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}
const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), body: code(p) }));

describe("🔴🔴 落点唯一作者:闭合式(只有 SSOT 自己能写出这些名字)", () => {
  it("扫描面不为空(空扫描恒绿 = 空断言)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.rel === OWNER)).toBe(true);
  });

  for (const [what, re, inOwner] of [
    ["码表落地表名前缀 dim_code_", /dim_code_/, true],
    // 纯负向:B 段收敛时这个形态才会回到 SSOT 里;此前任何文件(含 SSOT)都不许有
    ["旧模板自己拼的第二个落点 code_<id>", /`code_\$\{/, false],
    ["窄权写者 secret 前缀 bgp/shared-writer", /bgp\/shared-writer/, true],
    ["窄权写者库用户名 shared_writer(带引号的字面量)", /["'`]shared_writer["'`]/, true],
  ] as const) {
    it(`${what}:只许出现在 ${OWNER}`, () => {
      const offenders = files.filter((f) => f.rel !== OWNER && re.test(f.body)).map((f) => f.rel);
      expect(offenders, `这些文件自己拼了落点 / 身份名 ⇒ 第二个作者:${offenders.join(", ")}`).toEqual([]);
      if (inOwner) expect(re.test(files.find((f) => f.rel === OWNER)!.body), "SSOT 自己里都没有 ⇒ 判据钉错了对象").toBe(true);
    });
  }

  it("四个消费者在**调用位置**经 SSOT(剥掉 import 行再查)", () => {
    const callers: Record<string, RegExp> = {
      // ① 现网落地语句(表名)② 矩阵 physical / 解绑 / 预览 / 落地(service)③ admin 模板 land-code-table / grant / drop
      "lib/modeling/redshift.ts": /codeTableLandingFqn\(/,
      "lib/modeling/service.ts": /codeTableLandingFqn\(/,
      "lib/exec-env/admin-ddl-templates.ts": /codeTableLandingFqn\(/,
      // 执行器供给窄权写者、落地路径按名现查 secret
      "lib/exec-env/admin-ddl-executor.ts": /sharedWriterSecretName\(/,
      "lib/modeling/landing.ts": /sharedWriterSecretName\(/,
    };
    for (const [rel, re] of Object.entries(callers)) {
      const f = files.find((x) => x.rel === rel);
      expect(f, `${rel} 不见了`).toBeTruthy();
      const noImports = f!.body
        .split("\n")
        .filter((l) => !/^\s*(import|export)\b.*from\s+["']/.test(l) && !/^\s*[A-Za-z_, ]+\s*,?\s*$/.test(l))
        .join("\n");
      expect(re.test(noImports), `${rel} 只 import 了 SSOT、没在调用位置用它`).toBe(true);
    }
  });
});

describe("🔴 SSOT 的值(过渡期逐字节 = 现网;B 段只改这一个返回值)", () => {
  it("codeTableLandingFqn = public.dim_code_<code>;home 落地语句逐字节不变", () => {
    expect(codeTableLandingFqn({ code: "order_status" })).toEqual({
      schema: "public",
      table: "dim_code_order_status",
      fqn: "public.dim_code_order_status",
    });
    expect(codeTableName("order_status")).toBe("dim_code_order_status");
    const values = [
      { value: "A", label: "甲", seq: 0 },
      { value: "B'x", label: "乙", seq: 1 },
    ];
    // 🔴 逐字节快照:改造前 buildLandStatements 的产物(home 路径零变化)
    expect(buildLandStatements("order_status", values)).toEqual([
      'CREATE TABLE IF NOT EXISTS "public"."dim_code_order_status" ("value" VARCHAR(64) NOT NULL, "label" VARCHAR(256), "seq" INTEGER)',
      'DELETE FROM "public"."dim_code_order_status"',
      `INSERT INTO "public"."dim_code_order_status" ("value","label","seq") VALUES ('A', '甲', 0), ('B''x', '乙', 1)`,
    ]);
    // 两层拆分只是拼法不同,不是两个作者
    expect([buildCodeTableCreateStatement("order_status"), ...buildCodeTableWriteStatements("order_status", values)]).toEqual(
      buildLandStatements("order_status", values)
    );
  });

  it("窄权写者:库用户名 shared_writer;secret 名 = bgp/shared-writer/<targetSlug>(target 维走 toTargetSlug)", () => {
    expect(sharedWriterUserName()).toBe("shared_writer");
    expect(sharedWriterSecretName("tgt_usw2_a")).toBe("bgp/shared-writer/tgt-usw2-a");
    expect(() => sharedWriterSecretName("bad id")).toThrow();
  });

  it("🔴 门②:proj_ 前缀(大小写折叠)/ 空 ⇒ 拒;平台全局 schema ⇒ 放", () => {
    for (const bad of ["proj_x", "PROJ_ABC", " proj_default ", ""]) {
      expect(() => assertPlatformGlobalSchema(bad), JSON.stringify(bad)).toThrow(LandingSchemaRejected);
    }
    for (const ok of ["public", "shared", "dw", "ods", "project_x"]) expect(assertPlatformGlobalSchema(ok)).toBe(ok);
  });
});
