// 同步脚本是附加 JDBC 参数 / MySQL 方言默认参数的**消费者**:接缝判据(纯函数,零 mock)。
// 「写了」≠「接上了」:jdbcConnFor(ds) 经 toSourceRef → provider.buildConnection,参数必须真进 `jdbc_url = "…"` 那一行。
import { describe, it, expect } from "vitest";
import { generateGlueScript } from "@/lib/sync/glue-script-generator";
import { GOLDEN_BINDINGS, GOLDEN_SHAPES } from "./golden-shapes";

const shape = GOLDEN_SHAPES.find((s) => s.name === "jdbc-redshift-append")!;
const urlLine = (script: string) => script.split("\n").find((l) => l.startsWith("jdbc_url = "));

describe("Glue 同步脚本里的 jdbc_url", () => {
  it("MySQL 存量行(没有 jdbcParams 键)⇒ 只带方言默认参数 zeroDateTimeBehavior=CONVERT_TO_NULL(零值日期按 NULL 读入)", () => {
    const line = urlLine(generateGlueScript(shape.task, shape.ds, GOLDEN_BINDINGS));
    expect(line).toBe('jdbc_url = "jdbc:mysql://db.example.internal:3306/gamedb?zeroDateTimeBehavior=CONVERT_TO_NULL"');
  });
  it("带 jdbcParams 的行 ⇒ 用户参数接在默认之后;用户同名参数覆盖默认", () => {
    const ds1 = { ...(shape.ds as Record<string, unknown>), jdbcParams: "useSSL=false&serverTimezone=Asia/Shanghai" } as typeof shape.ds;
    expect(urlLine(generateGlueScript(shape.task, ds1, GOLDEN_BINDINGS))).toBe('jdbc_url = "jdbc:mysql://db.example.internal:3306/gamedb?zeroDateTimeBehavior=CONVERT_TO_NULL&useSSL=false&serverTimezone=Asia/Shanghai"');
    const ds2 = { ...(shape.ds as Record<string, unknown>), jdbcParams: "zeroDateTimeBehavior=EXCEPTION" } as typeof shape.ds;
    expect(urlLine(generateGlueScript(shape.task, ds2, GOLDEN_BINDINGS))).toBe('jdbc_url = "jdbc:mysql://db.example.internal:3306/gamedb?zeroDateTimeBehavior=EXCEPTION"');
  });
  it("脚本里 jdbc_url 只出现一次且是 Python 字符串字面量(参数校验已禁引号 / 反斜杠 / 空白,不会撑破字面量)", () => {
    const script = generateGlueScript(shape.task, { ...(shape.ds as Record<string, unknown>), jdbcParams: "a=1&b=x/y:z" } as typeof shape.ds, GOLDEN_BINDINGS);
    expect(script.split("\n").filter((l) => l.startsWith("jdbc_url = ")).length).toBe(1);
    expect(urlLine(script)).toMatch(/^jdbc_url = "[^"\\\s]+"$/);
  });
});
