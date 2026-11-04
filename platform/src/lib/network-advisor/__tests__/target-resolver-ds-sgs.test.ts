// 网络顾问把「数据源」当目标时读它已落库的 networkConfig:用户指定的**全部**安全组都要算上
// (建源落库 securityGroupIds;改网络的 PATCH 早就落这个键),存量行只有 securityGroupId ⇒ 与改动前一致。
// 只 mock 真外部(DDB)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ item: undefined as any }));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources" },
  docClient: { send: vi.fn(async () => ({ Item: h.item })) },
}));

import { resolveTargets } from "@/lib/network-advisor/target-resolver";

const run = async () => {
  const ctx = { degraded: false, missing: [] as string[], region: "us-east-1" };
  const [r] = await resolveTargets([{ kind: "datasource", datasourceId: "ds1" }], ctx);
  return r;
};
const base = { datasourceId: "ds1", type: "mysql", port: 3306, host: "h" };

beforeEach(() => { h.item = undefined; });

describe("网络顾问 · 数据源目标的安全组", () => {
  it("用户指定多个组 ⇒ 全部返回", async () => {
    h.item = { ...base, networkConfig: { vpcId: "vpc-1", subnetId: "s", securityGroupId: "sg-a", securityGroupIds: ["sg-a", "sg-b"], isRds: false } };
    expect((await run()).securityGroupIds).toEqual(["sg-a", "sg-b"]);
  });
  it("存量行(只有 securityGroupId)⇒ 与改动前一致", async () => {
    h.item = { ...base, networkConfig: { vpcId: "vpc-1", subnetId: "s", securityGroupId: "sg-a", isRds: false } };
    expect((await run()).securityGroupIds).toEqual(["sg-a"]);
  });
  it("空数组不当作「有」⇒ 回落 securityGroupId", async () => {
    h.item = { ...base, networkConfig: { vpcId: "vpc-1", subnetId: "s", securityGroupId: "sg-a", securityGroupIds: [], isRds: false } };
    expect((await run()).securityGroupIds).toEqual(["sg-a"]);
  });
});
