// 测试用的**真外部替身**:Redshift Data API / Secrets Manager / Redshift Serverless / CloudWatch。
// 只替换 `@/lib/aws/clients` 工厂吐出来的客户端(`regionalClient` / `redshiftDataClient`),
// 平台自己的模块(target-clients / 执行器 / statement 原语)一律真跑 —— 这是装配层判据的意义。
//
// Redshift 的行为由 `behaviors` 脚本决定:按 SQL 正则匹配第一条,可指定「失败文本」「先 STARTED 几次」「结果值」「生效次数」。
// 不匹配任何脚本 ⇒ 立即 FINISHED、没有结果集。

export interface StatementRecord {
  id: string;
  region: string;
  sqls: string[];
  secretArn?: string;
  workgroup?: string;
  database?: string;
  statementName?: string;
  pendingPolls: number;
  error?: string;
  value?: string;
}

export interface RsBehavior {
  match: RegExp;
  error?: string;
  pendingPolls?: number;
  value?: string;
  /** 只对前 N 次匹配生效(缺省一直生效) */
  times?: number;
  /** 只对用这个 secret 提交的语句生效 */
  secretArn?: string;
}

function awsError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export class FakeAws {
  statements: StatementRecord[] = [];
  behaviors: RsBehavior[] = [];
  secrets = new Map<string, { arn: string; value: string; region: string }>();
  /** DescribeSecret 对这些名字抛(模拟读失败) */
  secretReadErrors = new Map<string, string>();
  /** DeleteSecret 对这些名字抛(模拟 AccessDenied / 限流) */
  secretDeleteErrors = new Map<string, string>();
  metricValues: number[] = [];
  metricError: string | null = null;
  calls: string[] = [];
  private seq = 0;

  reset(): void {
    this.statements = [];
    this.behaviors = [];
    this.secrets.clear();
    this.secretReadErrors.clear();
    this.secretDeleteErrors.clear();
    this.metricValues = [];
    this.metricError = null;
    this.calls = [];
    this.seq = 0;
  }

  /** 所有提交过的 SQL(按提交顺序展开 batch)。 */
  sqls(): string[] {
    return this.statements.flatMap((s) => s.sqls);
  }

  private submit(region: string, input: any, sqls: string[]): { Id: string } {
    const id = `st-${++this.seq}`;
    const joined = sqls.join(";\n");
    const b = this.behaviors.find(
      (x) => x.match.test(joined) && (x.times === undefined || x.times > 0) && (!x.secretArn || x.secretArn === input.SecretArn)
    );
    if (b && b.times !== undefined) b.times -= 1;
    this.statements.push({
      id,
      region,
      sqls,
      secretArn: input.SecretArn,
      workgroup: input.WorkgroupName,
      database: input.Database,
      statementName: input.StatementName,
      pendingPolls: b?.pendingPolls ?? 0,
      ...(b?.error ? { error: b.error } : {}),
      ...(b?.value !== undefined ? { value: b.value } : {}),
    });
    return { Id: id };
  }

  redshiftData(region: string) {
    return {
      send: async (cmd: { input: any; constructor: { name: string } }) => {
        const n = cmd.constructor.name;
        this.calls.push(`rsdata:${n}`);
        const i = cmd.input;
        if (n === "ExecuteStatementCommand") return this.submit(region, i, [i.Sql]);
        if (n === "BatchExecuteStatementCommand") return this.submit(region, i, [...i.Sqls]);
        const st = this.statements.find((s) => s.id === i.Id);
        if (!st) throw awsError("ResourceNotFoundException", `statement ${i.Id} not found`);
        if (n === "DescribeStatementCommand") {
          if (st.pendingPolls > 0) {
            st.pendingPolls -= 1;
            return { Id: st.id, Status: "STARTED" };
          }
          if (st.error) return { Id: st.id, Status: "FAILED", Error: st.error };
          return { Id: st.id, Status: "FINISHED", HasResultSet: st.value !== undefined, ResultRows: st.value !== undefined ? 1 : 0 };
        }
        if (n === "GetStatementResultCommand") {
          if (st.value === undefined) throw awsError("ValidationException", "no result set");
          return { Records: [[{ stringValue: st.value }]] };
        }
        throw new Error(`FakeAws 不支持 redshift-data ${n}`);
      },
    };
  }

  regional(service: string, region: string) {
    return {
      send: async (cmd: { input: any; constructor: { name: string } }) => {
        const n = cmd.constructor.name;
        this.calls.push(`${service}:${n}`);
        const i = cmd.input;
        if (service === "secrets") {
          if (n === "DescribeSecretCommand") {
            const err = this.secretReadErrors.get(i.SecretId);
            if (err) throw awsError(err);
            const s = this.secrets.get(i.SecretId);
            if (!s) throw awsError("ResourceNotFoundException");
            return { ARN: s.arn, Name: i.SecretId };
          }
          if (n === "CreateSecretCommand") {
            if (this.secrets.has(i.Name)) throw awsError("ResourceExistsException");
            const arn = `arn:aws:secretsmanager:${region}:000000000000:secret:${i.Name}-AbCdEf`;
            this.secrets.set(i.Name, { arn, value: i.SecretString, region });
            return { ARN: arn };
          }
          if (n === "PutSecretValueCommand") {
            const s = this.secrets.get(i.SecretId);
            if (!s) throw awsError("ResourceNotFoundException");
            s.value = i.SecretString;
            return { ARN: s.arn };
          }
          // 🔴 secret 是**区域性**的:在别的区删同名 secret = 没有这个 secret。
          //   (只在 Delete 上按区判:删错区回 absent 正是「回收报成功、真 secret 原封不动」的那种缺陷,判据要看得见它)
          if (n === "DeleteSecretCommand") {
            const err = this.secretDeleteErrors.get(i.SecretId);
            if (err) throw awsError(err);
            const s = this.secrets.get(i.SecretId);
            if (!s || s.region !== region) throw awsError("ResourceNotFoundException");
            this.secrets.delete(i.SecretId);
            return { ARN: s.arn, Name: i.SecretId };
          }
          if (n === "GetSecretValueCommand") {
            const s = this.secrets.get(i.SecretId) ?? [...this.secrets.values()].find((x) => x.arn === i.SecretId);
            if (!s) throw awsError("ResourceNotFoundException");
            return { SecretString: s.value };
          }
        }
        if (service === "redshiftServerless" && n === "GetWorkgroupCommand") {
          return { workgroup: { endpoint: { address: `${i.workgroupName}.example.${region}.redshift-serverless.amazonaws.com`, port: 5439 } } };
        }
        if (service === "cloudwatch" && n === "GetMetricDataCommand") {
          if (this.metricError) throw awsError(this.metricError);
          return { MetricDataResults: [{ Id: "fb", StatusCode: "Complete", Values: [...this.metricValues] }] };
        }
        throw new Error(`FakeAws 不支持 ${service} ${n}`);
      },
    };
  }
}
