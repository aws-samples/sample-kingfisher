// stack-outputs(CFN Outputs 取数层)单测 —— **顶层 import + 顶层 vi.mock**(唯一已证可靠的组合;
// 动态 import + 包名 mock 实测拦不住、会真打 AWS,见 stack-outputs.ts 文件头)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const { cfnSend, cfnRegions, smSend, smRegions } = vi.hoisted(() => ({
  cfnSend: vi.fn(),
  cfnRegions: [] as string[],
  smSend: vi.fn(),
  smRegions: [] as string[],
}));
vi.mock("@aws-sdk/client-cloudformation", () => ({
  CloudFormationClient: class {
    constructor(cfg: { region: string }) {
      cfnRegions.push(cfg.region);
    }
    send = cfnSend;
  },
  DescribeStacksCommand: class {
    constructor(public input: { StackName: string }) {}
  },
}));

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    constructor(cfg: { region: string }) {
      smRegions.push(cfg.region);
    }
    send = smSend;
  },
  DescribeSecretCommand: class {
    constructor(public input: { SecretId: string }) {}
  },
}));

import { readExecEnvStackOutputs } from "@/lib/exec-env/stack-outputs";

const SECRET_ARN = "arn:aws:secretsmanager:us-west-2:123456789012:secret:redshift!bgp-namespace-tgt-usw2-a-admin-AbCdEf";

beforeEach(() => {
  vi.clearAllMocks();
  cfnRegions.length = 0;
  smRegions.length = 0;
  smSend.mockResolvedValue({ ARN: SECRET_ARN });
});

describe("readExecEnvStackOutputs", () => {
  it("按 slug 拼两个栈名、client 按目标 region 现建、OutputKey/Value 组装成 map", async () => {
    cfnSend.mockImplementation(async (cmd: { input: { StackName: string } }) => ({
      Stacks: [
        {
          Outputs: [
            { OutputKey: "who", OutputValue: cmd.input.StackName },
            // redshift 栈按合同吐的是 secret **名字**(ARN 由平台侧 DescribeSecret 换,见 stack-outputs.ts)
            { OutputKey: "redshiftSecretName", OutputValue: "redshift!bgp-namespace-tgt-usw2-a-admin" },
            { OutputKey: "empty", OutputValue: undefined }, // 无值的 Output 不进 map
          ],
        },
      ],
    }));
    const outs = await readExecEnvStackOutputs("us-west-2", "tgt_usw2_a");
    expect(outs.base.who).toBe("BgpExecEnv-tgt-usw2-a-base");
    expect(outs.core.who).toBe("BgpExecEnv-tgt-usw2-a-core");
    expect("empty" in outs.base).toBe(false);
    expect(cfnRegions).toEqual(["us-west-2"]);
  });

  it("栈不存在 ⇒ 错误消息带栈名/region 并指向『先 deploy 再回写』", async () => {
    cfnSend.mockRejectedValue(new Error("Stack with id X does not exist"));
    await expect(readExecEnvStackOutputs("us-west-2", "tgt_usw2_a")).rejects.toThrow(
      /读不到栈 BgpExecEnv-tgt-usw2-a-(base|core)(.*)先 deploy 再回写/
    );
  });

  it("非法 targetId ⇒ 在 toTargetSlug 就抛(不带非法串去拼栈名)", async () => {
    await expect(readExecEnvStackOutputs("us-west-2", "tgt-bad")).rejects.toThrow();
    expect(cfnSend).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 可选组件栈的**组件驱动**读取
// ══════════════════════════════════════════════════════════════════════════════
describe("可选组件栈(读到才算装了)", () => {
  /** 按栈名分发:`present` 里的栈返回 outputs,其余抛真 CFN 的 "does not exist" 文案。 */
  function stacks(present: Record<string, Record<string, string>>) {
    cfnSend.mockImplementation(async (cmd: { input: { StackName: string } }) => {
      const name = cmd.input.StackName;
      if (!(name in present)) {
        throw new Error(`Stack with id ${name} does not exist`);
      }
      return {
        Stacks: [{ Outputs: Object.entries(present[name]).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }],
      };
    });
  }
  const BASE = "BgpExecEnv-tgt-usw2-a-base";
  const CORE = "BgpExecEnv-tgt-usw2-a-core";

  it("🔴 **不按注册表声称的组件过滤**:对每个已实现可选组件各探一次(否则补充部署刚装的栈永远发现不了)", async () => {
    stacks({ [BASE]: { targetId: "tgt_usw2_a" }, [CORE]: { datalakeBucket: "b" } });
    await readExecEnvStackOutputs("us-west-2", "tgt_usw2_a");
    const asked = cfnSend.mock.calls.map((c) => (c[0] as { input: { StackName: string } }).input.StackName).sort();
    expect(asked).toEqual(
      // mwaa 已实现 ⇒ 它的栈也要探一次(补装刚装的 mwaa 才发现得了)
      [BASE, CORE, "BgpExecEnv-tgt-usw2-a-redshift", "BgpExecEnv-tgt-usw2-a-dms", "BgpExecEnv-tgt-usw2-a-flink", "BgpExecEnv-tgt-usw2-a-residency-api", "BgpExecEnv-tgt-usw2-a-mwaa", "BgpExecEnv-tgt-usw2-a-airflow-serverless"].sort()
    );
  });

  it("组件栈不存在 ⇒ 跳过、不抛(= 该组件没装,是正常状态)", async () => {
    stacks({ [BASE]: { targetId: "tgt_usw2_a" }, [CORE]: { datalakeBucket: "b" } });
    const outs = await readExecEnvStackOutputs("us-west-2", "tgt_usw2_a");
    expect(outs.components).toEqual({});
  });

  it("组件栈存在 ⇒ 收进 components[组件名],OutputKey 原样(= 描述符字段名)", async () => {
    stacks({
      [BASE]: { targetId: "tgt_usw2_a" },
      [CORE]: { datalakeBucket: "b" },
      "BgpExecEnv-tgt-usw2-a-dms": { dmsSubnetGroup: "bgp-dms-subnet-group-tgt-usw2-a" },
      "BgpExecEnv-tgt-usw2-a-flink": { flinkRoleArn: "arn:aws:iam::123456789012:role/BgpExecEnv-tgt-usw2-a-flink-role" },
    });
    const outs = await readExecEnvStackOutputs("us-west-2", "tgt_usw2_a");
    expect(Object.keys(outs.components).sort()).toEqual(["dms", "flink"]);
    expect(outs.components.dms.dmsSubnetGroup).toBe("bgp-dms-subnet-group-tgt-usw2-a");
    expect("redshift" in outs.components).toBe(false);
  });

  it("🔴 base/core 缺 ⇒ 仍然抛(必读两栈的语义没被组件驱动改掉)", async () => {
    stacks({ [BASE]: { targetId: "tgt_usw2_a" } }); // core 缺
    await expect(readExecEnvStackOutputs("us-west-2", "tgt_usw2_a")).rejects.toThrow(/读不到栈 .*-core/);
  });

  it("🔴 组件栈探测遇**非 does-not-exist** 错误(如 AccessDenied)⇒ 抛,绝不当成「没装」", async () => {
    cfnSend.mockImplementation(async (cmd: { input: { StackName: string } }) => {
      const name = cmd.input.StackName;
      if (name.endsWith("-base")) return { Stacks: [{ Outputs: [{ OutputKey: "targetId", OutputValue: "tgt_usw2_a" }] }] };
      if (name.endsWith("-core")) return { Stacks: [{ Outputs: [] }] };
      throw new Error("AccessDenied: not authorized to perform cloudformation:DescribeStacks");
    });
    // 理由:当成"没装"会把注册表里本来装着的组件抹掉(observed 回写),用一次抖动换永久假象
    await expect(readExecEnvStackOutputs("us-west-2", "tgt_usw2_a")).rejects.toThrow(/探组件栈 .*失败.*AccessDenied/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 跨侧接缝:redshift 组件栈吐 secret **名字**,平台侧按名换真 **ARN**
// (栈里拼不出 ARN —— 托管 secret 的 ARN 尾部是服务生成的随机后缀,且 CfnNamespace 无该 GetAtt)
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 redshiftSecretName → redshiftSecretArn(fail-closed,绝不拿名字冒充 ARN)", () => {
  const BASE = "BgpExecEnv-tgt-usw2-a-base";
  const CORE = "BgpExecEnv-tgt-usw2-a-core";
  const RS = "BgpExecEnv-tgt-usw2-a-redshift";
  function withRedshift(outs: Record<string, string>) {
    cfnSend.mockImplementation(async (cmd: { input: { StackName: string } }) => {
      const name = cmd.input.StackName;
      const map: Record<string, Record<string, string>> = {
        [BASE]: { targetId: "tgt_usw2_a" },
        [CORE]: { datalakeBucket: "b" },
        [RS]: outs,
      };
      if (!(name in map)) throw new Error(`Stack with id ${name} does not exist`);
      return { Stacks: [{ Outputs: Object.entries(map[name]).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
    });
  }

  it("按名 DescribeSecret 换成真 ARN,client 建在**目标 region**", async () => {
    withRedshift({ redshiftWorkgroup: "wg", redshiftDatabase: "dev", redshiftSecretName: "redshift!ns-admin" });
    const outs = await readExecEnvStackOutputs("us-west-2", "tgt_usw2_a");
    expect(outs.components.redshift.redshiftSecretArn).toBe(SECRET_ARN);
    expect(smRegions).toEqual(["us-west-2"]);
    expect((smSend.mock.calls[0][0] as { input: { SecretId: string } }).input.SecretId).toBe("redshift!ns-admin");
  });

  it("DescribeSecret 抛 ⇒ 整轮抛(不静默把 redshift 当没装,也不写半份)", async () => {
    withRedshift({ redshiftWorkgroup: "wg", redshiftDatabase: "dev", redshiftSecretName: "redshift!ns-admin" });
    smSend.mockRejectedValue(new Error("AccessDeniedException: not authorized"));
    await expect(readExecEnvStackOutputs("us-west-2", "tgt_usw2_a")).rejects.toThrow(/按名 DescribeSecret/);
  });

  it("DescribeSecret 没返回 ARN ⇒ 抛(不拿名字填 redshiftSecretArn)", async () => {
    withRedshift({ redshiftWorkgroup: "wg", redshiftDatabase: "dev", redshiftSecretName: "redshift!ns-admin" });
    smSend.mockResolvedValue({});
    await expect(readExecEnvStackOutputs("us-west-2", "tgt_usw2_a")).rejects.toThrow(/没返回 ARN/);
  });

  it("栈两个键都没吐 ⇒ 抛并指向栈组合同(不猜)", async () => {
    withRedshift({ redshiftWorkgroup: "wg", redshiftDatabase: "dev" });
    await expect(readExecEnvStackOutputs("us-west-2", "tgt_usw2_a")).rejects.toThrow(/栈组合同被改动/);
    expect(smSend).not.toHaveBeenCalled();
  });

  it("栈将来若直接吐 ARN ⇒ 让路,不再 describe", async () => {
    withRedshift({ redshiftWorkgroup: "wg", redshiftDatabase: "dev", redshiftSecretArn: SECRET_ARN });
    const outs = await readExecEnvStackOutputs("us-west-2", "tgt_usw2_a");
    expect(outs.components.redshift.redshiftSecretArn).toBe(SECRET_ARN);
    expect(smSend).not.toHaveBeenCalled();
  });
});
