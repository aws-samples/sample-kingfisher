// 附加 JDBC 参数唯一作者的判据(用户 2026-10-15 反馈 ① 零值时间戳报错 / ③ 缺 JDBC 参数化配置)。
// 钉事实:解析 / 归一化 / 拒绝清单 / 与方言默认合并(用户覆盖)/ 两种拼接风格 / 四方言 buildConnection 的最终 URL。
import { describe, it, expect } from "vitest";
import { parseJdbcParams, mergeJdbcParams, appendJdbcParams, buildJdbcUrlWithParams, JDBC_PARAMS_MAX_PAIRS } from "../jdbc/jdbc-params";
import { getProvider } from "../registry";
import { toSourceRef } from "../normalize";

describe("parseJdbcParams:形态", () => {
  it("空 / undefined / null / 空白 ⇒ ok 且无参数", () => {
    for (const v of [undefined, null, "", "   "]) expect(parseJdbcParams(v)).toEqual({ ok: true, pairs: [], normalized: "" });
  });
  it("k=v&k=v 归一化;也接受 ; 与换行分隔、前导 ? / ;、两侧空白", () => {
    expect(parseJdbcParams("useSSL=false&serverTimezone=Asia/Shanghai")).toEqual({ ok: true, pairs: [["useSSL", "false"], ["serverTimezone", "Asia/Shanghai"]], normalized: "useSSL=false&serverTimezone=Asia/Shanghai" });
    expect(parseJdbcParams("?encrypt=false; trustServerCertificate=true \n loginTimeout=30").normalized).toBe("encrypt=false&trustServerCertificate=true&loginTimeout=30");
  });
  it("拒:非字符串 / 不是 k=v / 键不合法 / 缺值 / 值含空白 引号 反斜杠 # ? & ; / 重复键(大小写不敏感)/ 超过上限", () => {
    const bad = [42, "useSSL", "=false", "1abc=x", "a b=1", "k=", "k=a b", 'k="x"', "k='x'", "k=a\\b", "k=a#b", "k=a?b", "useSSL=1&usessl=0"];
    for (const b of bad) expect(parseJdbcParams(b).ok, String(b)).toBe(false);
    const tooMany = Array.from({ length: JDBC_PARAMS_MAX_PAIRS + 1 }, (_, i) => `k${i}=v`).join("&");
    expect(parseJdbcParams(tooMany).ok).toBe(false);
    expect(parseJdbcParams("x".repeat(1001) + "=1").ok).toBe(false);
  });
  it("拒因是人话且点名参数", () => {
    const r = parseJdbcParams("useSSL=fa lse");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("useSSL");
  });
});

describe("mergeJdbcParams / appendJdbcParams", () => {
  it("默认在前、用户在后;用户同名键(大小写不敏感)覆盖默认且不重复", () => {
    expect(mergeJdbcParams({ zeroDateTimeBehavior: "CONVERT_TO_NULL" }, [["useSSL", "false"]])).toEqual([["zeroDateTimeBehavior", "CONVERT_TO_NULL"], ["useSSL", "false"]]);
    expect(mergeJdbcParams({ zeroDateTimeBehavior: "CONVERT_TO_NULL" }, [["zerodatetimebehavior", "EXCEPTION"]])).toEqual([["zerodatetimebehavior", "EXCEPTION"]]);
    expect(mergeJdbcParams(undefined, [])).toEqual([]);
  });
  it("query 风格 ?k=v&k=v;semicolon 风格 ;k=v;k=v;无参数原样", () => {
    expect(appendJdbcParams("jdbc:mysql://h:3306/d", [["a", "1"], ["b", "2"]], "query")).toBe("jdbc:mysql://h:3306/d?a=1&b=2");
    expect(appendJdbcParams("jdbc:sqlserver://h:1433;databaseName=d", [["encrypt", "false"]], "semicolon")).toBe("jdbc:sqlserver://h:1433;databaseName=d;encrypt=false");
    expect(appendJdbcParams("jdbc:postgresql://h:5432/d", [], "query")).toBe("jdbc:postgresql://h:5432/d");
  });
  it("buildJdbcUrlWithParams 对不合法用户参数抛(路由层先拦 400,这里不静默丢参数)", () => {
    expect(() => buildJdbcUrlWithParams("jdbc:mysql://h:3306/d", "query", undefined, "a b=1")).toThrow(/a b/);
  });
});

describe("四方言 buildConnection 的最终 URL(与 Glue 连接 / 同步脚本 / 发现脚本同一条)", () => {
  it("MySQL 默认带 zeroDateTimeBehavior=CONVERT_TO_NULL(①:零值日期按 NULL 读入,不让整个同步作业失败)", () => {
    const cm = getProvider("mysql").buildConnection({ type: "mysql", connection: { host: "db-1", port: 3306, database: "ecommerce" } });
    expect(cm.jdbcUrl).toBe("jdbc:mysql://db-1:3306/ecommerce?zeroDateTimeBehavior=CONVERT_TO_NULL");
  });
  it("MySQL 用户附加参数接在默认之后;用户同名参数覆盖默认", () => {
    expect(getProvider("mysql").buildConnection({ type: "mysql", connection: { host: "h", port: 3306, database: "d", jdbcParams: "useSSL=false&serverTimezone=Asia/Shanghai" } }).jdbcUrl)
      .toBe("jdbc:mysql://h:3306/d?zeroDateTimeBehavior=CONVERT_TO_NULL&useSSL=false&serverTimezone=Asia/Shanghai");
    expect(getProvider("mysql").buildConnection({ type: "mysql", connection: { host: "h", port: 3306, database: "d", jdbcParams: "zeroDateTimeBehavior=EXCEPTION" } }).jdbcUrl)
      .toBe("jdbc:mysql://h:3306/d?zeroDateTimeBehavior=EXCEPTION");
  });
  it("PostgreSQL / Oracle 无默认参数,用户参数用 ?;SQL Server 用 ;", () => {
    expect(getProvider("postgresql").buildConnection({ type: "postgresql", connection: { host: "h", port: 5432, database: "d" } }).jdbcUrl).toBe("jdbc:postgresql://h:5432/d");
    expect(getProvider("postgresql").buildConnection({ type: "postgresql", connection: { host: "h", port: 5432, database: "d", jdbcParams: "ssl=true&sslmode=require" } }).jdbcUrl).toBe("jdbc:postgresql://h:5432/d?ssl=true&sslmode=require");
    expect(getProvider("oracle").buildConnection({ type: "oracle", connection: { host: "h", port: 1521, database: "svc", jdbcParams: "oracle.net.CONNECT_TIMEOUT=10000" } }).jdbcUrl).toBe("jdbc:oracle:thin:@//h:1521/svc?oracle.net.CONNECT_TIMEOUT=10000");
    expect(getProvider("sqlserver").buildConnection({ type: "sqlserver", connection: { host: "h", port: 1433, database: "d", jdbcParams: "encrypt=false;trustServerCertificate=true" } }).jdbcUrl).toBe("jdbc:sqlserver://h:1433;databaseName=d;encrypt=false;trustServerCertificate=true");
  });
  it("存量扁平行(host/port/database/jdbcParams 都在顶层)经 toSourceRef 归一后参数进 URL;没有 jdbcParams 键的老行形态不变", () => {
    const withParams = toSourceRef({ type: "mysql", host: "h", port: 3306, database: "d", jdbcParams: "useSSL=false" });
    expect(withParams.connection.jdbcParams).toBe("useSSL=false");
    expect(getProvider("mysql").buildConnection(withParams).jdbcUrl).toBe("jdbc:mysql://h:3306/d?zeroDateTimeBehavior=CONVERT_TO_NULL&useSSL=false");
    const legacy = toSourceRef({ type: "mysql", host: "h", port: 3306, database: "d" });
    expect(legacy.connection).toEqual({ host: "h", port: 3306, database: "d" });
  });
  it("validateConfig 把不合法的附加参数报进 errors(建源 / 测连同一份文案);buildConnection 对不合法参数抛", () => {
    const v = getProvider("mysql").validateConfig({ host: "db.example.internal", port: 3306, database: "d", jdbcParams: "bad param" });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("bad param");
    expect(() => getProvider("mysql").buildConnection({ type: "mysql", connection: { host: "h", port: 3306, database: "d", jdbcParams: "bad param" } })).toThrow();
  });
});
