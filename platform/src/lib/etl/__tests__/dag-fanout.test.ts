// @kf-batch 50-P50.3-fanout
// 逐 target 扇出下发的门禁 —— 🔴 **全部可执行**(真调 `publishFanout`/`offlineFanout`,
// 打桩只打到 S3 / DDB / 绑定解析这三层边界),不用文本断言。
//
// 为什么这一组必须可执行:W3-a 那批的教训是「tsc 全绿 + 单测全绿,只有真跑才发现打回了 home」。
// 扇出的三个承重不变量都属于同一类"不报错、只是少做了一件事":
//   ① home 的 dagId 逐字节不变(否则存量 DAG 变孤儿 ⇒ **同一作业一天跑两遍**);
//   ② N 个绑定 ⇒ N 个**不同** S3 key(同名就只剩最后一个,而台账仍是 N 条绿);
//   ③ 失败也写台账 + fail-fast 之后**不写**被跳过的那些(写了就是编造)。
// 文本断言对这三条统统无能为力,所以这里全部真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  s3Puts: [] as Array<{ Bucket: string; Key: string; Body: string }>,
  failOnKeyPart: "",
  ddbSent: [] as Array<{ ctor: string; input: Record<string, any> }>,
  offlined: [] as string[],
  noMwaa: [] as string[],
  bindings: {} as Record<
    string,
    { region: string; workgroup: string; database: string; secretArn?: string; degraded?: boolean }
  >,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(public input: any) {}
  }
  class DeleteObjectCommand {
    constructor(public input: any) {}
  }
  class S3Client {
    async send(cmd: any) {
      if (h.failOnKeyPart && String(cmd.input?.Key || "").includes(h.failOnKeyPart)) {
        throw new Error("AccessDenied: 该区域的桶策略拒绝写入");
      }
      h.s3Puts.push(cmd.input);
      return {};
    }
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand };
});

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ETL_JOBS: "bgp-etl-jobs" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.ddbSent.push({ ctor: cmd.constructor.name, input: cmd.input });
      return {};
    }),
  },
}));

vi.mock("@/lib/scheduler/mwaa-offline", () => ({
  // @kf-batch 50-WP13-mwaa-region:下线带 targetId(去该 target 自己的 MWAA)
  offlineDag: vi.fn(async (dagId: string, targetId: string) => {
    h.offlined.push(`${dagId}@${targetId}`);
    return { dagId, targetId, paused: true, dagFileDeleted: true };
  }),
}));

// @kf-batch 50-WP13-mwaa-region —— MWAA 端点按 h.bindings 造(有绑定 = 装了 mwaa);h.noMwaa 里的 target 视为未装
vi.mock("@/lib/scheduler/mwaa-endpoint", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, any>;
  const epOf = (tid: string) => {
    if (h.noMwaa.includes(tid)) return null;
    const b = h.bindings[tid];
    const region = b?.region ?? (tid === "tgt_home" ? "us-east-1" : "us-west-2");
    return tid === "tgt_home"
      ? { targetId: tid, region, envName: "bgp-mwaa", dagBucket: "bgp-mwaa-dags", home: true }
      : { targetId: tid, region, envName: `bgp-mwaa-${tid.replace(/_/g, "-")}`, dagBucket: `bgp-mwaa-dags-${tid.replace(/_/g, "-")}`, home: false };
  };
  return {
    ...real,
    homeMwaaEndpoint: () => epOf("tgt_home"),
    mwaaEndpointFor: vi.fn(async (tid: string) => {
      const ep = epOf(tid);
      if (!ep) throw new real.MwaaNotInstalled([{ targetId: tid, region: "us-west-2", reason: "未安装 mwaa 组件" }]);
      return ep;
    }),
    requireMwaaForTargets: vi.fn(async (targets: string[]) => {
      const missing = targets.filter((t) => !epOf(t)).map((t) => ({ targetId: t, region: "us-west-2", reason: "未安装 mwaa 组件" }));
      if (missing.length) throw new real.MwaaNotInstalled(missing);
      return new Map(targets.map((t) => [t, epOf(t)]));
    }),
    // @kf-batch 50-WP15-airflow-serverless(施工序 6):预览改走联合解析器;本文件夹具全是经典 MWAA 端点(无 kind)⇒ 同一张 epOf
    schedulerEndpointFor: vi.fn(async (tid: string) => {
      const ep = epOf(tid);
      // 生产口径 = `${slsReason};${mwaaReason}`(两种缺因一起列);夹具照此拼,预览断言仍能看到 mwaa 缺因
      if (!ep) throw new real.MwaaNotInstalled([{ targetId: tid, region: "us-west-2", reason: "未安装 airflow-serverless 组件;未安装 mwaa 组件" }]);
      return ep;
    }),
    serverlessEndpointFor: vi.fn(async (tid: string) => {
      throw new real.MwaaNotInstalled([{ targetId: tid, region: "us-west-2", reason: "夹具无 serverless 端点" }]);
    }),
  };
});
vi.mock("@/lib/exec-env/target-clients", async () => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return { s3ClientFor: vi.fn(async () => new (S3Client as any)()) };
});
vi.mock("@/lib/exec-env/target-region", async (importOriginal) => {
  // 🔴 只替换 regionOfTarget:TargetBindingRejected 从这里 re-export,整包替掉会让 `new real.TargetBindingRejected` 变成 undefined
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, regionOfTarget: vi.fn(async (tid: string) => (tid === "tgt_home" ? "us-east-1" : "us-west-2")) };
});

vi.mock("@/lib/versions/version-service", () => ({
  currentDefinitionVersion: vi.fn(async () => 7),
}));

// 🔴 只替换**绑定解析**这一层(它要打注册表),`bindingTargets` 等归一函数用真的 ——
// 归一口径若也打桩,这组测试就变成"测打桩"了。
vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (args: { targetId?: string }) => {
      const tid = args.targetId || "tgt_home";
      const b = h.bindings[tid];
      if (!b) throw new (real.TargetBindingRejected as any)("missing-component", `目标 ${tid} 没装 redshift 组件`);
      // 🔴 与真实语义一致:home 目前就是共享 admin(per-project 化属 P52.5b),
      // 非 home 在 legacy-seeded / provisioning 下也回落该 target 自己的 admin。
      return { targetId: tid, ...b, degradedToLegacyAdmin: b.degraded ?? true, home: tid === "tgt_home" };
    }),
  };
});

import {
  dagIdForTarget,
  baseDagIdOf,
  publishFanout,
  offlineFanout,
  offlineUnboundTargets,
  deployedOrBoundTargets,
  planFanout,
} from "@/lib/etl/dag-fanout";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";
const EU = "tgt_euw1_a";

const job = (over: Record<string, unknown> = {}) =>
  ({
    userId: "default-user",
    jobId: "J1",
    name: "n",
    type: "redshift",
    script: "SELECT 1;",
    createdAt: "",
    updatedAt: "",
    ...over,
  }) as any;

beforeEach(() => {
  h.s3Puts.length = 0;
  h.ddbSent.length = 0;
  h.offlined.length = 0;
  h.noMwaa.length = 0;
  h.failOnKeyPart = "";
  h.bindings = {
    [HOME]: { region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:home" },
    [USW2]: { region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev", secretArn: "arn:usw2" },
  };
});

describe("🔴 dagId 命名:home 必须逐字节不变", () => {
  it("home 的 dagId 等于基准值(换名 ⇒ 存量 DAG 变孤儿 ⇒ 同一作业一天跑两遍)", () => {
    expect(dagIdForTarget("bgp_etl_J1", HOME)).toBe("bgp_etl_J1");
    expect(baseDagIdOf(job())).toBe("bgp_etl_J1");
    expect(baseDagIdOf(job({ airflowDagId: "custom_dag" }))).toBe("custom_dag");
  });

  it("非 home 带 target 段,且各 target 互不相同", () => {
    const a = dagIdForTarget("bgp_etl_J1", USW2);
    const b = dagIdForTarget("bgp_etl_J1", EU);
    expect(a).toBe("bgp_etl_J1__tgt_usw2_a");
    expect(a).not.toBe(b);
  });

  it("非法 targetId 当场抛(它会被拼进 dag_id 与 S3 key)", () => {
    expect(() => dagIdForTarget("bgp_etl_J1", "TGT_HOME")).toThrow();
    expect(() => dagIdForTarget("bgp_etl_J1", "tgt_a; rm -rf")).toThrow();
  });
});

describe("🔴🔴 扇出:N 个绑定 ⇒ N 份产物 + N 条台账", () => {
  it("绑两个区 ⇒ 两个**不同**的 S3 key,各自带自己的 region / workgroup", async () => {
    const r = await publishFanout(job({ targets: [HOME, USW2] }), { cron: "0 5 * * *" });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "ok"]);
    const keys = h.s3Puts.map((p) => p.Key);
    expect(keys).toEqual(["dags/bgp_etl_J1.py", "dags/bgp_etl_J1__tgt_usw2_a.py"]);
    expect(new Set(keys).size, "两份产物同名 ⇒ 只剩最后一个,而台账仍是两条绿").toBe(2);
    const homeDag = h.s3Puts[0].Body;
    const usw2Dag = h.s3Puts[1].Body;
    // 🔴🔴 **文件名对了不等于 dag_id 对了**(变异 M67 就是这么溜过第一版断言的):
    // 若两份文件都声明 `dag_id="bgp_etl_J1"`,Airflow 里就是**重复 dag_id**,只有一个生效 ——
    // S3 上两个文件、台账两条绿、MWAA 里只跑一个区。这种形态从产物名完全看不出来。
    expect(homeDag).toContain('dag_id="bgp_etl_J1"');
    expect(usw2Dag).toContain('dag_id="bgp_etl_J1__tgt_usw2_a"');
    expect(usw2Dag, "两份 DAG 声明了同一个 dag_id ⇒ Airflow 只认一个,另一个区静默不跑").not.toContain(
      'dag_id="bgp_etl_J1"\n'
    );
    expect(homeDag).toContain('EXEC_REGION = "us-east-1"');
    expect(usw2Dag).toContain('EXEC_REGION = "us-west-2"');
    expect(usw2Dag).toContain('CTRL_REGION = "us-east-1"'); // 控制面永远 home
    expect(usw2Dag).toContain('WorkgroupName="bgp-workgroup-tgt-usw2-a"');
    expect(usw2Dag).toContain('SecretArn="arn:usw2"');
  });

  it("🔴 每份 DAG 的**锁属性名**与**章**都是它自己那个 target 的", async () => {
    await publishFanout(job({ targets: [HOME, USW2], projectId: "proj-x" }), { cron: "0 5 * * *" });
    const homeDag = h.s3Puts[0].Body;
    const usw2Dag = h.s3Puts[1].Body;
    // home 与存量逐字节同名(并存期两侧不分裂)
    expect(homeDag).toContain('_LK_TOK, _LK_EXP, _LK_LEASE_MS = "runLockToken", "runLockExpiresAt"');
    expect(usw2Dag).toContain('"runLock-tgt_usw2_aToken", "runLock-tgt_usw2_aExpiresAt"');
    // 🔴 章:usw2 那份不许盖 home —— 盖错了作业跑对了、监控页却归错区(区域筛选从此不可信)
    expect(usw2Dag).toContain('"targetId": "tgt_usw2_a"');
    expect(usw2Dag).not.toContain('"targetId": "tgt_home"');
    expect(homeDag).toContain('"targetId": "tgt_home"');
  });

  it("台账逐 target 写、用 **map 路径**写(不是整包覆盖),且带当前定义版本", async () => {
    await publishFanout(job({ targets: [HOME, USW2] }), { cron: "0 5 * * *" });
    const mapWrites = h.ddbSent.filter((x) => String(x.input.UpdateExpression).includes("SET #d.#t"));
    expect(mapWrites.length, "两个 target 各写一条").toBe(2);
    expect(mapWrites.map((x) => x.input.ExpressionAttributeNames["#t"])).toEqual([HOME, USW2]);
    for (const w of mapWrites) {
      expect(w.input.ExpressionAttributeValues[":v"].version, "台账没记版本 ⇒ 矩阵判不出「版本不齐」").toBe(7);
      expect(w.input.ExpressionAttributeValues[":v"].status).toBe("ok");
    }
    // 🔴 负向:不许出现"整包覆盖 deployments"的写法(逐 target 串行下发时会抹掉前一个的结果)
    const wholeMap = h.ddbSent.filter((x) => /SET #d = :(?!empty)/.test(String(x.input.UpdateExpression)));
    expect(wholeMap, "整包覆盖 deployments ⇒ 第 3 个区失败时前两个成功记录一起消失").toEqual([]);
  });
});

describe("🔴 fail-fast:失败要写台账,被跳过的**不许**写", () => {
  it("第 2 个区失败 ⇒ 它记 failed、第 3 个区 skipped 且台账里没有它", async () => {
    h.bindings[EU] = { region: "eu-west-1", workgroup: "wg-eu", database: "dev", secretArn: "arn:eu" };
    h.failOnKeyPart = "tgt_usw2_a";
    const r = await publishFanout(job({ targets: [HOME, USW2, EU] }), { cron: "0 5 * * *" });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "failed", "skipped"]);
    expect(r.rows[1].error, "失败原因没带出来 ⇒ 看板只能显示「漏发」,处置完全不同").toContain("AccessDenied");
    const written = h.ddbSent
      .filter((x) => String(x.input.UpdateExpression).includes("SET #d.#t"))
      .map((x) => ({ t: x.input.ExpressionAttributeNames["#t"], s: x.input.ExpressionAttributeValues[":v"].status }));
    expect(written).toEqual([
      { t: HOME, s: "ok" },
      { t: USW2, s: "failed" },
    ]);
    expect(
      written.some((w) => w.t === EU),
      "给被 fail-fast 跳过的 target 写了台账 ⇒ 那是编造(它根本没动过)"
    ).toBe(false);
  });

  it("🔴 home 永远先发:用户先勾 usw2 再勾 home 时,usw2 失败也不许把 home 那份拖着不更新", async () => {
    h.failOnKeyPart = "tgt_usw2_a";
    const r = await publishFanout(job({ targets: [USW2, HOME] }), { cron: "0 5 * * *" });
    expect(r.rows.map((x) => x.targetId), "下发顺序没把 home 提前 ⇒ 第一个就 fail-fast,home 完全不会更新").toEqual([
      HOME,
      USW2,
    ]);
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "failed"]);
    expect(h.s3Puts.map((p) => p.Key)).toEqual(["dags/bgp_etl_J1.py"]);
  });

  // @kf-batch 50-P50.3-matrix
  it("🔴 子集重发(矩阵的「重发到此 region」):只发点名的那个区,**不动**其它区的台账", async () => {
    const r = await publishFanout(job({ targets: [HOME, USW2] }), { cron: "0 5 * * *", onlyTargets: [USW2] });
    expect(r.rows.map((x) => x.targetId)).toEqual([USW2]);
    expect(h.s3Puts.map((p) => p.Key)).toEqual(["dags/bgp_etl_J1__tgt_usw2_a.py"]);
    const written = h.ddbSent
      .filter((x) => String(x.input.UpdateExpression).includes("SET #d.#t"))
      .map((x) => x.input.ExpressionAttributeNames["#t"]);
    expect(written, "重发一个区却把别的区的台账也写了 ⇒ 会把别的区的真实状态改掉").toEqual([USW2]);
  });

  it("🔴 子集重发**不许顺手改绑定**:点名一个没绑的区 ⇒ 抛(下发不该有副作用)", async () => {
    await expect(
      publishFanout(job({ targets: [HOME] }), { cron: "0 5 * * *", onlyTargets: [USW2] })
    ).rejects.toThrow(/不在该作业的绑定里/);
    expect(h.s3Puts, "被拒了却已经发出去了 ⇒ 拒绝不彻底").toEqual([]);
  });

  it("绑定解析失败(目标没装组件)也走同一条 failed 记录,不是整体抛", async () => {
    const r = await publishFanout(job({ targets: [HOME, EU] }), { cron: "0 5 * * *" });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "failed"]);
    expect(r.rows[1].error).toContain("没装 redshift 组件");
  });
});

describe("🔴🔴 解绑 ≠ 下线", () => {
  it("下线覆盖 **绑定 ∪ 台账**:先解绑再下线时,那个区的 DAG 也要撤", async () => {
    const j = job({ targets: [HOME], deployments: { [USW2]: { version: 7, publishedAt: 1, status: "ok" } } });
    expect(deployedOrBoundTargets(j)).toEqual([HOME, USW2]);
    await offlineFanout(j);
    expect(h.offlined, "只撤了当前绑定 ⇒ usw2 那份 DAG 永久留在 MWAA 里按 cron 跑").toEqual([
      "bgp_etl_J1@tgt_home",
      "bgp_etl_J1__tgt_usw2_a@tgt_usw2_a",
    ]);
    // 台账也要清:DAG 撤了台账还留 ok 就是"看板假绿"
    const removes = h.ddbSent.filter((x) => String(x.input.UpdateExpression).startsWith("REMOVE #d.#t"));
    expect(removes.map((x) => x.input.ExpressionAttributeNames["#t"])).toEqual([HOME, USW2]);
  });

  it("绑定收缩:只下线被摘掉的那些,保留的那个不动", async () => {
    const j = job({
      targets: [HOME, USW2],
      deployments: {
        [HOME]: { version: 7, publishedAt: 1, status: "ok" },
        [USW2]: { version: 7, publishedAt: 1, status: "ok" },
      },
    });
    const removed = await offlineUnboundTargets(j, [HOME]);
    // @kf-batch 50-WP18d-unpublish-seam —— 返回值从「名字数组」改成 `{offlined, failures}`:
    // 逐区失败必须能带出来(`offlineFanout` 从不抛 ⇒ 调用点的 try/catch 拦不到)
    expect(removed).toEqual({ offlined: [USW2], failures: [] });
    expect(h.offlined).toEqual(["bgp_etl_J1__tgt_usw2_a@tgt_usw2_a"]);
  });

  it("绑定没变 ⇒ 什么都不下线(不许顺手把还绑着的区停掉)", async () => {
    const j = job({ targets: [HOME, USW2] });
    expect(await offlineUnboundTargets(j, [HOME, USW2])).toEqual({ offlined: [], failures: [] });
    expect(h.offlined).toEqual([]);
  });
});

describe("🔴 预览:绝不抛,逐行给原因", () => {
  it("一个区解析失败也要把整张表算出来(否则用户只能一个一个试)", async () => {
    const rows = await planFanout(job({ targets: [HOME, USW2, EU] }));
    expect(rows.map((r) => r.ok)).toEqual([true, true, false]);
    expect(rows[2].reason).toContain("没装 redshift 组件");
    expect(rows.map((r) => r.dagId)).toEqual([
      "bgp_etl_J1",
      "bgp_etl_J1__tgt_usw2_a",
      "bgp_etl_J1__tgt_euw1_a",
    ]);
  });

  it("🔴 预览只给凭证**形态**,不给 ARN(它会显示到界面上)", async () => {
    const rows = await planFanout(job({ targets: [HOME, USW2] }));
    expect(rows[0].credential).toBe("shared-admin"); // home 目前是共享 admin(per-project 化属 P52.5b)
    expect(rows[1].credential).toBe("shared-admin");
    // 供给完成(isolated)之后同一行应变成 per-project —— 形态是**算出来的**,不是写死的文案
    h.bindings[USW2].degraded = false;
    expect((await planFanout(job({ targets: [USW2] })))[0].credential).toBe("per-project");
    expect(JSON.stringify(rows), "预览里出现了凭证 ARN ⇒ 会落进浏览器历史与截图").not.toContain("arn:");
  });

  it("Glue 作业:非 home 也可下发(W3-g 起 Glue 全走该区客户端),region / 桶取该 target 的 MWAA", async () => {
    const rows = await planFanout(job({ type: "glue", targets: [HOME, USW2], glueJobName: "g" }));
    expect(rows[0].ok).toBe(true);
    expect(rows[1]).toMatchObject({ ok: true, region: "us-west-2", bucket: "bgp-mwaa-dags-tgt-usw2-a", envName: "bgp-mwaa-tgt-usw2-a" });
  });
  // @kf-batch 50-WP13-mwaa-region
  it("🔴 缺 MWAA 的区:预览整行 ✗ + code=MWAA_NOT_INSTALLED(前端据此渲染「去执行环境补装 MWAA」)", async () => {
    h.noMwaa.push(USW2);
    const rows = await planFanout(job({ targets: [HOME, USW2] }));
    expect(rows[0].ok).toBe(true);
    // @kf-batch 50-WP15-airflow-serverless:码改 SCHEDULER_NOT_INSTALLED(SPEC v3.27 §2.1;旧码在 detail.legacyCode)
    expect(rows[1]).toMatchObject({ ok: false, code: "SCHEDULER_NOT_INSTALLED", bucket: "—", envName: "—", region: "us-west-2" });
    expect(rows[1].reason).toContain("未安装 mwaa 组件");
  });
});

// @kf-batch 50-WP13-mwaa-region
describe("🔴🔴 区域内调度:每份 DAG 落该 target 自己的 MWAA 桶;缺 MWAA 在任何写之前整体拒", () => {
  it("home 的 DAG 在 home 桶、usw2 的 DAG 在 usw2 桶(不再全塞 home 桶 = 用户点名的跨区域调度)", async () => {
    const r = await publishFanout(job({ targets: [HOME, USW2] }), { cron: "0 * * * *" });
    expect(r.rows.map((x) => [x.targetId, x.status, x.bucket, x.envName])).toEqual([
      [HOME, "ok", "bgp-mwaa-dags", "bgp-mwaa"],
      [USW2, "ok", "bgp-mwaa-dags-tgt-usw2-a", "bgp-mwaa-tgt-usw2-a"],
    ]);
    expect(h.s3Puts.map((p) => p.Bucket)).toEqual(["bgp-mwaa-dags", "bgp-mwaa-dags-tgt-usw2-a"]);
    expect(Object.keys(r.endpoints).sort()).toEqual([HOME, USW2]);
  });
  it("🔴 一个区缺 MWAA ⇒ 整次抛 MwaaNotInstalled,**零** S3 写、零台账(E-208);missing 只列缺的那个", async () => {
    h.noMwaa.push(USW2);
    const { MwaaNotInstalled } = await import("@/lib/scheduler/mwaa-endpoint");
    const p = publishFanout(job({ targets: [HOME, USW2] }), { cron: "0 * * * *" });
    await expect(p).rejects.toBeInstanceOf(MwaaNotInstalled);
    const e = (await p.catch((x) => x)) as any;
    expect(e.missing.map((m: any) => m.targetId)).toEqual([USW2]);
    expect(h.s3Puts).toEqual([]);
    expect(h.ddbSent.filter((d) => d.ctor === "UpdateCommand")).toEqual([]);
  });
  it("下线逐 target 去它自己的 MWAA(offlineDag 带 targetId)", async () => {
    await offlineFanout(job({ targets: [HOME, USW2] }));
    expect(h.offlined).toEqual([`bgp_etl_J1@${HOME}`, `bgp_etl_J1__${USW2}@${USW2}`]);
  });
});
