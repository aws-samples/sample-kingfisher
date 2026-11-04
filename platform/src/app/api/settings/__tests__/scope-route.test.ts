// `/api/settings` 按执行范围给**该区自己的**资源。
//
// 🔴🔴 这一组判据钉的是本平台唯一一处**硬撒谎**:改动前这一页声明「不受执行范围影响」,
//     却把主控区的工作组 / 桶 / VPC 当「平台配置」给所有区看。所以最承重的一条是
//     **非主控区视角下不许出现主控区的任何值** —— 读不到就说读不到。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const HOME_BAG = {
  redshiftWorkgroup: "bgp-workgroup",
  redshiftDatabase: "bgp-data",
  scriptsBucket: "bgp-glue-scripts-home",
  glueRoleArn: "arn:aws:iam::x:role/bgp-glue-role",
  datalakeBucket: "bgp-datalake-home",
  tableBucket: "bgp-table-bucket-home",
  athenaWorkgroup: "bgp-athena",
  dagBucket: "bgp-dags-home",
  vpcId: "vpc-home",
};
const USW2_BAG = {
  redshiftWorkgroup: "bgp-workgroup-tgt-usw2-a",
  redshiftDatabase: "bgp-data-tgt-usw2-a",
  scriptsBucket: "bgp-glue-scripts-tgt-usw2-a",
  glueRoleArn: "arn:aws:iam::x:role/BgpExecEnv-tgt-usw2-a-glue-role",
  datalakeBucket: "bgp-datalake-tgt-usw2-a",
  tableBucket: "bgp-table-bucket-tgt-usw2-a",
  athenaWorkgroup: "bgp-athena-tgt-usw2-a",
  dagBucket: "bgp-dags-tgt-usw2-a",
  vpcId: "vpc-usw2",
};

let targets: Record<string, unknown> = {};

vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => (targets as Record<string, unknown>)[id] ?? null),
  descriptorViolation: vi.fn(() => null),
}));
vi.mock("@/lib/ai/model", () => ({ resolveModelRuntime: vi.fn(async () => ({ modelId: "m", source: "default", stale: false })) }));
vi.mock("@/lib/scheduler/mwaa-endpoint", () => ({
  homeMwaaConfigured: () => true,
  homeMwaaEndpoint: () => ({ dagBucket: "bgp-dags-home-env" }),
}));
vi.mock("@/lib/redshift/warehouse-location", () => ({ homeWorkgroup: () => "bgp-workgroup-env" }));
vi.mock("@/lib/exec-env/residency", () => ({ accessAllows: () => true, accessDeniedReason: () => "denied" }));

import { GET } from "../route";

const req = (qs = "") => new NextRequest(`https://x.test/api/settings${qs}`);
const body = async (qs = "") => (await (await GET(req(qs))).json()).data;

beforeEach(() => {
  targets = {
    tgt_home: { targetId: "tgt_home", region: "us-east-1", ready: true, displayName: "Home", resources: HOME_BAG, components: ["core", "redshift", "mwaa"] },
    tgt_usw2_a: { targetId: "tgt_usw2_a", region: "us-west-2", ready: true, displayName: "usw2", resources: USW2_BAG, components: ["core", "redshift"] },
    tgt_core_only: { targetId: "tgt_core_only", region: "us-west-2", ready: true, resources: { scriptsBucket: "bgp-glue-scripts-core" }, components: ["core"] },
  };
});

describe("按区取值", () => {
  it("🔴🔴 非主控区视角:每一项都是那个区自己的,**一个主控区的值都不许出现**", async () => {
    const d = await body("?scope=tgt_usw2_a");
    expect(d.targetId).toBe("tgt_usw2_a");
    expect(d.region).toBe("us-west-2");
    // 🔴 逐字段**相等**比,不用整体子串比:`bgp-athena` 是 `bgp-athena-tgt-usw2-a` 的子串,
    // 子串式断言在这里会假红(第一版就这么写的,当场被自己逮到)。
    const FIELD_OF_BAG_KEY: Record<string, string> = {
      redshiftWorkgroup: "redshiftWorkgroup",
      redshiftDatabase: "redshiftDatabase",
      scriptsBucket: "glueScriptsBucket",
      glueRoleArn: "glueRoleArn",
      datalakeBucket: "datalakeBucket",
      tableBucket: "tableBucket",
      athenaWorkgroup: "athenaWorkgroup",
      dagBucket: "mwaaDagBucket",
      vpcId: "defaultVpcId",
    };
    for (const [bagKey, field] of Object.entries(FIELD_OF_BAG_KEY)) {
      expect(
        d[field],
        `${field} 等于主控区的值 ${(HOME_BAG as Record<string, string>)[bagKey]} —— 这正是改动前那处撒谎`
      ).not.toBe((HOME_BAG as Record<string, string>)[bagKey]);
    }
    expect(d.redshiftWorkgroup).toBe(USW2_BAG.redshiftWorkgroup);
    expect(d.mwaaDagBucket).toBe(USW2_BAG.dagBucket);
    expect(d.defaultVpcId).toBe("vpc-usw2");
    expect(d.valuesFrom).toBe("descriptor");
  });

  it("主控区视角:取主控区描述符(不是进程环境变量)", async () => {
    const d = await body("?scope=tgt_home");
    expect(d.redshiftWorkgroup).toBe("bgp-workgroup");
    expect(d.valuesFrom).toBe("descriptor");
  });

  it("「全部」视角:仍给主控区的值,但必须标出 `valuesAreForSingleTarget=false`(页面据此提示)", async () => {
    const d = await body();
    expect(d.targetId).toBe("tgt_home");
    expect(d.valuesAreForSingleTarget).toBe(false);
  });

  it("🔴 该区没装数仓 ⇒ `warehouseInstalled=false`(页面显示「该区未部署数据仓库」而不是主控区的工作组名)", async () => {
    const d = await body("?scope=tgt_core_only");
    expect(d.warehouseInstalled).toBe(false);
    expect(d.redshiftWorkgroup).toBe("未配置");
    expect(JSON.stringify(d)).not.toContain(HOME_BAG.redshiftWorkgroup);
  });

  it("🔴 描述符读不到:一律「未配置」+ `valuesFrom=unavailable`,绝不拿主控区的顶上", async () => {
    targets = { tgt_home: { targetId: "tgt_home", region: "us-east-1", ready: true, resources: HOME_BAG, components: ["core"] }, tgt_usw2_a: { targetId: "tgt_usw2_a", region: "us-west-2", ready: true, components: ["core"] } };
    const d = await body("?scope=tgt_usw2_a");
    expect(d.valuesFrom).toBe("unavailable");
    expect(d.glueScriptsBucket).toBe("未配置");
    expect(JSON.stringify(d)).not.toContain(HOME_BAG.scriptsBucket);
  });

  it("身份是单池全局:两个视角下都一样(它确实与区无关)", async () => {
    const a = await body("?scope=tgt_home");
    const b = await body("?scope=tgt_usw2_a");
    expect(a.cognitoUserPoolId).toBe(b.cognitoUserPoolId);
  });

  it("非法 / 不存在的 scope 一律拒,不回落", async () => {
    expect((await GET(req("?scope=@@"))).status).toBe(400);
    expect((await GET(req("?scope=tgt_nope"))).status).toBe(404);
  });
});
