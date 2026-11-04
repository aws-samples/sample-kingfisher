// @kf-batch 50-G2
// G6(模块 50)—— 进程级缓存的**复合键 SSOT**。
//
// 设计合同:50 SPEC §3.1 末段、§3.9(`_cred` 的 key 形状)、§10 汇总表「§3.9 凭证」行。
//
// ── 为什么三个缓存必须一起改,而且必须含 `purpose` 维 ──────────────────────────────
// 平台里有三个"进程级单值"缓存,它们在单 region + 单 project 时是对的,一旦多 target/多 project
// 就全是**跨边界串值**:
//   ① `redshift/admin-secret.ts` 的 `_arn`           —— 单值,第一个 target 解析出的 secret 被所有 target 复用
//   ② `realtime/zeroetl-service.ts` 的 `_secretArnCache` —— 同上(R9 才发现的**第二个**凭证缓存;
//      只改 ① 的话,zero-etl 查询路径会绕过隔离)
//   ③ `engines/platform-env.ts` 的 `_sgIdCache`      —— 单值,按名查 SG 的结果被跨 target 复用
//
// 🔴 **`purpose` 维不是"顺手加的"**:少了它,class② `governance-read`(平台级只读治理身份)与
// class③ `admin-ddl` 会**共用同一个缓存槽** ⇒ 治理身份拿到 admin 凭证。这是权限提升,不是缓存瑕疵。
//
// 🔴 ③ 只按 `targetId` 键,**没有 project 维** —— 它是纯位置轴(SG 属于 VPC/region,与项目无关)。
// 给它加 project 维不是"更安全",而是把缓存命中率打碎、并暗示一个不存在的隔离语义。

import { assertTargetId } from "@/lib/exec-env/target-id";

/** 凭证类缓存的复合键三元(SPEC §3.9:key = `${targetId}#${project ?? "-"}#${purpose}`)。 */
export interface CredCacheKeyParts {
  targetId: string;
  /** 无项目上下文(如治理只读)时传 undefined —— 会落成 `-`,与"项目名恰好是 '-'"不会撞(项目 id 不允许裸 `-`)。 */
  project?: string;
  purpose: string;
  /**
   * 🔴 **凭证世代**(50 SPEC §3.9b,v3.3 新增维)。
   *
   * 少了它就会发生外部审核 v2 P0-3 实测到的事:target 的凭证隔离状态从 legacy 切到 isolated 之后,
   * **旧缓存仍然命中**,于是第二次调用还是拿到旧的 legacy admin —— 隔离切换永远收敛不了。
   * 键里带上 epoch 后,状态迁移(或 secret 轮换)一 `++`,**旧 epoch 的槽自然再也命中不到**。
   */
  epoch?: number;
}

/**
 * 凭证类缓存键。
 *
 * 🔴 分隔符用 `#`:targetId 明确禁 `#`(SPEC §1.1a),purpose 是内部枚举、也不含 `#`,
 * 所以三段不会因为某段里混进分隔符而歧义。**别改成 `:` 或 `-`** —— `-` 会与 targetSlug 撞。
 */
export function credCacheKey(parts: CredCacheKeyParts): string {
  assertTargetId(parts.targetId);
  if (!parts.purpose) throw new Error("credCacheKey 缺 purpose —— 少了这一维会让治理身份与 admin 共用缓存槽");
  const epoch = parts.epoch === undefined ? "-" : `e${parts.epoch}`;
  return `${parts.targetId}#${parts.project ?? "-"}#${parts.purpose}#${epoch}`;
}

/**
 * 纯位置轴缓存键(SG id 之类)。
 * 刻意**不接受** project / purpose:参数上就表达"这东西与项目无关",避免调用方误以为有隔离语义。
 */
export function locationCacheKey(targetId: string): string {
  return assertTargetId(targetId);
}

/**
 * 极小的进程级缓存。
 *
 * 🔴 **必须缓存负结果**:三个被改造的缓存原本都缓存负结果(`admin-secret` 用 `null`、
 * `zeroetl` 用 `""`),那是刻意的 —— 没配 secret 的环境不该每次调用都去打一次 Secrets Manager。
 * 若改造时把负缓存丢了,行为就变了(G 批要求零行为变化),而且会平白增加 API 调用与延迟。
 * 故 `resolve()` 用 `Map.has()` 区分"未解析"与"已解析为空",不靠值真假判断。
 */
export class ProcessCache<T> {
  private readonly m = new Map<string, T | null>();

  /**
   * 🔴 **失活代数(generation fencing,G8 新增)**。
   *
   * 【为什么必须有】外部审核 v3 P1-3 实测到一条我上一批漏掉的竞态:`resolve()` 的顺序是
   * "未命中 → `await resolver()` → `set`",而失活只删**当时已落槽的键** ⇒
   *   ① 读请求进入 resolver(Map 里还没有该 key);
   *   ② 写路径创建 secret 并失活 —— **此刻删除数为 0**;
   *   ③ 旧 resolver 返回 `null`;
   *   ④ `resolve()` 在失活**之后**把旧 `null` 写回 Map。
   * 结果:恰在 secret 创建窗口的那个请求,把一个 fail-open 的空值**缓存到整个进程生命周期**,
   * 而且不报错、看不出来(实测已复现)。
   *
   * 【为什么用全局单计数器,而不是 per-key / per-prefix 代数】前缀失活必须能作用于
   * **尚未落槽的在途 key**,per-key 计数器天生做不到(那个 key 此刻还不存在);
   * per-prefix 表则要维护"哪些前缀影响哪些 key"的匹配逻辑 = 又一处可写错的地方。
   * 失活是**罕见事件**(secret 轮换/创建),多解析一次的代价可以忽略,
   * 所以取最不容易写错的做法:**任何一次失活都让所有在途解析失去写缓存资格**。
   *
   * 🔴 语义边界(别读成"重试"):被 fence 掉的在途解析**仍会把它自己的结果返回给调用方**
   * (调用方在等一个答案,不能吊死),只是**不写缓存**。所以那**一次**请求可能仍用旧值,
   * 但**不会污染后续**——下一次调用会重新解析。要把那一次也修对,得在调用方做重试,
   * 属于站点自己的事,不是缓存的责任。
   */
  private generation = 0;

  /** 已解析过(含解析为空)则直接返回;否则调 resolver 并把结果(含 null)记下。 */
  async resolve(key: string, resolver: () => Promise<T | null>): Promise<T | null> {
    if (this.m.has(key)) return this.m.get(key) as T | null;
    const gen = this.generation; // 🔴 解析**开始前**取代数
    const v = await resolver();
    if (this.generation !== gen) {
      // 解析期间发生过失活 ⇒ 这个结果可能已经过时,**返回但不缓存**。
      return v;
    }
    this.m.set(key, v);
    return v;
  }

  /**
   * 读缓存但**不触发解析**。返回 `undefined` = 未解析过;`null` = 解析过且为空。
   * 给"只缓存正结果"的站点用(如 SG id:原语义是"查失败不缓存、下次重试")——
   * 那类站点不能走 `resolve()`,否则负结果会被缓存住,行为就变了。
   */
  peek(key: string): T | null | undefined {
    return this.m.get(key);
  }

  /** 显式写入(配合 `peek` 用于只缓存正结果的站点)。 */
  set(key: string, value: T | null): void {
    this.m.set(key, value);
  }

  /** 主动失效(如重写了 secret 之后)。🔴 同时递增代数,fence 掉在途解析(见 `generation` 注释)。 */
  invalidate(key: string): void {
    this.m.delete(key);
    this.generation++;
  }

  /**
   * 按前缀批量失效,返回清掉的槽数。
   *
   * 🔴 **为什么需要它**(G7,外部审核 v2 P2-2 的连带发现):secret 写后失活原本只清
   * `${targetId}#-#<purpose>#-` **这一个槽**(project 为空的那个)。可是同一个 target 下
   * 还有按 project 分出的槽,它们缓存的是**同一个** secret ——
   * 于是"secret 从不存在变成刚创建"这个转换后,**project 槽里的 `null` 会留着**,
   * 该 project 的调用继续回落 IAM 身份,而且**不报错**。
   * 用 `invalidatePrefix(targetId + "#")` 一次清干净:失活的粒度必须 ≥ 缓存的粒度,
   * 否则就是一个 no-op 式的"看起来失活了"。
   */
  invalidatePrefix(prefix: string): number {
    // 先收集再删:边遍历边删 Map 语义上可行,但收集一份更直白。
    // 用 forEach 而不是 `[...keys()]` —— 仓里 tsconfig 的 target 不支持迭代 MapIterator(会 TS2802)。
    const doomed: string[] = [];
    this.m.forEach((_v, k) => {
      if (k.startsWith(prefix)) doomed.push(k);
    });
    doomed.forEach((k) => this.m.delete(k));
    // 🔴 **无论删了几个都要递增代数**(哪怕 0 个):P1-3 那条竞态的关键就是
    // "失活时该 key 还没落槽 ⇒ 删除数为 0",若按删除数决定是否递增,等于这条修复不存在。
    this.generation++;
    return doomed.length;
  }

  /** 单测 / 排障用。同样递增代数(否则测试里"清完再放行在途解析"会得到与生产不一致的行为)。 */
  clear(): void {
    this.m.clear();
    this.generation++;
  }

  /** 仅供单测断言 fencing 是否生效。 */
  get generationForTest(): number {
    return this.generation;
  }

  /** 仅供单测断言"是否真的缓存了"。 */
  get size(): number {
    return this.m.size;
  }

  has(key: string): boolean {
    return this.m.has(key);
  }
}
