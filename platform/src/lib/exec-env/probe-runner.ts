// 执行环境**真实探活**(DESIGN §4.1 step4 / INTERACTION §1.3:探活项由已装 components 集驱动)。
//
// 【本文件的三条承重】
// ① **逐资源真探,不是"栈说建好了就信"**:CFN Outputs 证明"建过",HeadBucket/GetWorkGroup 证明
//    "现在还在且可见" —— 资源可能被人工删掉而栈状态不变(SPEC §3.5:探活为 observed 的来源);
// ② **单项失败不掀翻整轮**:每项各自 catch,产出 `{name, ok:false, error}` —— 一项挂了别的项
//    照样有结论,运维一眼看到红在哪(INTERACTION §1.3:每资源一行 + 红✗带原因);
// ③ **未装组件不探;已装但探活未实现的组件 = 红,不是跳过**:跳过会造出"探过了且全绿"的假象,
//    而 probe.ok 是 `enableTarget` 的前置 —— fail-closed 是这里唯一安全的方向。
import { homeRegion } from "@/lib/place/home-region";
import { S3Client, HeadBucketCommand, GetBucketReplicationCommand } from "@aws-sdk/client-s3";
// residency-api 片 1 的区域表真探
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { S3TablesClient, ListTableBucketsCommand } from "@aws-sdk/client-s3tables";
import { AthenaClient, GetWorkGroupCommand } from "@aws-sdk/client-athena";
// 零出网探活要读路由表 / NAT / 端点(都是**只读**、跨区调用)
import {
  EC2Client,
  DescribeSecurityGroupsCommand,
  DescribeRouteTablesCommand,
  DescribeNatGatewaysCommand,
  // 形态从「跨区端点」换成「跨区 peering」⇒ 这里不再读端点
  //   (DescribeVpcEndpoints 随之从探活的授权面里撤掉,见 infra/iam/platform-taskrole-calls.json)
  DescribeVpcPeeringConnectionsCommand,
} from "@aws-sdk/client-ec2";
import { Route53Client, ListResourceRecordSetsCommand, GetHostedZoneCommand } from "@aws-sdk/client-route-53";
import { IAMClient, GetRoleCommand } from "@aws-sdk/client-iam";
import { RedshiftServerlessClient, GetWorkgroupCommand } from "@aws-sdk/client-redshift-serverless";
// 候选区内在页面新建的执行区不再经 redeploy-platform.sh 放行 ⇒ 该区的 S3 Tables 联邦目录由「检测初始化」幂等开通(作者仍是那一个函数)
import { GlueClient } from "@aws-sdk/client-glue";
import { ensureS3TablesFederatedCatalog, S3TABLES_FEDERATED_CATALOG_ID } from "@/lib/aws/s3tables-catalog";
import { MWAAClient, GetEnvironmentCommand } from "@aws-sdk/client-mwaa";
import { DatabaseMigrationServiceClient, DescribeReplicationSubnetGroupsCommand } from "@aws-sdk/client-database-migration-service";
import {
  BedrockAgentCoreControlClient, GetAgentRuntimeCommand, GetMemoryCommand, GetGatewayCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { ExecutionTarget } from "@/lib/exec-env/registry";
import type { ProbeResult } from "@/lib/exec-env/registry";
// 执行角色键的 SSOT 判据(角色名必须是本 target 名)
import { expectedExecRoleName, isExecRoleResourceKey, roleNameOfArn, type ExecRoleResourceKey } from "@/lib/exec-env/exec-roles";
import { isHome } from "@/lib/exec-env/target-id";
// 散建收口到唯一工厂(数据面凭证注入点只有这一处)
import { sdkClient } from "@/lib/aws/clients";
// 探活是一条请求里第一批打到目标区的调用,落点决策要记在第一个 AWS 调用之前
//   已启用环境的「检测初始化」不需 finalize ⇒ reconcileOneTarget 不经 readBuildStatus(那是此前唯一的记账点)⇒ 整条流程零决策,
//   观测器把 CFN / S3 / EC2 / Redshift / Glue / DMS / Athena 的目标区探活全记成未归因(2026-10-23 测试账号 observe 复验抓到)
import { notePlaceDecision } from "@/lib/place/context";

const HOME_REGION = homeRegion();

/** 落点决策记账里的作者名(观测清单按它归类;判据按它过滤)。 */
export const PROBE_RUNNER_VIA = "runProbe";

type Item = ProbeResult["items"][number];

/** 一项探测:成功 ⇒ ok,任何异常 ⇒ 该项红(带原因),绝不向外抛。 */
async function probeOne(name: string, fn: () => Promise<void>): Promise<Item> {
  try {
    await fn();
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** 资源字段缺失 ⇒ 直接红(描述符没回写完就来探,红得明明白白,而不是拿 undefined 去打 AWS)。 */
/**
 * 探一个 per-target 执行角色:IAM GetRole(全局服务,client 用 home region)+ **角色名 = 命名 SSOT 的本 target 名**
 * (非 home)。🔴 只在描述符**有**该键时才出项:键缺省不出项 —— 「非 home 必须有」这道前置由准入(`hasPerTargetExecRoles`,
 * )判,不由探活判;否则存量 `tgt_usw2_a` 在重新部署前的周期探活会把整个健康 region 探红。
 */
function probeExecRole(target: ExecutionTarget, key: ExecRoleResourceKey, itemName: string, arn: unknown): Promise<Item> | null {
  if (typeof arn !== "string" || !arn) return null;
  return probeOne(itemName, async () => {
    const roleName = roleNameOfArn(arn);
    if (!roleName) throw new Error(`${key} 解析不出角色名:${arn}`);
    if (!isHome(target.targetId)) {
      const expected = expectedExecRoleName(target.targetId, key);
      if (roleName !== expected) throw new Error(`${key} 不是本 target 的角色(期望 ${expected},实为 ${roleName})—— 请重新部署以切换角色`);
    }
    const iam = sdkClient("control-plane", IAMClient, { region: HOME_REGION });
    await iam.send(new GetRoleCommand({ RoleName: roleName }));
  });
}

function missingItem(name: string): Item {
  return { name, ok: false, error: `描述符缺 resources.${name}(先 finalizeTargetResources 回写资源袋)` };
}

/**
 * 按已装 components 逐资源真探。所有 region 级 client 按 `target.region` 现建
 * (IAM 是全局服务,client 用 home region)。
 */
export async function runProbe(target: ExecutionTarget): Promise<ProbeResult> {
  notePlaceDecision({ targetId: target.targetId, via: PROBE_RUNNER_VIA }); // 第一个 await 之前(D11);请求外(周期 reconciler)no-op
  const res = (target.resources ?? {}) as Record<string, unknown>;
  const region = target.region;
  const components = target.components ?? [];
  const jobs: Array<Promise<Item>> = [];

  // ── core(components 必含 core —— 若真缺,产出一条红而不是空结果)────────────
  if (components.includes("core")) {
    // 数据湖直查 / 问数的区级前提:S3 Tables 联邦目录 s3tablescatalog。它不是 CDK 资源,
    //   原来由 redeploy-platform.sh 第 3c 步在「放行」时对每个已注册执行区开通;候选区内的执行区不再经那一步 ⇒ 这里在
    //   「检测初始化」时幂等开通(有则「已在」;无则 CreateCatalog;建不成 ⇒ 本项红并带 aws 原话,不假装绿)。
    //   home 也探(首装 6.3 步已建 ⇒ 恒「已在」)。所用权限 glue:GetCatalog / CreateCatalog / PassConnection 已在 TaskRole 的
    //   execution 轴上(infra/iam/platform-taskrole-calls.json,source = lib/aws/s3tables-catalog.ts),数据面角色是 glue:*。
    jobs.push(
      probeOne("lake:s3tablescatalog", async () => {
        const glue = sdkClient("data-plane", GlueClient, { region });
        // 账号号取描述符(整包校验过的 12 位;与本区表桶同账号),env 只兜存量描述符
        const outcome = await ensureS3TablesFederatedCatalog(glue, { region, accountId: target.accountId || process.env.AWS_ACCOUNT_ID || "" });
        if (outcome !== "existed" && outcome !== "created") {
          throw new Error(`${region} 的联邦目录 ${S3TABLES_FEDERATED_CATALOG_ID} 状态未知(ensure 返回 ${String(outcome)})`);
        }
      })
    );
    const s3 = sdkClient("data-plane", S3Client, { region });
    for (const key of ["datalakeBucket", "scriptsBucket"] as const) {
      const bucket = res[key];
      jobs.push(
        typeof bucket === "string" && bucket
          ? probeOne(key, async () => {
              await s3.send(new HeadBucketCommand({ Bucket: bucket }));
            })
          : Promise.resolve(missingItem(key))
      );
    }

    // S3Tables 表桶:GetTableBucket 需要 ARN,而拼 ARN 又要自己记格式(记错 = 假红)——
    // 用 ListTableBuckets({prefix}) 后**精确匹配名字**,不依赖对 ARN 格式的记忆。
    const tableBucket = res.tableBucket;
    jobs.push(
      typeof tableBucket === "string" && tableBucket
        ? probeOne("tableBucket", async () => {
            const s3t = sdkClient("data-plane", S3TablesClient, { region });
            const out = await s3t.send(new ListTableBucketsCommand({ prefix: tableBucket }));
            const hit = (out.tableBuckets ?? []).some((b) => b.name === tableBucket);
            if (!hit) throw new Error(`S3Tables 表桶 ${tableBucket} 不存在(ListTableBuckets 按前缀未命中精确名)`);
          })
        : Promise.resolve(missingItem("tableBucket"))
    );

    const wg = res.athenaWorkgroup;
    jobs.push(
      typeof wg === "string" && wg
        ? probeOne("athenaWorkgroup", async () => {
            const athena = sdkClient("data-plane", AthenaClient, { region });
            const out = await athena.send(new GetWorkGroupCommand({ WorkGroup: wg }));
            if (out.WorkGroup?.State !== "ENABLED") {
              throw new Error(`workgroup ${wg} 状态 ${out.WorkGroup?.State ?? "未知"}(须 ENABLED)`);
            }
          })
        : Promise.resolve(missingItem("athenaWorkgroup"))
    );

    const sgId = res.emrSecurityGroupId;
    jobs.push(
      typeof sgId === "string" && sgId
        ? probeOne("emrSecurityGroupId", async () => {
            const ec2 = sdkClient("data-plane", EC2Client, { region });
            const out = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }));
            if (!(out.SecurityGroups ?? []).some((g) => g.GroupId === sgId)) {
              throw new Error(`安全组 ${sgId} 不存在`);
            }
          })
        : Promise.resolve(missingItem("emrSecurityGroupId"))
    );

    const glueRoleArn = res.glueRoleArn;
    jobs.push(
      typeof glueRoleArn === "string" && glueRoleArn
        ? probeOne("glueRoleArn", async () => {
            // IAM 全局服务:client 用 home region;RoleName 取 ARN 最后一段(role/<path?>/<name>)。
            const roleName = glueRoleArn.split("/").pop();
            if (!roleName) throw new Error(`glueRoleArn 解析不出角色名:${glueRoleArn}`);
            const iam = sdkClient("control-plane", IAMClient, { region: HOME_REGION });
            await iam.send(new GetRoleCommand({ RoleName: roleName }));
          })
        : Promise.resolve(missingItem("glueRoleArn"))
    );
    // EMR 执行角色(core 键;有才探,见 probeExecRole 的说明)
    const emrProbe = isExecRoleResourceKey("emrExecutionRoleArn") ? probeExecRole(target, "emrExecutionRoleArn", "emrExecutionRoleArn", res.emrExecutionRoleArn) : null;
    if (emrProbe) jobs.push(emrProbe);
  } else {
    jobs.push(Promise.resolve({ name: "core", ok: false, error: "components 不含 core(描述符坏了,§1.1 要求必含)" }));
  }

  // ──:零出网两项(SPEC §3.16-F;INTERACTION v2.21 探活列表)────
  // 🔴 **诚实边界(必须写在这里,别让人误读)**:这两项只断**控制面观测得到**的事实。
  //   真正的端到端证据是「该区调度任务真跑成功且 run 台账回写到 home」(ACCEPTANCE N0-7)——
  //   因为「VPC 内解析 dynamodb.<home>.amazonaws.com 到端点 ENI」这件事,控制面(home 的 ECS)
  //   **在网络上就做不到**:它不在那个 VPC 里,私有托管域对它不生效。所以这里不假装能证明它。
  // 🔴 **退避重试**:接口端点 `State=available` 之后仍有约 2–3 分钟私有 DNS 传播窗口(spike),
  //   一次红就判「缺端点」= 把好产品报成缺陷。探活本身由 reconciler 周期性重跑 ⇒ 天然带重试;
  //   这里只保证**单次判定不因传播中途而误红**:端点处于 pending* 视为「还在建」,不算失败。
  // 🔴🔴 **灰度门:只对「已经切到零出网底座」的 target 出这两项**(判据 = 资源袋里有 `endpointIds`,
  //   那是零出网 base 栈才产出的 Output)。
  //   为什么必须有这道门(2026-09-08 真环境当场撞到):平台代码一上线,这两项对**还没走升级动线**的
  //   存量 target 必然判红(它们本来就还有 NAT)⇒ 所有非 home 环境瞬间从「运行中」掉成「降级」,
  //   而它们其实是好的。把好环境报成缺陷是本仓反复强调的禁忌,而且多段验收断的就是「卡片回运行中」。
  // 🔴 那「漏切了怎么发现」?——**不靠把好环境判红**,靠 `net0` 段的 N0-1 逐个非 home target 扫
  //   现网 NAT / 路由表 / IGW(漏一个就红),再加详情页网络行显示「跨区私连 未就位」。
  //   探活的职责是「已声明的形态是否还成立」,不是「该不该升级」——后者是迁移台账的事。
  const switchedToZeroEgress = typeof res.endpointIds === "string" && res.endpointIds.length > 0;
  if (!isHome(target.targetId) && components.includes("core") && switchedToZeroEgress) {
    const vpcId = typeof res.vpcId === "string" ? res.vpcId : "";
    if (!vpcId) {
      jobs.push(Promise.resolve(missingItem("vpcId")));
    } else {
      const ec2 = sdkClient("data-plane", EC2Client, { region });
      jobs.push(
        probeOne("network:egress-none", async () => {
          // ① 该 VPC 的私有子网路由表不许有默认路由
          const rts = await ec2.send(new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] }));
          const offenders: string[] = [];
          for (const rt of rts.RouteTables ?? []) {
            for (const r of rt.Routes ?? []) {
              if (r.DestinationCidrBlock === "0.0.0.0/0" || r.DestinationIpv6CidrBlock === "::/0") {
                offenders.push(`${rt.RouteTableId ?? "?"}→${r.GatewayId ?? r.NatGatewayId ?? r.TransitGatewayId ?? "?"}`);
              }
            }
          }
          if (offenders.length) throw new Error(`存在默认出口路由:${offenders.join(", ")}(零出网要求私有路由表无 0.0.0.0/0;该 target 可能还没走完切换动线)`);
          // ② 该 VPC 下不许有存活的 NAT 网关
          const nats = await ec2.send(new DescribeNatGatewaysCommand({ Filter: [{ Name: "vpc-id", Values: [vpcId] }] }));
          const alive = (nats.NatGateways ?? []).filter((n) => n.State !== "deleted" && n.State !== "failed");
          if (alive.length) throw new Error(`还有 ${alive.length} 个 NAT 网关存活(${alive.map((n) => n.NatGatewayId).join(", ")})—— 走一次「重新部署」把它切到零出网`);
        })
      );
      const homeLinkZone = typeof res.homeLinkHostedZoneId === "string" ? res.homeLinkHostedZoneId : "";
      // 形态换了 —— 从「本区的跨区端点」换成「跨区 peering + 主控区同区端点 + 本区私有托管域」
      const pcxId = typeof res.homeLinkPeeringId === "string" ? res.homeLinkPeeringId : "";
      jobs.push(
        probeOne("network:home-link", async () => {
          // 🔴 判据钉的是**现在这个形态**:老形态(`crossRegionDdbEndpointId`)被组织 SCP 拦死、
          //    在本组织永远建不出来 —— 对着一个建不出来的形态判红,只会让人照它去改代码然后一直撞 SCP
          //    (ACCEPTANCE N0-3 已改判;教训见 ROADMAP §2octies.58)。
          if (!pcxId) throw new Error("描述符缺 resources.homeLinkPeeringId —— 跨区台账回写没有私有通路(SPEC §3.14ter)");
          if (!homeLinkZone) throw new Error("描述符缺 resources.homeLinkHostedZoneId —— 通路在但默认域名仍解析公网,回写照样走不通");
          // ① peering 必须 active(pending-acceptance / 已被删都要响亮)
          const pcxOut = await ec2.send(new DescribeVpcPeeringConnectionsCommand({ VpcPeeringConnectionIds: [pcxId] }));
          const pcx = (pcxOut.VpcPeeringConnections ?? [])[0];
          if (!pcx) throw new Error(`跨区 peering ${pcxId} 不存在(被手工删了?)`);
          const pcxState = String(pcx.Status?.Code ?? "");
          if (pcxState === "pending-acceptance" || pcxState.startsWith("initiating") || pcxState === "provisioning") {
            throw new Error(`跨区 peering ${pcxId} 还在建(${pcxState})—— 属正常传播窗口,下一轮探活会转绿`);
          }
          if (pcxState !== "active") throw new Error(`跨区 peering ${pcxId} 状态 ${pcxState || "?"}(须 active)`);
          // ② 本区必须有到**主控区网段**的路由,且下一跳就是这条 peering。
          //    🔴 网段从 peering 自己身上读(`AccepterVpcInfo.CidrBlock`),不从描述符另存一份 ——
          //    另存就会有「主控区换了网段而这里还记着旧值」的漂移。
          const homeCidr = pcx.AccepterVpcInfo?.CidrBlock ?? pcx.RequesterVpcInfo?.CidrBlock ?? "";
          if (!homeCidr) throw new Error(`peering ${pcxId} 读不到对端网段 —— 无法判断本区路由对不对`);
          const rts2 = await ec2.send(new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] }));
          const tables = (rts2.RouteTables ?? []).filter((rt) => (rt.Associations ?? []).some((a) => a.SubnetId));
          const withRoute = tables.filter((rt) =>
            (rt.Routes ?? []).some((r) => r.DestinationCidrBlock === homeCidr && r.VpcPeeringConnectionId === pcxId)
          );
          // 🔴 必须**每张**私有子网路由表都有 —— 少一张 = 那个 AZ 的任务回写不了,而另一个 AZ 正常
          //    ⇒ **间歇性**失败(最难查的一类),所以这里不接受「至少一条」。
          if (tables.length === 0 || withRoute.length !== tables.length) {
            throw new Error(
              `本区 ${withRoute.length}/${tables.length} 张子网路由表有到主控区 ${homeCidr} 的 peering 路由 —— ` +
                `缺的那张会让对应 AZ 的任务静默回写不了台账`
            );
          }
          // ③ 私有托管域必须关联本 VPC,且有一条**带值**的 A 记录(A/ALIAS 都算)
          const r53 = sdkClient("control-plane", Route53Client, { region: HOME_REGION });
          const zone = await r53.send(new GetHostedZoneCommand({ Id: homeLinkZone }));
          const assoc = (zone.VPCs ?? []).some((v: { VPCId?: string }) => v.VPCId === vpcId);
          if (!assoc) throw new Error(`私有托管域 ${homeLinkZone} 没有关联本 target 的 VPC ${vpcId} —— 对该区任务不生效`);
          const rrs = await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: homeLinkZone, MaxItems: 10 }));
          // 🔴 是**A 记录 + 主控区端点 ENI 的私有 IP**(跨 region 拿不到 DnsEntries 做 ALIAS)
          //    ⇒ 判据不能只认 AliasTarget(只认它 = 对着旧形态判红)。
          const hasAnswer = (rrs.ResourceRecordSets ?? []).some(
            (r: { Type?: string; AliasTarget?: unknown; ResourceRecords?: Array<{ Value?: string }> }) =>
              r.Type === "A" && (!!r.AliasTarget || (r.ResourceRecords ?? []).some((v) => !!v.Value))
          );
          if (!hasAnswer) throw new Error(`私有托管域 ${homeLinkZone} 里没有带值的 A 记录 —— 默认域名仍解析公网`);
        })
      );
    }
  }

  // ── 非 core 组件(补真探;此前是"未实现=红"的 fail-closed 占位,home seed 一上就撞到)──
  // 每组件探"服务级存在性 + 描述符实名对得上",与 core 同口径:资源字段缺 ⇒ missingItem 红。
  for (const comp of components) {
    if (comp === "core") continue;
    if (comp === "redshift") {
      const wg = res.redshiftWorkgroup;
      if (typeof wg !== "string" || !wg) jobs.push(Promise.resolve(missingItem("redshiftWorkgroup")));
      else {
        const rsc = sdkClient("data-plane", RedshiftServerlessClient, { region });
        jobs.push(probeOne("redshift:workgroup", async () => {
          const out = await rsc.send(new GetWorkgroupCommand({ workgroupName: wg }));
          if (out.workgroup?.status !== "AVAILABLE") throw new Error(`workgroup ${wg} 状态 ${out.workgroup?.status ?? "?"}(非 AVAILABLE)`);
        }));
      }
      // COPY 角色(组件可选键;有才探)
      const copyProbe = probeExecRole(target, "redshiftCopyRoleArn", "redshift:copy-role", res.redshiftCopyRoleArn);
      if (copyProbe) jobs.push(copyProbe);
    } else if (comp === "mwaa") {
      const env = res.mwaaEnvName;
      if (typeof env !== "string" || !env) jobs.push(Promise.resolve(missingItem("mwaaEnvName")));
      else {
        const mw = sdkClient("data-plane", MWAAClient, { region });
        jobs.push(probeOne("mwaa:environment", async () => {
          const out = await mw.send(new GetEnvironmentCommand({ Name: env }));
          if (out.Environment?.Status !== "AVAILABLE") throw new Error(`MWAA ${env} 状态 ${out.Environment?.Status ?? "?"}(非 AVAILABLE)`);
        }));
      }
    } else if (comp === "airflow-serverless") {
      // 三样实名资源逐个真探(桶存在 / 角色存在 / SG 存在);缺键 ⇒ missingItem 红
      const wb = res.workflowBucket;
      if (typeof wb !== "string" || !wb) jobs.push(Promise.resolve(missingItem("workflowBucket")));
      else {
        const s3c = sdkClient("data-plane", S3Client, { region });
        jobs.push(probeOne("airflow-serverless:bucket", async () => { await s3c.send(new HeadBucketCommand({ Bucket: wb })); }));
      }
      const rarn = res.airflowServerlessRoleArn;
      if (typeof rarn !== "string" || !rarn) jobs.push(Promise.resolve(missingItem("airflowServerlessRoleArn")));
      else {
        const iamc = sdkClient("control-plane", IAMClient, { region: homeRegion() });
        const roleName = rarn.split("/").pop() ?? "";
        jobs.push(probeOne("airflow-serverless:role", async () => {
          const out = await iamc.send(new GetRoleCommand({ RoleName: roleName }));
          const doc = decodeURIComponent(String(out.Role?.AssumeRolePolicyDocument ?? ""));
          if (!doc.includes("airflow-serverless.amazonaws.com")) throw new Error(`角色 ${roleName} 未信任 airflow-serverless.amazonaws.com`);
        }));
      }
      const sgId = res.airflowServerlessSgId;
      if (typeof sgId !== "string" || !sgId) jobs.push(Promise.resolve(missingItem("airflowServerlessSgId")));
      else {
        const ec2c = sdkClient("data-plane", EC2Client, { region });
        jobs.push(probeOne("airflow-serverless:sg", async () => {
          const out = await ec2c.send(new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }));
          if ((out.SecurityGroups?.length ?? 0) === 0) throw new Error(`SG ${sgId} 不存在`);
        }));
      }
    } else if (comp === "dms") {
      const grp = res.dmsSubnetGroup;
      if (typeof grp !== "string" || !grp) jobs.push(Promise.resolve(missingItem("dmsSubnetGroup")));
      else {
        const dms = sdkClient("data-plane", DatabaseMigrationServiceClient, { region });
        jobs.push(probeOne("dms:subnet-group", async () => {
          const out = await dms.send(new DescribeReplicationSubnetGroupsCommand({
            Filters: [{ Name: "replication-subnet-group-id", Values: [grp] }],
          }));
          if ((out.ReplicationSubnetGroups?.length ?? 0) === 0) throw new Error(`DMS 子网组 ${grp} 不存在`);
        }));
      }
      // DMS 角色(组件可选键;有才探)
      const dmsRoleProbe = probeExecRole(target, "dmsKinesisRoleArn", "dms:kinesis-role", res.dmsKinesisRoleArn);
      if (dmsRoleProbe) jobs.push(dmsRoleProbe);
    } else if (comp === "flink") {
      const arn = res.flinkRoleArn;
      if (typeof arn !== "string" || !arn) jobs.push(Promise.resolve(missingItem("flinkRoleArn")));
      else {
        const iamc = sdkClient("control-plane", IAMClient, { region: homeRegion() });
        const roleName = arn.split("/").pop() ?? "";
        jobs.push(probeOne("flink:role", async () => {
          await iamc.send(new GetRoleCommand({ RoleName: roleName }));
        }));
      }
    } else if (comp === "agentcore") {
      // agentcore(补真探,用户实测反馈驱动):字段在 §1.1 的顶层 agentcore 袋、不在 resources。
      // 三项分探(runtime READY / memory ACTIVE / gateway READY——状态字面值 2026-09-01 真环境核过),
      // 缺字段 ⇒ 红得明白,不拿 undefined 去打 AWS。
      const ac = (target.agentcore ?? {}) as Record<string, unknown>;
      const acClient = sdkClient("central:agentcore", BedrockAgentCoreControlClient, { region });
      const runtimeArn = ac.genbiRuntimeArn;
      if (typeof runtimeArn !== "string" || !runtimeArn) {
        jobs.push(Promise.resolve({ name: "agentcore:runtime", ok: false, error: "描述符缺 agentcore.genbiRuntimeArn(SPEC §1.1)" }));
      } else {
        // ARN 尾段即 runtimeId:arn:…:runtime/bgp_genbi_agent-XXXX
        const runtimeId = runtimeArn.split("/").pop() ?? "";
        jobs.push(probeOne("agentcore:runtime", async () => {
          const out = await acClient.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
          if (out.status !== "READY") throw new Error(`runtime ${runtimeId} 状态 ${out.status ?? "?"}(非 READY)`);
        }));
      }
      const memoryId = ac.genbiMemoryId;
      if (typeof memoryId !== "string" || !memoryId) {
        jobs.push(Promise.resolve({ name: "agentcore:memory", ok: false, error: "描述符缺 agentcore.genbiMemoryId(SPEC §1.1)" }));
      } else {
        jobs.push(probeOne("agentcore:memory", async () => {
          const out = await acClient.send(new GetMemoryCommand({ memoryId }));
          if (out.memory?.status !== "ACTIVE") throw new Error(`memory ${memoryId} 状态 ${out.memory?.status ?? "?"}(非 ACTIVE)`);
        }));
      }
      const gatewayUrl = ac.gatewayUrl;
      if (typeof gatewayUrl !== "string" || !gatewayUrl) {
        jobs.push(Promise.resolve({ name: "agentcore:gateway", ok: false, error: "描述符缺 agentcore.gatewayUrl(SPEC §1.1)" }));
      } else {
        // gateway id = URL 主机名首段(https://<gatewayId>.gateway.bedrock-agentcore.<region>…/mcp)
        jobs.push(probeOne("agentcore:gateway", async () => {
          const host = new URL(gatewayUrl).hostname;
          const gatewayId = host.split(".")[0];
          if (!gatewayId) throw new Error(`gatewayUrl 解析不出 gatewayId:${gatewayUrl}`);
          const out = await acClient.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
          if (out.status !== "READY") throw new Error(`gateway ${gatewayId} 状态 ${out.status ?? "?"}(非 READY)`);
        }));
      }
    } else if (comp === "residency-api") {
      // residency-api 片 1 三项真探(SPEC v3.22 §1.3a S4):两张区域表 ACTIVE + 结果桶在且**没有复制配置**
      //    (E2:结果留区是产品能力;桶策略 deny 复制,这里再从真实配置侧证一次)。字段缺 ⇒ missingItem 红。
      const ddb = sdkClient("data-plane", DynamoDBClient, { region });
      for (const [key, itemName] of [["residencyAuditTable", "residency-api:audit-table"], ["residencyResultsTable", "residency-api:results-table"]] as const) {
        const tbl = res[key];
        if (typeof tbl !== "string" || !tbl) jobs.push(Promise.resolve(missingItem(key)));
        else {
          jobs.push(probeOne(itemName, async () => {
            const out = await ddb.send(new DescribeTableCommand({ TableName: tbl }));
            if (out.Table?.TableStatus !== "ACTIVE") throw new Error(`表 ${tbl} 状态 ${out.Table?.TableStatus ?? "?"}(非 ACTIVE)`);
          }));
        }
      }
      const bkt = res.residencyBucket;
      if (typeof bkt !== "string" || !bkt) jobs.push(Promise.resolve(missingItem("residencyBucket")));
      else {
        const s3r = sdkClient("data-plane", S3Client, { region });
        jobs.push(probeOne("residency-api:bucket", async () => {
          await s3r.send(new HeadBucketCommand({ Bucket: bkt }));
          // 有复制配置 = 结果会被搬出区 ⇒ 红。ReplicationConfigurationNotFoundError 才是「对」的答案。
          try {
            const rep = await s3r.send(new GetBucketReplicationCommand({ Bucket: bkt }));
            if ((rep.ReplicationConfiguration?.Rules ?? []).length > 0) throw new Error(`桶 ${bkt} 配置了跨区复制(${rep.ReplicationConfiguration?.Rules?.length} 条规则)—— 结果留区被破坏`);
          } catch (e) {
            const name = (e as { name?: string })?.name ?? "";
            if (!/ReplicationConfigurationNotFound/i.test(name) && !/ReplicationConfigurationNotFound/i.test(String((e as Error)?.message ?? ""))) throw e;
          }
        }));
      }
    } else {
      // 仍未实现真探的组件(kafka)保持 fail-closed 红:
      // 跳过 = 假绿,probe.ok 是启用前置。这些组件本就归后续批次,home 不声称它们。
      jobs.push(
        Promise.resolve({
          name: comp,
          ok: false,
          error: `组件 ${comp} 的探活未实现 —— 已装组件不许跳过探活(跳过 = 假绿,probe.ok 是启用前置)`,
        })
      );
    }
  }

  const items = await Promise.all(jobs);
  return { at: new Date().toISOString(), ok: items.every((i) => i.ok), items };
}
