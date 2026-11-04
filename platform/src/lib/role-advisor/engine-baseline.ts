// 「引擎 × 必备权限」—— **唯一真值源**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴🔴 这个文件是 2026-09-22 那次事故的根治(用户在 copilot 建的 ROI 作业上撞到):
//
// 用户原话:「这种能力我认为需要加入到配方库里面,不能我每次都需要手动处理这种错误。」
//          「**他需要知道这种任务需要添加哪些权限**,而不是报错了之后我通过你改源代码重新发布解决问题。」
//
// 【事故】copilot 在作业规格里填了角色顾问一键建出来的角色,一跑就:
//   AccessDenied: s3:PutObject on ".../emr-logs/<jobId>/.../job-metadata.log"
// 逐层查实,那个角色**一条 S3 语句都没有**,而且 CloudWatch 那条写死指向 `/aws-glue/*`(Glue 的日志组)。
//
// 【真根】`policy-builder.ts` 把权限**全部**交给调用方的「资源画像」(`s3Buckets` 等)决定;
//   调用方没填 ⇒ 它只往 `cautions` 里塞一句提示文字,**然后照样把角色建出来**。
//   ⇒ 「引擎自己跑起来就必须有的那些权限」在代码里**没有任何地方声明过** ——
//     它既不在授权侧,也不在配方里,只活在 CDK 那个默认角色的实现细节里。
//   (平台自动路径一直好的,正因为它用的是 CDK 建的 `bgp-emr-serverless-role`;
//    角色顾问这条路从诞生起就缺,而它从来没被真跑验过 —— 本仓元 bug「机制早就建好,只是那条路径没接」。)
//
// 【根治的形状】把「这类任务必须有哪些权限」变成**一份机器可读的声明**,四个消费者共用它:
//   ① `policy-builder.ts`  —— 建角色时**无条件**并进去(不由调用方的画像决定,画像只负责**额外**收敛);
//   ② `provisioner.ts`     —— 已存在的角色也**对账补齐**(原来是「存在就跳过」⇒ 坏角色永远修不好);
//   ③ 作业启动前的**预检** —— 缺哪条当场说清 + 给出路,而不是等 AccessDenied;
//   ④ **配方库** `cookbook/seed/emr.ts` —— 从本文件派生文案,让 copilot/planner 生成时就知道要什么权限。
//   🔴 四个消费者、一份声明。加一条必备权限只改这里,四处同时生效。
//
// 【封闭判据(写在这里,免得下次又退化)】
//   **角色顾问建出来的角色,必须至少能跑通平台默认角色能跑通的那件事。**
//   一键创建产出一个「比平台默认角色更不能用」的角色,就是缺陷 —— 不是「最小权限」。
// ══════════════════════════════════════════════════════════════════════════════

import { homeRegion } from "@/lib/place/home-region";
import type { PolicyStatement, RoleEngine } from "./types";
import { EMR_LOG_PREFIX, emrLogBucket, emrScriptBucket } from "../engines/emr/log-destination";

export interface BaselineCtx {
  region: string;
  accountId: string;
  /** 日志落点桶(EMR:平台数据湖桶)。缺省从 `engines/emr/log-destination` 派生。 */
  logBucket?: string;
  /** 脚本桶(引擎要读的入口脚本 / runtime jar)。缺省同上。 */
  scriptBucket?: string;
}

/** 一条**必备**权限:它不由调用方的资源画像决定,是「这个引擎跑起来就得有」。 */
export interface BaselineNeed {
  sid: string;
  actions: string[];
  resources: string[];
  /** 人读理由 —— 界面、配方、预检报错**共用这一句**(不许各写一遍)。 */
  why: string;
  /**
   * 预检探针:拿这一条去 `SimulatePrincipalPolicy`。
   * 🔴 探针必须是**这条权限最要紧的那个动作 + 一个具体资源**;用 `*` 探不出资源面写窄了的情况。
   */
  probe: { action: string; resource: string };
}

/**
 * 各引擎自己的 CloudWatch 日志组。
 * 🔴🔴 原来 `policy-builder` 对**所有**引擎都写 `/aws-glue/*` —— EMR / Flink / DMS 根本不用那个组,
 *   于是「看起来给了日志权限」而实际一条也没给。这是「有静默合法默认值的参数 = 一整类缺陷」的又一例:
 *   一个对 Glue 正确的默认值,套到别的引擎上就是**静默错误**。
 */
const CW_LOG_GROUP: Record<RoleEngine, string> = {
  glue: "/aws-glue/*",
  emr: "/aws/emr-serverless/*",
  flink: "/aws/kinesis-analytics/*",
  dms: "dms-tasks-*",
};

const S3_READ = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketLocation"];
const S3_WRITE = [
  "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation",
  // 🔴 分片上传三件套不能省:Spark 写大文件走 multipart,少了它 `PutObject` 过了照样失败。
  "s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts",
];

function ctxOf(c: BaselineCtx) {
  return {
    region: c.region,
    accountId: c.accountId,
    logBucket: c.logBucket || emrLogBucket(),
    scriptBucket: c.scriptBucket || emrScriptBucket(),
  };
}

/** 该引擎的**必备**权限清单(机器可读)。 */
export function engineBaseline(engine: RoleEngine, ctx: BaselineCtx): BaselineNeed[] {
  const { region, accountId, logBucket, scriptBucket } = ctxOf(ctx);
  const needs: BaselineNeed[] = [];

  // ── ① 引擎自己的日志组(逐引擎不同,见 CW_LOG_GROUP 的整段理由)────────────────
  const group = CW_LOG_GROUP[engine];
  needs.push({
    sid: "BaselineCloudWatchLogs",
    actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
    resources: [`arn:aws:logs:${region}:${accountId}:log-group:${group}`,
                `arn:aws:logs:${region}:${accountId}:log-group:${group}:*`],
    why: `写作业运行日志到 CloudWatch(${engine} 用的是 ${group} 这个日志组 —— 各引擎的组名不同,给错等于没给)`,
    probe: { action: "logs:PutLogEvents", resource: `arn:aws:logs:${region}:${accountId}:log-group:${group.replace("*", "probe")}:*` },
  });

  if (engine === "emr") {
    // ── ② EMR 读入口脚本 / 平台注入的 runtime jar ───────────────────────────
    needs.push({
      sid: "BaselineEmrScriptRead",
      actions: S3_READ,
      resources: [`arn:aws:s3:::${scriptBucket}`, `arn:aws:s3:::${scriptBucket}/*`],
      why: `读 PySpark 入口脚本与平台注入的 runtime jar(都在脚本桶 ${scriptBucket});少了它作业连代码都拉不到`,
      probe: { action: "s3:GetObject", resource: `arn:aws:s3:::${scriptBucket}/emr-scripts/probe.py` },
    });
    // ── ③ 🔴 **日志落点**:事故就出在这一条上 ───────────────────────────────
    needs.push({
      sid: "BaselineEmrLogDestination",
      actions: S3_WRITE,
      resources: [
        `arn:aws:s3:::${logBucket}`,
        `arn:aws:s3:::${logBucket}/${EMR_LOG_PREFIX}/*`,
      ],
      why: `EMR Serverless **用作业执行角色**把 job-metadata / driver / executor 日志写到 `
        + `s3://${logBucket}/${EMR_LOG_PREFIX}/ —— 少了它作业起步就 AccessDenied,`
        + `而报错里不会提示「缺日志落点写权限」(2026-09-22 真实事故)`,
      probe: { action: "s3:PutObject", resource: `arn:aws:s3:::${logBucket}/${EMR_LOG_PREFIX}/probe/job-metadata.log` },
    });
    // ── ④ 平台数据湖桶的读写(输入/中间/结果都落这里)─────────────────────────
    //   🔴 为什么算**必备**而不是等调用方填:封闭判据「一键建出来的角色不该比平台默认角色更不能用」。
    //   调用方额外提供的桶由 `policy-builder` 的资源画像再加,不与本条冲突。
    needs.push({
      sid: "BaselineEmrDatalake",
      actions: S3_WRITE,
      resources: [`arn:aws:s3:::${logBucket}`, `arn:aws:s3:::${logBucket}/*`],
      why: `读写平台数据湖桶 ${logBucket}(Spark 的输入 / 中间结果 / 输出)——平台默认执行角色本来就有这一条,`
        + `一键创建产出的角色不该比它更不能用`,
      probe: { action: "s3:PutObject", resource: `arn:aws:s3:::${logBucket}/warehouse/probe/part-0` },
    });
    // ── ④bis 读该区 Redshift 的凭证(2026-09-22 第九层)────────────────────────
    //   🔴 IAM 放行 `redshift-data:*` **不等于**库里有授权:不带 `SecretArn` 时 Data API 用调用者
    //     IAM 身份派生临时库用户,那个用户没有任何 GRANT ⇒ `permission denied for database dev`。
    //     平台权威口径是带 `SecretArn`(统一执行身份,表属主一致)⇒ 角色必须能**读到那个 secret**。
    needs.push({
      sid: "BaselineRedshiftCredential",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      resources: [
        `arn:aws:secretsmanager:${region}:${accountId}:secret:redshift!*`,
        `arn:aws:secretsmanager:${region}:${accountId}:secret:bgp/*`,
      ],
      why: "读该区 Redshift 的统一执行凭证(`redshift!bgp-namespace-admin` 之类)——"
        + "redshift-data 不带 SecretArn 会用没有授权的临时库用户,报 `permission denied for database dev`",
      probe: { action: "secretsmanager:GetSecretValue", resource: `arn:aws:secretsmanager:${region}:${accountId}:secret:redshift!probe-AbCdEf` },
    });
    // ── ⑤ VPC 接入:平台建的 EMR application 默认挂私有子网 ───────────────────
    needs.push({
      sid: "BaselineEmrVpcEni",
      actions: [
        "ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface",
        "ec2:CreateNetworkInterfacePermission", "ec2:DescribeNetworkInterfacePermissions",
        "ec2:DescribeSubnets", "ec2:DescribeVpcs", "ec2:DescribeSecurityGroups", "ec2:DescribeDhcpOptions",
      ],
      resources: ["*"],
      why: "平台建的 EMR Serverless application 挂在**私有子网**里(出网经 NAT);"
        + "挂 VPC 需要执行角色能管 ENI,少了它作业会卡在启动阶段",
      probe: { action: "ec2:CreateNetworkInterface", resource: "*" },
    });
  }

  if (engine === "glue") {
    needs.push({
      sid: "BaselineGlueScriptRead",
      actions: S3_READ,
      resources: [`arn:aws:s3:::${scriptBucket}`, `arn:aws:s3:::${scriptBucket}/*`],
      why: `读 Glue 作业脚本(脚本桶 ${scriptBucket})`,
      probe: { action: "s3:GetObject", resource: `arn:aws:s3:::${scriptBucket}/scripts/probe.py` },
    });
    needs.push({
      sid: "BaselineGlueDatalake",
      actions: S3_WRITE,
      resources: [`arn:aws:s3:::${logBucket}`, `arn:aws:s3:::${logBucket}/*`],
      why: `读写平台数据湖桶 ${logBucket}(Glue 的输入/输出/临时目录)`,
      probe: { action: "s3:PutObject", resource: `arn:aws:s3:::${logBucket}/temp/probe` },
    });
  }

  return needs;
}

/** 必备权限 → IAM 语句(给 `policy-builder` / `provisioner` 用)。 */
export function baselineStatements(engine: RoleEngine, ctx: BaselineCtx): PolicyStatement[] {
  return engineBaseline(engine, ctx).map((n) => ({
    Sid: n.sid, Effect: "Allow" as const, Action: n.actions, Resource: n.resources,
  }));
}

/** 必备权限 → 预检探针(给作业启动前的 `SimulatePrincipalPolicy` 用)。 */
export function baselineProbes(engine: RoleEngine, ctx: BaselineCtx): { sid: string; action: string; resource: string; why: string }[] {
  return engineBaseline(engine, ctx).map((n) => ({ sid: n.sid, ...n.probe, why: n.why }));
}

/**
 * 必备权限 → **人读清单**(界面提示 / 配方库 / 预检报错共用)。
 * 🔴 配方库刻意从这里派生文案,不另写一份 —— 两份文案就会有一份过期(本仓老账)。
 */
export function baselineSummaryLines(engine: RoleEngine, ctx?: Partial<BaselineCtx>): string[] {
  const c: BaselineCtx = {
    // L4 过渡:语义是缺省回落主控区(静默默认值类),序 6 再按落点改
    region: ctx?.region || homeRegion(),
    accountId: ctx?.accountId || process.env.AWS_ACCOUNT_ID || "<账号>",
    logBucket: ctx?.logBucket,
    scriptBucket: ctx?.scriptBucket,
  };
  return engineBaseline(engine, c).map(
    (n) => `【${n.sid}】${n.actions.slice(0, 4).join(" / ")}${n.actions.length > 4 ? " …" : ""}`
      + ` → ${n.resources.join(" , ")}:${n.why}`
  );
}
