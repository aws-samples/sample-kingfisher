// →:删数据源时平台自建安全组被 Glue 作业的网卡占着(DependencyViolation)。
//   把它如实区分成 failed-dependency 后交给**进程内存里**的 10 × 30 秒重试 —— 2026-10-28 CloudTrail 坐实预算耗尽即永久遗留。
//   由持久清理作业(lib/datasource/sg-cleanup-job.ts)按网卡事实收口,本文件只钉两件底层事实
//     ① deleteSecurityGroup 如实区分 deleted / gone / skipped-not-platform / failed / failed-dependency;
//     ② countNetworkInterfacesInSecurityGroup 翻到底累加、读失败抛(不回 0)。
//   只 mock 真外部(EC2)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  groups: {} as Record<string, string>, cmds: [] as string[], depFails: 0, otherFail: false,
  eniPages: [] as Array<{ NetworkInterfaces: Array<{ NetworkInterfaceId: string }>; NextToken?: string }>,
  describeEniError: null as Error | null,
  eniFilters: [] as any[],
}));
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
      if (n === "DeleteSecurityGroupCommand") {
        h.cmds.push(`delete ${cmd.input.GroupId}`);
        if (h.otherFail) { const e: any = new Error("boom"); e.name = "UnauthorizedOperation"; throw e; }
        if (h.depFails > 0) {
          h.depFails -= 1;
          const e: any = new Error("resource sg-plat has a dependent object");
          e.name = "DependencyViolation";
          throw e;
        }
        return {};
      }
      if (n === "DescribeNetworkInterfacesCommand") {
        h.cmds.push(`enis ${cmd.input.NextToken ?? "first"}`);
        h.eniFilters.push(cmd.input.Filters);
        if (h.describeEniError) throw h.describeEniError;
        const i = cmd.input.NextToken ? Number(cmd.input.NextToken) : 0;
        return h.eniPages[i] ?? { NetworkInterfaces: [] };
      }
      return {};
    },
  };
  return { ...real, ec2ClientFor: async () => ec2, glueClientFor: async () => ({ send: async () => ({}) }), rdsClientFor: async () => ({ send: async () => ({}) }) };
});

import { deleteSecurityGroup, countNetworkInterfacesInSecurityGroup } from "@/lib/aws/datasource-service";

const DSID = "01HXAAAAAAAAAAAAAAAA12345678"; // 本源的平台组名 = bgp-ds-12345678
beforeEach(() => {
  h.cmds.length = 0; h.depFails = 0; h.otherFail = false; h.eniPages = []; h.describeEniError = null; h.eniFilters.length = 0;
  h.groups = { "sg-plat": "bgp-ds-12345678", "sg-cust": "customer-db-access" };
});

describe("🔴 ① deleteSecurityGroup 五种结论如实区分", () => {
  it("DependencyViolation ⇒ failed-dependency(不是笼统的 failed)", async () => {
    h.depFails = 1;
    expect(await deleteSecurityGroup("sg-plat", "us-east-1", DSID)).toBe("failed-dependency");
  });
  it("别的删除失败 ⇒ failed(不会被当成网卡占用去等)", async () => {
    h.otherFail = true;
    expect(await deleteSecurityGroup("sg-plat", "us-east-1", DSID)).toBe("failed");
  });
  it("删成功 ⇒ deleted;组名不是本源的平台组名 ⇒ skipped-not-platform 且**不发 Delete**;组不在 ⇒ gone", async () => {
    expect(await deleteSecurityGroup("sg-plat", "us-east-1", DSID)).toBe("deleted");
    expect(await deleteSecurityGroup("sg-cust", "us-east-1", DSID)).toBe("skipped-not-platform");
    expect(h.cmds.filter((c) => c === "delete sg-cust")).toHaveLength(0);
    expect(await deleteSecurityGroup("sg-nope", "us-east-1", DSID)).toBe("gone");
  });
});

describe("🔴 ② countNetworkInterfacesInSecurityGroup:网卡事实翻到底", () => {
  it("按 group-id 过滤;两页累加 = 3", async () => {
    h.eniPages = [
      { NetworkInterfaces: [{ NetworkInterfaceId: "eni-1" }, { NetworkInterfaceId: "eni-2" }], NextToken: "1" },
      { NetworkInterfaces: [{ NetworkInterfaceId: "eni-3" }] },
    ];
    expect(await countNetworkInterfacesInSecurityGroup("sg-plat", "us-east-1")).toBe(3);
    expect(h.eniFilters[0]).toEqual([{ Name: "group-id", Values: ["sg-plat"] }]);
    expect(h.cmds.filter((c) => c.startsWith("enis"))).toEqual(["enis first", "enis 1"]);
  });
  it("没有网卡 ⇒ 0(组不存在时 EC2 也回空清单,删除那一步再按 gone 收口)", async () => {
    expect(await countNetworkInterfacesInSecurityGroup("sg-plat", "us-east-1")).toBe(0);
  });
  it("读失败 ⇒ 抛,不回 0(0 会被当成「可以删」)", async () => {
    h.describeEniError = Object.assign(new Error("throttled"), { name: "RequestLimitExceeded" });
    await expect(countNetworkInterfacesInSecurityGroup("sg-plat", "us-east-1")).rejects.toThrow(/throttled/);
  });
});
