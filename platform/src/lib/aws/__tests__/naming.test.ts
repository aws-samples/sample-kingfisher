// @kf-batch 50-P50.1a-naming-ssot
// 命名 SSOT 合同级单测(50 DESIGN §3.2 + SPEC §6.5 Q-2 / SPEC §1.1a / ACCEPTANCE E-15)。
//
// 【本文件的四条承重】
// ① **home 豁免 = infra 现网实名**:每个 kind 的 home 名必须在 infra/lib 的真源码里找得到。
//    这条是最要紧的 —— 若 naming.json 写的 home 名与 CDK 实际建的名字不一致,P50.2 给 home
//    seed 出来的描述符会指向**不存在的资源**,而且报错发生在很远的地方(读桶 404 / workgroup not found)。
// ② **non-home 必带 target 维**:同 region 两 target(蓝绿/主备)不许撞名 —— 这是 SPEC §6.5 Q-2
//    "允许同 region 多 target" 的直接推论,也是本批把派生键从 region 改成 targetSlug 的原因。
// ③ **fail-closed**:未登记 kind / 缺变量 / 残留占位符 / 超长 / 非法 targetId,一律抛,不返回猜的名字。
// ④ **被否决的方案留算术在案**:`region + slug` 双段会溢出 S3 的 63 —— 免得下一个人再提一遍。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  resourceName,
  execEnvStackName,
  homeSourceOf,
  RESOURCE_KINDS,
  NAMING_VERSION,
  NON_HOME_DIMENSION,
} from "@/lib/aws/naming";
import { HOME_TARGET_ID, HOME_TARGET_SLUG, toTargetSlug } from "@/lib/exec-env/target-id";
import namingConfig from "../../../../naming.json";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../.."); // .../platform/src/lib/aws/__tests__ → repo 根
const ACCOUNT = "123456789012";

/** 两个同 region 的 target(蓝绿):用来证明"同区不撞名"。 */
const T_A = "tgt_usw2_a";
const T_B = "tgt_usw2_b";

/** 合同允许的最长 targetId(SPEC §1.1a:`tgt_` + 正文 1–16,总长 ≤ 20)。 */
const LONGEST_TARGET = "tgt_" + "a".repeat(16);

type Rule = { scope: string; vars: string[]; home: string; target: string; maxLength: number; homeSource?: string };
const KINDS = namingConfig.kinds as unknown as Record<string, Rule>;

/** 需要 account 的 kind 才传 account;stackName 才传 component。 */
function varsFor(kind: string, targetId: string): Parameters<typeof resourceName>[1] {
  const rule = KINDS[kind];
  return {
    targetId,
    ...(rule.vars.includes("account") ? { account: ACCOUNT } : {}),
    ...(rule.vars.includes("component") ? { component: "core" } : {}),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 金标准快照(characterization)—— change-safety A3「改前先录下现在实际怎样」
//
// 为什么要把名字**再抄一遍**在测试里(看着冗余):
//   变异自检实测,只靠"去 infra 里找得到"这一条,改一个 home 名只红 1 条断言(判据要求 ≥2)。
//   金标准表提供**独立的第二个角度**:它不问"infra 里有没有",只问"是不是这几个字"。
//   两条一起,任何 home 名的改动都必然红 ≥2 —— 且这张表本身就是给人看的命名一览。
// 🔴 改这张表 = 改真实资源名,必须同时改 naming.json + infra + 台账,不许只顺手改测试。
// ══════════════════════════════════════════════════════════════════════════════
const GOLDEN_HOME: Record<string, string> = {
  datalakeBucket: `bgp-datalake-${ACCOUNT}`,
  scriptsBucket: `bgp-glue-scripts-${ACCOUNT}`,
  dagBucket: `bgp-mwaa-dags-${ACCOUNT}`,
  tableBucket: "bgp-table-bucket",
  athenaWorkgroup: "bgp-athena",
  redshiftWorkgroup: "bgp-workgroup",
  redshiftNamespace: "bgp-namespace",
  redshiftDatabase: "dev",
  mwaaEnvName: "bgp-mwaa",
  dmsInstanceId: "bgp-dms",
  dmsSubnetGroup: "bgp-dms-subnet-group",
  dmsSecurityGroup: "bgp-dms-sg",
  emrSecurityGroup: "bgp-emr-sg",
  flinkSourceStream: "bgp-flink-source",
  glueRole: "bgp-glue-role",
  flinkRole: "bgp-flink-role",
  emrServerlessRole: "bgp-emr-serverless-role",
  redshiftCopyRole: "bgp-redshift-copy-role",
  dmsKinesisRole: "bgp-dms-kinesis-role",
  // @kf-batch 50-WP13-mwaa-region:per-target MWAA 执行角色(home 的 MWAA 角色是 CDK 自动名,home 模板永不建,只为 SSOT 完整)
  mwaaRole: "bgp-mwaa-role",
  // @kf-batch 50-WP15-airflow-serverless:MWAA Serverless 入口(定义桶 + 执行角色;home 模板由施工序 2b 建)
  workflowBucket: `bgp-airflow-sls-${ACCOUNT}`,
  airflowServerlessRole: "bgp-airflow-sls-role",
  airflowServerlessSg: "bgp-airflow-sls-sg",
  // @kf-batch 50-W5-seg1-WP10a:residency-api 片 1 三样(home 法域永不建,home 模板只为 SSOT 完整)
  residencyAuditTable: "bgp-region-audit-home",
  residencyResultsTable: "bgp-region-results-home",
  residencyBucket: `bgp-region-results-${ACCOUNT}-home`,
  dataKeyAlias: "alias/bgp-data",
  logsKeyAlias: "alias/bgp-logs",
  redshiftAdminSecretName: "redshift!bgp-namespace-admin",
  stackName: "BgpExecEnv-tgt-home-core",
  // @kf-batch 50-WP31-seq5-dataplane-role:主控区平台数据面角色(新建,不是存量;建在平台栈)
  platformDataRole: "bgp-platform-data-role",
};

const GOLDEN_TARGET: Record<string, string> = {
  datalakeBucket: `bgp-datalake-${ACCOUNT}-tgt-usw2-a`,
  scriptsBucket: `bgp-glue-scripts-${ACCOUNT}-tgt-usw2-a`,
  dagBucket: `bgp-mwaa-dags-${ACCOUNT}-tgt-usw2-a`,
  tableBucket: "bgp-table-bucket-tgt-usw2-a",
  athenaWorkgroup: "bgp-athena-tgt-usw2-a",
  redshiftWorkgroup: "bgp-workgroup-tgt-usw2-a",
  redshiftNamespace: "bgp-namespace-tgt-usw2-a",
  redshiftDatabase: "dev",
  mwaaEnvName: "bgp-mwaa-tgt-usw2-a",
  dmsInstanceId: "bgp-dms-tgt-usw2-a",
  dmsSubnetGroup: "bgp-dms-subnet-group-tgt-usw2-a",
  dmsSecurityGroup: "bgp-dms-sg-tgt-usw2-a",
  emrSecurityGroup: "bgp-emr-sg-tgt-usw2-a",
  flinkSourceStream: "bgp-flink-source-tgt-usw2-a",
  glueRole: "BgpExecEnv-tgt-usw2-a-glue-role",
  flinkRole: "BgpExecEnv-tgt-usw2-a-flink-role",
  emrServerlessRole: "BgpExecEnv-tgt-usw2-a-emr-role",
  redshiftCopyRole: "BgpExecEnv-tgt-usw2-a-redshift-copy-role",
  dmsKinesisRole: "BgpExecEnv-tgt-usw2-a-dms-kinesis-role",
  // @kf-batch 50-WP13-mwaa-region
  mwaaRole: "BgpExecEnv-tgt-usw2-a-mwaa-role",
  platformDataRole: "BgpExecEnv-tgt-usw2-a-platform-data-role",
  // @kf-batch 50-WP15-airflow-serverless
  workflowBucket: `bgp-airflow-sls-${ACCOUNT}-tgt-usw2-a`,
  airflowServerlessRole: "BgpExecEnv-tgt-usw2-a-airflow-sls-role",
  airflowServerlessSg: "bgp-airflow-sls-sg-tgt-usw2-a",
  // @kf-batch 50-W5-seg1-WP10a
  residencyAuditTable: "bgp-region-audit-tgt-usw2-a",
  residencyResultsTable: "bgp-region-results-tgt-usw2-a",
  residencyBucket: `bgp-region-results-${ACCOUNT}-tgt-usw2-a`,
  dataKeyAlias: "alias/bgp-data-tgt-usw2-a",
  logsKeyAlias: "alias/bgp-logs-tgt-usw2-a",
  redshiftAdminSecretName: "redshift!bgp-namespace-tgt-usw2-a-admin",
  stackName: "BgpExecEnv-tgt-usw2-a-core",
};

/**
 * 🔴 各 scope 的 maxLength 必须**等于 AWS 服务真实上限**。
 * 变异自检实测:把 `maxLength: 63` 放宽到 200 时,没有任何断言变红 —— 因为生成名本来才 50 字,
 * 长度门禁被架空却查不出来。⇒ 门禁自身的**取值**也必须是合同,不能只在越界时才被间接检查。
 */
const SCOPE_LIMIT: Record<string, number> = {
  "s3-global": 63, // S3 桶名 3–63
  "account-region": -1, // 逐 kind 不同(见 KIND_LIMIT)
  namespace: 64,
  vpc: 255, // SG 名 255
  "iam-global": 64, // IAM 角色名 64
  cfn: 128, // CFN 栈名 128
  "kms-alias": 256, // KMS 别名 alias/ + 250
};
const KIND_LIMIT: Record<string, number> = {
  // @kf-batch 50-W5-seg1-WP10a:DynamoDB 表名上限 255(区域审计表 / 结果表)
  residencyAuditTable: 255,
  residencyResultsTable: 255,
  tableBucket: 63, // S3 Tables 表桶名 3–63
  athenaWorkgroup: 128,
  redshiftWorkgroup: 64,
  redshiftNamespace: 64,
  mwaaEnvName: 80,
  dmsInstanceId: 60, // DMS 复制实例标识符 60
  dmsSubnetGroup: 255,
  flinkSourceStream: 128, // Kinesis 流名 128
  redshiftAdminSecretName: 512, // Secrets Manager 名 512
};

describe("命名 SSOT 表本身(加载期自检已在 import 时跑过)", () => {
  it("版本存在、kind 非空、派生键是 targetSlug(不是 region/cellId)", () => {
    expect(NAMING_VERSION).toBeGreaterThanOrEqual(1);
    expect(RESOURCE_KINDS.length).toBeGreaterThan(10);
    expect(NON_HOME_DIMENSION).toBe("targetSlug");
  });

  it("每个 kind 都有 home / target / maxLength / vars 四件套", () => {
    for (const kind of RESOURCE_KINDS) {
      const r = KINDS[kind];
      expect(typeof r.home, kind).toBe("string");
      expect(typeof r.target, kind).toBe("string");
      expect(Array.isArray(r.vars), kind).toBe(true);
      expect(r.maxLength, kind).toBeGreaterThan(0);
    }
  });

  it("🔴 每个 kind 的 maxLength = AWS 服务真实上限(门禁自身的取值也是合同)", () => {
    for (const kind of RESOURCE_KINDS) {
      const r = KINDS[kind];
      const expected = KIND_LIMIT[kind] ?? SCOPE_LIMIT[r.scope];
      expect(expected, `${kind}(scope=${r.scope})没有登记期望上限`).toBeGreaterThan(0);
      expect(r.maxLength, `${kind} 的 maxLength 被改动 ⇒ 长度门禁会被架空`).toBe(expected);
    }
  });

  it("🔴 桶类 maxLength 的 63 来自 registry §3.1a 的桶名形态校验(跨模块同一上限,独立来源)", () => {
    // 独立于上面那张 SCOPE_LIMIT 手抄表:直接从已被审核过的描述符校验器里把上限**算出来**。
    // registry.ts: bucket: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/ ⇒ 1 + 61 + 1 = 63。
    const reg = readFileSync(resolve(REPO, "platform/src/lib/exec-env/registry.ts"), "utf8");
    const m = reg.match(/bucket:\s*\/\^\[a-z0-9\]\[a-z0-9\.-\]\{1,(\d+)\}\[a-z0-9\]\$\//);
    expect(m, "registry.ts 的 SHAPE.bucket 形态变了 —— 两处上限必须一起改").not.toBeNull();
    const impliedMax = 1 + Number(m![1]) + 1;
    expect(impliedMax).toBe(63);
    for (const kind of RESOURCE_KINDS) {
      if (KINDS[kind].scope !== "s3-global" && kind !== "tableBucket") continue;
      expect(KINDS[kind].maxLength, `${kind} 的上限须与 registry 桶名形态同源`).toBe(impliedMax);
    }
  });

  it("🔴 金标准:全部 kind 的 home 名逐字对上(独立于『infra 里找得到』的第二个角度)", () => {
    const actual: Record<string, string> = {};
    for (const kind of RESOURCE_KINDS) actual[kind] = resourceName(kind, varsFor(kind, HOME_TARGET_ID));
    expect(actual).toEqual(GOLDEN_HOME);
  });

  it("🔴 金标准:全部 kind 的 non-home 名逐字对上(tgt_usw2_a)", () => {
    const actual: Record<string, string> = {};
    for (const kind of RESOURCE_KINDS) actual[kind] = resourceName(kind, varsFor(kind, T_A));
    expect(actual).toEqual(GOLDEN_TARGET);
  });

  it("🔴 Redshift 托管 admin secret 名必须与 namespace 名**保持派生**(它是服务生成规则,不是我们取的名)", () => {
    for (const t of [HOME_TARGET_ID, T_A, LONGEST_TARGET]) {
      const ns = resourceName("redshiftNamespace", { targetId: t });
      expect(resourceName("redshiftAdminSecretName", { targetId: t }), `target=${t}`).toBe(`redshift!${ns}-admin`);
    }
  });

  it("🔴 声明的派生键与实际行为一致:non-home 名带 slug、且**不含** region 串", () => {
    expect(NON_HOME_DIMENSION).toBe("targetSlug");
    const region = "us-west-2";
    for (const kind of RESOURCE_KINDS) {
      const name = resourceName(kind, { ...varsFor(kind, T_A), region });
      expect(name, `${kind} 不该把 region 拼进名字(派生键是 ${NON_HOME_DIMENSION})`).not.toContain(region);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 承重 ① home 豁免 = infra 现网实名(不是"理论上该叫什么")
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 home 豁免逐个对上 infra/lib 真源码(对不上 ⇒ P50.2 seed 出指向不存在资源的描述符)", () => {
  // homeSource 里的**行号只作人工导航用**,断言只看文件内容 —— 行号漂移不该让门禁变红。
  const cases = RESOURCE_KINDS.filter((k) => (homeSourceOf(k) ?? "").startsWith("infra/"));

  it("绝大多数 kind 都登记了 infra 出处(未登记的必须是 stackName 这类新栈)", () => {
    const unregistered = RESOURCE_KINDS.filter((k) => !(homeSourceOf(k) ?? "").startsWith("infra/"));
    expect(unregistered).toEqual(["stackName"]);
  });

  for (const kind of cases) {
    it(`${kind}:home 名在 ${homeSourceOf(kind)} 找得到`, () => {
      const src = homeSourceOf(kind)!.split(":")[0];
      const text = readFileSync(resolve(REPO, src), "utf8");
      const rule = KINDS[kind];
      const homeName = resourceName(kind, varsFor(kind, HOME_TARGET_ID));

      // @kf-batch 50-P50.1-workgroup-ssot
      // 🔴 **第三种形态:infra 侧改为从命名 SSOT 派生**(`resourceName("<kind>", …)`)。
      // 这不是把门禁放宽,而是比原判据**更强**:原判据只是"两边的文本恰好一样",
      // 派生则是**同一个真值源**,结构上不可能漂移。所以先认派生,再退回字面量比对。
      const derives = new RegExp(`resourceName\\(\\s*["'\`]${kind}["'\`]`).test(text);
      if (derives) {
        // 🔴 这里断的**不是**"派生结果等于登记值"—— 那会是同义反复(homeName 就是从 rule.home 算出来的)。
        //    真正要防的是「**派生与硬编码并存**」:infra 里同时留着旧字面量,
        //    改 naming.json 只改到一半、另一半仍按旧名建资源(比全硬编码更难查)。
        //    "登记值 == 存量实名"这件事另由本文件的 GOLDEN_HOME 金标准表独立钉住。
        if (!rule.home.includes("{")) {
          expect(
            text.includes(`"${homeName}"`),
            `${kind} 在 ${src} 里既走 resourceName 派生、又留着硬编码 "${homeName}" —— 二者必须只留派生`
          ).toBe(false);
        }
      } else if (rule.home.includes("{account}")) {
        // CDK 侧写的是模板串(前缀 + 账号插值)—— 断言前缀形态在,而不是断插值后的字面量。
        const prefix = rule.home.replace("-{account}", "");
        expect(text, `${kind} 的模板前缀 ${prefix} 应出现在 ${src}`).toContain(prefix + "-$" + "{");
        expect(homeName).toBe(`${prefix}-${ACCOUNT}`);
      } else {
        expect(text, `${kind} 的字面量 "${homeName}" 应出现在 ${src}`).toContain(`"${homeName}"`);
      }
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 承重 ② non-home 必带 target 维:同 region 两 target 不许撞名
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 同 region 两 target 不撞名(SPEC §6.5 Q-2 允许同区蓝绿/主备)", () => {
  // redshiftDatabase 刻意例外:库名在 namespace 内作用域,每 target 各有 namespace ⇒ 同名不撞。
  const SCOPED_EXEMPT = ["redshiftDatabase"];

  for (const kind of RESOURCE_KINDS) {
    it(`${kind}:tgt_usw2_a 与 tgt_usw2_b ${SCOPED_EXEMPT.includes(kind) ? "同名(namespace 内作用域,已登记例外)" : "必须不同名"}`, () => {
      const a = resourceName(kind, varsFor(kind, T_A));
      const b = resourceName(kind, varsFor(kind, T_B));
      if (SCOPED_EXEMPT.includes(kind)) expect(a).toBe(b);
      else expect(a).not.toBe(b);
    });
  }

  it("🔴 non-home 名一律含 slug(除已登记的作用域例外)", () => {
    for (const kind of RESOURCE_KINDS) {
      if (SCOPED_EXEMPT.includes(kind)) continue;
      expect(resourceName(kind, varsFor(kind, T_A)), kind).toContain(toTargetSlug(T_A));
    }
  });

  it("home 名一律**不含** slug(豁免的意义就是沿用存量名),栈名除外", () => {
    for (const kind of RESOURCE_KINDS) {
      const name = resourceName(kind, varsFor(kind, HOME_TARGET_ID));
      if (kind === "stackName") {
        // 执行环境栈组在 home 上是**全新栈**,没有存量要豁免 ⇒ 照样带 slug。
        expect(name).toContain(HOME_TARGET_SLUG);
      } else {
        expect(name, `${kind} 的 home 名不该带 slug`).not.toContain(HOME_TARGET_SLUG);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 承重 ③ fail-closed
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 fail-closed:宁可抛,也不返回猜的名字", () => {
  it("未登记的 kind ⇒ 抛,且错误里列出已登记清单", () => {
    expect(() => resourceName("somethingNew", { targetId: T_A })).toThrow(/未登记的资源类别/);
  });

  it("缺 targetId ⇒ 抛(home 判定不接受调用方传参,只能由 targetId 导出)", () => {
    expect(() => resourceName("datalakeBucket", { targetId: "" })).toThrow(/缺 targetId/);
    expect(() => resourceName("datalakeBucket", {} as never)).toThrow(/缺 targetId/);
  });

  it("🔴 调用方伪造 isHome 不起作用(没有这个入口 —— 传了也被忽略)", () => {
    const forged = resourceName("redshiftWorkgroup", { targetId: T_A, isHome: true } as never);
    expect(forged, "非 home target 不该拿到 home 存量名").toBe(`bgp-workgroup-${toTargetSlug(T_A)}`);
    expect(forged).not.toBe("bgp-workgroup");
  });

  it("S3 kind 缺 account / account 非 12 位 ⇒ 抛(不拼出 `bgp-datalake--slug`)", () => {
    expect(() => resourceName("datalakeBucket", { targetId: T_A })).toThrow(/需要 12 位 account/);
    expect(() => resourceName("datalakeBucket", { targetId: T_A, account: "12345" })).toThrow(/需要 12 位 account/);
  });

  it("stackName 缺 component / component 畸形 ⇒ 抛", () => {
    expect(() => resourceName("stackName", { targetId: T_A })).toThrow(/需要合法 component/);
    expect(() => resourceName("stackName", { targetId: T_A, component: "Core!" })).toThrow(/需要合法 component/);
  });

  it("🔴 非法 targetId ⇒ 抛(而不是把非法串塞进真实资源名)", () => {
    for (const bad of ["tgt-usw2-a", "tgt_a_", "usw2", "TGT_A", "tgt_" + "a".repeat(17)]) {
      expect(() => resourceName("redshiftWorkgroup", { targetId: bad }), bad).toThrow();
    }
  });

  it("🔴 插值后不许残留占位符(裂缝B 教训:带 `{` 的名字进真实资源比报错难查一个量级)", () => {
    // 用一个"声明了 account 却不传"的路径反证:它在 account 校验处就被拦下,永远走不到残留占位符。
    // 残留占位符这条防线本身由 naming.json 的加载期自检 + 下面这条不变量共同保证。
    for (const kind of RESOURCE_KINDS) {
      for (const t of [HOME_TARGET_ID, T_A]) {
        const name = resourceName(kind, varsFor(kind, t));
        expect(name, `${kind}/${t}`).not.toMatch(/[{}]/);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 承重 ④ 长度算术:最长 slug 也不超限;并把"被否决的 region+slug 双段"留在案
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 长度不变量(S3 桶名 63 是硬上限,超了是部署期才炸)", () => {
  it("最长合法 targetId 下,每个 kind 都不超它自己的 maxLength", () => {
    for (const kind of RESOURCE_KINDS) {
      const name = resourceName(kind, varsFor(kind, LONGEST_TARGET));
      expect(name.length, `${kind} = ${name}`).toBeLessThanOrEqual(KINDS[kind].maxLength);
    }
  });

  it("S3 类 kind 在最长 slug 下 ≤ 63", () => {
    for (const kind of RESOURCE_KINDS) {
      if (KINDS[kind].scope !== "s3-global") continue;
      expect(resourceName(kind, varsFor(kind, LONGEST_TARGET)).length, kind).toBeLessThanOrEqual(63);
    }
  });

  it("🔴 被否决方案留证:`bgp-<用途>-<acct>-<region>-<slug>` 双段会溢出 63(所以派生键只能取一个)", () => {
    const prefix = "bgp-glue-scripts-"; // 17
    const longestRegion = "ap-southeast-4"; // 14(us-gov-east-1 = 13)
    const longestSlug = toTargetSlug(LONGEST_TARGET); // 20
    const hybrid = `${prefix}${ACCOUNT}-${longestRegion}-${longestSlug}`;
    expect(hybrid.length).toBe(65);
    expect(hybrid.length).toBeGreaterThan(63);
    // 而只取 slug 一段是安全的:
    expect(`${prefix}${ACCOUNT}-${longestSlug}`.length).toBe(50);
  });
});

describe("execEnvStackName 出口", () => {
  it("home / 非 home 都是 BgpExecEnv-<slug>-<component>,且与控制面存量栈名零相交", () => {
    expect(execEnvStackName(HOME_TARGET_ID, "core")).toBe(`BgpExecEnv-${HOME_TARGET_SLUG}-core`);
    expect(execEnvStackName(T_A, "redshift")).toBe(`BgpExecEnv-${toTargetSlug(T_A)}-redshift`);
    // 存量 21 栈都是 Bgp<Name>Stack 形态,不带 `BgpExecEnv-` 前缀 ⇒ 天然不相交(synth 门禁在 P50.2 补真扫)。
    expect(execEnvStackName(T_A, "core").startsWith("BgpExecEnv-")).toBe(true);
  });

  it("生成的栈名是合法 CFN 栈名(`[a-zA-Z][-a-zA-Z0-9]*`,不含下划线)", () => {
    for (const t of [HOME_TARGET_ID, T_A, LONGEST_TARGET]) {
      expect(execEnvStackName(t, "core")).toMatch(/^[a-zA-Z][-a-zA-Z0-9]*$/);
    }
  });
});
