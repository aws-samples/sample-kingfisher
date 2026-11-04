// Redshift Data API 的**两段式原语**:提交(拿 statementId 立即返回)/ 读终态(一次 Describe)。
//
// 🔴 为什么不复用 `target-clients.execOnTarget`:那是「提交 + 原地轮询到终态(≤~3 分钟)」的同步形态,
//    一个请求里跑 N 个项目 × ~10 条语句,跨区就撞 ALB 504(② 第 2/3 行)。作业化之后,
//    一步只做「提交」或「读一次终态」,statementId 记在作业行上,下一步(可能在另一个副本、
//    进程重启之后)接着读 —— 那需要的正是这两个**不等待**的原语。
// 🔴 `target-clients.ts` 不改(并行包在那里):新原语写在这里,客户端用唯一工厂 `lib/aws/clients.ts`。
// 🔴 `secretArn` 必填(禁 IAM fallback,§3.9a 第 8 步;与 execOnTarget 同一纪律)。
import {
  BatchExecuteStatementCommand,
  DescribeStatementCommand,
  ExecuteStatementCommand,
  GetStatementResultCommand,
} from "@aws-sdk/client-redshift-data";
import { redshiftDataClient } from "@/lib/aws/clients";

/** 语句落点:region + workgroup + database(与 target-clients.TargetWarehouse 同形,避免依赖它)。 */
export interface StatementPlace {
  region: string;
  workgroup: string;
  database: string;
}

function assertSecretArn(secretArn: string): void {
  if (typeof secretArn !== "string" || !secretArn.startsWith("arn:")) {
    throw new Error(
      `提交语句需要真实的 SecretArn(收到 ${JSON.stringify(secretArn)})—— 拒绝。` +
        `§3.9a:禁 IAM fallback,解析不到凭证就拒,不许省略 SecretArn 退回联邦身份`
    );
  }
}

/**
 * 提交一组语句,**不等待**。
 *  · 1 条 ⇒ ExecuteStatement;
 *  · 多条 ⇒ BatchExecuteStatement(Data API 在**一个事务**里按序执行;任何一条失败整批回滚 ⇒
 *    作业重试时不会留下「做了一半」的状态 —— 这比逐条提交更适合可续跑的作业)。
 * @param statementName 关联键(写成审计 id ⇒ 从 Redshift 侧能反查到这条审计,与同一做法)
 */
export async function submitStatements(args: {
  place: StatementPlace;
  sqls: readonly string[];
  secretArn: string;
  statementName?: string;
}): Promise<string> {
  assertSecretArn(args.secretArn);
  if (!args.sqls.length) throw new Error("submitStatements:语句为空(no-op 不允许冒充成功)");
  const client = redshiftDataClient(args.place.region);
  const common = {
    WorkgroupName: args.place.workgroup,
    Database: args.place.database,
    SecretArn: args.secretArn,
    ...(args.statementName ? { StatementName: args.statementName.slice(0, 500) } : {}),
  };
  const r =
    args.sqls.length === 1
      ? await client.send(new ExecuteStatementCommand({ ...common, Sql: args.sqls[0] }))
      : await client.send(new BatchExecuteStatementCommand({ ...common, Sqls: [...args.sqls] }));
  if (!r.Id) throw new Error("Redshift Data API 没有返回 statement Id ⇒ 无法确认执行结果,拒绝当成功");
  return r.Id;
}

export type StatementState =
  | { state: "running" }
  | { state: "finished"; affected: number; hasResultSet: boolean }
  | { state: "failed"; error: string };

/** 读一次终态(不等待)。ABORTED 归为 failed(被中止不是成功)。 */
export async function describeStatementState(region: string, statementId: string): Promise<StatementState> {
  const d = await redshiftDataClient(region).send(new DescribeStatementCommand({ Id: statementId }));
  switch (d.Status) {
    case "FINISHED":
      return {
        state: "finished",
        affected: typeof d.ResultRows === "number" && d.ResultRows > 0 ? d.ResultRows : 0,
        hasResultSet: d.HasResultSet === true,
      };
    case "FAILED":
    case "ABORTED":
      return { state: "failed", error: `${d.Status === "ABORTED" ? "被中止" : "失败"}:${d.Error || d.Status}` };
    default:
      // SUBMITTED / PICKED / STARTED / 未知 ⇒ 还没完。🔴 未知状态不许当成功。
      return { state: "running" };
  }
}

/** 取结果集第一行第一列的字符串值(C-1 `current_user` / C-7 `current_schemas`)。拿不到就抛。 */
export async function firstScalar(region: string, statementId: string): Promise<string> {
  const r = await redshiftDataClient(region).send(new GetStatementResultCommand({ Id: statementId }));
  const cell = r.Records?.[0]?.[0];
  if (!cell) throw new Error("语句结果为空 ⇒ 无法取标量");
  const v =
    cell.stringValue ??
    (cell.longValue !== undefined ? String(cell.longValue) : undefined) ??
    (cell.doubleValue !== undefined ? String(cell.doubleValue) : undefined) ??
    (cell.booleanValue !== undefined ? String(cell.booleanValue) : undefined);
  if (v === undefined) throw new Error("语句结果首格不是可读的标量(isNull 或未知类型)");
  return v;
}
