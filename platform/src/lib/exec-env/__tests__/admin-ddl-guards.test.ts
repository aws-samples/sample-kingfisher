// G2R —— admin-DDL defense-in-depth lint 单测(50 SPEC §3.9a v3.3)。
//
// 【本文件存在的理由,写清楚免得后人重蹈】
// 上一版这套正则被当成**安全边界**,外部审核 v2 P0-4 给了 5 个 payload,实测**5 条全部放行**。
// 其中第 1 条的根因是我自己的顺序 bug(先删注释、后 mask 字符串);
// 而讽刺的是我上一版**写过一条号称防这个的测试且它是绿的** —— 因为我选的 payload 是 `'x'` 不是 `'--'`,
// **挑中了自己代码恰好能处理的那个变体**。
// ⇒ 所以这里的负向用例**不来自我的想象**:第一组直接抄审核报告的 5 条,一条不改。
import { describe, it, expect } from "vitest";
import {
  sqlSkeleton,
  assertSingleStatement,
  assertNotUserDataRead,
  assertNoCrossProjectMove,
  assertOwnedByProject,
  lintGeneratedStatement,
  AdminDdlRejected,
} from "@/lib/exec-env/admin-ddl-guards";
// role/user 名一律取自 SSOT,测试里不手拼(手拼会掩盖派生错)。
import { projectRoleName, projectDbUserName } from "@/lib/exec-env/project-schema";

/** 审核报告 audit-results/v2 §P0-4 的 5 个 payload,原文照抄。 */
const AUDIT_PAYLOADS: Array<[string, string]> = [
  ["字面量里的 `--` 遮蔽后续语句(顺序 bug)", `COMMENT ON SCHEMA s IS '--'; SELECT * FROM orders`],
  ["quoted identifier 绕过 UPDATE 规则", `UPDATE "orders" SET x = 1`],
  ["destructive DDL 不在名单", `DROP DATABASE dev`],
  ["跨项目 GRANT(正则判不了归属)", `GRANT ALL ON SCHEMA proj_b TO ROLE role_proj_a`],
  ["CALL 存储过程 = 任意代码面", `CALL evil()`],
];

// 🔴 fixture 用**真环境形态**(大写 ULID):原来是 "0".repeat(26),全数字大小写同形,
//    正是"校验只收小写而平台只生成大写"那个真 bug 能一路全绿的原因(2026-09-03 D4 真环境逮到)。
const PROJ_A = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const PROJ_A_SCHEMA = "proj_proj_01m1kp594d2e6djqc8ez8craes"; // schema 一律小写(sanitize)
// 第二个项目(跨项目负测用);末位不同,确保派生名真的不同。
const PROJ_B = "proj-01M1KP594D2E6DJQC8EZ8CRAEZ";

describe("🔴 审核 v2 P0-4 的 5 个 payload —— 一条都不许再放行", () => {
  for (const [why, sql] of AUDIT_PAYLOADS) {
    it(`拒:${why}`, () => {
      // 第 4 条(跨项目 GRANT)必须靠**参数绑定**才判得了 —— 正则永远做不到,所以带上 projectId。
      expect(() => lintGeneratedStatement(sql, { projectId: PROJ_A })).toThrow(AdminDdlRejected);
    });
  }
});

describe("sqlSkeleton —— 先 mask 字面量、再删注释(顺序即语义)", () => {
  it("🔴 字面量里的 `--` 不得被当成注释起点(否则后面整条语句被吞掉)", () => {
    const s = sqlSkeleton(`COMMENT ON SCHEMA s IS '--'; SELECT * FROM orders`);
    expect(s, "骨架里必须还能看到 select,才可能被下游规则抓到").toContain("select");
    expect(s).toContain(";");
  });

  it("真正的行注释仍要被删(不能因为改了顺序就不认注释了)", () => {
    expect(sqlSkeleton(`CREATE SCHEMA s -- select * from orders`)).not.toContain("select");
  });

  it("块注释同样删", () => {
    expect(sqlSkeleton(`CREATE SCHEMA s /* insert into x */`)).not.toContain("insert");
  });

  it("字面量内容被抹掉(无害语句不该被误拒)", () => {
    expect(sqlSkeleton(`COMMENT ON SCHEMA s IS 'select from orders'`)).not.toContain("select from orders");
  });
});

describe("assertSingleStatement —— 拒多语句(一条规则灭掉整类绕过)", () => {
  it("骨架里出现分号即拒", () => {
    expect(() => assertSingleStatement(`CREATE SCHEMA a; DROP SCHEMA b`)).toThrow(/multi-statement|多条语句/);
  });

  it("容忍结尾一个分号(模板可能带)", () => {
    expect(() => assertSingleStatement(`CREATE SCHEMA a;`)).not.toThrow();
  });

  it("字面量里的分号不算语句分隔", () => {
    expect(() => assertSingleStatement(`COMMENT ON SCHEMA s IS 'a;b'`)).not.toThrow();
  });
});

describe("assertNotUserDataRead", () => {
  it("拒 SELECT / CTAS / INSERT…SELECT / UNLOAD / COPY…TO / UPDATE(含 quoted)/ DELETE / MERGE", () => {
    for (const sql of [
      "SELECT * FROM orders",
      "CREATE TABLE t AS SELECT * FROM orders",
      "INSERT INTO t SELECT * FROM orders",
      "UNLOAD ('x') TO 's3://x/'",
      "COPY orders TO 's3://x/'",
      `UPDATE "orders" SET x = 1`,
      "UPDATE orders SET x = 1",
      "DELETE FROM orders",
      "MERGE INTO t USING s ON t.id = s.id",
    ]) {
      expect(() => assertNotUserDataRead(sql), `应拒:${sql}`).toThrow(AdminDdlRejected);
    }
  });

  it("结构/权限类 DDL 放行(误拒会让建 schema 全过不去)", () => {
    for (const sql of [
      "CREATE SCHEMA IF NOT EXISTS proj_abc",
      'CREATE ROLE "role_proj_abc"',
      "GRANT USAGE ON SCHEMA proj_abc TO ROLE role_proj_abc",
      "DROP SCHEMA IF EXISTS proj_abc CASCADE",
      "ALTER SCHEMA proj_abc OWNER TO role_proj_abc",
      "COMMENT ON TABLE shared.code_x IS 'code-table:x'",
    ]) {
      expect(() => assertNotUserDataRead(sql), `不该拒:${sql}`).not.toThrow();
    }
  });
});

describe("assertNoCrossProjectMove —— 含 v3.3 新补的 destructive/执行面", () => {
  it("拒跨项目搬运与任意代码面", () => {
    for (const sql of [
      "CREATE EXTERNAL SCHEMA ext FROM DATA CATALOG DATABASE 'x'",
      "CREATE DATASHARE ds",
      "CREATE DATABASE d FROM DATASHARE ds OF NAMESPACE 'n'",
      "GRANT ALL ON SCHEMA proj_a TO PUBLIC",
      "DROP DATABASE victim",
      "CALL evil()",
      "EXECUTE stmt",
      "ALTER SYSTEM SET x = 1",
    ]) {
      expect(() => assertNoCrossProjectMove(sql), `应拒:${sql}`).toThrow(AdminDdlRejected);
    }
  });

  it("给具体角色的正常 GRANT 不受影响", () => {
    expect(() => assertNoCrossProjectMove("GRANT USAGE ON SCHEMA proj_a TO ROLE role_proj_a")).not.toThrow();
  });
});

describe("🔴 assertOwnedByProject —— 正则做不到的那一条(参数绑定)", () => {
  it("引用别的项目 schema 即拒", () => {
    expect(() => assertOwnedByProject(`GRANT ALL ON SCHEMA proj_b TO ROLE role_proj_a`, PROJ_A)).toThrow(
      /cross-project-object|不属于本项目/
    );
  });

  it("只引用本项目 schema 则放行", () => {
    const own = `GRANT USAGE ON SCHEMA ${PROJ_A_SCHEMA} TO ROLE r`;
    expect(() => assertOwnedByProject(own, PROJ_A)).not.toThrow();
  });

  // 🔴🔴 **本组是补一个真盲区(施工时逮到)**:原正则 `\bproj_[a-z0-9_]+` 里的 `\b`
  // 在 `role_proj_x` / `user_proj_x` 中**不成立** —— `_` 与 `p` 都是 word 字符、中间没有词边界。
  // 后果:整条语句只提到 role/user 名(不直接提 schema)时,归属校验**完全不生效**。
  // 既有 `create-role` 模板产物(`CREATE ROLE role_proj_x`)就从来没被这条守卫覆盖过;
  // 要新增的登录用户名 `user_proj_x` 同理。
  it("🔴 只提到**别的项目的 role 名**(不提 schema)也必须被拒", () => {
    expect(() => assertOwnedByProject(`CREATE ROLE ${projectRoleName(PROJ_B)}`, PROJ_A)).toThrow(
      /cross-project-object|不属于本项目/
    );
  });

  it("🔴 只提到**别的项目的登录用户名**也必须被拒", () => {
    expect(() => assertOwnedByProject(`GRANT ROLE ${projectRoleName(PROJ_A)} TO "${projectDbUserName(PROJ_B)}"`, PROJ_A)).toThrow(
      /cross-project-object|不属于本项目/
    );
  });

  it("本项目自己的 role + 登录用户放行(别把闸做成谁都过不去)", () => {
    const own = `GRANT ROLE ${projectRoleName(PROJ_A)} TO "${projectDbUserName(PROJ_A)}"`;
    expect(() => assertOwnedByProject(own, PROJ_A)).not.toThrow();
    expect(() => assertOwnedByProject(`CREATE ROLE ${projectRoleName(PROJ_A)}`, PROJ_A)).not.toThrow();
  });

  it("🔴 不传 projectId 时这条形同不存在 —— 必须让调用方看得见这个后果", () => {
    // 这不是"设计缺陷",是刻意的:lint 无法自己知道"本项目是谁"。
    // 有项目维的 operation 必须传 projectId,否则跨项目 GRANT 会溜过。
    expect(() => lintGeneratedStatement(`GRANT ALL ON SCHEMA proj_b TO ROLE role_proj_a`)).not.toThrow();
    expect(() => lintGeneratedStatement(`GRANT ALL ON SCHEMA proj_b TO ROLE role_proj_a`, { projectId: PROJ_A })).toThrow();
  });
});

describe("lintGeneratedStatement —— 统一入口", () => {
  it("空语句拒", () => {
    for (const bad of ["", "   ", null, undefined, 1]) {
      expect(() => lintGeneratedStatement(bad as never)).toThrow(AdminDdlRejected);
    }
  });

  it("报错带 rule 字段(审计里要能区分被哪条拒的)", () => {
    try {
      lintGeneratedStatement("SELECT 1");
      throw new Error("应该抛");
    } catch (e) {
      expect((e as AdminDdlRejected).rule).toBe("user-data-read");
    }
  });

  it("合法 DDL 放行", () => {
    expect(() => lintGeneratedStatement("CREATE SCHEMA IF NOT EXISTS shared")).not.toThrow();
  });
});
