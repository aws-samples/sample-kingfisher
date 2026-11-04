// @kf-batch 41-B115-netadvisor-place
// 网络顾问的落点决定 —— 三条路由(probe / advise / apply)与长操作共用的**唯一**一处。
//
// 不另造「按区建客户端」的轮子:落点点名经 `requestedTargetId`(缺 ⇒ 400,不默认主控区),
// 描述符经 `registeredPlace`(不存在 / 没装好 ⇒ 409,不回落主控区),客户端由 lib/aws/clients 的唯一工厂按 region 建。
import { requestedTargetId, registeredPlace } from "@/lib/place/resolve";
import { NET_ADVISOR } from "./config";
import type { ConnectivityRequest, PlacedConnectivityRequest } from "./types";

/**
 * 把客户端送来的请求落到一个执行环境上:region / placeVpcId 由描述符给,客户端带的同名字段一律覆盖。
 * @param where 出错信息里的入口名(如 `network-advisor/probe`)。
 * @throws PlaceUndecidable(缺 targetId)/ PlaceUnavailable(执行环境不存在或不可用)—— 路由用 `placeErrorResponse` 映射。
 */
export async function placeConnectivityRequest(body: ConnectivityRequest, where: string): Promise<PlacedConnectivityRequest> {
  const targetId = requestedTargetId((body as { targetId?: unknown }).targetId, where);
  const place = await registeredPlace(targetId, where);
  const fromDescriptor = place.resources.vpcId;
  const placeVpcId =
    typeof fromDescriptor === "string" && fromDescriptor
      ? fromDescriptor
      : place.home && NET_ADVISOR.defaultVpcId
        ? NET_ADVISOR.defaultVpcId
        : undefined;
  // 显式逐字段组装:客户端带的 region / placeVpcId(以及任何别的字段)一律不透传。
  return {
    computeKind: body.computeKind,
    targets: body.targets,
    ...(body.source ? { source: body.source } : {}),
    ...(body.constraints ? { constraints: body.constraints } : {}),
    ...(body.conversationId ? { conversationId: body.conversationId } : {}),
    ...(body.userMessage ? { userMessage: body.userMessage } : {}),
    ...(body.hints ? { hints: body.hints } : {}),
    targetId,
    region: place.region,
    ...(placeVpcId ? { placeVpcId } : {}),
  };
}
