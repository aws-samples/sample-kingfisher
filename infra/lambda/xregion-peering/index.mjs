// @kf-batch 50-WP23-xregion-peering
// **跨区私网通路的 home 侧接线**(CFN 自定义资源;50 SPEC §3.14ter)。
//
// 【它为什么必须是自定义资源,而不是 buildspec 里的几行 aws cli】
//   要做的三件事全都**只能在 home 那一侧**做,而 home 的路由表属于**另一个 region 的另一个栈**:
//     ① 跨区 peering 同账号也要**显式 accept**(CFN 只对同区同账号自动接受);
//     ② home 侧的**回程路由**(目的地 = 本执行环境的 VPC 段,下一跳 = 这条 peering)——
//        它是 per-target 的,平台栈没法预先枚举将来会建哪些执行环境;
//     ③ 读回 home 侧 DynamoDB 接口端点的 **ENI 私有 IP**,给本区私有托管域做 A 记录。
//   放 buildspec 的致命缺点是**删不掉**:环境下线后 home 的路由表会留一条 blackhole,
//   下一个环境若分到同一段,`CreateRoute` 直接 `RouteAlreadyExists`(本仓在 S3 网关端点上已吃过
//   一次「路由表里已有同目的地条目」的整栈回滚)。自定义资源让**回程路由的生命周期 = peering 的生命周期**
//   —— 删栈即回收,这才是根治。
//
// 🔴 幂等:Create/Update 都按「已存在就核对、不一致就响亮报错」处理,绝不覆盖别人的路由。
// 🔴 冲突要点名:两个执行环境分到同一段时,`RouteAlreadyExists` 会指向**另一条** peering ⇒
//    直接抛,并把冲突的 pcx 写进错误里(注册期分配有一个并发窄窗口,兜底就在这里,SPEC §3.14ter)。
import {
  EC2Client,
  AcceptVpcPeeringConnectionCommand,
  DescribeVpcPeeringConnectionsCommand,
  DescribeVpcEndpointsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  CreateRouteCommand,
  DeleteRouteCommand,
} from "@aws-sdk/client-ec2";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** peering 变成 active 的等待上限(跨区接受后通常几秒;给足传播时间但不无限等)。 */
const ACTIVE_TIMEOUT_MS = 5 * 60 * 1000;

function req(props, key) {
  const v = props?.[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`自定义资源缺属性 ${key} —— 上游(base 栈)没传,拒绝猜默认值`);
  }
  return v;
}

/**
 * @param event CFN 自定义资源事件
 * @param deps  **测试接缝**:只注入「真外部」EC2 客户端。
 *   🔴 之所以留这个口子:这段代码会**改主控区的路由表** —— 全仓最不该只靠「读一遍觉得对」的地方。
 *   注入的是真 SDK 的同形对象(send(command)),不是把兄弟模块 mock 掉(见记忆 mock-hides-the-seam)。
 */
export const handler = async (event, deps = {}) => {
  const props = event.ResourceProperties || {};
  const homeRegion = req(props, "HomeRegion");
  const pcxId = req(props, "PeeringConnectionId");
  const localCidr = req(props, "LocalVpcCidr");
  const endpointId = req(props, "HomeDdbEndpointId");
  const targetId = req(props, "TargetId");
  const ec2 = deps.ec2 ?? new EC2Client({ region: homeRegion });
  const physicalId = `homelink-${targetId}`;
  const log = (o) => console.log(JSON.stringify({ kind: "xregion-peering", at: new Date().toISOString(), targetId, ...o }));

  if (event.RequestType === "Delete") {
    // 🔴 删:只删「目的地 = 本环境网段 **且** 下一跳 = 本条 peering」的那些路由。
    //    条件缺一不可 —— 否则会删掉别人的条目(同网段不同 pcx 只可能是冲突场景,那时也不该由删除路径善后)。
    let removed = 0;
    try {
      const rts = await homeRouteTables(ec2, endpointId);
      for (const rt of rts) {
        const hit = (rt.Routes ?? []).find((r) => r.DestinationCidrBlock === localCidr && r.VpcPeeringConnectionId === pcxId);
        if (!hit) continue;
        await ec2.send(new DeleteRouteCommand({ RouteTableId: rt.RouteTableId, DestinationCidrBlock: localCidr }));
        removed++;
      }
    } catch (e) {
      // 删除路径**不许**因为读不到东西就失败:栈删除卡住比留一条 blackhole 更糟。响亮留痕即可。
      log({ deleteWarning: String(e?.message || e) });
    }
    log({ deleted: removed });
    return { PhysicalResourceId: physicalId, Data: { RemovedRoutes: String(removed) } };
  }

  // ── ① accept(同账号跨区也要显式接受)+ 等 active ────────────────────────────
  const state0 = await peeringState(ec2, pcxId);
  log({ initialState: state0 });
  if (state0 === "pending-acceptance") {
    await ec2.send(new AcceptVpcPeeringConnectionCommand({ VpcPeeringConnectionId: pcxId }));
  }
  const deadline = Date.now() + ACTIVE_TIMEOUT_MS;
  let state = state0;
  while (state !== "active") {
    if (Date.now() > deadline) throw new Error(`peering ${pcxId} 在 ${ACTIVE_TIMEOUT_MS / 1000}s 内没有变成 active(当前 ${state})`);
    await sleep(deps.pollMs ?? 5000);
    state = await peeringState(ec2, pcxId);
    if (state === "failed" || state === "rejected" || state === "deleted" || state === "expired") {
      throw new Error(`peering ${pcxId} 进入终态 ${state} —— 跨区私网通路建不起来,拒绝继续(不要重试同一条)`);
    }
  }

  // ── ② home 侧回程路由(目的地 = 本环境网段,下一跳 = 本条 peering)───────────
  const rts = await homeRouteTables(ec2, endpointId);
  if (rts.length === 0) throw new Error(`按 home 端点 ${endpointId} 找不到任何路由表 —— 回程路由无处可加(端点是不是被手工删了?)`);
  // 🔴🔴 **两段式:先全部核对,再全部创建**。
  //    一边核对一边创建的话,冲突出现在第二张表时**第一张已经加上了** ⇒ 留下半套路由,
  //    而半套路由的症状是「一个 AZ 通、另一个 AZ 不通」= 间歇性失败(比整体失败难查得多)。
  //    (这一条是写判据时发现的:原实现只在「冲突恰好在第一张表」时才真的零副作用 ——
  //     判据若也只造那一种,就是在测运气而不是测性质。)
  const todo = [];
  for (const rt of rts) {
    const existing = (rt.Routes ?? []).find((r) => r.DestinationCidrBlock === localCidr);
    if (existing) {
      if (existing.VpcPeeringConnectionId === pcxId) continue; // 幂等:已经是我们这条
      throw new Error(
        `主控区路由表 ${rt.RouteTableId} 已有一条到 ${localCidr} 的路由,下一跳是 ` +
          `${existing.VpcPeeringConnectionId ?? existing.GatewayId ?? existing.NatGatewayId ?? "?"}(不是本环境的 ${pcxId})—— ` +
          `两个执行环境分到了同一个 VPC 网段。请删掉其中一个环境后重建(地址段在注册时分配,SPEC §3.14ter)`
      );
    }
    todo.push(rt.RouteTableId);
  }
  const touched = [];
  for (const routeTableId of todo) {
    await ec2.send(
      new CreateRouteCommand({
        RouteTableId: routeTableId,
        DestinationCidrBlock: localCidr,
        VpcPeeringConnectionId: pcxId,
      })
    );
    touched.push(routeTableId);
  }

  // ── ③ 端点 ENI 的私有 IP(给本区私有托管域做 A 记录)────────────────────────
  const ips = await endpointPrivateIps(ec2, endpointId);
  if (ips.length === 0) throw new Error(`home 端点 ${endpointId} 读不到任何 ENI 私有 IP —— 私有托管域会指向空值,回写照样走不通`);
  log({ state, routesAdded: touched, endpointIps: ips });
  return {
    PhysicalResourceId: physicalId,
    Data: {
      // 🔴 排序:CFN 会把 Data 拼进模板输出与 A 记录,顺序不稳定会造成无意义的 changeset 抖动
      EndpointIps: ips.join(","),
      RouteTableIds: rts.map((r) => r.RouteTableId).join(","),
      PeeringState: state,
    },
  };
};

async function peeringState(ec2, pcxId) {
  const out = await ec2.send(new DescribeVpcPeeringConnectionsCommand({ VpcPeeringConnectionIds: [pcxId] }));
  const pcx = (out.VpcPeeringConnections ?? [])[0];
  if (!pcx) throw new Error(`peering ${pcxId} 在 home 侧查不到`);
  return String(pcx.Status?.Code ?? "unknown");
}

/**
 * home 侧**该加回程路由的**那些路由表 = 端点 ENI 所在子网关联的路由表。
 * 🔴 子网没有显式关联时按 VPC 的**主**路由表算(AWS 的默认行为;漏了它 = 回程包无路可走,
 *    症状是「请求发出去了、永远收不到响应」而不是报错)。
 */
export async function homeRouteTables(ec2, endpointId) {
  const eps = await ec2.send(new DescribeVpcEndpointsCommand({ VpcEndpointIds: [endpointId] }));
  const ep = (eps.VpcEndpoints ?? [])[0];
  if (!ep) throw new Error(`home 侧 DynamoDB 接口端点 ${endpointId} 不存在`);
  const subnetIds = ep.SubnetIds ?? [];
  const vpcId = ep.VpcId;
  if (!vpcId || subnetIds.length === 0) throw new Error(`端点 ${endpointId} 没有 VpcId/SubnetIds(形态不对)`);
  const all = await ec2.send(new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] }));
  const tables = all.RouteTables ?? [];
  const picked = new Map();
  for (const sn of subnetIds) {
    const explicit = tables.find((rt) => (rt.Associations ?? []).some((a) => a.SubnetId === sn));
    const chosen = explicit ?? tables.find((rt) => (rt.Associations ?? []).some((a) => a.Main === true));
    if (chosen?.RouteTableId) picked.set(chosen.RouteTableId, chosen);
  }
  return [...picked.values()];
}

export async function endpointPrivateIps(ec2, endpointId) {
  const eps = await ec2.send(new DescribeVpcEndpointsCommand({ VpcEndpointIds: [endpointId] }));
  const ids = (eps.VpcEndpoints ?? [])[0]?.NetworkInterfaceIds ?? [];
  if (ids.length === 0) return [];
  const enis = await ec2.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: ids }));
  return (enis.NetworkInterfaces ?? [])
    .map((n) => n.PrivateIpAddress)
    .filter((x) => typeof x === "string" && x.length > 0)
    .sort();
}
