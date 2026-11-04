import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  toSparkSubmitParameters,
  userSparkConfToParameters,
  EMR_SPEC_DEFAULT,
  EMR_RELEASE_LABELS,
  EMR_DEFAULT_RELEASE,
  RESERVED_SPARK_CONF,
} from "../emr/spec";
import { isEngineType, getProvider, listEngines } from "../registry";
import { mapEmrState, EMR_TERMINAL_STATES } from "../emr/run-record";
import { isEmrNetworkFilled, emrNetworkFromPrefill } from "../emr/network";

describe("registry (SPI 表驱动)", () => {
  it("isEngineType 只认注册过的引擎", () => {
    expect(isEngineType("emr-serverless")).toBe(true);
    expect(isEngineType("glue")).toBe(false);
    expect(isEngineType("")).toBe(false);
    expect(isEngineType(null)).toBe(false);
    expect(isEngineType(123)).toBe(false);
  });
  it("getProvider 返回 emr-serverless provider", () => {
    const p = getProvider("emr-serverless");
    expect(p.type).toBe("emr-serverless");
    expect(p.capabilities.canStop).toBe(true);
    expect(p.capabilities.supportsDryRun).toBe(false);
  });
  it("listEngines 至少含 emr-serverless", () => {
    expect(listEngines()).toContain("emr-serverless");
  });
});

describe("EMR release 清单与缺省(用户 2026-10-26 拍板:缺省最高、清单允许降版)", () => {
  it("清单含 emr-7.14.0(2026-09 发布的 7.x 最高)且缺省 = 清单第一项 = emr-spark-8.0.0(最高)", () => {
    expect(EMR_RELEASE_LABELS).toContain("emr-7.14.0");
    expect(EMR_RELEASE_LABELS[0]).toBe(EMR_DEFAULT_RELEASE);
    expect(EMR_DEFAULT_RELEASE).toBe("emr-spark-8.0.0");
    expect(EMR_SPEC_DEFAULT.releaseLabel).toBe(EMR_DEFAULT_RELEASE);
    expect(new Set(EMR_RELEASE_LABELS).size).toBe(EMR_RELEASE_LABELS.length);
  });
  it("第二作者的回落值都等于 EMR_DEFAULT_RELEASE:application.ts 不再写死 emr-7.5.0;infra platform-stack.ts 的 EMR_RELEASE_LABEL 回落字面量与之逐字相同", () => {
    const app = readFileSync(join(__dirname, "..", "emr", "application.ts"), "utf8");
    expect(app).toContain("process.env.EMR_RELEASE_LABEL || EMR_DEFAULT_RELEASE");
    expect(app).not.toContain('"emr-7.5.0"');
    // vitest 在 platform/ 起;infra 是同仓兄弟目录(infra 不能 import platform ⇒ 只能钉字面量)
    const stack = join(process.cwd(), "..", "infra", "lib", "platform-stack.ts");
    expect(existsSync(stack), stack).toBe(true);
    const infra = readFileSync(stack, "utf8");
    const m = /EMR_RELEASE_LABEL: \(this\.node\.tryGetContext\("emr-release"\) as string\) \|\| "([^"]+)"/.exec(infra);
    expect(m, "platform-stack.ts 里找不到 EMR_RELEASE_LABEL 的回落写法").not.toBeNull();
    expect(m![1]).toBe(EMR_DEFAULT_RELEASE);
  });
});

describe("toSparkSubmitParameters (确定性生成)", () => {
  it("默认规格生成正确的 --conf", () => {
    const s = toSparkSubmitParameters(EMR_SPEC_DEFAULT);
    expect(s).toContain("--conf spark.driver.cores=4");
    expect(s).toContain("--conf spark.driver.memory=16g");
    expect(s).toContain("--conf spark.executor.cores=4");
    expect(s).toContain("--conf spark.executor.memory=16g");
    expect(s).toContain("--conf spark.executor.instances=2");
    expect(s).toContain("--conf spark.emr-serverless.driver.disk=20G");
    expect(s).toContain("--conf spark.emr-serverless.executor.disk=20G");
  });
  it("规格数值随输入变化", () => {
    const s = toSparkSubmitParameters({
      releaseLabel: "emr-7.5.0",
      architecture: "X86_64",
      driver: { cpu: "8 vCPU", memory: "32 GB" },
      executor: { cpu: "2 vCPU", memory: "8 GB", disk: "50 GB" },
      executorCount: 10,
    });
    expect(s).toContain("spark.driver.cores=8");
    expect(s).toContain("spark.executor.memory=8g");
    expect(s).toContain("spark.executor.instances=10");
    expect(s).toContain("spark.emr-serverless.executor.disk=50G");
    // 无 driver.disk → 不生成该行
    expect(s).not.toContain("spark.emr-serverless.driver.disk");
  });
});

describe("userSparkConfToParameters (保留键黑名单)", () => {
  it("过滤平台保留键，保留用户自定义键", () => {
    const s = userSparkConfToParameters({
      "spark.driver.cores": "99", // 保留键 → 被过滤（用户不能覆盖平台规格）
      "spark.sql.shuffle.partitions": "200", // 自定义 → 保留
      "spark.executor.memory": "999g", // 保留键 → 被过滤
    });
    expect(s).not.toContain("spark.driver.cores=99");
    expect(s).not.toContain("spark.executor.memory=999g");
    expect(s).toContain("--conf spark.sql.shuffle.partitions=200");
  });
  it("空/未定义返回空串", () => {
    expect(userSparkConfToParameters(undefined)).toBe("");
    expect(userSparkConfToParameters({})).toBe("");
  });
  it("RESERVED_SPARK_CONF 含全部平台规格键", () => {
    expect(RESERVED_SPARK_CONF.has("spark.executor.instances")).toBe(true);
    expect(RESERVED_SPARK_CONF.has("spark.emr-serverless.driver.disk")).toBe(true);
  });
});

describe("mapEmrState (EMR JobRunState → 4 值)", () => {
  it("覆盖全部原生态", () => {
    expect(mapEmrState("SUCCESS")).toBe("succeeded");
    expect(mapEmrState("FAILED")).toBe("failed");
    expect(mapEmrState("CANCELLED")).toBe("stopped");
    expect(mapEmrState("CANCELLING")).toBe("stopped");
    expect(mapEmrState("RUNNING")).toBe("running");
    expect(mapEmrState("SUBMITTED")).toBe("running");
    expect(mapEmrState("PENDING")).toBe("running");
    expect(mapEmrState("QUEUED")).toBe("running");
    expect(mapEmrState("SCHEDULED")).toBe("running");
    expect(mapEmrState(undefined)).toBe("running");
  });
  it("终态集合正确", () => {
    expect(EMR_TERMINAL_STATES).toEqual(["SUCCESS", "FAILED", "CANCELLED"]);
  });
});

describe("emr network 连接信息前置", () => {
  it("isEmrNetworkFilled 要求子网+SG 都非空", () => {
    expect(isEmrNetworkFilled({ subnetIds: ["s-1"], securityGroupIds: ["sg-1"] })).toBe(true);
    expect(isEmrNetworkFilled({ subnetIds: [], securityGroupIds: ["sg-1"] })).toBe(false);
    expect(isEmrNetworkFilled({ subnetIds: ["s-1"], securityGroupIds: [] })).toBe(false);
    expect(isEmrNetworkFilled(null)).toBe(false);
  });
  it("emrNetworkFromPrefill 解析 generic 通道", () => {
    const n = emrNetworkFromPrefill({ channel: "generic", subnetIds: ["s-1", "s-2"], securityGroupIds: ["sg-1"], availabilityZones: ["us-east-1a"] });
    expect(n).toEqual({ subnetIds: ["s-1", "s-2"], securityGroupIds: ["sg-1"] });
  });
  it("非 generic 通道返回 null", () => {
    expect(emrNetworkFromPrefill({ channel: "flink", vpcConfiguration: { SubnetIds: [], SecurityGroupIds: [] } } as any)).toBeNull();
    expect(emrNetworkFromPrefill(null)).toBeNull();
  });
});
