// @kf-batch 50-WP23-p0e-preview-flake
// **P0-E 预演结果判定**(`infra/scripts/preview-outcome.mjs`)的门禁 —— 这一层此前**零离线覆盖**。
//
// 【为什么一定要有】2026-09-15 真环境:给 `tgt_usw2_a` 补装 `dms` 的 build 死在 P0-E 闸的第 ① 步 ——
// CDK 刚 `CreateChangeSet` 就 describe,撞上 CloudFormation 最终一致性窗口拿到 `ChangeSetNotFoundException`,
// 于是「预演失败 ⇒ 不知道会改什么 ⇒ 拒绝部署」。而那个 changeset 就在那儿正在创建(紧接着的 delete 报
// `Cannot delete ChangeSet in status CREATE_IN_PROGRESS` 是铁证)⇒ **补装组件随机整体失败**。
// 那一层只在 CodeBuild 里跑(`infra/prod-only-layers.json` 的一类),所以修法必须连**离线替身**一起给。
//
// 🔴 判据的重点是**判别力**:瞬态与真错必须分开、fail-closed 不许被放宽 ——
//    所以每条正向都配一条把「瞬态」换成「真错」的反例。
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../../..");
const MOD = resolve(REPO, "infra/scripts/preview-outcome.mjs");

async function load() {
  return (await import(MOD)) as {
    parseCdkStackFailures: (o: string) => Array<{ stackName: string; error: string }>;
    isTransientPreviewError: (m: string) => boolean;
    classifyChangeSet: (raw: unknown) => string;
    previewVerdict: (a: {
      cdkFailed?: boolean;
      failures?: Array<{ stackName: string; error: string }>;
      outcomes?: Record<string, string>;
    }) => { proceed: boolean; retry: boolean; why: string; unresolved: string[] };
    CHANGE_SET_EMPTY_RE: RegExp;
  };
}

// 真环境**原文**(CloudWatch 日志逐字复制;判据不许拿我自己编的格式当输入)
const REAL_LOG = [
  "BgpExecEnv-tgt-usw2-a-base: creating CloudFormation changeset...",
  "",
  "NOTICES         (What's this? https://github.com/aws/aws-cdk/wiki/CLI-Notices)",
  "",
  "❌  BgpExecEnv-tgt-usw2-a-base failed: ChangeSetNotFoundException: ChangeSet [bgp-p0e-preview] does not exist",
  "",
].join("\n");

const NAMES = [
  "BgpExecEnv-tgt-usw2-a-base",
  "BgpExecEnv-tgt-usw2-a-core",
  "BgpExecEnv-tgt-usw2-a-redshift",
  "BgpExecEnv-tgt-usw2-a-dms",
  "BgpExecEnv-tgt-usw2-a-airflow-serverless",
];
const allOutcomes = (v: string) => Object.fromEntries(NAMES.map((n) => [n, v]));

describe("P0-E 预演结果判定(preview-outcome.mjs)", () => {
  it("从真环境日志原文里认出那一条逐栈失败(栈名 + 拒因都要对)", async () => {
    const { parseCdkStackFailures } = await load();
    const f = parseCdkStackFailures(REAL_LOG);
    expect(f).toHaveLength(1);
    expect(f[0].stackName).toBe("BgpExecEnv-tgt-usw2-a-base");
    expect(f[0].error).toBe("ChangeSetNotFoundException: ChangeSet [bgp-p0e-preview] does not exist");
  });

  it("不把普通日志行当失败(只认 CDK 自己的失败标记行)", async () => {
    const { parseCdkStackFailures } = await load();
    expect(parseCdkStackFailures("BgpExecEnv-x: creating CloudFormation changeset...\n✅  done\n")).toEqual([]);
    // 🔴 反例:文本里出现 failed 但不是那种行 ⇒ 不许命中
    expect(parseCdkStackFailures("note: a previous deploy failed: whatever")).toEqual([]);
  });

  it("瞬态词表:最终一致性 / 限流算瞬态,而真错不算", async () => {
    const { isTransientPreviewError } = await load();
    expect(isTransientPreviewError("ChangeSetNotFoundException: ChangeSet [bgp-p0e-preview] does not exist")).toBe(true);
    expect(isTransientPreviewError("Rate exceeded")).toBe(true);
    expect(isTransientPreviewError("ThrottlingException: Rate exceeded")).toBe(true);
    // 反例(这些必须**不是**瞬态,否则闸就被放宽了)
    expect(isTransientPreviewError("ValidationError: Parameter foo must be a string")).toBe(false);
    expect(isTransientPreviewError("Resource handler returned message: Access Denied")).toBe(false);
    expect(isTransientPreviewError("The stack named X is in ROLLBACK_COMPLETE state")).toBe(false);
  });

  it("changeset 五态归一:ready / empty / pending / missing / failed", async () => {
    const { classifyChangeSet } = await load();
    expect(classifyChangeSet({ Status: "CREATE_COMPLETE" })).toBe("ready");
    expect(classifyChangeSet({ Status: "FAILED", StatusReason: "The submitted information didn't contain changes." })).toBe("empty");
    expect(classifyChangeSet({ Status: "FAILED", StatusReason: "No updates are to be performed." })).toBe("empty");
    expect(classifyChangeSet({ Status: "CREATE_IN_PROGRESS" })).toBe("pending");
    expect(classifyChangeSet({ Status: "CREATE_PENDING" })).toBe("pending");
    expect(classifyChangeSet(null)).toBe("missing");
    expect(classifyChangeSet({})).toBe("missing");
    // 🔴 真失败绝不能被归成 empty(那会让闸拿一份空计划去放行)
    expect(classifyChangeSet({ Status: "FAILED", StatusReason: "Transform AWS::Include failed" })).toBe("failed");
    expect(classifyChangeSet({ Status: "DELETE_COMPLETE" })).toBe("failed");
  });

  it("空 changeset 的判据与 deploy-impact 的归一函数用**同一份**措辞(两处都改才算改)", async () => {
    const { CHANGE_SET_EMPTY_RE } = await load();
    const impact = (await import(resolve(REPO, "infra/scripts/deploy-impact.mjs"))) as {
      normalizeDescribeChangeSet: (n: string, raw: unknown) => { empty: boolean };
    };
    for (const reason of ["The submitted information didn't contain changes.", "No updates are to be performed."]) {
      expect(CHANGE_SET_EMPTY_RE.test(reason)).toBe(true);
      expect(impact.normalizeDescribeChangeSet("s", { Status: "FAILED", StatusReason: reason }).empty).toBe(true);
    }
  });

  it("🔴 事故那一幕:CDK 报瞬态错,但逐栈 changeset 全部读到终态 ⇒ 放行(不再整体拒)", async () => {
    const { parseCdkStackFailures, previewVerdict } = await load();
    const v = previewVerdict({
      cdkFailed: true,
      failures: parseCdkStackFailures(REAL_LOG),
      outcomes: { ...allOutcomes("ready"), "BgpExecEnv-tgt-usw2-a-redshift": "empty" },
    });
    expect(v.proceed).toBe(true);
    expect(v.retry).toBe(false);
    expect(v.why).toContain("瞬态");
  });

  it("🔴 瞬态 + 还有栈没量到终态 ⇒ **不放行**,但允许清干净后重试一次", async () => {
    const { parseCdkStackFailures, previewVerdict } = await load();
    const v = previewVerdict({
      cdkFailed: true,
      failures: parseCdkStackFailures(REAL_LOG),
      outcomes: { ...allOutcomes("ready"), "BgpExecEnv-tgt-usw2-a-dms": "missing" },
    });
    expect(v.proceed).toBe(false);
    expect(v.retry).toBe(true);
    expect(v.unresolved).toEqual(["BgpExecEnv-tgt-usw2-a-dms"]);
  });

  it("🔴 反例一:有栈的 changeset **真失败** ⇒ 既不放行也不重试(哪怕 CDK 的错因是瞬态)", async () => {
    const { parseCdkStackFailures, previewVerdict } = await load();
    const v = previewVerdict({
      cdkFailed: true,
      failures: parseCdkStackFailures(REAL_LOG),
      outcomes: { ...allOutcomes("ready"), "BgpExecEnv-tgt-usw2-a-core": "failed" },
    });
    expect(v.proceed).toBe(false);
    expect(v.retry).toBe(false);
    expect(v.why).toContain("core=failed");
  });

  it("🔴 反例二:错因**不是**瞬态(真 synth/权限错)⇒ 不重试、不放行", async () => {
    const { previewVerdict } = await load();
    const v = previewVerdict({
      cdkFailed: true,
      failures: [{ stackName: "BgpExecEnv-tgt-usw2-a-base", error: "ValidationError: Template format error" }],
      outcomes: allOutcomes("missing"),
    });
    expect(v.proceed).toBe(false);
    expect(v.retry).toBe(false);
  });

  it("🔴 反例三:一个栈都没量到 ⇒ 最严(绝不因为「没看见问题」就放行)", async () => {
    const { previewVerdict } = await load();
    const v = previewVerdict({ cdkFailed: true, failures: [], outcomes: {} });
    expect(v.proceed).toBe(false);
    expect(v.retry).toBe(false);
  });

  it("CDK 没报错时:全部 ready/empty ⇒ 放行且理由里不提瞬态", async () => {
    const { previewVerdict } = await load();
    const v = previewVerdict({ cdkFailed: false, failures: [], outcomes: allOutcomes("ready") });
    expect(v.proceed).toBe(true);
    expect(v.why).toContain("预演成功");
    expect(v.why).not.toContain("瞬态");
  });
});
