import { describe, it, expect } from "vitest";
import { prefillFor, toGlue, toFlink, toDms } from "../prefill-adapters";
import type { RecommendedPlacement } from "../types";

const p: RecommendedPlacement = {
  vpcId: "vpc-1",
  subnetIds: ["subnet-a", "subnet-b"],
  securityGroupIds: ["sg-1", "sg-2"],
  availabilityZones: ["us-east-1a", "us-east-1b"],
  rationale: "test",
};

describe("prefill 适配器 — 通道字段映射", () => {
  it("Glue：单子网 + SG 列表 + AZ（AZ 取首子网 AZ）", () => {
    const g = toGlue(p);
    expect(g).toEqual({ channel: "glue", subnetId: "subnet-a", securityGroupIdList: ["sg-1", "sg-2"], availabilityZone: "us-east-1a" });
  });

  it("Flink：VpcConfiguration{SubnetIds[],SecurityGroupIds[]}", () => {
    expect(toFlink(p)).toEqual({ channel: "flink", vpcConfiguration: { SubnetIds: ["subnet-a", "subnet-b"], SecurityGroupIds: ["sg-1", "sg-2"] } });
  });

  it("DMS：复制子网组子网 + VPC SGs", () => {
    expect(toDms(p)).toEqual({ channel: "dms", replicationSubnetGroupSubnetIds: ["subnet-a", "subnet-b"], vpcSecurityGroupIds: ["sg-1", "sg-2"] });
  });

  it("prefillFor 按 computeKind 分发", () => {
    expect(prefillFor("glue", p).channel).toBe("glue");
    expect(prefillFor("flink", p).channel).toBe("flink");
    expect(prefillFor("dms", p).channel).toBe("dms");
    expect(prefillFor("zeroetl", p).channel).toBe("zeroetl");
    expect(prefillFor("lambda-vpc", p).channel).toBe("lambda-vpc");
    expect(prefillFor("emr", p).channel).toBe("generic"); // 未特化 → generic
  });
});
