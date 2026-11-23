// DMS 通道落点解析(lib/realtime/dms-place.ts)的判据。
//   只 mock 注册表的两个读口(`requireReadyTarget` 准入 / `getTargetRaw` 读原始描述符;整包校验与准入的真实现在注册表自己的判据里);
//   命名单一事实源、组件断言、执行角色判定、数仓 / 数据湖落点、区解析、决策账本都真跑。
//   执行环境描述符夹具的键与值形态照执行环境栈交付的写(名字里的 slug = 把 targetId 的下划线换成连字符)。
//   判据:
//     ① 主控区:名字与 2026-11 之前服务层的字面缺省逐字相同,访问角色取平台容器的 DMS_ROLE_ARN,不读注册表;
//     ② 执行区:区 / 子网组 / 访问角色 / 暂存桶 / 数仓全部来自该区的描述符,实例名与安全组名来自命名单一事实源;没有一项是主控区的值;
//     ③ 缺任何一项 ⇒ `DmsPlaceUnavailable`(503),消息点名缺什么、去哪补;绑了多个区 ⇒ 409;
//     ④ 准入通过才记落点决策(被拒的请求不许被归到某个区);
//     ⑤ `DmsSite`(停止 / 删除 / 读状态 / 回收用)不做准入:正在停止承接的执行区照样解析得出区与实例名;读不到区 ⇒ 抛,不回落主控区;
//     ⑥ 棘轮:落点只有本模块造得出来 —— 产品代码里不许出现判据专用构造,也不许在别处把普通对象断言成落点类型。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  process.env.REDSHIFT_WORKGROUP = "bgp-workgroup";
  process.env.REDSHIFT_DATABASE = "dev";
  delete process.env.EMR_LOG_BUCKET;
  return {
    targets: new Map<string, Record<string, unknown>>(),
    /** 准入会拒的执行环境(targetId → 拒因) */
    notReady: new Map<string, string>(),
    readyCalls: [] as string[],
    rawCalls: [] as string[],
  };
});

vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    requireReadyTarget: vi.fn(async (targetId: string) => {
      h.readyCalls.push(targetId);
      const why = h.notReady.get(targetId);
      if (why) throw new Error(why);
      const t = h.targets.get(targetId);
      if (!t) throw new Error(`执行目标 ${targetId} 不可用:注册表里没有该描述符(未注册 / 已删除)`);
      return t;
    }),
    getTargetRaw: vi.fn(async (targetId: string) => {
      h.rawCalls.push(targetId);
      return h.targets.get(targetId) ?? null;
    }),
  };
});

import {
  DMS_PLACE_VIA, DmsPlaceUnavailable, dmsTargetOfTask, resolveDmsPlace, resolveDmsSite, resolveDmsSiteOfTarget,
} from "@/lib/realtime/dms-place";
import { __resetRegionCache } from "@/lib/exec-env/target-region";
import { __setRequestStoreProvider, decisionsOfCurrentRequest } from "@/lib/place/context";

const HOME_ROLE = "arn:aws:iam::123456789012:role/bgp-dms-kinesis-role";
const WEST = "tgt_usw2";
const WEST_ROLE = "arn:aws:iam::123456789012:role/BgpExecEnv-tgt-usw2-dms-kinesis-role";

/** 一个已就位、装全组件的执行区描述符(us-west-2)。 */
function westTarget(over: { components?: string[]; resources?: Record<string, unknown>; drop?: string[] } = {}): Record<string, unknown> {
  const resources: Record<string, unknown> = {
    datalakeBucket: "bgp-datalake-123456789012-tgt-usw2",
    scriptsBucket: "bgp-glue-scripts-123456789012-tgt-usw2",
    redshiftWorkgroup: "bgp-workgroup-tgt-usw2",
    redshiftDatabase: "dev",
    dmsSubnetGroup: "bgp-dms-subnet-group-tgt-usw2",
    dmsKinesisRoleArn: WEST_ROLE,
    ...(over.resources ?? {}),
  };
  for (const k of over.drop ?? []) delete resources[k];
  return {
    targetId: WEST, region: "us-west-2", status: "active", ready: true,
    components: over.components ?? ["core", "redshift", "dms", "flink", "airflow-serverless"],
    resources,
  };
}
const boundTo = (...targets: string[]) => ({ taskId: "sync_x", channel: "dms", targets });

async function rejection(p: Promise<unknown>): Promise<DmsPlaceUnavailable> {
  const e = await p.then(() => null, (err) => err);
  expect(e, "应当被拒").toBeInstanceOf(DmsPlaceUnavailable);
  return e as DmsPlaceUnavailable;
}

let store: object;
beforeEach(() => {
  h.targets.clear(); h.notReady.clear(); h.readyCalls.length = 0; h.rawCalls.length = 0;
  h.targets.set(WEST, westTarget());
  process.env.DMS_ROLE_ARN = HOME_ROLE;
  __resetRegionCache();
  store = {};
  __setRequestStoreProvider(() => store);
});
afterEach(() => __setRequestStoreProvider(null));

describe("主控区的落点:与此前的字面缺省逐字相同", () => {
  it("① 三种绑定形态(targets[] / 存量顶层 targetId / 两者都没有)都解析到主控区,名字逐字不变,不读注册表", async () => {
    for (const task of [boundTo("tgt_home"), { targetId: "tgt_home" }, {}]) {
      const p = await resolveDmsPlace(task);
      expect({ ...p }).toEqual({
        targetId: "tgt_home",
        region: "us-east-1",
        instanceId: "bgp-dms",
        subnetGroupId: "bgp-dms-subnet-group",
        securityGroupName: "bgp-dms-sg",
        roleArn: HOME_ROLE,
        stagingBucket: "bgp-datalake-123456789012",
        warehouse: { targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-workgroup", database: "dev" },
        targetSecretName: "bgp/dms/redshift-target",
      });
    }
    expect(h.readyCalls).toEqual([]);
    expect(h.rawCalls).toEqual([]);
  });

  it("①b 平台容器没有 DMS_ROLE_ARN ⇒ 503,指路部署实时基建栈", async () => {
    delete process.env.DMS_ROLE_ARN;
    const e = await rejection(resolveDmsPlace(boundTo("tgt_home")));
    expect(e.reason).toBe("missing-resource");
    expect(e.httpStatus).toBe(503);
    expect(e.message).toContain("BgpRealtimeStack");
  });
});

describe("执行区的落点:每一项都来自任务绑定的那个区", () => {
  it("② 区 / 子网组 / 访问角色 / 暂存桶 / 数仓取该区描述符,实例名与安全组名取命名单一事实源;没有一项是主控区的值", async () => {
    const p = await resolveDmsPlace(boundTo(WEST));
    expect({ ...p }).toEqual({
      targetId: WEST,
      region: "us-west-2",
      instanceId: "bgp-dms-tgt-usw2",
      subnetGroupId: "bgp-dms-subnet-group-tgt-usw2",
      securityGroupName: "bgp-dms-sg-tgt-usw2",
      roleArn: WEST_ROLE,
      stagingBucket: "bgp-datalake-123456789012-tgt-usw2",
      warehouse: { targetId: WEST, region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2", database: "dev" },
      targetSecretName: "bgp/dms/redshift-target",
    });
    const home = await resolveDmsPlace(boundTo("tgt_home"));
    for (const k of ["targetId", "region", "instanceId", "subnetGroupId", "securityGroupName", "roleArn", "stagingBucket"] as const) {
      expect(p[k], `${k} 与主控区相同 ⇒ 这一项没有按区取`).not.toBe(home[k]);
    }
    expect(p.warehouse.workgroup).not.toBe(home.warehouse.workgroup);
    expect(h.readyCalls).toEqual([WEST]);
  });

  it("②b 子网组与数仓库名以描述符为准(栈交付什么就用什么),不按名字规则猜", async () => {
    h.targets.set(WEST, westTarget({ resources: { dmsSubnetGroup: "custom-subnet-group", redshiftDatabase: "analytics" } }));
    const p = await resolveDmsPlace(boundTo(WEST));
    expect(p.subnetGroupId).toBe("custom-subnet-group");
    expect(p.warehouse.database).toBe("analytics");
  });

  it("③ 该区没装 DMS 组件 ⇒ 503 missing-component,点名执行环境", async () => {
    h.targets.set(WEST, westTarget({ components: ["core", "redshift"] }));
    const e = await rejection(resolveDmsPlace(boundTo(WEST)));
    expect(e.reason).toBe("missing-component");
    expect(e.httpStatus).toBe(503);
    expect(e.targetId).toBe(WEST);
    expect(e.message).toContain(WEST);
    expect(e.message).toContain("dms");
  });

  it("③b 描述符缺复制子网组 / 数据湖桶 ⇒ 503 missing-resource,说清缺什么并指路「重新部署」", async () => {
    h.targets.set(WEST, westTarget({ drop: ["dmsSubnetGroup"] }));
    const noSubnet = await rejection(resolveDmsPlace(boundTo(WEST)));
    expect(noSubnet.reason).toBe("missing-resource");
    expect(noSubnet.httpStatus).toBe(503);
    expect(noSubnet.message).toContain("复制子网组");
    expect(noSubnet.message).toContain("「重新部署」");
    h.targets.set(WEST, westTarget({ drop: ["datalakeBucket"] }));
    const noBucket = await rejection(resolveDmsPlace(boundTo(WEST)));
    expect(noBucket.reason).toBe("missing-resource");
    expect(noBucket.message).toContain("数据湖桶");
    expect(noBucket.message).toContain("「重新部署」");
  });

  it("③c 访问角色缺、或不是这个区自己的角色(还是主控区那个共享角色)⇒ 503 missing-resource 指路「重新部署」;绝不拿主控区的角色凑数", async () => {
    h.targets.set(WEST, westTarget({ drop: ["dmsKinesisRoleArn"] }));
    const missing = await rejection(resolveDmsPlace(boundTo(WEST)));
    expect(missing.reason).toBe("missing-resource");
    expect(missing.message).toContain("dmsKinesisRoleArn");
    expect(missing.message).toContain("「重新部署」");
    h.targets.set(WEST, westTarget({ resources: { dmsKinesisRoleArn: HOME_ROLE } }));
    const shared = await rejection(resolveDmsPlace(boundTo(WEST)));
    expect(shared.reason).toBe("missing-resource");
    expect(shared.message).toContain("BgpExecEnv-tgt-usw2-dms-kinesis-role");
  });

  it("③d 描述符缺数仓工作组 ⇒ 503 missing-resource(不回落主控区的数仓)", async () => {
    h.targets.set(WEST, westTarget({ drop: ["redshiftWorkgroup"] }));
    const e = await rejection(resolveDmsPlace(boundTo(WEST)));
    expect(e.reason).toBe("missing-resource");
    expect(e.message).toContain("redshiftWorkgroup");
  });

  it("③e 执行环境不在可承接状态(准入拒)⇒ 503 not-ready,带上准入给的原因", async () => {
    h.notReady.set(WEST, "执行目标 tgt_usw2 不可用:状态 draining(停止承接新工作)");
    const e = await rejection(resolveDmsPlace(boundTo(WEST)));
    expect(e.reason).toBe("not-ready");
    expect(e.httpStatus).toBe(503);
    expect(e.message).toContain("执行环境 tgt_usw2 当前不可用");
    expect(e.message).toContain("draining");
  });

  it("③f 任务绑了多个执行区 ⇒ 409 multi-binding,列出绑定;不读注册表", async () => {
    const e = await rejection(resolveDmsPlace(boundTo("tgt_home", WEST)));
    expect(e.reason).toBe("multi-binding");
    expect(e.httpStatus).toBe(409);
    expect(e.message).toContain("tgt_home / tgt_usw2");
    expect(h.readyCalls).toEqual([]);
    expect(() => dmsTargetOfTask(boundTo("tgt_home", WEST))).toThrow(DmsPlaceUnavailable);
    expect(dmsTargetOfTask(boundTo(WEST))).toBe(WEST);
  });
});

describe("落点决策:准入通过才记", () => {
  const via = () => decisionsOfCurrentRequest().decisions.filter((d) => d.via === DMS_PLACE_VIA);

  it("④ 解析成功 ⇒ 记一笔(执行区 / 主控区各自的 targetId)", async () => {
    await resolveDmsPlace(boundTo(WEST));
    expect(via()).toEqual([{ targetId: WEST, via: DMS_PLACE_VIA }]);
    store = {};
    await resolveDmsPlace(boundTo("tgt_home"));
    expect(via()).toEqual([{ targetId: "tgt_home", via: DMS_PLACE_VIA }]);
  });

  it("④b 被拒(准入拒 / 缺组件 / 缺资源 / 多绑定)⇒ 一笔都不记", async () => {
    h.notReady.set(WEST, "draining");
    await rejection(resolveDmsPlace(boundTo(WEST)));
    h.notReady.clear();
    h.targets.set(WEST, westTarget({ components: ["core"] }));
    await rejection(resolveDmsPlace(boundTo(WEST)));
    h.targets.set(WEST, westTarget({ drop: ["dmsSubnetGroup"] }));
    await rejection(resolveDmsPlace(boundTo(WEST)));
    await rejection(resolveDmsPlace(boundTo("tgt_home", WEST)));
    expect(decisionsOfCurrentRequest().decisions).toEqual([]);
  });
});

describe("只要「哪个区、哪台实例」的解析(停止 / 删除 / 读状态 / 回收用):不做准入", () => {
  it("⑤ 正在停止承接的执行区照样解析得出区与实例名(那里的通道也得停得下来),不调准入", async () => {
    h.notReady.set(WEST, "draining");
    h.targets.set(WEST, westTarget({ components: ["core"], drop: ["dmsSubnetGroup", "dmsKinesisRoleArn"] }));
    const s = await resolveDmsSite(boundTo(WEST));
    expect({ ...s }).toEqual({ targetId: WEST, region: "us-west-2", instanceId: "bgp-dms-tgt-usw2" });
    expect(h.readyCalls).toEqual([]);
    expect(h.rawCalls).toEqual([WEST]);
    expect(decisionsOfCurrentRequest().decisions).toContainEqual({ targetId: WEST, via: DMS_PLACE_VIA });
  });

  it("⑤b 主控区 ⇒ 主控区的区与 bgp-dms,不读注册表", async () => {
    expect({ ...(await resolveDmsSiteOfTarget("tgt_home")) }).toEqual({ targetId: "tgt_home", region: "us-east-1", instanceId: "bgp-dms" });
    expect({ ...(await resolveDmsSite({})) }).toEqual({ targetId: "tgt_home", region: "us-east-1", instanceId: "bgp-dms" });
    expect(h.rawCalls).toEqual([]);
  });

  it("⑤c 注册表里读不到这个执行环境的区 ⇒ 抛,不回落主控区(调用方按「不知道它在哪跑」处理);多绑定同样抛", async () => {
    h.targets.clear();
    await expect(resolveDmsSite(boundTo(WEST))).rejects.toThrow(/tgt_usw2/);
    await expect(resolveDmsSiteOfTarget("tgt_bad id")).rejects.toThrow();
    await expect(resolveDmsSite(boundTo("tgt_home", WEST))).rejects.toBeInstanceOf(DmsPlaceUnavailable);
  });
});

describe("棘轮:落点只有落点解析模块造得出来", () => {
  const SRC = path.join(process.cwd(), "src");
  const AUTHOR = "lib/realtime/dms-place.ts";
  function productSources(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) productSources(full, out);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
  }
  const files = productSources(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join("/"), text: readFileSync(f, "utf8") }));

  it("⑥ 扫到的是整棵产品源码树(扫空了 = 这条棘轮什么都没看)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.rel === AUTHOR)).toBe(true);
    expect(files.some((f) => f.rel === "lib/realtime/dms-service.ts")).toBe(true);
  });

  it("⑥b 判据专用构造 `__dmsPlaceForTest` 在产品代码里只有定义那一处,没有任何引用", () => {
    const hits = files.flatMap((f) => (f.text.match(/__dmsPlaceForTest/g) ?? []).map(() => f.rel));
    expect(hits).toEqual([AUTHOR]);
    const author = files.find((f) => f.rel === AUTHOR)!.text;
    expect(author).toContain("export function __dmsPlaceForTest(");
  });

  it("⑥c 把普通对象断言成 `DmsSite` / `DmsPlace` 的写法只许出现在落点解析模块里(别处这样写 = 绕过解析自己造落点)", () => {
    const cast = /\bas\s+(?:unknown\s+as\s+)?Dms(?:Site|Place)\b/;
    const offenders = files.filter((f) => f.rel !== AUTHOR && cast.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
    // 对照:这条正则在作者模块里确实认得出断言(认不出 = 上一条恒绿)
    expect(cast.test(files.find((f) => f.rel === AUTHOR)!.text)).toBe(true);
  });
});
