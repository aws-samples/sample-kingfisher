// @kf-batch 50-G2R
// G2R(模块 50)—— admin-DDL 的 **defense-in-depth lint**(50 SPEC §3.9a v3.3)。
//
// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴 **本文件不是安全边界,也不是授权判定。**
//      语义只有一个方向:**命中可拒,未命中不代表安全。**
//      真正的边界是 `admin-ddl-request.ts`(结构化请求,类型层没有自由 SQL 的口子)
//      + `admin-ddl-templates.ts`(SQL 只能由模块私有模板生成,产物是 branded type)。
//      本文件退化成"生成器自检 + 告警":用来在**模板自己写错**时把问题拦在执行前。
// ══════════════════════════════════════════════════════════════════════════════
//
// ── 为什么要降级(不是我谦虚,是实测) ──────────────────────────────────────────
// v3.2 版把这套正则当成安全边界。外部审核 v2 P0-4 给了 5 个 payload,我打真码跑,**5 条全部放行**:
//   ① `COMMENT ON SCHEMA s IS '--'; SELECT * FROM orders`   ← 根因是我自己的**顺序 bug**:
//      旧 `sqlSkeleton` **先删 `--` 注释、后 mask 字符串** ⇒ 字面量里的 `--` 被当注释起点,
//      把后面整条 `SELECT` 吞掉。讽刺的是我还写了一条测试号称防这个,但我选的 payload 是 `'x'` 而不是
//      `'--'` —— **挑中了自己代码恰好能处理的那个变体**。
//   ② `UPDATE "orders" SET x = 1`  ← 旧正则要求 `update` 后跟 `\w`,quoted identifier 溜过。
//   ③ `DROP DATABASE dev` / ⑤ `CALL evil()`  ← 根本不在名单里。
//   ④ `GRANT ALL ON SCHEMA proj_b TO ROLE role_proj_a`  ← 正则**判不了**跨项目:它不知道"本项目"是谁。
//      ⇒ 这一条只能靠**参数绑定**(把 `{operation, projectId}` 传进来核对对象归属),正则永远做不到。
//
// 本次修的四条:mask 顺序调正、**拒多语句**、`UPDATE` 允许 quoted identifier、补 destructive 名单;
// 并新增 `assertOwnedByProject()` 做参数绑定式的归属校验。

import { isSchemaOfProject } from "@/lib/exec-env/project-schema";

export class AdminDdlRejected extends Error {
  constructor(
    readonly rule: string,
    message: string
  ) {
    super(message);
    this.name = "AdminDdlRejected";
  }
}

/**
 * 把 SQL 归约成"裸骨架":抹掉字符串字面量与注释,只留关键字结构。
 *
 * 🔴 **顺序不可颠倒:先 mask 字面量,再删注释。**
 * 反过来(旧实现)会让 `'--'` 里的注释符生效,把它之后的真语句整段吞掉 —— 那正是 payload ① 的根因。
 * 反向的错(不 mask 就查关键字)也出过事:一条无害的 `COMMENT ON … IS 'select …'` 会被误拒。
 * 两个方向都踩过,所以顺序在这里是**语义的一部分**,不是风格。
 */
export function sqlSkeleton(sql: string): string {
  let s = String(sql);
  // ① 先 mask 字面量(单引号,含 '' 转义;以及 dollar-quoted)
  s = s.replace(/'(?:[^']|'')*'/g, " '' ");
  s = s.replace(/\$\$[\s\S]*?\$\$/g, " '' ");
  // ② 再删注释(此时字面量里的 -- / /* 已经不在了)
  s = s.replace(/--[^\n]*/g, " ");
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 单语句约束。
 *
 * 🔴 **这一条一加,payload ① 那整类("字面量遮蔽 + 追加第二条语句")就没了** ——
 * 比逐个补关键字有效得多:多语句本身就不该出现在模板产物里。
 */
export function assertSingleStatement(sql: string): void {
  const s = sqlSkeleton(sql);
  const body = s.endsWith(";") ? s.slice(0, -1) : s; // 容忍结尾一个分号
  if (body.includes(";")) {
    throw new AdminDdlRejected(
      "multi-statement",
      "admin-DDL 语句里出现多条语句(骨架中含分号);模板必须一条一条产出"
    );
  }
}

/**
 * 绝不代用户读/写业务数据。
 *
 * 注意 `INSERT`/`DELETE` 也在名单里 —— 这是**刻意的**:按 50 SPEC §3.9a §4.6,
 * 码表落地的数据写入**已移出 admin 通道**(走窄权 shared-writer),所以 admin 模板产物里
 * 本就不该出现 DML。🔴 反过来说:**不要**把这个守卫接到码表落地的写入路径上 ——
 * 那条路径的 `INSERT/DELETE` 是合法的,接上去就会把功能判死(v3.2 版正是这个错)。
 */
export function assertNotUserDataRead(sql: string): void {
  const s = sqlSkeleton(sql);
  // 🔴 `GRANT` / `REVOKE` 语句里的 SELECT/INSERT/UPDATE/DELETE 是**权限名**,不是取数动作。
  // 不做这个豁免,`GRANT SELECT ON ALL TABLES IN SCHEMA shared TO ROLE …` 会被误拒 ——
  // 那正是 `grant` operation 自己的模板产物,等于把该功能判死(与 §4.6 码表落地同一个病:
  // 守卫"对功能太强")。豁免只作用于关键字这一组,跨项目/TO PUBLIC 那组仍照查。
  if (/^(grant|revoke)\b/.test(s)) return;
  const banned: Array<[RegExp, string]> = [
    [/\bselect\b/, "SELECT"],
    [/\bunload\b/, "UNLOAD(导出到 S3)"],
    [/\bcopy\b[^;]*\bto\b/, "COPY … TO(导出)"],
    [/\binsert\b/, "INSERT"],
    [/\bupdate\b\s+["\w]/, "UPDATE(含 quoted identifier)"],
    [/\bdelete\b\s+from\b/, "DELETE FROM"],
    [/\bmerge\b\s+into\b/, "MERGE INTO"],
  ];
  for (const [re, why] of banned) {
    if (re.test(s)) {
      throw new AdminDdlRejected("user-data-read", `admin-DDL 语句里出现 ${why};该通道只允许结构/权限类 DDL`);
    }
  }
}

/** 禁跨项目搬运 + destructive/可执行任意代码的形态(T-7 及其扩展)。 */
export function assertNoCrossProjectMove(sql: string): void {
  const s = sqlSkeleton(sql);
  const banned: Array<[RegExp, string]> = [
    [/\bcreate\b[^;]*\bexternal\s+schema\b/, "CREATE EXTERNAL SCHEMA"],
    [/\bdatashare\b/, "DATASHARE"],
    [/\bunload\b/, "UNLOAD"],
    [/\bcreate\b[^;]*\bdatabase\b[^;]*\bfrom\b/, "CREATE DATABASE … FROM(从 datashare 建库)"],
    [/\bgrant\b[^;]*\bto\s+public\b/, "GRANT … TO PUBLIC"],
    // 🔴 v3.3 补(审核 payload ③⑤):这些不搬数据,但破坏面/执行面同样致命。
    [/\bdrop\b\s+database\b/, "DROP DATABASE"],
    [/\bcall\b\s+/, "CALL(执行存储过程 = 任意代码面)"],
    [/\bexecute\b\s+/, "EXECUTE(动态 SQL)"],
    [/\balter\b[^;]*\bsystem\b/, "ALTER SYSTEM"],
  ];
  for (const [re, why] of banned) {
    if (re.test(s)) {
      throw new AdminDdlRejected("cross-project-move", `admin-DDL 语句里出现 ${why}`);
    }
  }
}

/**
 * 🔴 **参数绑定式归属校验** —— 正则永远做不到的那一条(payload ④)。
 *
 * 正则不知道"本项目是谁",所以 `GRANT ALL ON SCHEMA proj_b TO ROLE role_proj_a` 判不了。
 * 把 `projectId` 传进来后就能判:语句里出现的 `proj_*` schema 必须**都属于本项目**
 * (`shared` 是显式允许的例外)。
 */
export function assertOwnedByProject(sql: string, projectId: string): void {
  const s = sqlSkeleton(sql);
  // @kf-batch 52-P52.5a-supply
  // 🔴🔴 **补一个盲区(P52.5a 施工时逮到)**:原正则是 `\bproj_[a-z0-9_]+`,而项目的 **role 名**
  // (`role_proj_<id>`)与 **登录用户名**(`user_proj_<id>`)里,`proj_` 前面紧挨着 `_`
  // —— `_` 和 `p` 都是 word 字符,**中间没有词边界** ⇒ `\bproj_` 根本匹配不到它们。
  // 后果:`CREATE ROLE role_proj_b` / `GRANT ROLE role_proj_b TO user_proj_a` 这类**跨项目**语句
  // 在这条守卫下完全隐形(既有 `create-role` 模板产物本来就没被归属校验覆盖过)。
  // ⇒ 现在把两个前缀显式纳入,并把它们**还原回项目 schema 名**再判归属(同一 sanitize,可逆)。
  // 判据仍只有一条:语句里出现的项目派生名必须**都属于本项目**;`shared` 是显式例外(不带 proj_ 前缀)。
  const all: string[] = s.match(/\b(?:role_|user_)?proj_[a-z0-9_]+/g) ?? [];
  const mentioned = all.filter((x, i) => all.indexOf(x) === i);
  for (const name of mentioned) {
    // 去掉 role_/user_ 前缀后就是项目 schema 名(`projectRoleName`/`projectDbUserName` 与
    // `projectSchema` 共用同一 sanitize,故这一步是精确还原,不是猜)。
    const schema = name.replace(/^(?:role_|user_)/, "");
    if (!isSchemaOfProject(schema, projectId)) {
      throw new AdminDdlRejected(
        "cross-project-object",
        `admin-DDL 语句引用了不属于本项目的对象:${name}(归一到 schema ${schema};projectId=${projectId})`
      );
    }
  }
}

/**
 * 模板产物的统一自检入口(执行器在生成之后、执行之前调用)。
 *
 * 🔴 再强调一次:**这是自检,不是授权**。它拦不住的东西由结构化请求 + 私有模板拦住。
 * @param projectId 有项目维的 operation 必传 —— 否则归属校验这一条形同不存在。
 */
export function lintGeneratedStatement(sql: string, opts?: { projectId?: string }): void {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new AdminDdlRejected("empty-statement", "admin-DDL 语句为空");
  }
  assertSingleStatement(sql);
  assertNotUserDataRead(sql);
  assertNoCrossProjectMove(sql);
  if (opts?.projectId) assertOwnedByProject(sql, opts.projectId);
}
