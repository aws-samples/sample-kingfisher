/**
 * @kf-batch 50-WP31-place-first-class
 * WP-31 L4「环境无默认区域」—— **全仓唯一**允许读进程区变量(`BGP_HOME_REGION` / `AWS_REGION`)的地方。
 *
 * 为什么要收成一个作者:序 6 要把平台 ECS 任务的 `AWS_REGION` 设成空串(D1b 实测 Fargate 会自注入
 * `AWS_DEFAULT_REGION`,任务定义里设 `""` 才能盖掉),让「忘了给区」当场报错、而不是静默落到主控区。
 * 前提是业务代码里**不再直接读** `process.env.AWS_REGION`:那 78 处散读一旦被清空,行为就散落地变;
 * 收到这里之后,序 6 只需改这一个文件的回落语义。棘轮 `place-ratchets.test.ts` 的 L4 是**闭合门**:
 * 进程区变量的读取只许出现在本文件。
 *
 * 读取顺序:`BGP_HOME_REGION`(序 6 由平台栈注入;本包不改 infra,当前环境里没有它)→ `AWS_REGION`
 * → 回落。两处都用 `||`(空串当作没有),与迁移前 `process.env.AWS_REGION || …` 的语义逐字节一致。
 *
 * 🔴 零依赖:不许 import 任何 SDK / node 内置 / 别的业务模块 —— `src/middleware.ts` 跑在 edge,
 * import 图碰到 node 内置就构建失败。
 */

/**
 * 主控区(控制面所在区)。
 *
 * 🔴 末尾的 `"us-east-1"` 回落属于「静默合法默认值」缺陷类(没配区 ⇒ 悄悄落到一个看起来合法的区)。
 * 这里**有意保留**,只为本包「收口、行为不变」:迁移前 78 处读取几乎都是 `|| "us-east-1"`。
 * 序 6 平台栈注入 `BGP_HOME_REGION` 后,这一条改成「缺即抛」(两者都没有 ⇒ throw),届时全仓同时生效。
 */
export function homeRegion(): string {
  return process.env.BGP_HOME_REGION || process.env.AWS_REGION || "us-east-1";
}

/**
 * 同 `homeRegion()`,但从**注入的** env 读(给 `exec-env/control-plane-regions.ts` 这类「env 可注入以便单测」的纯函数用)。
 * 读取顺序与回落与 `homeRegion()` 完全一致(单测钉住两者同序)。
 *
 * 🔴 为什么 `homeRegion()` 不直接写成 `homeRegionOf(process.env)`:middleware 跑在 edge 沙箱里,
 * 迁移前它的读法是字面量 `process.env.AWS_REGION`;这里保持字面量 `process.env.X` 写法,与迁移前同形
 * (2026-10-11 `next build` 实测:middleware 产物内联的正是 `process.env.BGP_HOME_REGION||process.env.AWS_REGION`),
 * 不去赌 edge 沙箱对「把 `process.env` 当对象传走」的支持。
 */
export function homeRegionOf(env: { readonly [k: string]: string | undefined }): string {
  return env.BGP_HOME_REGION || env.AWS_REGION || "us-east-1";
}

/**
 * 同 `homeRegion()`,但**不回落**:两者都没有 ⇒ `""`。
 * 只给迁移前就是 `process.env.AWS_REGION || ""` 的调用点用(如 `/api/public/config`),保证它们的输出不变;
 * 别在新代码里用它来「拿个区试试」—— 空串就是「不知道」,由调用方自己决定怎么呈现。
 */
export function homeRegionOrEmpty(): string {
  return process.env.BGP_HOME_REGION || process.env.AWS_REGION || "";
}
