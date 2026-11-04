// @kf-batch 50-B109-exec-target-dims
// `GET /api/exec-targets?component=` 认的**组件维度闭合清单** —— 路由校验与页面传参的单一作者。
// 零依赖叶子模块(没有 "use client",服务端路由与客户端读法都从这里 import;客户端文件带 "use client",
// 服务端若从它 import 常量会拿到客户端引用代理,所以清单不能放在 exec-targets-client.ts 里)。
//
// 🔴 B-109(2026-10-20 测试账号 contract-guard 定性时抓到;2026-09-16 接线那一刻就坏):
//   编排页传 "airflow"、治理目录「新建表」向导的 S3 Tables 分支传 "core",而路由只认 redshift / any
//   ⇒ 每次 400 VALIDATION_FAILED 被页面 `.catch(() => [])` 吞成空列表 ⇒ 「执行区域(可多选)」永远空、
//   「全选当前活跃区(0)」灰 ⇒ 多区扇出入口在页面上不可用;建表向导则在切到 S3 Tables 后挂一条红告警。
//   当时的接线守卫只盯「调用点经 fetchExecTargets 调」,没盯「传的维度路由认不认」—— 两边各有一份字面、
//   没有单一作者,是「门禁枚举违规写法就漏第 N+1 种」的又一例。
//   现在:① 清单只写这一份;② `fetchExecTargets(component: ExecTargetComponentDim)` 让不在清单里的值在 tsc 就红
//   (让非法状态无法表达);③ 路由用同一清单校验;④ 接线守卫逐调用点核实参字面 ∈ 清单(exec-targets-client.test.ts)。
//
// 维度语义(与写入路径同口径,呈现 = 授权;谓词的唯一作者在 data-plane-target.ts `listComponentCapableTargets`):
//   · redshift = 装了数仓(`assertTargetComponent(t, "redshift")` 同一字面)
//   · airflow  = 装了任一调度组件(新建编排 `requireMwaaForTargets` 认的 `SCHEDULER_PREFERENCE_COMPONENT` 值域;主控区恒在)
//   · core     = 每个已就位目标(S3 Tables 表桶属 core,每个区都有)
//   · any      = 顶栏「执行范围」清单(`listScopeTargets`,不筛组件;SPEC v3.36 §2.6.5a)
export const EXEC_TARGET_COMPONENT_DIMS = ["redshift", "airflow", "core", "any"] as const;
export type ExecTargetComponentDim = (typeof EXEC_TARGET_COMPONENT_DIMS)[number];

/** 要「按组件筛目标」的维度(any 走 listScopeTargets,不筛组件)。 */
export type ExecTargetCapabilityDim = Exclude<ExecTargetComponentDim, "any">;

export function isExecTargetComponentDim(v: unknown): v is ExecTargetComponentDim {
  return typeof v === "string" && (EXEC_TARGET_COMPONENT_DIMS as readonly string[]).includes(v);
}
