// 「`CREATE SCHEMA IF NOT EXISTS` 不是并发安全的」这一**类**缺陷的判据:
//   ① 判别函数的行为(含负向:真故障不许被重试掩盖);
//   ② 重试包装器的行为;
//   ③ 🔴 **零棘轮**:仓里每一个发出 `CREATE SCHEMA IF NOT EXISTS` 的地方都必须走加固路径。
//      「机制建好了但那条路径没接」是本仓反复踩的元 bug ⇒ 用清单驱动的闭合判据钉死,不靠记性。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isConcurrentSchemaCreate,
  isIdempotentSchemaCreate,
  withSchemaCreateRetry,
} from "@/lib/redshift/concurrent-schema";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const REAL = "ERROR: duplicate key violates unique constraint \"pg_namespace_nspname_index\" (possibly caused by concurrent transaction conflict)";

describe("并发签名的判别力", () => {
  it("认得真环境那一句,也认得只给「已存在 + schema」措辞的变体", () => {
    expect(isConcurrentSchemaCreate(new Error(REAL))).toBe(true);
    expect(isConcurrentSchemaCreate(new Error("CREATE SCHEMA failed: " + REAL))).toBe(true);
    expect(isConcurrentSchemaCreate(new Error("ERROR: schema \"showcase\" already exists"))).toBe(true);
  });

  it("🔴 负向:真故障一个都不许判成可重试(否则红灯被拖成 60 秒后的红灯)", () => {
    expect(isConcurrentSchemaCreate(new Error("ERROR: permission denied for database dev"))).toBe(false);
    expect(isConcurrentSchemaCreate(new Error("ERROR: syntax error at or near \"SCHEMAA\""))).toBe(false);
    // 「表已存在」不是 schema 竞态 —— 不许顺手一起吞
    expect(isConcurrentSchemaCreate(new Error("ERROR: duplicate key value violates unique constraint \"orders_pkey\""))).toBe(false);
    expect(isConcurrentSchemaCreate(new Error(""))).toBe(false);
    expect(isConcurrentSchemaCreate(undefined)).toBe(false);
  });

  it("只有带 IF NOT EXISTS 的 schema 创建才算幂等(裸 CREATE SCHEMA 必须立刻红)", () => {
    expect(isIdempotentSchemaCreate("CREATE SCHEMA IF NOT EXISTS \"showcase\"")).toBe(true);
    expect(isIdempotentSchemaCreate("  create schema if not exists showcase AUTHORIZATION u;")).toBe(true);
    expect(isIdempotentSchemaCreate("CREATE SCHEMA showcase")).toBe(false);
    expect(isIdempotentSchemaCreate("CREATE TABLE IF NOT EXISTS showcase.t (a int)")).toBe(false);
  });
});

describe("withSchemaCreateRetry 的行为", () => {
  const SQL = "CREATE SCHEMA IF NOT EXISTS showcase";

  it("并发签名 ⇒ 重试到 no-op 成功(成功本身即证明 schema 已在)", async () => {
    let n = 0;
    const r = await withSchemaCreateRetry(SQL, async () => {
      n++;
      if (n < 3) throw new Error(REAL);
      return "ok";
    }, { delayMs: 0 });
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });

  it("🔴 别的错误 ⇒ 一次都不重试", async () => {
    let n = 0;
    await expect(withSchemaCreateRetry(SQL, async () => {
      n++;
      throw new Error("ERROR: permission denied for database dev");
    }, { delayMs: 0 })).rejects.toThrow(/permission denied/);
    expect(n).toBe(1);
  });

  it("🔴 语句不是幂等 schema 创建 ⇒ 即使撞到同一个签名也不重试", async () => {
    let n = 0;
    await expect(withSchemaCreateRetry("CREATE SCHEMA showcase", async () => {
      n++;
      throw new Error(REAL);
    }, { delayMs: 0 })).rejects.toThrow(/pg_namespace_nspname_index/);
    expect(n).toBe(1);
  });

  it("窗口用完仍失败 ⇒ 抛原错(不吞)", async () => {
    let n = 0;
    await expect(withSchemaCreateRetry(SQL, async () => {
      n++;
      throw new Error(REAL);
    }, { attempts: 3, delayMs: 0 })).rejects.toThrow(/pg_namespace_nspname_index/);
    expect(n).toBe(3);
  });
});

/** 逐行剥掉行注释与块注释起始行(负向文本判据前必须剥注释 —— 否则注释里提一句就算「出现」)。 */
function stripComments(body: string): string {
  return body
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

describe("🔴 零棘轮:每个发 CREATE SCHEMA IF NOT EXISTS 的地方都必须走加固路径", () => {
  // 发出点 → 负责加固的文件(发出与执行常常不在一处:模板只拼语句,重试在执行器里)
  const HARDENED_BY: Record<string, string> = {
    "lib/exec-env/admin-ddl-templates.ts": "lib/exec-env/admin-ddl-executor.ts",
    // 发出点(建模 DDL 生成)不变,加固点改到**真正执行它的那条路**:
    //   原映射指向 redshift.ts 自己的 execStatements,而那个函数零生产调用方(已删)⇒ 这条门禁一直在给死代码打勾。
    "lib/modeling/redshift.ts": "lib/modeling/landing.ts",
    "lib/realtime/redshift-target.ts": "lib/realtime/redshift-target.ts",
    // Glue 生成脚本是**另一个运行时**(Python),它自己那份加固叫 ensure_schema
    "lib/sync/glue-script-generator.ts": "lib/sync/glue-script-generator.ts",
  };
  // 🔴 只减不增:还没加固的发出点。**必须保持空**(要加进来先说明为什么这一处不可能并发)。
  const ALLOW: string[] = [];

  it("发出点清单闭合,且每个点的加固都在位", () => {
    const emitters: string[] = [];
    for (const p of walk(SRC)) {
      const rel = relative(SRC, p);
      if (rel.startsWith("lib/redshift/concurrent-schema.ts")) continue; // 判别模块自己
      const code = stripComments(readFileSync(p, "utf8"));
      if (/create\s+schema\s+if\s+not\s+exists/i.test(code)) emitters.push(rel);
    }
    // 闭合:发出点必须都在映射里(新增一处就会在这里现形)
    const unknown = emitters.filter((f) => !(f in HARDENED_BY) && !ALLOW.includes(f));
    expect(unknown, `新的 CREATE SCHEMA IF NOT EXISTS 发出点没有加固:${unknown.join(", ")}`).toEqual([]);
    expect(ALLOW, "ALLOW 是只减不增的棘轮,必须保持空").toEqual([]);
    // 反向闭合:映射里的点必须真的还在发(否则是陈旧条目,会把棘轮养肥)
    for (const f of Object.keys(HARDENED_BY)) {
      expect(emitters, `${f} 已不再发 CREATE SCHEMA IF NOT EXISTS ⇒ 从映射里删掉`).toContain(f);
    }
    // 加固真的在位
    for (const [emitter, hardener] of Object.entries(HARDENED_BY)) {
      const body = readFileSync(resolve(SRC, hardener), "utf8");
      const hardened = body.includes("withSchemaCreateRetry(") || body.includes("ensure_schema(");
      expect(hardened, `${emitter} 的加固点 ${hardener} 里没有 withSchemaCreateRetry / ensure_schema`).toBe(true);
    }
  });

  it("Glue 生成脚本:schema 那一条**不许**再走裸 run_stmt(它是 fatal,并发就直接判死)", () => {
    const body = readFileSync(resolve(SRC, "lib/sync/glue-script-generator.ts"), "utf8");
    expect(body).toContain("ensure_schema(f\"CREATE SCHEMA IF NOT EXISTS {rs_schema}\"");
    expect(body).not.toContain("run_stmt(f\"CREATE SCHEMA IF NOT EXISTS {rs_schema}\"");
    // Python 侧的签名判别必须与 Node 侧同源(两个运行时各一份,判据钉住关键词)
    expect(body).toContain("pg_namespace_nspname_index");
  });
});
