// 数据面长作业(durable async job)的**表形态常量** —— 唯一作者(④-1 / 52 SPEC §1 `bgp-dataplane-jobs`)。
//
// 🔴 **本文件必须零 node 内置依赖**:推进泵(`pump.ts`)挂在周期 reconciler 上,而 reconciler 在
//    `instrumentation.ts` 的可达面里 —— 那个图会被 Next 编进 **edge** bundle,碰到 `crypto` 就构建失败
//    (门禁 `instrumentation-bundle-guard.test.ts`,事故经过见其文件头)。所以确定性 jobId 的 sha256
//    住在 `model.ts`(泵不 import 它),这里只放泵与 store **都要用**的那几个名字。
//
// ── 表形态 ──────────────────────────────────────────────────────────────────────
//   基表   pk = jobId(确定性:同一件事算出同一个 id ⇒ 重复入队天然幂等,见 model.dataplaneJobId)
//   GSI ①  byDue    (dueShard S, nextRunAt N)  —— 🔴 **稀疏**:只有未终态的作业带 `dueShard`,
//                     终态时 REMOVE ⇒ 泵每轮一次 Query 就拿到「到期且未终态」的那几条,不 Scan。
//   GSI ②  byTarget (targetId S, createdAt S)  —— 某个执行环境下的作业清单(页面 / 前置判据 删除预检)。
import { TABLES } from "@/lib/aws/dynamodb";

export const DATAPLANE_JOBS_TABLE = (): string => TABLES.DATAPLANE_JOBS;

export const GSI_BY_DUE = "byDue";
export const GSI_BY_TARGET = "byTarget";

/** 稀疏 GSI 的分区值(只有一个分区:未终态作业的量级是「项目 × 区」,远到不了需要分片)。 */
export const DUE_SHARD = "due";

/** 作业种类(封闭集合;9a 只实现前两类,其余由 9b / 9c 落地时加 handler)。 */
// + `reclaim`:删项目后回收该项目在各执行区的 per-project 凭证 secret
//   (一区一条,确定性 id;handler 在 `lib/exec-env/project-cred-reclaim.ts`)。
// + `sg-cleanup`:删数据源 / 建源失败清理后,平台自建安全组 `bgp-ds-*` 按网卡事实收口的持久清理
//   (handler 在 `lib/datasource/sg-cleanup-job.ts`;原来是进程内存里 10 × 30 秒的定时重试,耗尽即永久遗留)。
export const JOB_KINDS = ["supply", "canary", "reclaim", "sg-cleanup"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** 作业阶段。🔴 前三个是「未终态」(带 dueShard),后两个是终态(dueShard 被 REMOVE)。 */
export const JOB_PHASES = ["queued", "running", "waiting", "succeeded", "failed"] as const;
export type JobPhase = (typeof JOB_PHASES)[number];
export const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>(["succeeded", "failed"]);

/** 内部推进端点(泵回环 POST 它;页面「立即推进」走同一份 runner 逻辑)。 */
export const STEP_ENDPOINT_PATH = "/api/internal/dataplane-jobs/step";
/** 内部「补齐入队」端点(绑定即自动供给:泵定期调,扫在用项目 → 缺作业就入队)。 */
export const SWEEP_ENDPOINT_PATH = "/api/internal/dataplane-jobs/sweep";

/**
 * 🔴 停泵开关:`BGP_DATAPLANE_JOBS_PAUSED=1`。
 *   · 泵不再取作业、不再回环调用;
 *   · 内部端点与「立即推进」一律 503(不是静默成功);
 *   · **入队照常**(作业停在 queued,恢复后继续)—— 停泵是「先别动」,不是「把请求吞掉」。
 * 只认字面 `1`:拼错不许变成「停了」以外的第三态。
 */
export function dataplaneJobsPaused(): boolean {
  return process.env.BGP_DATAPLANE_JOBS_PAUSED === "1";
}

/**
 * 「绑定即自动供给」的开关:`BGP_DATAPLANE_AUTO_SUPPLY=on` 才开(缺省关)。
 * 🔴 为什么缺省关(2026-10-真环境勘定):非主控区一旦查到某项目的 per-project secret,该项目在该区就**改用项目身份**
 *    (`data-plane-target.ts`),而项目身份只被授了 `proj_<id>` 与 `shared` —— 现网该区的数据全在 `public`、属主是 admin。
 *    ⇒ 部署后泵 10 分钟内给全部在用项目自动供给 = 这些项目在该区**当场读不到自己的表**(⑩-1 那条风险的真形态)。
 *    必须等 9b 的搬迁 / 只读授权(⑨-5)落地之后再开;在那之前供给只走人点名的〔供给凭证〕(一次一个项目,人看得见后果)。
 * 只认字面 `on`(与 `PER_PROJECT_CRED` 同形):拼错不许变成「开了」。
 */
export function dataplaneAutoSupplyEnabled(): boolean {
  return process.env.BGP_DATAPLANE_AUTO_SUPPLY === "on";
}
