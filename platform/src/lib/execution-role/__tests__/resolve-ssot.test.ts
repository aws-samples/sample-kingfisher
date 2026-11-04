// 序 72 B-139(模块 56)—— 执行角色解析的单一作者 + 棘轮:
//   ① `iam::\d{12}:role` 这条正则在产品源码里只许出现在 lib/execution-role/resolve.ts(改动前四入口 + 两条 Flink 路由 +
//      role-advisor/preflight + exec-env/exec-roles + aws/dataplane-creds 各一份,改一处漏七处);
//   ② 四个作业入口与两条 Flink 路由 / 两条 ETL 路由必须真 import 单一作者(「写了」≠「接上了」:判据钉调用点字面,不只钉 import)。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutionRoleArn, roleArnShapeRejection, roleNameOfArn, rolePathAndNameOfArn, isRoleArn, ExecRoleRejected } from "../resolve";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "__tests__" && n !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}

describe("序 72 B-139 执行角色 ARN:单一作者", () => {
  it("形态:合法 / 分区后缀 / 带路径都认;非法逐字原话拒", () => {
    expect(isRoleArn("arn:aws:iam::123456789012:role/customer-glue-role")).toBe(true);
    expect(isRoleArn("arn:aws-cn:iam::123456789012:role/svc/customer-glue-role")).toBe(true);
    expect(isRoleArn("arn:aws:iam::12345:role/x")).toBe(false);
    expect(isRoleArn("customer-glue-role")).toBe(false);
    expect(roleArnShapeRejection("nope")).toBe("执行角色 ARN 格式非法:nope(应形如 arn:aws:iam::<账号>:role/<角色名>)");
    expect(roleArnShapeRejection("arn:aws:iam::123456789012:role/ok")).toBeNull();
    expect(roleNameOfArn("arn:aws:iam::123456789012:role/svc/customer-glue-role")).toBe("customer-glue-role");
    expect(rolePathAndNameOfArn("arn:aws:iam::123456789012:role/svc/customer-glue-role")).toBe("svc/customer-glue-role");
    expect(roleNameOfArn(42)).toBeNull();
  });

  it("解析:自定义优先(isCustom=true)/ 留空回退平台默认(isCustom=false)/ 都没有 ⇒ ExecRoleRejected(调用方原话)", () => {
    expect(resolveExecutionRoleArn({ custom: " arn:aws:iam::123456789012:role/mine ", fallback: "arn:aws:iam::123456789012:role/platform", missingMessage: "m" }))
      .toEqual({ roleArn: "arn:aws:iam::123456789012:role/mine", isCustom: true });
    expect(resolveExecutionRoleArn({ custom: "", fallback: "arn:aws:iam::123456789012:role/platform", missingMessage: "m" }))
      .toEqual({ roleArn: "arn:aws:iam::123456789012:role/platform", isCustom: false });
    expect(resolveExecutionRoleArn({ custom: undefined, fallback: "arn:aws:iam::123456789012:role/platform", missingMessage: "m" }).isCustom).toBe(false);
    expect(() => resolveExecutionRoleArn({ custom: "bad", fallback: "x", missingMessage: "m" })).toThrow(ExecRoleRejected);
    expect(() => resolveExecutionRoleArn({ custom: "", fallback: "", missingMessage: "未指定执行角色:请在作业高级参数填写执行角色 ARN,或部署配置 GLUE_ROLE_ARN" }))
      .toThrow("未指定执行角色:请在作业高级参数填写执行角色 ARN,或部署配置 GLUE_ROLE_ARN");
  });

  it("🔴 棘轮:`iam::\\d{12}:role` 正则在产品源码里只许出现在 lib/execution-role/resolve.ts", () => {
    const offenders = walk(SRC)
      .filter((f) => /iam::\\d\{12\}:role/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f))
      .filter((f) => f !== "lib/execution-role/resolve.ts");
    expect(offenders, `又长出一份 ARN 正则副本:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("🔴 接线:四个作业入口都经 resolveExecutionRoleArn 取角色(调用点字面,不只 import),自定义角色都走 preflightExecutionRole", () => {
    for (const f of ["lib/etl/job-service.ts", "lib/sync/start-run.ts", "lib/realtime/flink-service.ts", "lib/engines/emr/provider.ts", "lib/engines/emr/schedule-fanout.ts"]) {
      const src = read(f);
      expect(src, `${f} 缺 import resolveExecutionRoleArn`).toContain('from "@/lib/execution-role/resolve"');
      expect(src, `${f} 没有调用 resolveExecutionRoleArn(`).toMatch(/resolveExecutionRoleArn\(\{/);
      expect(src, `${f} 没有调用 preflightExecutionRole(`).toMatch(/await preflightExecutionRole\(\{/);
      expect(src, `${f} 还留着自己的「自定义优先 || 回退」写法`).not.toMatch(/customRole \|\| (landing\.|ctx\.)/);
    }
  });

  it("🔴 接线:两条 ETL 保存路由 + 两条 Flink 路由在落库前调 preflightCustomRoleForTargets;Flink 路由形态校验走 roleArnShapeRejection", () => {
    for (const f of ["app/api/etl-jobs/route.ts", "app/api/etl-jobs/[id]/route.ts", "app/api/flink/jobs/route.ts", "app/api/flink/jobs/[id]/route.ts"]) {
      const src = read(f);
      expect(src, `${f} 没有调用 preflightCustomRoleForTargets(`).toMatch(/await preflightCustomRoleForTargets\(\{/);
    }
    for (const f of ["app/api/flink/jobs/route.ts", "app/api/flink/jobs/[id]/route.ts"]) {
      expect(read(f)).toMatch(/roleArnShapeRejection\(/);
    }
    // ETL 新建:预检在 PutCommand 之前(落库前拒)
    const post = read("app/api/etl-jobs/route.ts");
    expect(post.indexOf("preflightCustomRoleForTargets({")).toBeLessThan(post.indexOf("new PutCommand("));
    const put = read("app/api/etl-jobs/[id]/route.ts");
    expect(put.indexOf("preflightCustomRoleForTargets({")).toBeLessThan(put.indexOf("new UpdateCommand("));
  });

  it("B-140:依赖上传按作业绑定的每个落点各传一份(resolveGlueBinding + s3ClientFor),不再读 GLUE_SCRIPTS_BUCKET;提交侧按区换桶", () => {
    const deps = read("app/api/etl-jobs/[id]/deps/route.ts");
    expect(deps).not.toContain("GLUE_SCRIPTS_BUCKET");
    expect(deps).toMatch(/for \(const targetId of targets\)/);
    expect(deps).toMatch(/await resolveGlueBinding\(\{ targetId \}\)/);
    expect(deps).toMatch(/await s3ClientFor\(landing\.region\)/);
    expect(deps).toContain("PLATFORM_DEP_KEY_PREFIX");
    const js = read("lib/etl/job-service.ts");
    expect(js).toMatch(/localizePlatformDepUris\(cfg\.extraJars, landing\)/);
    expect(js).toMatch(/localizePlatformDepUris\(cfg\.extraPyFiles, landing\)/);
  });
});
