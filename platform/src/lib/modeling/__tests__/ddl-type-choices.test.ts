// @kf-batch 50-SEQ47c-catalog-ddl —— 页面「列类型」候选(客户端清单)必须与服务端白名单 DDL_TYPES 逐项一致(两处同改,少一处就红)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DDL_TYPE_CHOICES, ICEBERG_UNSUPPORTED_TYPES } from "../ddl-type-choices";
import { DDL_TYPE_OPTIONS, normalizeColumnType } from "../redshift";

describe("DDL_TYPE_CHOICES ⇄ DDL_TYPES", () => {
  it("客户端候选的每一项都是服务端白名单键;白名单里页面没列出的只有别名(INT / NUMERIC / FLOAT / DOUBLE / BOOL / TEXT)", () => {
    const serverKeys = new Set(DDL_TYPE_OPTIONS);
    for (const c of DDL_TYPE_CHOICES) expect(serverKeys.has(c), c).toBe(true);
    const aliases = new Set(["INT", "NUMERIC", "FLOAT", "DOUBLE", "BOOL", "TEXT"]);
    const missing = DDL_TYPE_OPTIONS.filter((k) => !(DDL_TYPE_CHOICES as readonly string[]).includes(k) && !aliases.has(k));
    expect(missing, `服务端白名单新增了类型但页面候选没跟上:${missing.join(",")}`).toEqual([]);
    for (const c of DDL_TYPE_CHOICES) expect(() => normalizeColumnType(c)).not.toThrow();
    expect(ICEBERG_UNSUPPORTED_TYPES).toEqual(["SUPER"]);
  });
  it("建模页 / 新建表向导 / 改表抽屉三处下拉都 import 同一份清单(不再各写一遍字面量数组)", () => {
    const SRC = join(__dirname, "..", "..", "..");
    for (const rel of ["app/modeling/page.tsx", "components/governance/CreateTableWizard.tsx", "components/governance/AlterTableDrawer.tsx"]) {
      const code = readFileSync(join(SRC, rel), "utf8");
      expect(code, rel).toContain("DDL_TYPE_CHOICES");
      expect(code, `${rel} 还留着字面量类型数组`).not.toMatch(/\["VARCHAR",\s*"CHAR",\s*"INTEGER"/);
    }
  });
});
