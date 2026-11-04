// G6—— 复合键 SSOT + 进程级缓存单测。
//
// 【为什么必须有这个测试】三个被改造的缓存原本都缓存**负结果**(`admin-secret` 用 null、
// `zeroetl` 用 ""),那是刻意的:没配 secret 的环境不该每次调用都打一次 Secrets Manager。
// 改造时一旦把负缓存丢了,**行为就变了**(G 批要求零行为变化)、而且平白增加 API 调用与延迟,
// 却不会有任何测试报错。所以这里把"负结果也要缓存"钉成不变量。
import { describe, it, expect } from "vitest";
import { credCacheKey, locationCacheKey, ProcessCache } from "@/lib/exec-env/cred-cache";

describe("credCacheKey —— 三元键形状", () => {
  it("形如 targetId#project#purpose", () => {
    expect(credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "project-context" })).toBe(
      "tgt_home#proj_a#project-context#-"
    );
  });

  it("无项目上下文落成 '-'(治理只读那类本来就没有 project)", () => {
    expect(credCacheKey({ targetId: "tgt_home", purpose: "governance-read" })).toBe("tgt_home#-#governance-read#-");
  });

  it("🔴 purpose 不同必须落不同键 —— 少了这一维,治理只读身份会与 admin 共用缓存槽(权限提升)", () => {
    const a = credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "governance-read" });
    const b = credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "admin-ddl" });
    expect(a).not.toBe(b);
  });

  it("🔴 targetId 不同必须落不同键 —— 少了这一维就是跨区串值(第一个 target 的 secret 被所有 target 复用)", () => {
    const a = credCacheKey({ targetId: "tgt_home", purpose: "project-context" });
    const b = credCacheKey({ targetId: "tgt_eu1", purpose: "project-context" });
    expect(a).not.toBe(b);
  });

  it("project 不同必须落不同键", () => {
    const a = credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "project-context" });
    const b = credCacheKey({ targetId: "tgt_home", project: "proj_b", purpose: "project-context" });
    expect(a).not.toBe(b);
  });

  it("🔴 epoch 不同必须落不同键 —— 少了这一维,状态从 legacy 切到 isolated 后旧缓存仍会命中(v2 审核 P0-3 实测)", () => {
    const a = credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "project-context", epoch: 0 });
    const b = credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "project-context", epoch: 1 });
    expect(a).not.toBe(b);
    expect(a).toContain("#e0");
    expect(b).toContain("#e1");
  });

  it("不传 epoch 落成 '-'(治理只读那类无世代语义)", () => {
    expect(credCacheKey({ targetId: "tgt_home", purpose: "governance-read" })).toBe("tgt_home#-#governance-read#-");
  });

  it("非法 targetId / 缺 purpose 一律抛(键是安全边界,不容许模糊)", () => {
    expect(() => credCacheKey({ targetId: "tgt_BAD", purpose: "project-context" })).toThrow();
    expect(() => credCacheKey({ targetId: "tgt_home", purpose: "" })).toThrow(/purpose/);
  });
});

describe("locationCacheKey —— 纯位置轴", () => {
  it("只按 targetId(SG 属于 VPC/region,与项目/用途无关)", () => {
    expect(locationCacheKey("tgt_home")).toBe("tgt_home");
  });

  it("非法 targetId 仍要抛", () => {
    expect(() => locationCacheKey("nope")).toThrow();
  });
});

describe("ProcessCache —— 负结果也必须缓存", () => {
  it("🔴 解析为 null 也算解析过:第二次不再调 resolver", async () => {
    const c = new ProcessCache<string>();
    let calls = 0;
    const r = async () => {
      calls++;
      return null;
    };
    expect(await c.resolve("k", r)).toBeNull();
    expect(await c.resolve("k", r)).toBeNull();
    expect(calls, "负结果没被缓存 ⇒ 每次调用都会打一次 Secrets Manager").toBe(1);
  });

  it("正结果缓存后不再调 resolver", async () => {
    const c = new ProcessCache<string>();
    let calls = 0;
    const r = async () => {
      calls++;
      return "arn:x";
    };
    expect(await c.resolve("k", r)).toBe("arn:x");
    expect(await c.resolve("k", r)).toBe("arn:x");
    expect(calls).toBe(1);
  });

  it("不同键互不影响(这才是复合键的意义)", async () => {
    const c = new ProcessCache<string>();
    await c.resolve("a", async () => "A");
    await c.resolve("b", async () => "B");
    expect(await c.resolve("a", async () => "X")).toBe("A");
    expect(await c.resolve("b", async () => "X")).toBe("B");
    expect(c.size).toBe(2);
  });

  it("invalidate 只清指定键(重写 secret 后不该把别的 target 一起清掉)", async () => {
    const c = new ProcessCache<string>();
    await c.resolve("a", async () => "A");
    await c.resolve("b", async () => "B");
    c.invalidate("a");
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
  });

  it("🔴 epoch 维的**行为级**验证:epoch 0 写入的槽,用 epoch 1 读不到(secret 轮换后旧 ARN 不被复用)", async () => {
    // 为什么单独补这条:P0-3 那个"状态切换"回归场景,实际是被"回落结果不缓存"挡住的,
    // 不是被 epoch 挡住的 —— 变异测试把 epoch 维删掉时只有"键形状"那条测试变红,
    // 说明 epoch 维当时**没有行为级测试**。epoch 真正保护的是**正结果**路径:
    // 项目 secret 轮换(epoch++)后,旧 ARN 绝不能继续命中。
    const c = new ProcessCache<string>();
    const k0 = credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "project-context", epoch: 0 });
    const k1 = credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "project-context", epoch: 1 });
    c.set(k0, "arn:OLD-SECRET");
    expect(c.peek(k1), "epoch 前进后旧槽不得命中").toBeUndefined();
    expect(await c.resolve(k1, async () => "arn:NEW-SECRET")).toBe("arn:NEW-SECRET");
    // ⚠️ 如实登记:`getPrivilegedCred` 的**正结果**路径今天走不到(lookupProjectSecretArn 在
    // G 阶段恒返回 undefined,per-project secret 要才创建),所以那一层的端到端
    // 行为测试要等。此处先在机制层钉住。
  });

  it("peek 区分'未解析'(undefined)与'解析过且为空'(null)——只缓存正结果的站点靠它", async () => {
    const c = new ProcessCache<string>();
    expect(c.peek("k")).toBeUndefined();
    await c.resolve("k", async () => null);
    expect(c.peek("k")).toBeNull();
    c.set("j", "v");
    expect(c.peek("j")).toBe("v");
  });

  // 🔴 G7 新增(外部审核 v2 P2-2 连带发现):失活的粒度必须 ≥ 缓存的粒度。
  // 缓存键含 project 维,而 secret 写后只清"project 为空"那一槽 ⇒ project 槽里的 null 留着,
  // 那个 project 继续回落 IAM 身份、不报错、看不出来。
  describe("invalidatePrefix —— 失活粒度必须 ≥ 缓存粒度", () => {
    it("清掉某 target 的**全部**槽(跨 project、跨 purpose、跨 epoch)", async () => {
      const c = new ProcessCache<string>();
      const keys = [
        credCacheKey({ targetId: "tgt_home", purpose: "zeroetl-admin" }),
        credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "zeroetl-admin" }),
        credCacheKey({ targetId: "tgt_home", project: "proj_a", purpose: "project-context", epoch: 3 }),
      ];
      keys.forEach((k) => c.set(k, "v"));
      const other = credCacheKey({ targetId: "tgt_eu1", project: "proj_a", purpose: "zeroetl-admin" });
      c.set(other, "v-eu");
      expect(c.invalidatePrefix("tgt_home#")).toBe(3);
      keys.forEach((k) => expect(c.peek(k), `${k} 应已被清掉`).toBeUndefined());
      expect(c.peek(other), "别的 target 不该被带走").toBe("v-eu");
    });

    it("🔴 前缀不许越界:清 `tgt_home#` 不能带走 `tgt_home2#`(所以前缀必须带 '#')", () => {
      const c = new ProcessCache<string>();
      c.set("tgt_home#-#p#-", "a");
      c.set("tgt_home2#-#p#-", "b");
      expect(c.invalidatePrefix("tgt_home#")).toBe(1);
      expect(c.peek("tgt_home2#-#p#-")).toBe("b");
    });

    it("没有匹配槽时返回 0(不抛,失活是幂等操作)", () => {
      const c = new ProcessCache<string>();
      expect(c.invalidatePrefix("tgt_home#")).toBe(0);
    });
  });

  // 🔴 在途并发放在这一层测(外部审核 v2 P2-2)。
  // 为什么不在 `redshift/admin-secret` 那个站点测:它的 resolver 里是**动态 import**,
  // vitest 下第二个并发 import 会被 mock 注册表拒、又被站点的 `catch{}` 吞掉 ⇒ 那里断出来的
  // 不是产品行为(详见 admin-secret.test.ts 的说明)。机制本身在这儿,就在这儿钉。
  describe("在途并发", () => {
    it("同槽并发:两个调用者拿到同一个值,收敛后只留一个槽", async () => {
      const c = new ProcessCache<string>();
      const pending: Array<(v: string | null) => void> = [];
      const resolver = () => new Promise<string | null>((res) => pending.push(res));
      const p1 = c.resolve("k", resolver);
      const p2 = c.resolve("k", resolver);
      expect(pending.length, "两个调用都应已进入解析(本实现刻意没做 in-flight 去重)").toBe(2);
      pending.forEach((res) => res("v"));
      expect(await p1).toBe("v");
      expect(await p2).toBe("v");
      expect(c.size, "收敛后只应留一个槽").toBe(1);
      // 🔴 如实登记:**没有 in-flight 去重**(改造前也没有)。这里断的是"值一致 + 槽不分裂",
      // 不把"resolver 被调几次"钉成合同 —— 那是可优化的实现细节,不是要保的语义。
    });

    it("不同槽并发互不串值", async () => {
      const c = new ProcessCache<string>();
      const [a, b] = await Promise.all([c.resolve("ka", async () => "va"), c.resolve("kb", async () => "vb")]);
      expect(a).toBe("va");
      expect(b).toBe("vb");
      expect(c.peek("ka")).toBe("va");
      expect(c.peek("kb")).toBe("vb");
    });

    it("resolver 抛错时**不缓存**(否则一次抖动被钉死;负结果只指'解析成了空')", async () => {
      const c = new ProcessCache<string>();
      await expect(c.resolve("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow(/boom/);
      expect(c.has("k"), "抛错不该留下槽").toBe(false);
      expect(await c.resolve("k", async () => "v")).toBe("v");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴 G8 —— 失活的**时机**(generation fencing),外部审核 v3 P1-3 的 N4 整改
//
// 上一批我只修了失活的**粒度**(前缀批量清),没修**时机**:`resolve()` 是
// "未命中 → await resolver → set",失活只删当时已落槽的键 ⇒ 恰在写窗口的在途解析
// 会在失活**之后**把旧值写回,把 fail-open 的空值缓存到整个进程生命周期(实测复现)。
// 这一组就是那条竞态的回归门禁(ACCEPTANCE)。
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 在途解析 × 失活 的竞态", () => {
  it("🔴🔴 失活发生在解析途中 ⇒ 旧值**不得**写回缓存(v3 实测曾写回)", async () => {
    const c = new ProcessCache<string>();
    let release: (v: string | null) => void = () => {};
    const p = c.resolve("tgt_home#-#p#-", () => new Promise<string | null>((r) => (release = r)));

    // 写路径:创建 secret 后失活 —— 此刻该 key **还没落槽**,删除数必然是 0。
    expect(c.invalidatePrefix("tgt_home#"), "此刻还没落槽,删除数就是 0").toBe(0);

    release(null); // 旧 resolver 现在才返回"没有 secret"
    expect(await p, "调用方仍要拿到一个答案(不能吊死)").toBeNull();
    expect(c.has("tgt_home#-#p#-"), "🔴 但它绝不能进缓存 —— 否则整个进程都回落 IAM 身份").toBe(false);

    // 下一次调用必须重新解析,并拿到新值。
    expect(await c.resolve("tgt_home#-#p#-", async () => "arn:new")).toBe("arn:new");
    expect(c.peek("tgt_home#-#p#-")).toBe("arn:new");
  });

  it("单键 invalidate 也 fence(不只前缀失活)", async () => {
    const c = new ProcessCache<string>();
    let release: (v: string | null) => void = () => {};
    const p = c.resolve("k", () => new Promise<string | null>((r) => (release = r)));
    c.invalidate("k");
    release("old");
    expect(await p).toBe("old");
    expect(c.has("k"), "失活后旧值不得回填").toBe(false);
  });

  it("clear 同样 fence(否则测试里的行为与生产不一致 = 又一个假绿源)", async () => {
    const c = new ProcessCache<string>();
    let release: (v: string | null) => void = () => {};
    const p = c.resolve("k", () => new Promise<string | null>((r) => (release = r)));
    c.clear();
    release("old");
    await p;
    expect(c.has("k")).toBe(false);
  });

  it("没有失活时正常写缓存(别把 fencing 做成「永不缓存」)", async () => {
    const c = new ProcessCache<string>();
    expect(await c.resolve("k", async () => "v")).toBe("v");
    expect(c.peek("k")).toBe("v");
    expect(c.generationForTest, "没失活过,代数不该动").toBe(0);
  });

  it("🔴 失活**无论删了几个**都要递增代数(按删除数决定 = 这条修复等于不存在)", () => {
    const c = new ProcessCache<string>();
    const g0 = c.generationForTest;
    expect(c.invalidatePrefix("nothing-matches#")).toBe(0);
    expect(c.generationForTest, "删 0 个也必须递增").toBe(g0 + 1);
  });

  it("两个不同 key 的在途解析:失活只让它们都不写缓存,但都能拿到自己的值", async () => {
    const c = new ProcessCache<string>();
    const rel: Array<(v: string | null) => void> = [];
    const pa = c.resolve("a", () => new Promise<string | null>((r) => rel.push(r)));
    const pb = c.resolve("b", () => new Promise<string | null>((r) => rel.push(r)));
    c.invalidatePrefix("a");
    rel[0]("va");
    rel[1]("vb");
    expect(await pa).toBe("va");
    expect(await pb).toBe("vb");
    // 🔴 如实登记:全局单计数器的代价是"无关 key 的在途解析也不写缓存"。
    // 这是**刻意**的取舍:失活罕见,多解析一次可忽略;换来的是不可能写回陈旧值。
    expect(c.size, "两者都没进缓存(保守但绝不会错)").toBe(0);
  });
});
