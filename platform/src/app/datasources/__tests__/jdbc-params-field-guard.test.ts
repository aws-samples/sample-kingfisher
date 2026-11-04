// 数据源弹窗「附加 JDBC 连接参数」字段的接线判据(用户 2026-10-15 反馈 ③)。
// 「写了」≠「接上了」:字段必须在 JDBC 表单段里、用与服务端同一个校验函数、进可编辑清单;建源 POST / 编辑 PUT 都认它。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DS_EDITABLE_FIELDS, pickEditableDatasourceFields } from "@/lib/datasources/editable-fields";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("弹窗字段", () => {
  const modal = read("../DataSourceModal.tsx");
  it("Form.Item name=jdbcParams 在 JDBC 段(数据库名之后、探测方式之前),校验器调 parseJdbcParams,带两个 testid,输入框可清空", () => {
    const i = modal.indexOf('<Form.Item name="jdbcParams"');
    expect(i).toBeGreaterThan(0);
    expect(modal.indexOf('<Form.Item name="database"')).toBeLessThan(i);
    expect(modal.indexOf('<Form.Item name="probeVia"')).toBeGreaterThan(i);
    expect(modal).toMatch(/import \{ parseJdbcParams \} from "@\/lib\/datasource-spi\/jdbc\/jdbc-params";/);
    expect(modal).toMatch(/validator: \(_, v\) => \{ const r = parseJdbcParams\(v\); return r\.ok \? Promise\.resolve\(\) : Promise\.reject\(new Error\(r\.error\)\); \}/);
    expect(modal).toContain('data-testid="ds-jdbc-params-item"');
    expect(modal).toContain('data-testid="ds-jdbc-params"');
    expect(modal).toMatch(/<Input placeholder="useSSL=false&serverTimezone=Asia\/Shanghai" allowClear data-testid="ds-jdbc-params" \/>/);
  });
  it("提示文案如实说边界:只作用于 Glue 连接 / Glue 作业,控制面直连不读;MySQL 默认 zeroDateTimeBehavior=CONVERT_TO_NULL 可覆盖", () => {
    expect(modal).toContain("控制面直连探测不读它");
    expect(modal).toContain("zeroDateTimeBehavior=CONVERT_TO_NULL");
  });
});

describe("服务端接线", () => {
  it("可编辑清单含 jdbcParams;空串保留(= 清空),undefined 丢弃", () => {
    expect(DS_EDITABLE_FIELDS as readonly string[]).toContain("jdbcParams");
    expect(pickEditableDatasourceFields({ jdbcParams: "" }).picked).toEqual({ jdbcParams: "" });
    expect(pickEditableDatasourceFields({ jdbcParams: undefined }).picked).toEqual({});
  });
  it("POST 校验 + 落库 + 进 createGlueConnection;PUT 校验 + 算进 endpointChanged + 传给 updateGlueConnectionEndpoint", () => {
    const post = read("../../api/datasources/route.ts");
    expect(post).toMatch(/const jp = parseJdbcParams\(body\.jdbcParams\);\s*if \(!jp\.ok\) return apiError\(jp\.error, 400, \{ code: "VALIDATION_FAILED" \}\);\s*const jdbcParams = jp\.normalized;/);
    // 路由把归一化后的 jdbcParams 交进长操作参数(不填不写键);Glue 连接与落库在执行体 lib/datasource/long-ops.ts
    expect(post).toContain("...(jdbcParams ? { jdbcParams } : {}),");
    const executor = read("../../../lib/datasource/long-ops.ts");
    expect(executor).toContain("createGlueConnection(datasourceId, type, host, port, database, secretArn, networkConfig, dsPlace.region, jdbcParams || undefined)");
    expect(executor).toContain("...(jdbcParams ? { jdbcParams } : {}),");
    const put = read("../../api/datasources/[id]/route.ts");
    expect(put).toMatch(/if \(body\.jdbcParams !== undefined\) \{\s*const jp = parseJdbcParams\(body\.jdbcParams\);\s*if \(!jp\.ok\) return apiError\(jp\.error, 400, \{ code: "VALIDATION_FAILED" \}\);\s*body\.jdbcParams = jp\.normalized;\s*\}/);
    expect(put).toContain('const endpointChanged = ["type", "host", "port", "database", "jdbcParams"].some(changed);');
    expect(put).toContain('jdbcParams: String(body.jdbcParams ?? cur.jdbcParams ?? "") || undefined,');
  });
});
