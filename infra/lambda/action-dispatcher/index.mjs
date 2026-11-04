// @kf-batch 50-WP28-platform-action-node
// 平台动作命令的**分发 Lambda**(主控区,平台 VPC 内)。用户 2026-09-20 拍板:消费端 = 主控区 Lambda。
//
// 链路:执行区 DAG 的 platform-action 节点 → 主控区 DDB 表 bgp-action-commands(INSERT, status=pending)
//       → DynamoDB Streams(事件过滤只收 INSERT)→ **本函数** → 平台内部端点 POST /api/internal/actions/run {commandId}
//       → 平台校验 + 抢单 + 后台执行(终态由平台写回命令行)→ DAG 轮询到终态。
//
// 🔴 本函数**不做任何业务**:只把 commandId 转交平台(动作永远只有一个作者 = 平台自己的库函数)。
// 🔴 它怎么到达平台:ALB 是 internet-facing,公网 DNS 解析出的是公网地址(从 VPC 内走会绕 NAT,源地址变成
//    NAT 的公网 IP,安全组认不出来)⇒ 本函数按 ALB 的网卡描述(`ELB app/<name>/<id>`)查出 ALB 在本 VPC 的
//    **私网地址**直连;ALB 的安全组单独给本函数的安全组开了 80 入站。HTTP 走 VPC 内网,不出公网。
// 🔴 鉴权:请求头带 Secrets Manager 里那份共享密钥 + 来源声明头(平台侧 internal-guard 校验);
//    请求里**只有 commandId**,动作 / 参数平台自己从命令行读。
// 🔴 失败语义:平台回 202(已受理)/ 409(已被处理)/ 403·404·400(平台已把命令判 failed 或命令不存在)⇒ 完成;
//    网络错 / 5xx / 401 ⇒ 换一个 ALB 地址重试,最多 3 轮;仍不成 ⇒ **把命令判 failed 并写清原因**
//    (条件写:只在仍是 pending 时)—— DAG 那头立刻看到真因,不用白等抢单时限。
//
// 纯函数与 AWS 调用分开(`makeHandler(deps)`),离线判据 infra/test/action-dispatcher/ 注入假依赖真跑。
import http from "node:http";

export const INTERNAL_PATH = "/api/internal/actions/run";
export const INTERNAL_KEY_HEADER = "x-bgp-internal-key";
export const INTERNAL_SOURCE_HEADER = "x-bgp-internal-source";
export const INTERNAL_SOURCE = "action-dispatcher";
const DONE_STATUSES = new Set([202, 409, 403, 404, 400]);
const ATTEMPTS = 3;

/** Streams 事件 → 待分发的 commandId(只要 INSERT 且 status=pending 的;其余一律忽略)。 */
export function pendingCommandIds(event) {
  const out = [];
  for (const r of event?.Records ?? []) {
    if (r?.eventName !== "INSERT") continue;
    const img = r?.dynamodb?.NewImage ?? {};
    const id = img?.commandId?.S;
    if (typeof id !== "string" || !id) continue;
    if (img?.status?.S !== "pending") continue;
    out.push(id);
  }
  return out;
}

/** ALB 网卡 → 私网地址(描述形如 `ELB app/<name>/<id>`)。 */
export function albPrivateIps(networkInterfaces) {
  return (networkInterfaces ?? [])
    .filter((n) => n?.Status === "in-use" || n?.Status === undefined)
    .map((n) => n?.PrivateIpAddress)
    .filter((ip) => typeof ip === "string" && ip.length > 0)
    .sort();
}

function defaultPost({ ip, port, key, body, timeoutMs }) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: ip,
        port,
        path: INTERNAL_PATH,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          [INTERNAL_KEY_HEADER]: key,
          [INTERNAL_SOURCE_HEADER]: INTERNAL_SOURCE,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, text: String(e?.message ?? e) }));
    req.end(data);
  });
}

/**
 * @param deps.getKey()            读共享密钥(带缓存)
 * @param deps.getAlbIps()         ALB 私网地址列表(带缓存)
 * @param deps.post({ip,port,key,body,timeoutMs}) → {status,text}
 * @param deps.failCommand(commandId, reason)  条件写 pending → failed
 * @param deps.sleep(ms)
 */
export function makeHandler(deps) {
  const port = Number(deps.port ?? 80);
  const timeoutMs = Number(deps.timeoutMs ?? 20000);
  const post = deps.post ?? defaultPost;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function dispatchOne(commandId) {
    let last = "";
    for (let round = 0; round < ATTEMPTS; round++) {
      let key, ips;
      try {
        key = await deps.getKey(round > 0);
        ips = await deps.getAlbIps(round > 0);
      } catch (e) {
        last = `读密钥 / 查 ALB 地址失败:${String(e?.message ?? e)}`;
        await sleep(1000 * (round + 1));
        continue;
      }
      if (!ips.length) {
        last = "查不到 ALB 的私网地址(网卡描述 ELB app/... 无匹配)";
        await sleep(1000 * (round + 1));
        continue;
      }
      for (const ip of ips) {
        const r = await post({ ip, port, key, body: { commandId }, timeoutMs });
        if (DONE_STATUSES.has(r.status)) return { commandId, status: r.status };
        last = `平台内部端点 ${ip} 回 ${r.status || "网络错误"}:${String(r.text || "").slice(0, 300)}`;
      }
      await sleep(1000 * (round + 1));
    }
    const reason = `分发 Lambda 没能把命令交给平台(${ATTEMPTS} 轮重试):${last}`;
    await deps.failCommand(commandId, reason);
    return { commandId, status: "failed", reason };
  }

  return async function handler(event) {
    const ids = pendingCommandIds(event);
    const results = [];
    for (const id of ids) results.push(await dispatchOne(id));
    console.log(JSON.stringify({ dispatched: results }));
    // 🔴 不回 batchItemFailures:每条要么交给了平台,要么已被判 failed —— Streams 重放只会制造重复
    return { batchItemFailures: [] };
  };
}

/** 真依赖(只在 Lambda 里用;离线判据注入假的)。 */
export function defaultDeps(env = process.env) {
  let keyCache = null;
  let ipCache = null;
  const TTL = 5 * 60 * 1000;
  let sdk = null;
  const load = async () => {
    if (sdk) return sdk;
    const [{ SecretsManagerClient, GetSecretValueCommand }, { EC2Client, DescribeNetworkInterfacesCommand }, { DynamoDBClient, UpdateItemCommand }] =
      await Promise.all([import("@aws-sdk/client-secrets-manager"), import("@aws-sdk/client-ec2"), import("@aws-sdk/client-dynamodb")]);
    sdk = {
      sm: new SecretsManagerClient({}),
      ec2: new EC2Client({}),
      ddb: new DynamoDBClient({}),
      GetSecretValueCommand,
      DescribeNetworkInterfacesCommand,
      UpdateItemCommand,
    };
    return sdk;
  };
  return {
    port: env.PLATFORM_PORT || 80,
    async getKey(force) {
      if (!force && keyCache && Date.now() - keyCache.at < TTL) return keyCache.v;
      const s = await load();
      const r = await s.sm.send(new s.GetSecretValueCommand({ SecretId: env.SECRET_ARN }));
      keyCache = { v: String(r.SecretString || ""), at: Date.now() };
      return keyCache.v;
    },
    async getAlbIps(force) {
      if (!force && ipCache && Date.now() - ipCache.at < TTL) return ipCache.v;
      const s = await load();
      const r = await s.ec2.send(
        new s.DescribeNetworkInterfacesCommand({ Filters: [{ Name: "description", Values: [`ELB ${env.LB_FULL_NAME}`] }] })
      );
      ipCache = { v: albPrivateIps(r.NetworkInterfaces), at: Date.now() };
      return ipCache.v;
    },
    async failCommand(commandId, reason) {
      const s = await load();
      try {
        await s.ddb.send(
          new s.UpdateItemCommand({
            TableName: env.TABLE_NAME,
            Key: { commandId: { S: commandId } },
            UpdateExpression: "SET #s = :failed, finishedAt = :t, #e = :err",
            ConditionExpression: "#s = :pending",
            ExpressionAttributeNames: { "#s": "status", "#e": "error" },
            ExpressionAttributeValues: {
              ":failed": { S: "failed" },
              ":pending": { S: "pending" },
              ":t": { S: new Date().toISOString() },
              ":err": { S: reason.slice(0, 1000) },
            },
          })
        );
      } catch (e) {
        if (e?.name !== "ConditionalCheckFailedException") throw e;
      }
    },
  };
}

let _handler = null;
export async function handler(event) {
  if (!_handler) _handler = makeHandler(defaultDeps());
  return _handler(event);
}
