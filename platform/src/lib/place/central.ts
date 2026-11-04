// @kf-batch 50-WP31-place-first-class
// WP-31 序 3 —— **中心件**:用户拍板「一个 AgentCore + 一个 OpenMetadata」(2026-09-10,不许为非主控区另开第二条路)。
// 它们不分区、只在主控区 ⇒ 在别的区的请求里调用它们是**合法的**,但必须**声明**,不能靠观测器「按服务整块豁免」:
//   · 整块豁免 secretsmanager ⇒ 数据源密钥越区也被放过(那才是真违规);
//   · 整块豁免 monitoring ⇒ 读某个区作业指标打错区也被放过。
// ⇒ 这里是唯一的声明处:封闭的中心件清单 + 每个中心件「按资源名」认得出的调用。第十一轮越区清单只剩这两类(13 + 6 次)。
//
// 本文件零依赖(只 import 账本),edge / node / 测试都能用。
import { notePlaceDecision } from "./context";

/** 封闭清单。新增一个 = 又多一个「不分区」的组件,必须有用户拍板。 */
export type CentralComponent = "openmetadata" | "agentcore";

/** 中心件里**按资源名**认得出的调用(只在主控区算合法;资源名必须全部命中前缀)。 */
export const CENTRAL_COMPONENT_RESOURCES: ReadonlyArray<{
  readonly component: CentralComponent;
  readonly service: string;
  readonly operation: string;
  readonly idPrefix: string;
}> = [
  // OM ingestion bot 的 JWT(om-client.ts):治理目录 / 元数据镜像 / 数据源列表 / Flink 启动上报血缘都会取它
  { component: "openmetadata", service: "secretsmanager", operation: "GetSecretValue", idPrefix: "bgp/om/" },
];

/** 资源标识(密钥名 / 密钥 ARN)是否属于该前缀。 */
export function matchesCentralPrefix(id: string, prefix: string): boolean {
  if (id.startsWith(prefix)) return true;
  const m = /:secret:(.+)$/.exec(id);
  return !!m && m[1].startsWith(prefix);
}

/**
 * 本请求要读一个**中心件**的数据(例如问数可观测指标 = 唯一 AgentCore 的指标)⇒ 显式记一条主控区决策。
 * 🔴 必须在第一个 await 之前调(D11:放到 await 之后调用方就看不见了)。
 */
export function noteCentralComponent(component: CentralComponent, via: string): void {
  notePlaceDecision({ targetId: "tgt_home", via, homeReason: `central:${component}` });
}
