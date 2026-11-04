// 序 38 B-71 —— 一个执行环境的全部 S3 Tables 落点(平台表桶 + 已登记外部表桶)与按命名空间找桶。
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@aws-sdk/client-s3tables";

const h = vi.hoisted(() => ({
  ext: [] as Array<{ targetId: string; bucket: string; region: string; label?: string; addedBy: string; addedAt: string }>,
  nsByBucket: {} as Record<string, string[]>,
  tablesByBucketNs: {} as Record<string, string[]>,
  calls: [] as Array<{ cmd: string; input: Record<string, unknown> }>,
}));

vi.mock("@/lib/aws/clients", () => ({
  sdkClient: vi.fn(() => ({
    send: vi.fn(async (cmd: any) => {
      h.calls.push({ cmd: cmd.constructor.name, input: cmd.input });
      const bucket = String(cmd.input.tableBucketARN).split("/").pop()!;
      if (cmd.constructor.name === "ListNamespacesCommand") return { namespaces: (h.nsByBucket[bucket] || []).map((n) => ({ namespace: [n] })) };
      if (cmd.constructor.name === "ListTablesCommand") return { tables: (h.tablesByBucketNs[`${bucket}/${cmd.input.namespace}`] || []).map((t) => ({ name: t })) };
      return {};
    }),
  })),
}));
vi.mock("@/lib/lake/external-table-buckets", () => ({
  listExternalTableBuckets: vi.fn(async (tid: string) => h.ext.filter((e) => e.targetId === tid)),
}));
vi.mock("@/lib/exec-env/registry", () => ({
  requireReadyTarget: vi.fn(async (id: string) => ({ targetId: id, region: "us-west-2", resources: { tableBucket: "bgp-table-bucket-usw2" } })),
}));

import { resolveS3TablesPlaces, listNamespaceTreeAll, resolveS3TablesPlaceForNamespace, resolveS3TablesPlace, S3TABLES_BUCKET, forgetExternalBucketsMemo } from "@/lib/athena/s3tables";

beforeEach(() => {
  h.ext.length = 0; h.calls.length = 0;
  forgetExternalBucketsMemo(); // 15s 读缓存:每条判据从干净状态起(生产里登记 / 撤销后最多 15s 生效)
  h.nsByBucket = { [S3TABLES_BUCKET]: ["gamedata", "ods"], "cust-own": ["ods", "raw"], "bgp-table-bucket-usw2": ["gamedata"] };
  h.tablesByBucketNs = { [`${S3TABLES_BUCKET}/gamedata`]: ["players"], [`${S3TABLES_BUCKET}/ods`]: ["ods_a"], "cust-own/ods": ["ods_vehicle"], "cust-own/raw": ["events"] };
});

describe("B-71 resolveS3TablesPlaces", () => {
  it("没登记 ⇒ 只有平台表桶(external=false),与 resolveS3TablesPlace 同值", async () => {
    const ps = await resolveS3TablesPlaces("tgt_home");
    const p = await resolveS3TablesPlace("tgt_home");
    expect(ps).toEqual([{ ...p, external: false }]);
  });
  it("登记了 ⇒ 平台表桶在前,外部桶按登记顺序,目录引用 = s3tablescatalog/<桶>,区 / home 随平台表桶", async () => {
    h.ext.push({ targetId: "tgt_home", bucket: "cust-own", region: "us-east-1", label: "客户自有", addedBy: "a", addedAt: "2026-10-13T00:00:00Z" });
    const ps = await resolveS3TablesPlaces("tgt_home");
    expect(ps).toHaveLength(2);
    expect(ps[1]).toMatchObject({ bucket: "cust-own", catalogRef: "s3tablescatalog/cust-own", external: true, label: "客户自有", targetId: "tgt_home", home: true });
    expect(ps[1].region).toBe(ps[0].region);
  });
  it("非 home 的登记只影响那个 target", async () => {
    h.ext.push({ targetId: "tgt_usw2_a", bucket: "cust-usw2", region: "us-west-2", addedBy: "a", addedAt: "2026-10-13T00:00:00Z" });
    expect(await resolveS3TablesPlaces("tgt_home")).toHaveLength(1);
    const ps = await resolveS3TablesPlaces("tgt_usw2_a");
    expect(ps.map((p) => p.bucket)).toEqual(["bgp-table-bucket-usw2", "cust-usw2"]);
  });
});

describe("B-71 listNamespaceTreeAll / resolveS3TablesPlaceForNamespace", () => {
  beforeEach(() => { h.ext.push({ targetId: "tgt_home", bucket: "cust-own", region: "us-east-1", addedBy: "a", addedAt: "2026-10-13T00:00:00Z" }); });
  it("树:每个命名空间带 bucket / catalog / external;外部桶的表三段名用外部桶的目录引用", async () => {
    const tree = await listNamespaceTreeAll(await resolveS3TablesPlaces("tgt_home"));
    expect(tree.map((n) => `${n.bucket}:${n.namespace}:${n.external}`)).toEqual([
      `${S3TABLES_BUCKET}:gamedata:false`, `${S3TABLES_BUCKET}:ods:false`, "cust-own:ods:true", "cust-own:raw:true",
    ]);
    const ext = tree.find((n) => n.bucket === "cust-own" && n.namespace === "ods")!;
    expect(ext.catalog).toBe("s3tablescatalog/cust-own");
    expect(ext.tables[0].qualifiedName).toBe('"s3tablescatalog/cust-own"."ods"."ods_vehicle"');
    const plat = tree.find((n) => n.bucket === S3TABLES_BUCKET && n.namespace === "ods")!;
    expect(plat.tables[0].qualifiedName).toBe(`"s3tablescatalog/${S3TABLES_BUCKET}"."ods"."ods_a"`);
  });
  it("按命名空间找桶:只在外部桶里的 ⇒ 外部桶;两边都有的 ⇒ 平台表桶优先;哪都没有 ⇒ 平台表桶(Athena 如实报 schema 不存在)", async () => {
    expect((await resolveS3TablesPlaceForNamespace("tgt_home", "raw")).bucket).toBe("cust-own");
    expect((await resolveS3TablesPlaceForNamespace("tgt_home", "ods")).bucket).toBe(S3TABLES_BUCKET);
    expect((await resolveS3TablesPlaceForNamespace("tgt_home", "nope")).bucket).toBe(S3TABLES_BUCKET);
  });
  it("没登记外部桶时按命名空间找桶**零** ListNamespaces 调用(存量路径不多发请求)", async () => {
    h.ext.length = 0;
    const p = await resolveS3TablesPlaceForNamespace("tgt_home", "anything");
    expect(p.bucket).toBe(S3TABLES_BUCKET);
    expect(h.calls.filter((c) => c.cmd === "ListNamespacesCommand")).toHaveLength(0);
  });
});
