// 序 38 B-68 —— 「按名字建 / 更新一个 Glue 作业」的唯一作者(同步作业 start-run.ts、数据源发现作业 glue-reach.ts 都走这里;
//   离线作业 etl/job-service.ts 早已是同一形状,本文件把它抽成可复用的函数)。
//
// 【缺陷原形(2026-10-13 客户生产环境)】同步作业原来「先 CreateJob,报 already exists 才 UpdateJob」:
//   作业已存在而**定义有变**(改 Glue 版本 / 改目标表桶 ⇒ --conf 变)时 Glue 回的是 IdempotentParameterMismatchException
//   「Job already submitted with different configuration」—— 不含 already exists ⇒ 掉进「最小参数重建」再撞同一错 ⇒ 保存 502 / 启动 500;
//   定义没变时 UpdateJob 失败又被 `catch {}` 吞掉 ⇒ 页面说保存成功、作业还是旧的。
// 【规则】GetJob 判存在 ⇒ 存在就 UpdateJob(失败**如实上抛**);不存在才 CreateJob;CreateJob 撞「已存在 / 幂等不匹配」
//   (GetJob 与 CreateJob 之间被别人建了)⇒ 按已存在走 UpdateJob。GetJob 的权限 / 限流 / 网络错原样抛 —— 不许把「没查到」当「不存在」去建。
//   🔴 没有「最小参数重建」这类静默降级([[silent-default-is-a-defect-class]])。
import { CreateJobCommand, UpdateJobCommand, GetJobCommand, type CreateJobCommandInput } from "@aws-sdk/client-glue";

/** 作业定义 = CreateJob 入参去掉 Name(UpdateJob 的 JobUpdate 与之同形)。 */
export type GlueJobDefinition = Omit<CreateJobCommandInput, "Name">;

/** 只要求 `send`(真客户端 / 判据里的假客户端都满足)。 */
export interface GlueSender {
  send(command: unknown): Promise<unknown>;
}

export type GlueJobUpsertOutcome = "created" | "updated";

export async function upsertGlueJob(glue: GlueSender, jobName: string, def: GlueJobDefinition): Promise<GlueJobUpsertOutcome> {
  if (await glueJobExists(glue, jobName)) {
    await glue.send(new UpdateJobCommand({ JobName: jobName, JobUpdate: def }));
    return "updated";
  }
  try {
    await glue.send(new CreateJobCommand({ Name: jobName, ...def }));
    return "created";
  } catch (e: unknown) {
    if (!isGlueJobAlreadyThere(e)) throw e;
    await glue.send(new UpdateJobCommand({ JobName: jobName, JobUpdate: def }));
    return "updated";
  }
}

/** 作业存在性:只有 Glue 明说「没有这个实体」才算不存在;别的错原样抛。 */
export async function glueJobExists(glue: GlueSender, jobName: string): Promise<boolean> {
  try {
    await glue.send(new GetJobCommand({ JobName: jobName }));
    return true;
  } catch (e: unknown) {
    if (isGlueEntityNotFound(e)) return false;
    throw e;
  }
}

export function isGlueEntityNotFound(e: unknown): boolean {
  const err = (e ?? {}) as { name?: string; message?: string };
  return err.name === "EntityNotFoundException" || /not found/i.test(String(err.message ?? ""));
}

/**
 * CreateJob 回「作业已经在了」的两种说法:AlreadyExistsException「already exists」(定义相同)与
 * IdempotentParameterMismatchException「Job already submitted with different configuration」(定义不同)。
 * 两种都意味着「存在 ⇒ 该走 UpdateJob」;后者正是 B-68 原来漏掉的那一种。导出供判据钉住这张清单。
 */
export function isGlueJobAlreadyThere(e: unknown): boolean {
  const err = (e ?? {}) as { name?: string; message?: string };
  const msg = String(err.message ?? "");
  return err.name === "AlreadyExistsException" || err.name === "IdempotentParameterMismatchException" || /already exists|already submitted/i.test(msg);
}
