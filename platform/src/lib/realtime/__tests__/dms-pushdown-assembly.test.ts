// 🔴🔴 装配层:DMS 通道逐区下推 —— 启动路由 ↔ 落点解析 ↔ 服务层 ↔ 目标侧准备 ↔ 受控 DDL 执行器 ↔ 通道下线 ↔ 回收作业,
//   兄弟模块之间**一个都不 mock**。
//
// 只 mock 真外部:AWS 出口(`lib/exec-env/target-clients` 的按区客户端与数仓 / 密钥出口)、DynamoDB、执行环境注册表、
//   审计、身份、运行台账。AWS 那一侧是一个**按区分桶**的小型假云:每个区各有自己的 DMS(实例 / 端点 / 复制任务 / 连通性)、
//   安全组、密钥、数仓、命名空间,同名对象在两个区互不可见;拿着 A 区的标识去 B 区问,得到的是「没有」。
//   状态机照真服务写:实例要读几次才就绪、删除中还占着名字;复制任务建完先「创建中」、启动后先「启动中」、
//   删除后还要被读到几次「删除中」才消失;端点被复制任务引用时删不掉;实例上有任务时删不掉。
//
// 判据:
//   ① 执行区任务「启动」⇒ 每一个云调用都打在执行区,主控区的桶里零调用、零对象;实例 / 端点 / 复制任务 / 专用用户 / schema / 密钥 /
//      角色关联全在该区,用的是该区的名字、角色、桶、数仓、管理员凭证;口令不进审计与运行日志;
//   ② 同一个区第二条任务启动 ⇒ 密钥沿用(不再建 / 改用户、不再写密钥)、实例沿用;
//   ③ 两个区各有一条任务:执行区的「停止」只动执行区,端点保留;「删除」后回收作业等复制任务消失才清端点、过了空闲宽限才删实例,
//      全程主控区一个调用都没有、主控区的实例 / 端点 / 任务原封不动;反过来删主控区的任务,执行区一样不受影响;
//   ④ 实例被回收之后在同一个区再启动 ⇒ 重新懒创建,照样走到运行中;
//   ⑤ 沿用的源端点跟着数据源的现值走:停止后改了数据源(换主机 / 改口令)再启动 ⇒ 端点按现值更新并重新测连通性;
//      上一次启动因为地址填错而失败 ⇒ 改对之后再点一次就成;改错了 ⇒ 如实失败并带 DMS 的失败原文,不拿旧配置测出来的「成功」放行;
//   ⑥ 目标端:密钥里的口令与数仓里专用用户的真口令对不上(数仓被从快照恢复过)⇒ 这次启动自己重设一次口令再测,走到运行中;
//      重设也救不回来(不是口令的事)⇒ 只重设一次,如实失败并带原文。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeInstance { id: string; arn: string; status: string; readsLeft: number; subnetGroup: string; sgIds: string[]; cls: string }
interface FakeEndpoint { id: string; arn: string; input: Record<string, any> }
interface FakeTask { ident: string; arn: string; status: string; stopReason?: string; lastFailure?: string; instanceArn: string; src: string; tgt: string; deletingReads: number }
interface FakeRegion {
  instance: FakeInstance | null;
  instanceGen: number;
  endpoints: Map<string, FakeEndpoint>;
  tasks: Map<string, FakeTask>;
  conns: Map<string, { status: string; reads: number; failure?: string }>;
  /** 该区连得上的源库:主机 → 能登录的账号口令。不给 ⇒ 源端点的连通性测试一律成功(不关心连通性的用例)。 */
  sourceTruth?: Record<string, { username: string; password: string }>;
  /** 一个端点测失败过之后,再对它发起的测试一直停在「测试中」(DMS 那边排队 / 变慢),到启动超时都不出结果 */
  slowRetests?: boolean;
  sgs: Record<string, string>;
  /** Secrets Manager:名字 → { arn, value } */
  secrets: Record<string, { arn: string; value: Record<string, unknown> }>;
  /** 数仓里真执行过的语句(口令已抹)与凭的哪个密钥 */
  sql: Array<{ sql: string; secretArn: string }>;
  users: Set<string>;
  /** 数仓里每个用户**此刻真正的**口令(CREATE / ALTER USER 写进来;判据可以直接改它,模拟数仓被从快照恢复) */
  userPasswords: Record<string, string>;
  workgroups: Record<string, { namespace: string; host: string }>;
  namespaces: Record<string, string[]>;
}

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  process.env.REDSHIFT_WORKGROUP = "bgp-workgroup";
  process.env.REDSHIFT_DATABASE = "dev";
  process.env.DMS_ROLE_ARN = "arn:aws:iam::123456789012:role/bgp-dms-kinesis-role";
  delete process.env.EMR_LOG_BUCKET;
  return {
    /** 每一个云调用:哪个服务、哪个区、什么操作 */
    calls: [] as Array<{ svc: string; region: string; op: string }>,
    regions: {} as Record<string, FakeRegion>,
    /** DynamoDB:表名 → 主键 → 行 */
    ddb: new Map<string, Map<string, Record<string, any>>>(),
    audits: [] as Array<{ action: string; opts: Record<string, any> }>,
    runs: [] as Array<Record<string, any>>,
    settles: [] as Array<Record<string, any>>,   // 收口「运行中」运行行的调用(含补章用的章)
    targets: {} as Record<string, Record<string, unknown>>,
  };
});

const ACCOUNT = "123456789012";
const fault = (name: string, message = name) => Object.assign(new Error(message), { name });

// ── 真外部 ① AWS 出口:按区分桶的假云 ─────────────────────────────────────────────
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const bucket = (region: string): FakeRegion => {
    const b = h.regions[region];
    if (!b) throw new Error(`判据没有给 ${region} 准备假云`);
    return b;
  };
  const note = (svc: string, region: string, op: string) => { h.calls.push({ svc, region, op }); };

  const dms = (region: string) => ({
    async send(cmd: any) {
      const n = String(cmd.constructor.name).replace(/Command$/, "");
      const input = cmd.input as Record<string, any>;
      note("dms", region, n);
      const b = bucket(region);
      const filter = input.Filters?.[0] as { Name: string; Values: string[] } | undefined;
      /** 读一次复制任务:过渡态往前走一步;删除中的读够次数就消失 */
      const readTask = (t: FakeTask): FakeTask | null => {
        if (t.status === "deleting") {
          if (t.deletingReads-- <= 0) { b.tasks.delete(t.ident); return null; }
          return t;
        }
        if (t.status === "creating") t.status = "ready";
        else if (t.status === "starting") t.status = "running";
        else if (t.status === "stopping") t.status = "stopped";
        else if (t.status === "stopped" && t.stopReason === "") t.stopReason = "Stop Reason NORMAL";
        return t;
      };
      const shape = (t: FakeTask) => ({
        ReplicationTaskIdentifier: t.ident, ReplicationTaskArn: t.arn, Status: t.status, ReplicationInstanceArn: t.instanceArn,
        SourceEndpointArn: t.src, TargetEndpointArn: t.tgt, ...(t.stopReason ? { StopReason: t.stopReason } : {}),
        ...(t.lastFailure ? { LastFailureMessage: t.lastFailure } : {}),
        ReplicationTaskStats: { FullLoadProgressPercent: t.status === "running" ? 100 : 0 },
      });
      switch (n) {
        case "DescribeReplicationInstances": {
          const inst = b.instance;
          if (!inst || inst.id !== filter?.Values[0]) throw fault("ResourceNotFoundFault", "No Replication Instances found");
          if (inst.status === "creating" && --inst.readsLeft <= 0) inst.status = "available";
          else if (inst.status === "deleting" && --inst.readsLeft <= 0) { b.instance = null; throw fault("ResourceNotFoundFault", "No Replication Instances found"); }
          return { ReplicationInstances: [{ ReplicationInstanceIdentifier: inst.id, ReplicationInstanceArn: inst.arn, ReplicationInstanceStatus: inst.status, ReplicationInstanceClass: inst.cls }] };
        }
        case "CreateReplicationInstance": {
          if (b.instance) throw fault("ResourceAlreadyExistsFault", `Replication instance ${input.ReplicationInstanceIdentifier} already exists`);
          b.instance = {
            id: input.ReplicationInstanceIdentifier, arn: `arn:aws:dms:${region}:${ACCOUNT}:rep:GEN${++b.instanceGen}`, status: "creating", readsLeft: 2,
            subnetGroup: input.ReplicationSubnetGroupIdentifier, sgIds: input.VpcSecurityGroupIds ?? [], cls: input.ReplicationInstanceClass,
          };
          return {};
        }
        case "DeleteReplicationInstance": {
          if (!b.instance || b.instance.arn !== input.ReplicationInstanceArn) throw fault("ResourceNotFoundFault");
          if ([...b.tasks.values()].some((t) => t.instanceArn === input.ReplicationInstanceArn)) throw fault("InvalidResourceStateFault", "instance has replication tasks");
          b.instance.status = "deleting"; b.instance.readsLeft = 2;
          return {};
        }
        case "DescribeEndpoints": {
          if (!filter) return { Endpoints: [...b.endpoints.values()].map((e) => ({ EndpointIdentifier: e.id, EndpointArn: e.arn })) };
          const e = b.endpoints.get(filter.Values[0]);
          if (!e) throw fault("ResourceNotFoundFault", "No Endpoints found matching the criteria");
          return { Endpoints: [{ EndpointIdentifier: e.id, EndpointArn: e.arn }] };
        }
        case "CreateEndpoint": {
          if (b.endpoints.has(input.EndpointIdentifier)) throw fault("ResourceAlreadyExistsFault", "endpoint already exists");
          const e = { id: input.EndpointIdentifier, arn: `arn:aws:dms:${region}:${ACCOUNT}:endpoint:${String(input.EndpointIdentifier).toUpperCase()}`, input };
          b.endpoints.set(e.id, e);
          return { Endpoint: { EndpointArn: e.arn } };
        }
        case "ModifyEndpoint": {
          const e = [...b.endpoints.values()].find((x) => x.arn === input.EndpointArn);
          if (!e) throw fault("ResourceNotFoundFault", "endpoint not found");
          // 保守假设:端点被运行中 / 正在启停的复制任务占着时不让改(产品只在复制任务到可启动的稳态之后才改)
          if ([...b.tasks.values()].some((t) => (t.src === e.arn || t.tgt === e.arn) && ["starting", "running", "stopping"].includes(t.status))) {
            throw fault("InvalidResourceStateFault", "endpoint is in use by a running replication task");
          }
          const { EndpointArn: _arn, ...changes } = input;
          e.input = { ...e.input, ...changes };
          // 连通性记录原样留着(上一次测出来的结论不会因为改了配置而自己失效)⇒ 要新结论必须重测
          return { Endpoint: { EndpointArn: e.arn } };
        }
        case "DeleteEndpoint": {
          const e = [...b.endpoints.values()].find((x) => x.arn === input.EndpointArn);
          if (!e) throw fault("ResourceNotFoundFault", "endpoint not found");
          if ([...b.tasks.values()].some((t) => t.src === e.arn || t.tgt === e.arn)) throw fault("InvalidResourceStateFault", "endpoint is in use by a replication task");
          b.endpoints.delete(e.id);
          b.conns.delete(e.arn);
          return {};
        }
        case "DescribeReplicationTasks": {
          let list = [...b.tasks.values()];
          if (filter?.Name === "replication-task-id") list = list.filter((t) => t.ident === filter.Values[0]);
          else if (filter?.Name === "replication-task-arn") list = list.filter((t) => t.arn === filter.Values[0]);
          else if (filter?.Name === "replication-instance-arn") list = list.filter((t) => t.instanceArn === filter.Values[0]);
          const out = list.map(readTask).filter((t): t is FakeTask => t !== null).map(shape);
          if (filter && filter.Name !== "replication-instance-arn" && out.length === 0) throw fault("ResourceNotFoundFault", "No Tasks found matching the criteria");
          return { ReplicationTasks: out };
        }
        case "CreateReplicationTask": {
          const ident = input.ReplicationTaskIdentifier;
          if (b.tasks.has(ident)) throw fault("ResourceAlreadyExistsFault", `ReplicationTask "${ident}" already in use.`);
          // 实例与两个端点都必须是**本区**的对象(拿别的区的标识来建 ⇒ 真服务回「不存在」)
          if (!b.instance || b.instance.arn !== input.ReplicationInstanceArn) throw fault("ResourceNotFoundFault", `Replication Instance ARN ${input.ReplicationInstanceArn} does not exist`);
          const arns = new Set([...b.endpoints.values()].map((e) => e.arn));
          if (!arns.has(input.SourceEndpointArn) || !arns.has(input.TargetEndpointArn)) throw fault("ResourceNotFoundFault", "Endpoint does not exist");
          const t: FakeTask = {
            ident, arn: `arn:aws:dms:${region}:${ACCOUNT}:task:${String(ident).toUpperCase()}`, status: "creating",
            instanceArn: input.ReplicationInstanceArn, src: input.SourceEndpointArn, tgt: input.TargetEndpointArn, deletingReads: 2,
          };
          b.tasks.set(ident, t);
          return { ReplicationTask: { ReplicationTaskArn: t.arn } };
        }
        case "ModifyReplicationTask": return {};
        case "StartReplicationTask": {
          const t = [...b.tasks.values()].find((x) => x.arn === input.ReplicationTaskArn);
          if (!t) throw fault("ResourceNotFoundFault");
          if (!["ready", "stopped", "failed"].includes(t.status)) throw fault("InvalidResourceStateFault", `Replication Task cannot be started, invalid state: ${t.status}`);
          t.status = "starting"; t.stopReason = undefined;
          return {};
        }
        case "StopReplicationTask": {
          const t = [...b.tasks.values()].find((x) => x.arn === input.ReplicationTaskArn);
          if (!t) throw fault("ResourceNotFoundFault");
          if (t.status !== "running") throw fault("InvalidResourceStateFault", `Replication Task ${t.arn} is currently not running`);
          t.status = "stopping"; t.stopReason = "";
          return {};
        }
        case "DeleteReplicationTask": {
          const t = [...b.tasks.values()].find((x) => x.arn === input.ReplicationTaskArn);
          if (!t) throw fault("ResourceNotFoundFault");
          if (!["ready", "stopped", "failed"].includes(t.status)) throw fault("InvalidResourceStateFault", `Replication Task cannot be deleted, invalid state: ${t.status}`);
          t.status = "deleting";
          return {};
        }
        case "TestConnection": {
          if (!b.instance || b.instance.arn !== input.ReplicationInstanceArn) throw fault("ResourceNotFoundFault");
          const prev = b.conns.get(input.EndpointArn);
          b.conns.set(input.EndpointArn, { status: "testing", reads: b.slowRetests && prev?.failure ? Number.NEGATIVE_INFINITY : 0 });
          return {};
        }
        case "DescribeConnections": {
          /** 一次连通性测试的结论:按端点**此刻**的配置去连该区的源库 */
          const verdict = (arn: string): string | undefined => {
            const e = [...b.endpoints.values()].find((x) => x.arn === arn);
            if (e?.input.EndpointType === "target") {
              // 目标端:DMS 用端点上写的那个密钥(本区)里的账号口令去登数仓
              const secret = b.secrets[String(e.input.RedshiftSettings?.SecretsManagerSecretId)]?.value as { username?: string; password?: string } | undefined;
              if (!secret) return "Error Details: [message=Secrets Manager can't find the specified secret, errType=, status=0]";
              if (b.userPasswords[String(secret.username)] !== secret.password) {
                return `Error Details: [message=FATAL: password authentication failed for user "${secret.username}", errType=, status=1022502]`;
              }
              return undefined;
            }
            if (!b.sourceTruth || e?.input.EndpointType !== "source") return undefined;
            const db = b.sourceTruth[String(e.input.ServerName)];
            if (!db) return `Error Details: [message=Unknown MySQL server host '${e.input.ServerName}', errType=, status=2005]`;
            if (db.username !== e.input.Username || db.password !== e.input.Password) {
              return `Error Details: [message=Access denied for user '${e.input.Username}'@'10.0.0.1' (using password: YES), errType=, status=1045]`;
            }
            return undefined;
          };
          const out = [...b.conns.entries()].map(([arn, c]) => {
            if (c.status === "testing" && c.reads++ >= 1) {
              const failure = verdict(arn);
              c.status = failure ? "failed" : "successful";
              c.failure = failure;
            }
            return { EndpointArn: arn, Status: c.status, ...(c.failure ? { LastFailureMessage: c.failure } : {}) };
          });
          return { Connections: out };
        }
        case "DescribeTableStatistics": return { TableStatistics: [] };
        default: throw new Error(`假 DMS 未支持 ${n}`);
      }
    },
  });

  const secretOf = (region: string, id: string) => {
    const b = bucket(region);
    return Object.values(b.secrets).find((s) => s.arn === id) ?? b.secrets[id];
  };

  return {
    ...real,
    dmsClientFor: async (region: string) => dms(region),
    ec2ClientFor: async (region: string) => ({
      async send(cmd: any) {
        note("ec2", region, "DescribeSecurityGroups");
        const name = cmd.input.Filters?.[0]?.Values?.[0];
        const id = bucket(region).sgs[name];
        return { SecurityGroups: id ? [{ GroupId: id, GroupName: name }] : [] };
      },
    }),
    secretsClientFor: async (region: string) => ({
      async send(cmd: any) {
        note("secrets", region, "GetSecretValue");
        const s = secretOf(region, String(cmd.input.SecretId));
        if (!s) throw fault("ResourceNotFoundException", "Secrets Manager can't find the specified secret.");
        return { SecretString: JSON.stringify(s.value) };
      },
    }),
    redshiftServerlessClientFor: async (region: string) => ({
      async send(cmd: any) {
        const n = String(cmd.constructor.name).replace(/Command$/, "");
        note("redshift-serverless", region, n);
        const b = bucket(region);
        if (n === "GetWorkgroup") {
          const w = b.workgroups[cmd.input.workgroupName];
          if (!w) throw fault("ResourceNotFoundException", "workgroup not found");
          return { workgroup: { workgroupName: cmd.input.workgroupName, namespaceName: w.namespace, endpoint: { address: w.host, port: 5439 } } };
        }
        if (n === "GetNamespace") return { namespace: { namespaceName: cmd.input.namespaceName, iamRoles: b.namespaces[cmd.input.namespaceName] ?? [] } };
        if (n === "UpdateNamespace") { b.namespaces[cmd.input.namespaceName] = cmd.input.iamRoles; return {}; }
        throw new Error(`假 Redshift Serverless 未支持 ${n}`);
      },
    }),
    resolveTargetEndpoint: vi.fn(async (w: { region: string; workgroup: string }) => {
      note("redshift-serverless", w.region, "GetWorkgroup");
      const wg = bucket(w.region).workgroups[w.workgroup];
      if (!wg) throw new Error(`解析不到 workgroup ${w.workgroup}(region=${w.region})的连接端点`);
      return { host: wg.host, port: 5439 };
    }),
    execOnTarget: vi.fn(async (a: { warehouse: { region: string; workgroup: string }; sql: string; secretArn: string }) => {
      note("redshift-data", a.warehouse.region, "ExecuteStatement");
      const b = bucket(a.warehouse.region);
      if (!b.workgroups[a.warehouse.workgroup]) throw new Error(`workgroup ${a.warehouse.workgroup} 不在 ${a.warehouse.region}`);
      // 管理员凭证必须是本区的那一个(拿别的区的密钥 ARN 来,Data API 读不到)
      if (!a.secretArn.startsWith(`arn:aws:secretsmanager:${a.warehouse.region}:`)) throw new Error(`secret ${a.secretArn} 不在 ${a.warehouse.region}`);
      const m = a.sql.match(/^CREATE USER "(\w+)" PASSWORD '([^']*)'/);
      if (m) {
        if (b.users.has(m[1])) throw new Error(`ERROR: user "${m[1]}" already exists`);
        b.users.add(m[1]);
        b.userPasswords[m[1]] = m[2];
      }
      const alter = a.sql.match(/^ALTER USER "(\w+)" PASSWORD '([^']*)'/);
      if (alter) {
        if (!b.users.has(alter[1])) throw new Error(`ERROR: user "${alter[1]}" does not exist`);
        b.userPasswords[alter[1]] = alter[2];
      }
      b.sql.push({ sql: a.sql.replace(/PASSWORD '[^']*'/, "PASSWORD '<redacted>'"), secretArn: a.secretArn });
      return { affected: 0, statementId: "st" };
    }),
    describeSecretArnByName: vi.fn(async (region: string, name: string) => { note("secrets", region, "DescribeSecret"); return bucket(region).secrets[name]?.arn; }),
    awaitSecretArnByName: vi.fn(async (region: string, name: string) => { note("secrets", region, "DescribeSecret"); return bucket(region).secrets[name]?.arn; }),
    putSecretJson: vi.fn(async (region: string, name: string, value: Record<string, unknown>) => {
      note("secrets", region, "PutSecret");
      const b = bucket(region);
      const created = !b.secrets[name];
      b.secrets[name] = { arn: `arn:aws:secretsmanager:${region}:${ACCOUNT}:secret:${name}-AbCdEf`, value };
      return { arn: b.secrets[name].arn, created };
    }),
  };
});

// ── 真外部 ② DynamoDB:按表存行的内存表 ───────────────────────────────────────────
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real: any = await orig();
  const table = (name: string) => { let t = h.ddb.get(name); if (!t) { t = new Map(); h.ddb.set(name, t); } return t; };
  const idOf = (o: Record<string, any>) => String(o.taskId ?? o.datasourceId ?? o.jobId ?? o.auditId ?? o.sk ?? JSON.stringify(o));
  return {
    ...real,
    docClient: {
      send: vi.fn(async (cmd: any) => {
        const n = String(cmd.constructor.name);
        const input = cmd.input as Record<string, any>;
        const t = table(String(input.TableName));
        if (n === "GetCommand") { const row = t.get(idOf(input.Key)); return row ? { Item: JSON.parse(JSON.stringify(row)) } : {}; }
        if (n === "PutCommand") {
          const id = idOf(input.Item);
          if (/attribute_not_exists/.test(String(input.ConditionExpression ?? "")) && t.has(id)) throw fault("ConditionalCheckFailedException", "The conditional request failed");
          t.set(id, JSON.parse(JSON.stringify(input.Item)));
          return {};
        }
        if (n === "DeleteCommand") { t.delete(idOf(input.Key)); return {}; }
        if (n === "ScanCommand") return { Items: [...t.values()].map((r) => JSON.parse(JSON.stringify(r))) };
        if (n === "QueryCommand") {
          const tid = input.ExpressionAttributeValues?.[":t"];
          return { Items: [...t.values()].filter((r) => tid === undefined || r.targetId === tid).map((r) => JSON.parse(JSON.stringify(r))) };
        }
        if (n === "UpdateCommand") {
          const row = t.get(idOf(input.Key));
          // 任务行的唯一写通道一律带「行必须存在」;行没了 ⇒ 条件失败(不带旧行 = 已删)
          if (!row) throw fault("ConditionalCheckFailedException", "The conditional request failed");
          const names = input.ExpressionAttributeNames ?? {};
          const values = input.ExpressionAttributeValues ?? {};
          const m = /^\s*SET\s+(.*)$/s.exec(String(input.UpdateExpression));
          if (!m) throw new Error(`假 DDB 只支持 SET:${input.UpdateExpression}`);
          for (const part of m[1].split(",")) {
            const [lhs, rhs] = part.split("=").map((x) => x.trim());
            // 路径写法 `a.#b`:写进嵌套对象
            const path = lhs.split(".").map((seg) => names[seg] ?? seg);
            let obj = row;
            for (const seg of path.slice(0, -1)) obj = (obj[seg] ??= {});
            obj[path[path.length - 1]] = values[rhs];
          }
          return { Attributes: JSON.parse(JSON.stringify(row)) };
        }
        throw new Error(`假 DDB 未支持 ${n}`);
      }),
    },
  };
});

// ── 真外部 ③ 执行环境注册表 / 审计 / 身份 / 运行台账 ─────────────────────────────────
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    requireReadyTarget: vi.fn(async (tid: string) => {
      const t = h.targets[tid];
      if (!t) throw new Error(`执行目标 ${tid} 不可用:注册表里没有该描述符`);
      return t;
    }),
    getTargetRaw: vi.fn(async (tid: string) => h.targets[tid] ?? null),
  };
});
vi.mock("@/lib/audit", () => ({
  recordAudit: vi.fn(async () => {}),
  writeAuditRecord: vi.fn(async (_actor: unknown, action: string, opts: Record<string, any>) => { h.audits.push({ action, opts }); return `audit#${h.audits.length}`; }),
  writeAuditRecordOnce: vi.fn(async (_actor: unknown, action: string, opts: Record<string, any>) => { h.audits.push({ action, opts }); return `audit#${h.audits.length}`; }),
}));
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
}));
vi.mock("@/lib/projects/project-service", () => ({ getProject: vi.fn(async () => null), getApproval: vi.fn(async () => null) }));
// 运行行的两个写入口只记录入参(真外部是运行表);🔴 盖章函数用真的 ——
//   2026-11-20 页面实测:执行区的 DMS 运行在任务监控里记成了主控区。此前这里放的是一个读 targets[0] 的假盖章函数,
//   而真的那个不传落点就回主控区(同步任务的区在 targets[] 里,它不读)⇒ 假的与真的不同形,把「启动路由没传落点」藏住了。
vi.mock("@/lib/monitor/run-records", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    putRunRecord: vi.fn(async (args: Record<string, any>) => { h.runs.push(args); }),
    settleRunningRuns: vi.fn(async (args: Record<string, any>) => { h.settles.push(args); return 0; }),
  };
});

// ── 被测:全部真模块 ─────────────────────────────────────────────────────────────
import { TABLES } from "@/lib/aws/dynamodb";
import { teardownSyncChannel, TEARDOWN_LONG_OP_WAIT_MS } from "@/lib/sync/teardown";
import { resolveDmsSite } from "@/lib/realtime/dms-place";
import {
  dmsInstanceReclaimJobHandler, enqueueDmsInstanceReclaim,
  DMS_ENDPOINT_SWEEP_AUDIT_ACTION, DMS_INSTANCE_IDLE_GRACE_MS, DMS_RECLAIM_AUDIT_ACTION,
} from "@/lib/realtime/dms-instance-reclaim-job";
import { getReplicationStatus } from "@/lib/realtime/dms-service";
import { reconcileSyncTask } from "@/lib/sync/reconcile";
import { __resetRegionCache } from "@/lib/exec-env/target-region";
import type { DataplaneJobRow } from "@/lib/dataplane-jobs/model";

const HOME = "us-east-1";
const WEST = "us-west-2";
const WEST_TARGET = "tgt_usw2";
const WEST_ROLE = `arn:aws:iam::${ACCOUNT}:role/BgpExecEnv-tgt-usw2-dms-kinesis-role`;
const HOME_ROLE = `arn:aws:iam::${ACCOUNT}:role/bgp-dms-kinesis-role`;
const WEST_ADMIN = `arn:aws:secretsmanager:${WEST}:${ACCOUNT}:secret:redshift!bgp-namespace-tgt-usw2-admin-AbCdEf`;
const HOME_ADMIN = `arn:aws:secretsmanager:${HOME}:${ACCOUNT}:secret:redshift!bgp-namespace-admin-AbCdEf`;
const WEST_SRC_SECRET = `arn:aws:secretsmanager:${WEST}:${ACCOUNT}:secret:bgp/datasource/ds-west-AbCdEf`;
const HOME_SRC_SECRET = `arn:aws:secretsmanager:${HOME}:${ACCOUNT}:secret:bgp/datasource/ds-home-AbCdEf`;

function emptyRegion(over: Partial<FakeRegion>): FakeRegion {
  return { instance: null, instanceGen: 0, endpoints: new Map(), tasks: new Map(), conns: new Map(), sgs: {}, secrets: {}, sql: [], users: new Set(), userPasswords: {}, workgroups: {}, namespaces: {}, ...over };
}
/** 同步任务行(向导建出来的形态:只存数据源 id,连接信息从数据源行取;绑定只写 `targets[]`)。 */
function seedTask(taskId: string, targetId: string, datasourceId: string) {
  h.ddb.get(TABLES.SYNC_TASKS)!.set(taskId, {
    userId: "default-user", taskId, name: `cdc-${taskId.slice(-4)}`, channel: "dms", syncMode: "incremental", status: "draft", projectId: "p1",
    targets: [targetId], datasourceId, sourceTables: ["orders"], updatedAt: "2026-11-18T00:00:00.000Z",
  });
}
const taskRow = (taskId: string) => h.ddb.get(TABLES.SYNC_TASKS)!.get(taskId)!;
const shortOf = (taskId: string) => taskId.slice(-12).toLowerCase().replace(/[^a-z0-9]/g, "");
const callsIn = (region: string) => h.calls.filter((c) => c.region === region);
const ops = (region: string, svc = "dms") => callsIn(region).filter((c) => c.svc === svc).map((c) => c.op);

const realSetTimeout = globalThis.setTimeout;
/** 假时钟里推进,直到条件成立(每秒让出一次真事件循环,让后台编排的异步链接着跑)。 */
async function drive(cond: () => boolean, what: string, maxSeconds = 600) {
  for (let i = 0; i < maxSeconds && !cond(); i++) { await vi.advanceTimersByTimeAsync(1_000); await new Promise((r) => realSetTimeout(r, 0)); }
  if (!cond()) throw new Error(`等不到:${what}(calls=${JSON.stringify(h.calls.slice(-12))})`);
  for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(1_000); await new Promise((r) => realSetTimeout(r, 0)); }
}
/** 假时钟里把一个异步动作跑到结束。 */
async function settle<T>(run: () => Promise<T>, maxSeconds = 600): Promise<T> {
  const p = run();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < maxSeconds && !done; i++) { await vi.advanceTimersByTimeAsync(1_000); await new Promise((r) => realSetTimeout(r, 0)); }
  expect(done, "动作在虚拟时间内没有结束").toBe(true);
  return p;
}
/** 页面点一次「启动」:走真路由,等后台编排把任务推到终态(运行中 / 异常),回任务行。 */
async function clickStart(taskId: string) {
  const { POST } = await import("@/app/api/sync/[id]/start-realtime/route");
  const res = await POST(new Request("http://x/api/sync/x/start-realtime", { method: "POST" }) as never, { params: Promise.resolve({ id: taskId }) } as never);
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(202);
  // 路由受理时先把行写成「启动中」;终态由后台编排写
  expect(taskRow(taskId).status).toBe("provisioning");
  await drive(() => ["running", "error"].includes(taskRow(taskId).status), `任务 ${taskId} 的启动编排到终态`);
  return taskRow(taskId);
}
/** 页面点「启动」并要求走到运行中。 */
async function start(taskId: string) {
  const row = await clickStart(taskId);
  expect(row.status, JSON.stringify(row.realtimeConfig)).toBe("running");
}
/** 页面点「停止」:通道下线(不撤资源)+ 执行体把行写成已停止。 */
async function stop(taskId: string) {
  const td = await settle(() => teardownSyncChannel(taskRow(taskId) as never, { purge: false, waitMs: TEARDOWN_LONG_OP_WAIT_MS }));
  expect(td.hardFailures, JSON.stringify(td)).toEqual([]);
  expect(td.dms).toMatchObject({ found: true, stopped: true });
  taskRow(taskId).status = "stopped";
}
/** 页面「编辑数据源」保存之后的样子:行上的主机变了,源库密钥里的账号口令变了(该区)。 */
function editDatasource(region: string, datasourceId: string, change: { host?: string; username?: string; password?: string }) {
  const row = h.ddb.get(TABLES.DATASOURCES)!.get(datasourceId)!;
  if (change.host) row.host = change.host;
  const secret = Object.values(h.regions[region].secrets).find((x) => x.arn === row.secretArn)!;
  secret.value = { ...secret.value, ...(change.username ? { username: change.username } : {}), ...(change.password ? { password: change.password } : {}) };
}
/**
 * 详情页读一次每条任务的状态之后,该区全部复制任务的状态。
 * (产品在 StartReplicationTask 被受理后就把任务记成运行中;复制任务在 DMS 里从「启动中」到「运行中」要等下一次读到。)
 */
async function taskStatuses(region: string): Promise<string[]> {
  for (const row of h.ddb.get(TABLES.SYNC_TASKS)!.values()) {
    const arn = row.realtimeConfig?.replicationTaskArn as string | undefined;
    if (arn?.includes(`:dms:${region}:`)) await getReplicationStatus(await resolveDmsSite(row), arn);
  }
  return [...h.regions[region].tasks.values()].map((t) => t.status);
}
/** 「删除」执行体做的三件事(通道下线 → 登记回收 → 删行;路由与执行体的接线在 app/api/sync/__tests__/teardown-guard.test.ts)。 */
async function deleteTask(taskId: string): Promise<DataplaneJobRow> {
  const task = taskRow(taskId);
  const td = await settle(() => teardownSyncChannel(task as never, { purge: true, waitMs: TEARDOWN_LONG_OP_WAIT_MS }));
  expect(td.hardFailures, JSON.stringify(td)).toEqual([]);
  const site = await resolveDmsSite(task);
  const r = await enqueueDmsInstanceReclaim({ targetId: site.targetId, region: site.region, instanceId: site.instanceId, reason: "task-deleted", createdBy: "user:admin" });
  h.ddb.get(TABLES.SYNC_TASKS)!.delete(taskId);
  const jobs = [...h.ddb.values()].flatMap((t) => [...t.values()]).filter((row) => row.jobId === r.jobId);
  expect(jobs).toHaveLength(1);
  return jobs[0] as DataplaneJobRow;
}
/** 泵推一步回收作业(把这一步的证据带进下一步,与真泵存档后再推一样)。 */
async function pump(job: DataplaneJobRow, atMsAfterEnqueue: number) {
  const now = Date.parse(job.createdAt) + atMsAfterEnqueue;
  const r = await dmsInstanceReclaimJobHandler.step({ job, now: () => now, deadline: now + 45_000, sleep: async () => {} });
  job.evidence = r.evidence as never;
  return r;
}

beforeEach(() => {
  h.calls.length = 0; h.audits.length = 0; h.runs.length = 0; h.settles.length = 0; h.ddb.clear();
  for (const t of [TABLES.SYNC_TASKS, TABLES.DATASOURCES]) h.ddb.set(t, new Map());
  h.regions = {
    [HOME]: emptyRegion({
      sgs: { "bgp-dms-sg": "sg-home" },
      secrets: { "bgp/datasource/ds-home": { arn: HOME_SRC_SECRET, value: { username: "app", password: "src-home-pw" } } },
      workgroups: { "bgp-workgroup": { namespace: "bgp-namespace", host: "bgp-workgroup.home.example" } },
    }),
    [WEST]: emptyRegion({
      sgs: { "bgp-dms-sg-tgt-usw2": "sg-west" },
      secrets: { "bgp/datasource/ds-west": { arn: WEST_SRC_SECRET, value: { username: "app", password: "src-west-pw" } } },
      workgroups: { "bgp-workgroup-tgt-usw2": { namespace: "bgp-namespace-tgt-usw2", host: "bgp-workgroup-tgt-usw2.west.example" } },
    }),
  };
  h.targets = {
    tgt_home: {
      targetId: "tgt_home", region: HOME, status: "active", ready: true, components: ["core", "redshift", "dms"],
      credentialIsolationState: "isolated", credentialEpoch: 1, resources: { redshiftSecretArn: HOME_ADMIN },
    },
    [WEST_TARGET]: {
      targetId: WEST_TARGET, region: WEST, status: "active", ready: true, components: ["core", "redshift", "dms"],
      credentialIsolationState: "isolated", credentialEpoch: 1,
      resources: {
        datalakeBucket: `bgp-datalake-${ACCOUNT}-tgt-usw2`, redshiftWorkgroup: "bgp-workgroup-tgt-usw2", redshiftDatabase: "dev",
        redshiftSecretArn: WEST_ADMIN, dmsSubnetGroup: "bgp-dms-subnet-group-tgt-usw2", dmsKinesisRoleArn: WEST_ROLE,
      },
    },
  };
  // 数据源行:执行区的带归属章;主控区的存量行没有章
  h.ddb.get(TABLES.DATASOURCES)!.set("ds_west", { userId: "default-user", datasourceId: "ds_west", type: "mysql", host: "db.west.internal", port: 3306, database: "gamedata", secretArn: WEST_SRC_SECRET, ownerTargetId: WEST_TARGET });
  h.ddb.get(TABLES.DATASOURCES)!.set("ds_home", { userId: "default-user", datasourceId: "ds_home", type: "mysql", host: "db.home.internal", port: 3306, database: "gamedata", secretArn: HOME_SRC_SECRET });
  __resetRegionCache();
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

const T_WEST = "sync_01JCWEST0000000000000000AA";
const T_WEST2 = "sync_01JCWEST0000000000000000BB";
const T_HOME = "sync_01JCHOME0000000000000000CC";

describe("🔴🔴 装配层:执行区的 DMS 任务,通道整条建在执行区", () => {
  it("① 启动 ⇒ 每个云调用都在执行区;实例 / 端点 / 复制任务 / 专用用户 / schema / 密钥 / 角色关联用的全是该区的名字与凭证;主控区零调用、零对象", async () => {
    seedTask(T_WEST, WEST_TARGET, "ds_west");
    await start(T_WEST);

    // 一个都没打到别的区
    expect(h.calls.length).toBeGreaterThan(20);
    expect(h.calls.filter((c) => c.region !== WEST)).toEqual([]);
    for (const svc of ["dms", "ec2", "secrets", "redshift-serverless", "redshift-data"]) {
      expect(callsIn(WEST).some((c) => c.svc === svc), `${svc} 在执行区一次都没调`).toBe(true);
    }
    // 该区的对象
    const west = h.regions[WEST];
    expect(west.instance).toMatchObject({ id: "bgp-dms-tgt-usw2", status: "available", subnetGroup: "bgp-dms-subnet-group-tgt-usw2", sgIds: ["sg-west"] });
    expect([...west.endpoints.keys()].sort()).toEqual([`bgp-src-${shortOf(T_WEST)}`, `bgp-tgt-${shortOf(T_WEST)}`]);
    expect(west.tasks.size).toBe(1);
    expect(taskRow(T_WEST).realtimeConfig.replicationTaskArn).toContain(`:dms:${WEST}:`);
    // 目标端点:该区的密钥 / 角色 / 暂存桶 / 库
    const target = west.endpoints.get(`bgp-tgt-${shortOf(T_WEST)}`)!.input;
    expect(target.RedshiftSettings).toMatchObject({
      SecretsManagerSecretId: "bgp/dms/redshift-target", SecretsManagerAccessRoleArn: WEST_ROLE, ServiceAccessRoleArn: WEST_ROLE,
      DatabaseName: "dev", BucketName: `bgp-datalake-${ACCOUNT}-tgt-usw2`,
    });
    // 源端点:连接信息取自该区的数据源行与该区的源库密钥
    const source = west.endpoints.get(`bgp-src-${shortOf(T_WEST)}`)!.input;
    expect(source).toMatchObject({ ServerName: "db.west.internal", Port: 3306, Username: "app" });
    // 数仓:专用用户与 schema 建在该区,凭该区的管理员凭证
    expect(west.sql.map((s) => s.sql)).toEqual([
      `CREATE USER "dms_ingest" PASSWORD '<redacted>' CREATEDB`,
      `CREATE SCHEMA IF NOT EXISTS "gamedata" AUTHORIZATION "dms_ingest"`,
    ]);
    expect(new Set(west.sql.map((s) => s.secretArn))).toEqual(new Set([WEST_ADMIN]));
    // 密钥:完整连接字段,写在该区
    const ingest = west.secrets["bgp/dms/redshift-target"];
    expect(ingest.value).toMatchObject({ username: "dms_ingest", host: "bgp-workgroup-tgt-usw2.west.example", port: 5439, database: "dev" });
    expect(String(ingest.value.password).length).toBeGreaterThanOrEqual(16);
    expect(west.namespaces["bgp-namespace-tgt-usw2"]).toEqual([WEST_ROLE]);
    // 主控区:什么都没有
    const home = h.regions[HOME];
    expect(home.instance).toBeNull();
    expect(home.endpoints.size + home.tasks.size + home.sql.length).toBe(0);
    expect(home.secrets["bgp/dms/redshift-target"]).toBeUndefined();
    expect(home.namespaces).toEqual({});
    // 审计记了意图与结果、点名执行环境;口令不在审计里,也不在运行日志里
    expect(h.audits.map((a) => a.action)).toEqual(expect.arrayContaining([
      "exec-env.admin-ddl.provision-dms-ingest-user.intent", "exec-env.admin-ddl.provision-dms-ingest-user.done",
    ]));
    expect(h.audits.every((a) => a.opts?.detail?.targetId === WEST_TARGET)).toBe(true);
    expect(JSON.stringify(h.audits)).not.toContain(String(ingest.value.password));
    expect(JSON.stringify(h.runs)).not.toContain(String(ingest.value.password));
    expect(JSON.stringify(taskRow(T_WEST))).not.toContain(String(ingest.value.password));
    // 运行行的章 = 任务真正跑的那个区(任务监控的「区域」列、按执行范围过滤、多区看板都读它);启动时收口旧运行行补的章同样
    const westRuns = h.runs.filter((r) => r.taskId === T_WEST);
    expect(westRuns.length).toBeGreaterThan(0);
    expect(westRuns.map((r) => r.stamp?.targetId)).toEqual(westRuns.map(() => WEST_TARGET));
    const westSettles = h.settles.filter((x) => x.taskId === T_WEST);
    expect(westSettles.length).toBeGreaterThan(0);
    expect(westSettles.map((x) => x.stamp?.targetId)).toEqual(westSettles.map(() => WEST_TARGET));
    // 详情页读状态:同样去执行区问
    h.calls.length = 0;
    const st = await getReplicationStatus(await resolveDmsSite(taskRow(T_WEST)), taskRow(T_WEST).realtimeConfig.replicationTaskArn);
    expect(st?.status).toBe("running");
    expect(await taskStatuses(WEST)).toEqual(["running"]);
    expect(h.calls.filter((c) => c.region !== WEST)).toEqual([]);
  });

  it("② 同一个区第二条任务启动 ⇒ 密钥沿用(不再建 / 改用户,不再写密钥),实例沿用;只多出它自己的端点与复制任务", async () => {
    seedTask(T_WEST, WEST_TARGET, "ds_west");
    seedTask(T_WEST2, WEST_TARGET, "ds_west");
    await start(T_WEST);
    const password = h.regions[WEST].secrets["bgp/dms/redshift-target"].value.password;
    h.calls.length = 0;
    await start(T_WEST2);
    const west = h.regions[WEST];
    expect(west.sql.filter((s) => /^(CREATE|ALTER) USER/.test(s.sql))).toHaveLength(1);
    expect(callsIn(WEST).filter((c) => c.op === "PutSecret")).toEqual([]);
    expect(west.secrets["bgp/dms/redshift-target"].value.password).toBe(password);
    expect(ops(WEST)).not.toContain("CreateReplicationInstance");
    expect(west.instanceGen).toBe(1);
    expect(west.endpoints.size).toBe(4);
    expect(await taskStatuses(WEST)).toEqual(["running", "running"]);
    expect(h.calls.filter((c) => c.region !== WEST)).toEqual([]);
  });
});

describe("🔴🔴 装配层:两个区各有一条任务,停止 / 删除 / 回收互不影响", () => {
  async function bothRunning() {
    seedTask(T_WEST, WEST_TARGET, "ds_west");
    seedTask(T_HOME, "tgt_home", "ds_home");
    await start(T_WEST);
    h.calls.length = 0;
    await start(T_HOME);
    // 对照:主控区任务的运行行章是主控区(章跟着任务的区走,不是恒等于某个值)
    const homeRuns = h.runs.filter((r) => r.taskId === T_HOME);
    expect(homeRuns.length).toBeGreaterThan(0);
    expect(homeRuns.map((r) => r.stamp?.targetId)).toEqual(homeRuns.map(() => "tgt_home"));
    // 主控区任务的启动同样一个都没打到执行区,名字是主控区的
    expect(h.calls.filter((c) => c.region !== HOME)).toEqual([]);
    expect(h.regions[HOME].instance).toMatchObject({ id: "bgp-dms", subnetGroup: "bgp-dms-subnet-group", sgIds: ["sg-home"] });
    expect(h.regions[HOME].endpoints.get(`bgp-tgt-${shortOf(T_HOME)}`)!.input.RedshiftSettings).toMatchObject({
      SecretsManagerSecretId: "bgp/dms/redshift-target", ServiceAccessRoleArn: HOME_ROLE, BucketName: `bgp-datalake-${ACCOUNT}`, DatabaseName: "dev",
    });
    expect(new Set(h.regions[HOME].sql.map((s) => s.secretArn))).toEqual(new Set([HOME_ADMIN]));
    h.calls.length = 0; h.audits.length = 0;
  }
  const snapshot = (region: string) => {
    const b = h.regions[region];
    return { instance: b.instance && { id: b.instance.id, arn: b.instance.arn, status: b.instance.status }, endpoints: [...b.endpoints.keys()].sort(), tasks: [...b.tasks.values()].map((t) => `${t.ident}:${t.status}`) };
  };

  it("③ 执行区任务「停止」⇒ 只动执行区:复制任务停稳、端点保留;主控区零调用、原封不动", async () => {
    await bothRunning();
    const homeBefore = snapshot(HOME);
    const td = await settle(() => teardownSyncChannel(taskRow(T_WEST) as never, { purge: false, waitMs: TEARDOWN_LONG_OP_WAIT_MS }));
    expect(td.hardFailures).toEqual([]);
    expect(td.dms).toMatchObject({ found: true, stopped: true });
    expect(ops(WEST)).toContain("StopReplicationTask");
    expect(callsIn(HOME)).toEqual([]);
    expect([...h.regions[WEST].tasks.values()].map((t) => t.status)).toEqual(["stopped"]);
    expect(h.regions[WEST].endpoints.size).toBe(2);
    expect(snapshot(HOME)).toEqual(homeBefore);
  });

  it("③b 执行区任务「删除」⇒ 回收作业等复制任务从 DMS 消失才清它的两个端点,过了空闲宽限才删该区的实例;全程主控区零调用、原封不动", async () => {
    await bothRunning();
    const homeBefore = snapshot(HOME);
    const job = await deleteTask(T_WEST);
    expect(job).toMatchObject({ kind: "dms-instance-reclaim", targetId: WEST_TARGET, state: { region: WEST, instanceId: "bgp-dms-tgt-usw2", reason: "task-deleted" } });
    expect([...h.regions[WEST].tasks.values()].map((t) => t.status)).toEqual(["deleting"]);

    // 第一步(刚删完):复制任务还在「删除中」⇒ 端点一个不删
    const first = await pump(job, 9_000);
    expect(first.next.kind).toBe("wait");
    expect(first.evidence).toMatchObject({ endpointsPending: [`bgp-src-${shortOf(T_WEST)}`, `bgp-tgt-${shortOf(T_WEST)}`] });
    expect(ops(WEST)).not.toContain("DeleteEndpoint");
    expect(h.regions[WEST].endpoints.size).toBe(2);
    // 之后的几步:复制任务消失 ⇒ 端点被清;实例上零任务但还没过空闲宽限 ⇒ 不删实例
    let r = first;
    for (let i = 1; i <= 4 && h.regions[WEST].endpoints.size > 0; i++) r = await pump(job, 9_000 + i * 60_000);
    expect(h.regions[WEST].tasks.size).toBe(0);
    expect(h.regions[WEST].endpoints.size).toBe(0);
    expect(r.evidence).toMatchObject({ endpointsDeleted: [`bgp-src-${shortOf(T_WEST)}`, `bgp-tgt-${shortOf(T_WEST)}`] });
    const idle = await pump(job, 6 * 60_000);
    expect(idle.next.kind).toBe("wait");
    expect(idle.evidence).toMatchObject({ waitingFor: "idle-grace" });
    expect(ops(WEST)).not.toContain("DeleteReplicationInstance");
    // 过了宽限 ⇒ 删实例
    const last = await pump(job, DMS_INSTANCE_IDLE_GRACE_MS + 60_000);
    expect(last.next).toEqual({ kind: "succeeded" });
    expect(last.evidence).toMatchObject({ outcome: "deleted", instanceId: "bgp-dms-tgt-usw2", region: WEST });
    expect(h.regions[WEST].instance?.status).toBe("deleting");
    // 审计:清端点、回收实例各一条,都点名执行区
    const swept = h.audits.filter((a) => a.action === DMS_ENDPOINT_SWEEP_AUDIT_ACTION);
    expect(swept).toHaveLength(1);
    expect(swept[0].opts.detail).toMatchObject({ region: WEST, targetId: WEST_TARGET });
    expect(h.audits.filter((a) => a.action === DMS_RECLAIM_AUDIT_ACTION).map((a) => a.opts.detail.region)).toEqual([WEST]);
    // 主控区:零调用,实例 / 端点 / 运行中的任务原封不动
    expect(callsIn(HOME)).toEqual([]);
    expect(snapshot(HOME)).toEqual(homeBefore);
  });

  it("③c 反过来:删主控区的任务 ⇒ 只动主控区;执行区零调用、那边的任务照常运行", async () => {
    await bothRunning();
    const westBefore = snapshot(WEST);
    const job = await deleteTask(T_HOME);
    expect(job).toMatchObject({ targetId: "tgt_home", state: { region: HOME, instanceId: "bgp-dms" } });
    for (let i = 0; i <= 4 && h.regions[HOME].endpoints.size > 0; i++) await pump(job, 9_000 + i * 60_000);
    expect(h.regions[HOME].endpoints.size).toBe(0);
    const last = await pump(job, DMS_INSTANCE_IDLE_GRACE_MS + 60_000);
    expect(last.evidence).toMatchObject({ outcome: "deleted", instanceId: "bgp-dms", region: HOME });
    expect(callsIn(WEST)).toEqual([]);
    expect(snapshot(WEST)).toEqual(westBefore);
  });

  it("④ 执行区的实例被回收之后,在该区再建一条任务并启动 ⇒ 重新懒创建实例(新的一台),照样走到运行中;密钥沿用", async () => {
    seedTask(T_WEST, WEST_TARGET, "ds_west");
    await start(T_WEST);
    const job = await deleteTask(T_WEST);
    for (let i = 0; i <= 4 && h.regions[WEST].endpoints.size > 0; i++) await pump(job, 9_000 + i * 60_000);
    const last = await pump(job, DMS_INSTANCE_IDLE_GRACE_MS + 60_000);
    expect(last.evidence).toMatchObject({ outcome: "deleted" });
    const firstArn = h.regions[WEST].instance!.arn;
    // 再创建 / 再启动(实例此刻还在「删除中」:启动照常受理,等它删完再重建)
    h.calls.length = 0;
    seedTask(T_WEST2, WEST_TARGET, "ds_west");
    await start(T_WEST2);
    const west = h.regions[WEST];
    expect(west.instance).toMatchObject({ id: "bgp-dms-tgt-usw2", status: "available" });
    expect(west.instance!.arn).not.toBe(firstArn);
    expect(await taskStatuses(WEST)).toEqual(["running"]);
    expect([...west.tasks.values()].map((t) => t.instanceArn)).toEqual([west.instance!.arn]);
    expect(west.sql.filter((s) => /^(CREATE|ALTER) USER/.test(s.sql))).toHaveLength(1);
    expect(h.calls.filter((c) => c.region !== WEST)).toEqual([]);
  });
});

describe("🔴🔴 装配层:沿用的源端点跟着数据源的现值走", () => {
  const srcEndpoint = () => h.regions[WEST].endpoints.get(`bgp-src-${shortOf(T_WEST)}`)!;
  const dmsOps = () => ops(WEST);
  beforeEach(() => {
    // 该区连得上两台源库:原来那台,和用户之后要换过去的那台
    h.regions[WEST].sourceTruth = {
      "db.west.internal": { username: "app", password: "src-west-pw" },
      "db-new.west.internal": { username: "app2", password: "src-west-pw-2" },
    };
    seedTask(T_WEST, WEST_TARGET, "ds_west");
  });

  it("⑤ 停止后改了数据源(换主机、换账号口令)再启动 ⇒ 源端点按现值更新、在该区重新测连通性,任务回到运行中;端点还是原来那一个", async () => {
    await start(T_WEST);
    const arn = srcEndpoint().arn;
    expect(srcEndpoint().input).toMatchObject({ ServerName: "db.west.internal", Username: "app", Password: "src-west-pw" });
    await stop(T_WEST);
    editDatasource(WEST, "ds_west", { host: "db-new.west.internal", username: "app2", password: "src-west-pw-2" });

    h.calls.length = 0;
    await start(T_WEST);
    expect(srcEndpoint().arn).toBe(arn);
    expect(srcEndpoint().input).toMatchObject({ ServerName: "db-new.west.internal", Port: 3306, Username: "app2", Password: "src-west-pw-2" });
    // 改完之后重新测了一次源端(上一次的「成功」是旧主机测出来的),然后才启动复制任务
    const seq = dmsOps();
    const iModify = seq.indexOf("ModifyEndpoint");
    expect(iModify).toBeGreaterThan(-1);
    expect(seq.indexOf("TestConnection", iModify)).toBeGreaterThan(iModify);
    expect(seq.indexOf("StartReplicationTask")).toBeGreaterThan(seq.indexOf("TestConnection", iModify));
    expect(seq).not.toContain("CreateEndpoint");
    expect(h.regions[WEST].conns.get(arn)).toMatchObject({ status: "successful" });
    expect(await taskStatuses(WEST)).toEqual(["running"]);
    expect(h.calls.filter((c) => c.region !== WEST)).toEqual([]);
    // 口令不进任务行与运行日志
    expect(JSON.stringify(taskRow(T_WEST))).not.toContain("src-west-pw-2");
    expect(JSON.stringify(h.runs)).not.toContain("src-west-pw-2");
  });

  it("⑤b 第一次启动因为数据源的主机填错而失败 ⇒ 把数据源改对之后再点一次「启动」就成(此前端点里一直是错的主机,点多少次都一样)", async () => {
    editDatasource(WEST, "ds_west", { host: "db-typo.west.internal" });
    const failed = await clickStart(T_WEST);
    expect(failed.status).toBe("error");
    expect(String(failed.realtimeConfig?.error)).toContain("源=failed(Error Details: [message=Unknown MySQL server host 'db-typo.west.internal'");
    expect(dmsOps()).not.toContain("StartReplicationTask");

    editDatasource(WEST, "ds_west", { host: "db.west.internal" });
    h.calls.length = 0;
    await start(T_WEST);
    expect(srcEndpoint().input).toMatchObject({ ServerName: "db.west.internal" });
    expect(await taskStatuses(WEST)).toEqual(["running"]);
    expect(dmsOps().filter((op) => op === "StartReplicationTask")).toHaveLength(1);
  });

  it("⑤c 停止后把数据源的口令改错了再启动 ⇒ 如实失败并带上 DMS 给的失败原文;不拿旧口令测出来的「成功」放行,复制任务没有被启动", async () => {
    await start(T_WEST);
    await stop(T_WEST);
    editDatasource(WEST, "ds_west", { password: "wrong-pw" });

    h.calls.length = 0;
    const failed = await clickStart(T_WEST);
    expect(failed.status).toBe("error");
    expect(String(failed.realtimeConfig?.error)).toContain("源=failed(Error Details: [message=Access denied for user 'app'");
    expect(String(failed.realtimeConfig?.error)).toContain("目标=successful");
    expect(dmsOps()).toContain("ModifyEndpoint");
    expect(dmsOps()).not.toContain("StartReplicationTask");
    expect([...h.regions[WEST].tasks.values()].map((t) => t.status)).toEqual(["stopped"]);
    expect(JSON.stringify(failed)).not.toContain("wrong-pw");
  });

  it("⑤e 源端第一次测失败之后,重测到启动超时都还停在「测试中」⇒ 任务错误里仍是那次失败的原文(不是一句「源=testing」)", async () => {
    editDatasource(WEST, "ds_west", { host: "db-typo.west.internal" });
    h.regions[WEST].slowRetests = true;
    const failed = await clickStart(T_WEST);
    expect(failed.status).toBe("error");
    expect(h.regions[WEST].conns.get(srcEndpoint().arn)).toMatchObject({ status: "testing" });
    expect(String(failed.realtimeConfig?.error)).toContain("源=failed(Error Details: [message=Unknown MySQL server host 'db-typo.west.internal'");
    const runLogs = h.runs.filter((r) => r.taskId === T_WEST).flatMap((r) => (r.extra?.logs as string[] | undefined) ?? []).join("\n");
    expect(runLogs).toContain("Unknown MySQL server host 'db-typo.west.internal'");
  });

  it("⑤d 没改数据源的再启动 ⇒ 端点的连接配置与原来逐项相同,照常回到运行中", async () => {
    await start(T_WEST);
    const before = { ...srcEndpoint().input };
    await stop(T_WEST);
    await start(T_WEST);
    expect(srcEndpoint().input).toEqual(before);
    expect(await taskStatuses(WEST)).toEqual(["running"]);
  });
});

describe("🔴🔴 装配层:目标端连不上时,重设专用用户口令至多一次", () => {
  const alterCount = () => h.regions[WEST].sql.filter((x) => /^ALTER USER "dms_ingest" PASSWORD/.test(x.sql)).length;
  const logsOf = (taskId: string) => h.runs.filter((r) => r.taskId === taskId).flatMap((r) => (r.extra?.logs as string[] | undefined) ?? []);

  it("⑥ 密钥里的口令与数仓里的真口令对不上(数仓被从快照恢复)⇒ 启动只点一次:自己重设口令、覆盖密钥、重新测,走到运行中", async () => {
    seedTask(T_WEST, WEST_TARGET, "ds_west");
    await start(T_WEST);
    const west = h.regions[WEST];
    const oldSecret = String(west.secrets["bgp/dms/redshift-target"].value.password);
    west.userPasswords.dms_ingest = "password-from-an-old-snapshot";

    h.calls.length = 0;
    seedTask(T_WEST2, WEST_TARGET, "ds_west");
    await start(T_WEST2);
    expect(alterCount()).toBe(1);
    expect(callsIn(WEST).filter((c) => c.op === "PutSecret")).toHaveLength(1);
    const newSecret = String(west.secrets["bgp/dms/redshift-target"].value.password);
    expect(newSecret).not.toBe(oldSecret);
    expect(west.userPasswords.dms_ingest).toBe(newSecret);
    expect(await taskStatuses(WEST)).toEqual(["running", "running"]);
    expect(logsOf(T_WEST2).join("\n")).toContain("已重设目标专用用户的口令");
    expect(JSON.stringify(h.runs)).not.toContain(newSecret);
    expect(JSON.stringify(h.audits)).not.toContain(newSecret);
    expect(h.calls.filter((c) => c.region !== WEST)).toEqual([]);
  });

  it("⑥c 目标端上留着一次**这次启动之前**的失败结论(口令其实没问题)⇒ 不据此动口令:重新测、通过、运行中;同区正在跑的通道读的那份密钥原样不动", async () => {
    seedTask(T_WEST, WEST_TARGET, "ds_west");
    await start(T_WEST);
    await stop(T_WEST);
    const west = h.regions[WEST];
    const secret = String(west.secrets["bgp/dms/redshift-target"].value.password);
    const targetArn = west.endpoints.get(`bgp-tgt-${shortOf(T_WEST)}`)!.arn;
    west.conns.set(targetArn, { status: "failed", reads: 0, failure: "Error Details: [message=Timeout expired, errType=, status=0]" });

    h.calls.length = 0;
    await start(T_WEST);
    expect(alterCount()).toBe(0);
    expect(callsIn(WEST).filter((c) => c.op === "PutSecret")).toEqual([]);
    expect(String(west.secrets["bgp/dms/redshift-target"].value.password)).toBe(secret);
    expect(west.conns.get(targetArn)).toMatchObject({ status: "successful" });
    expect(await taskStatuses(WEST)).toEqual(["running"]);
  });

  it("⑥b 重设之后目标端还是连不上(密钥被换成了平台管不着的内容)⇒ 只重设一次,如实失败并带 DMS 的失败原文;复制任务没有被启动", async () => {
    seedTask(T_WEST, WEST_TARGET, "ds_west");
    await start(T_WEST);
    const west = h.regions[WEST];
    // 之后每一次往密钥里写,落进去的都不是数仓里的真口令(外部把这份密钥接管了)
    const real = west.secrets;
    west.secrets = new Proxy(real, {
      set(obj, key, value) { obj[String(key)] = String(key) === "bgp/dms/redshift-target" ? { ...value, value: { ...value.value, password: "overwritten-elsewhere" } } : value; return true; },
    });
    west.secrets["bgp/dms/redshift-target"] = real["bgp/dms/redshift-target"];

    h.calls.length = 0;
    seedTask(T_WEST2, WEST_TARGET, "ds_west");
    const failed = await clickStart(T_WEST2);
    expect(failed.status).toBe("error");
    expect(String(failed.realtimeConfig?.error)).toContain('目标=failed(Error Details: [message=FATAL: password authentication failed for user "dms_ingest"');
    expect(alterCount()).toBe(1);
    expect(ops(WEST).filter((op) => op === "StartReplicationTask")).toEqual([]);
    expect(String(failed.realtimeConfig?.error)).not.toContain("overwritten-elsewhere");
  });
});

describe("🔴🔴 装配层:读状态也去任务绑定的那个区问", () => {
  async function detailStatus(taskId: string) {
    const { GET } = await import("@/app/api/sync/[id]/realtime-status/route");
    const res = await GET(new Request("http://x/api/sync/x/realtime-status") as never, { params: Promise.resolve({ id: taskId }) } as never);
    return { status: res.status, body: await res.json() };
  }

  it("⑦ 执行区任务的详情状态 ⇒ 回的是执行区那条复制任务的真实状态(不是 unknown);查询全在执行区,主控区零调用", async () => {
    seedTask(T_WEST, WEST_TARGET, "ds_west");
    await start(T_WEST);
    h.calls.length = 0;
    const r = await detailStatus(T_WEST);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ provisioned: true, status: "running" });
    expect(ops(WEST)).toContain("DescribeReplicationTasks");
    expect(h.calls.filter((c) => c.region !== WEST)).toEqual([]);
  });

  it("⑦b 执行区任务在 DMS 里失败了 ⇒ 列表对账把这一行改成失败并带上 DMS 的原文;查询打在执行区,主控区零调用", async () => {
    seedTask(T_WEST, WEST_TARGET, "ds_west");
    await start(T_WEST);
    await taskStatuses(WEST);
    const repl = [...h.regions[WEST].tasks.values()][0];
    repl.status = "failed";
    repl.lastFailure = "Last Error  Binary Logging must be enabled for MySQL server";
    h.calls.length = 0;

    const out = await reconcileSyncTask(taskRow(T_WEST) as never);
    expect(out.status).toBe("failed");
    expect(taskRow(T_WEST)).toMatchObject({ status: "failed", realtimeConfig: { error: "Last Error  Binary Logging must be enabled for MySQL server" } });
    expect(ops(WEST)).toEqual(["DescribeReplicationTasks"]);
    expect(h.calls.filter((c) => c.region !== WEST)).toEqual([]);
    // 详情页同一时刻读到的也是失败
    expect((await detailStatus(T_WEST)).body.data).toMatchObject({ provisioned: true, status: "failed" });
  });

  it("⑦c 主控区任务照旧:详情状态与列表对账都只问主控区", async () => {
    seedTask(T_HOME, "tgt_home", "ds_home");
    await start(T_HOME);
    h.calls.length = 0;
    expect((await detailStatus(T_HOME)).body.data).toMatchObject({ provisioned: true, status: "running" });
    expect((await reconcileSyncTask(taskRow(T_HOME) as never)).status).toBe("running");
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.filter((c) => c.region !== HOME)).toEqual([]);
  });
});
