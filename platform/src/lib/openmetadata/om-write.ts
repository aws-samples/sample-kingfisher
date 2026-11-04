// @kf-batch 50-WP2-one-agentcore-one-om
// **OpenMetadata 写入原语的轻量层**(service / database / schema / table 四个 PUT + 列归一)。
//
// ── 为什么要单独一层(不是洁癖,是**编译边界**)────────────────────────────────
// 这些原语被两处用:`om-push.ts`(同步 / 血缘的事件式推送)与 `om-mirror-push.ts`(元数据镜像推送)。
// 而镜像是**周期任务**,跑在 `instrumentation` 的可达面上 —— 那一面被 Next 编成 **edge**,
// 碰到任何 node 内置就**整个 `next build` 失败**。`om-push.ts` 顺带 import 了 `genbi/athena`,
// 那条链最终走到 `node:crypto`(instrumentation → reconciler-loop → mirror → om-push → genbi/athena
// → … → project-schema),门禁 `instrumentation-bundle-guard` 当场逮住。
// 🔴 **`await import()` 与 `NEXT_RUNTIME` 判断都不构成编译边界**(本仓踩过一次、有专门门禁钉)⇒
//    唯一正解 = 把周期任务要的这一小块**搬到轻量层**:本文件只依赖 `om-client`(fetch),零 node 内置。
//
// 🔴 搬家不是复制:`om-push.ts` 现在从本文件 **import**(单一作者不变)。尤其 `putTable` 里那条
//    承重逻辑(空列时不许用 `_row` 覆盖真实列,否则列级血缘全局消失)必须只有一份 ——
//    复制出第二份的那天,就是列级血缘再消失一次的那天。

import { omRequest, getEntityByName } from "./om-client";

function omType(raw?: string): string {
  const t = (raw || "").toLowerCase().trim();
  const base = t.replace(/\(.*\)/, "").trim();
  if (t === "tinyint(1)") return "BOOLEAN";
  const m: Record<string, string> = {
    int: "INT", integer: "INT", mediumint: "INT", tinyint: "SMALLINT", smallint: "SMALLINT",
    bigint: "BIGINT", long: "BIGINT",
    float: "FLOAT", real: "FLOAT", double: "DOUBLE", "double precision": "DOUBLE",
    decimal: "DECIMAL", numeric: "DECIMAL",
    date: "DATE", datetime: "TIMESTAMP", timestamp: "TIMESTAMP", timestamptz: "TIMESTAMP",
    "timestamp without time zone": "TIMESTAMP", "timestamp with time zone": "TIMESTAMP",
    boolean: "BOOLEAN", bool: "BOOLEAN",
    json: "JSON", jsonb: "JSON", super: "JSON",
    binary: "BINARY", varbinary: "BINARY", blob: "BINARY", bytea: "BINARY",
  };
  return m[t] || m[base] || "STRING"; // STRING needs no dataLength (safe default for text types)
}

function columns(pairs: { name: string; type?: string }[]) {
  return pairs
    .filter((c) => c?.name)
    .map((c, i) => ({
      name: c.name,
      dataType: omType(c.type),
      dataTypeDisplay: c.type || "string",
      ordinalPosition: i + 1,
    }));
}

export async function ensureService(name: string, payload: any) {
  const existing = await getEntityByName("services/databaseServices", name);
  if (existing?.id) return;
  await omRequest("PUT", "/api/v1/services/databaseServices", payload);
}

export const putDatabase = (name: string, service: string) =>
  omRequest("PUT", "/api/v1/databases", { name, service });
export const putSchema = (name: string, database: string) =>
  omRequest("PUT", "/api/v1/databaseSchemas", { name, database });
export const putTable = async (name: string, databaseSchema: string, cols: { name: string; type?: string }[]) => {
  const real = columns(cols);
  if (real.length) {
    return omRequest("PUT", "/api/v1/tables", { name, databaseSchema, tableType: "Regular", columns: real });
  }
  // 空列:若该表已存在且已有真实列(非 _row),保留,绝不用 _row 覆盖。
  const fqn = `${databaseSchema}.${name}`;
  const existing = await omColumnNames(fqn); // 已过滤 _row;非空=已有真实列
  if (existing.length) return; // 保留真实列,不覆盖(根治点)
  // 表不存在或仅 _row 占位 → 建壳(幂等)。
  return omRequest("PUT", "/api/v1/tables", { name, databaseSchema, tableType: "Regular", columns: [{ name: "_row", dataType: "STRING" }] });
};

export const customDbService = (name: string) => ({
  name,
  serviceType: "CustomDatabase",
  connection: { config: { type: "CustomDatabase", sourcePythonClass: "metadata.ingestion.source.database.customdatabase.CustomDatabaseSource" } },
});


export async function omColumnNames(fqn: string): Promise<string[]> {
  if (!fqn) return [];
  // fields=columns must stay a real query param, so encode only the FQN path segment.
  const t = await omRequest("GET", `/api/v1/tables/name/${encodeURIComponent(fqn)}?fields=columns`);
  const cols: any[] = t?.columns || [];
  return cols.map((c) => c?.name).filter((n) => n && n !== "_row");
}

