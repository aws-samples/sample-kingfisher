// @kf-batch 50-PROD-A-launch-hardening
// 🔴 删数据源只删**平台自建**的安全组(组名 bgp-ds-*);用户指定的组(可能是客户的)平台永远不删。
//   只 mock 真外部(EC2):按夹具「组 id → 组名」作答,记下每一条命令。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ groups: {} as Record<string, string>, cmds: [] as string[] }));
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const ec2 = {
    send: async (cmd: any) => {
      const n = cmd.constructor.name;
      if (n === "DescribeSecurityGroupsCommand") {
        const id = cmd.input.GroupIds[0];
        h.cmds.push(`describe ${id}`);
        if (!(id in h.groups)) { const e: any = new Error("nf"); e.name = "InvalidGroup.NotFound"; throw e; }
        return { SecurityGroups: [{ GroupId: id, GroupName: h.groups[id] }] };
      }
      if (n === "DeleteSecurityGroupCommand") { h.cmds.push(`delete ${cmd.input.GroupId}`); return {}; }
      return {};
    },
  };
  return { ...real, ec2ClientFor: async () => ec2, glueClientFor: async () => ({ send: async () => ({}) }), rdsClientFor: async () => ({ send: async () => ({}) }) };
});

import { deleteSecurityGroup } from "@/lib/aws/datasource-service";

const DSID = "01HXAAAAAAAAAAAAAAAA12345678"; // 本源的平台组名 = bgp-ds-12345678
beforeEach(() => { h.cmds.length = 0; h.groups = { "sg-plat": "bgp-ds-12345678", "sg-cust": "customer-db-access", "sg-other": "bgp-ds-87654321" }; });

describe("🔴 deleteSecurityGroup 按组名判归属", () => {
  it("🔴 B-54 收紧:**别的数据源**的 bgp-ds-* 组 ⇒ 不删(组名必须恰好等于本源的平台组名)", async () => {
    expect(await deleteSecurityGroup("sg-other", "us-east-1", DSID)).toBe("skipped-not-platform");
    expect(h.cmds).toEqual(["describe sg-other"]);
  });
  it("客户的组 ⇒ 不删(只查不删),如实回 skipped-not-platform", async () => {
    expect(await deleteSecurityGroup("sg-cust", "us-east-1", DSID)).toBe("skipped-not-platform");
    expect(h.cmds).toEqual(["describe sg-cust"]);
  });
  it("正控制:平台自建的组 ⇒ 删", async () => {
    expect(await deleteSecurityGroup("sg-plat", "us-east-1", DSID)).toBe("deleted");
    expect(h.cmds).toEqual(["describe sg-plat", "delete sg-plat"]);
  });
  it("已不存在 ⇒ gone,不发删除", async () => {
    expect(await deleteSecurityGroup("sg-x", "us-east-1", DSID)).toBe("gone");
    expect(h.cmds.some((c) => c.startsWith("delete"))).toBe(false);
  });
});
