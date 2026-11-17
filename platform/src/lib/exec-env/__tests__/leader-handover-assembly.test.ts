// 🔴 装配层:选主租约(leader-lease)+ 进程内循环(reconciler-loop)+ 注册表读法**一起**跑,两个副本共用同一张表。
// 只 mock 真外部(DynamoDB 文档客户端);兄弟模块一律走真实现。锁行的假客户端按 DynamoDB 条件写的语义求值
// (条件不成立 ⇒ ConditionalCheckFailedException),不靠「mock 返回成功 / 失败」来演。
//
// 判据钉的是用户能感知的事实(2026-11-16 真环境:滚动升级后旧主副本被停,后台评估停了约 5 分钟,最长可到 12 分钟):
//   · 主副本正常退出 ⇒ 备用副本在一个选主拍(30 秒)内接手,并立刻探活一轮;
//   · 主副本猝死(来不及释放)⇒ 备用副本在租约过期后的下一拍接手(距最后一次续租 ≤ 3.5 分钟);
//   · 任一时刻最多一个副本认为自己是主副本;退出中的副本不会把刚释放的租约续回去;进程等释放写完才退出(限时)。
// 时钟是假的,节奏是产品真实的(探活节拍 4 分钟 / 选主拍 30 秒 / 租约 3 分钟),不给产品加旋钮。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

type LockRow = Record<string, unknown>;
const h = vi.hoisted(() => ({
  lock: null as null | Record<string, unknown>,
  writes: [] as Array<{ at: number; op: "update" | "delete"; token: string; ok: boolean }>,
  /** 「列执行环境」发生的时刻(探活节拍的第一步)—— 用它看哪一刻真的探活了 */
  envQueries: [] as number[],
  updateDelayMs: 0,
  deleteDelayMs: 0,
  /** 按凭证注入故障:throw = 网络错误;hang = 请求永不返回(进程卡死 / 猝死的替身) */
  updateFault: null as null | ((token: string) => "throw" | "hang" | null),
  deleteFault: null as null | ((token: string) => "hang" | null),
  events: [] as string[],
  /** 告警评估泵真的发出去的回环请求(一条 = 某个副本在某一刻评估了某个项目)—— 页面上「上次评估」心跳的来源 */
  posts: [] as Array<{ at: number; who: string; projectId: string }>,
}));

/** DynamoDB 条件表达式求值(只认锁行用到的三种项;出现别的写法就抛,不许静默放行)。 */
function conditionHolds(expr: string, names: Record<string, string>, values: Record<string, unknown>, item: LockRow | null): boolean {
  return expr.split(" OR ").some((raw) => {
    const term = raw.trim();
    let m = /^attribute_not_exists\((#\w+)\)$/.exec(term);
    if (m) return !item || item[names[m[1]]] === undefined;
    m = /^(#\w+) (<|=) (:\w+)$/.exec(term);
    if (m) {
      const left = item ? item[names[m[1]]] : undefined;
      if (left === undefined) return false; // 属性不存在:比较恒不成立(与真服务一致)
      const right = values[m[3]];
      return m[2] === "<" ? (left as number) < (right as number) : left === right;
    }
    throw new Error("假 DynamoDB 不认识的条件项:" + term);
  });
}
const conditionalCheckFailed = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const ENVS = (real.TABLES as Record<string, string>).EXECUTION_ENVS;
  const PROJECTS = (real.TABLES as Record<string, string>).PROJECTS;
  return {
    ...real,
    docClient: {
      send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const kind = c.constructor.name;
        const input = c.input;
        if (kind === "QueryCommand" || kind === "ScanCommand") {
          const pk = (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"];
          if (input.TableName === ENVS && pk === "env") h.envQueries.push(Date.now());
          // 告警评估泵「有哪些项目要评估」的那一次读:环境里有一个项目
          if (kind === "QueryCommand" && input.TableName === PROJECTS) return { Items: [{ projectId: "proj-default" }] };
          return { Items: [] };
        }
        if (kind === "GetCommand") return {};
        const key = input.Key as { pk?: string; sk?: string } | undefined;
        if (input.TableName !== ENVS || key?.pk !== "lock" || key?.sk !== "reconciler") {
          throw new Error(`意料之外的写:${kind} ${JSON.stringify(key)}`);
        }
        const names = input.ExpressionAttributeNames as Record<string, string>;
        const values = input.ExpressionAttributeValues as Record<string, unknown>;
        const token = String(values[":tok"]);
        if (kind === "UpdateCommand") {
          const fault = h.updateFault?.(token);
          if (fault === "hang") return new Promise(() => {});
          if (fault === "throw") throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
          if (h.updateDelayMs) await sleep(h.updateDelayMs);
          const ok = conditionHolds(String(input.ConditionExpression), names, values, h.lock);
          h.writes.push({ at: Date.now(), op: "update", token, ok });
          if (!ok) throw conditionalCheckFailed();
          const next: LockRow = { ...(h.lock ?? { pk: "lock", sk: "reconciler" }) };
          const set = /^SET (.+)$/.exec(String(input.UpdateExpression));
          if (!set) throw new Error("假 DynamoDB 只认 SET:" + String(input.UpdateExpression));
          for (const part of set[1].split(",")) {
            const a = /^\s*(#\w+) = (:\w+)\s*$/.exec(part);
            if (!a) throw new Error("假 DynamoDB 不认识的赋值:" + part);
            next[names[a[1]]] = values[a[2]];
          }
          h.lock = next;
          return {};
        }
        if (kind === "DeleteCommand") {
          if (h.deleteFault?.(token) === "hang") return new Promise(() => {});
          if (h.deleteDelayMs) await sleep(h.deleteDelayMs);
          const ok = conditionHolds(String(input.ConditionExpression), names, values, h.lock);
          h.writes.push({ at: Date.now(), op: "delete", token, ok });
          if (!ok) throw conditionalCheckFailed();
          h.lock = null;
          h.events.push("lock-deleted");
          return {};
        }
        throw new Error("意料之外的命令:" + kind);
      },
    },
  };
});

type Loop = typeof import("@/lib/exec-env/reconciler-loop");
interface Host {
  listeners: Record<"SIGTERM" | "SIGINT", Array<() => void>>;
  prependListener(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
  exit: (code?: number) => unknown;
  exited: Array<{ at: number; code: number | undefined }>;
  /** 发信号:按注册顺序逐个同步调用(node 的事件发射语义) */
  signal(sig: "SIGTERM" | "SIGINT"): void;
}
/** 与 node 的 process 同形的宿主;已经挂着一个「框架的处理器」—— 收到信号**同步**退出(最坏情形:一点不等)。 */
function makeHost(name: string): Host {
  const host: Host = {
    listeners: { SIGTERM: [], SIGINT: [] },
    prependListener(signal, listener) {
      this.listeners[signal].unshift(listener);
    },
    exit(code?: number) {
      host.exited.push({ at: Date.now(), code });
      h.events.push(`${name}-exited`);
    },
    exited: [],
    signal(sig) {
      for (const l of [...this.listeners[sig]]) l();
    },
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) host.listeners[sig].push(() => host.exit(0));
  return host;
}

type AlertingPump = typeof import("@/lib/alerting/pump");
interface Replica {
  loop: Loop;
  /** 与这个副本同一份模块实例里的告警评估泵(真实现;外部只有回环 HTTP 与内部密钥是假的) */
  pump: AlertingPump;
}
/** 一个副本 = 一份全新的模块实例(各有各的进程内状态),共用同一张假表。 */
async function loadReplica(): Promise<Replica> {
  vi.resetModules();
  const loop = (await import("@/lib/exec-env/reconciler-loop")) as Loop;
  const pump = (await import("@/lib/alerting/pump")) as AlertingPump;
  return { loop, pump };
}
/**
 * 像 `startReconcilerLoop` 那样把一个副本接起来:告警评估泵看本副本的选主口径;本副本一接手,泵把等着的那一轮提到现在。
 * (另外两台泵用的是同一份计时器代码与同一个接法,接线由文件末尾的调用点判据钉住。)
 */
function startReplica(r: Replica, who: string, host: Host): void {
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    h.posts.push({ at: Date.now(), who, projectId: (JSON.parse(init.body) as { projectId: string }).projectId });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  const pump = r.pump.startAlertingPump({
    isLeader: () => r.loop.holdsLeaderLease(),
    fetchImpl,
    loadKey: async () => "k-1",
    baseUrl: "http://self:3000",
  });
  r.loop.startLeaderLoops(host, () => pump.kick());
}
/** 某个副本的评估时刻(秒,相对起点),去重排序 */
const postsOf = (who: string) => [...new Set(h.posts.filter((p) => p.who === who).map((p) => Math.round((p.at - BASE) / SEC)))].sort((x, y) => x - y);

const BASE = Date.UTC(2026, 10, 16, 13, 0, 0);
const at = () => Date.now() - BASE;
const SEC = 1000;
const MIN = 60 * SEC;
let A: Loop, B: Loop, hostA: Host, hostB: Host;
let logs: string[] = [];

/** 逐秒推进,并在每一秒核「最多一个主副本」;返回 pred 第一次成立时距起点的毫秒数(没成立过 = null)。 */
async function advance(ms: number, pred?: () => boolean): Promise<number | null> {
  let first: number | null = null;
  for (let t = 0; t < ms; t += SEC) {
    await vi.advanceTimersByTimeAsync(Math.min(SEC, ms - t));
    expect(A.holdsLeaderLease() && B.holdsLeaderLease(), `两个副本同时认为自己是主副本 @${at()}ms`).toBe(false);
    if (first === null && pred?.()) first = at();
  }
  return first;
}
/** A 的凭证:A 先起,第一条成功的写就是它的(持锁期间凭证不变)。备用副本没持过锁,每次尝试都换一个新凭证 ⇒ 「不是 A 的」就是 B 的。 */
const tokenOfA = () => h.writes.find((w) => w.op === "update" && w.ok)!.token;
const writesOfB = () => h.writes.filter((w) => w.token !== tokenOfA());

beforeEach(async () => {
  Object.assign(h, { lock: null, writes: [], envQueries: [], updateDelayMs: 0, deleteDelayMs: 0, updateFault: null, deleteFault: null, events: [], posts: [] });
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(format(...a)));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push("ERR " + format(...a)));
  // 先装载(真异步 IO),再换假时钟,再起循环
  const ra = await loadReplica();
  const rb = await loadReplica();
  A = ra.loop;
  B = rb.loop;
  // 探活节拍里按需装载的模块先装好:假时钟下它们不该再去做真的文件 IO(否则下一拍排在哪一刻就不确定了)
  await import("@/lib/exec-env/metadata-mirror");
  await import("@/lib/exec-env/metadata-mirror-shared");
  await import("@/lib/exec-env/registry");
  vi.useFakeTimers({ now: BASE });
  hostA = makeHost("A");
  hostB = makeHost("B");
  startReplica(ra, "A", hostA);
  await vi.advanceTimersByTimeAsync(1 * SEC); // B 晚 1 秒起:两个副本的拍子错开,时刻可断言
  startReplica(rb, "B", hostB);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("🔴 主副本交接(两副本,真实节奏)", { timeout: 60_000 }, () => {
  it("平稳期:先起的副本当主副本并一直续着;探活照 4 分钟节拍只由它做", async () => {
    await advance(31 * SEC);
    expect(A.holdsLeaderLease()).toBe(true);
    expect(B.holdsLeaderLease()).toBe(false);
    await advance(10 * MIN);
    expect(A.holdsLeaderLease()).toBe(true);
    expect(B.holdsLeaderLease()).toBe(false);
    expect(h.lock?.leaseToken).toBe(tokenOfA());
    // 主副本每 30 秒续一次(探活节拍那一刻也经同一个选主函数,不重复发)
    const renewals = [...new Set(h.writes.filter((w) => w.token === tokenOfA() && w.ok).map((w) => (w.at - BASE) / SEC))];
    expect(renewals.slice(0, 5)).toEqual([30, 60, 90, 120, 150]);
    expect(h.writes.filter((w) => w.token === tokenOfA() && !w.ok)).toHaveLength(0);
    // 探活:30 秒(首轮)、4 分 30、8 分 30 —— 都是 A 的节拍;B 从没探过
    expect([...new Set(h.envQueries.map((t) => (t - BASE) / SEC))]).toEqual([30, 270, 510]);
    expect(writesOfB().filter((w) => w.ok)).toHaveLength(0);
  });

  it("探活节拍与选主拍同一刻到、写还在途:只发一次选主写(各抢各的,后落地的失败会把先落地的成功盖成「不是主副本」)", async () => {
    h.updateDelayMs = 50; // 真环境的一次写要几十毫秒:两个计时器同到时前一次还没落地
    await advance(31 * SEC);
    const mine = h.writes.filter((w) => w.at - BASE < 31 * SEC && w.at - BASE >= 30 * SEC && w.at - BASE < 31 * SEC - 500);
    expect(mine).toHaveLength(1); // 30.05 秒那一次;B 的在 31.05 秒
    expect(mine[0].ok).toBe(true);
    expect(A.holdsLeaderLease()).toBe(true);
    await advance(2 * MIN);
    expect(A.holdsLeaderLease()).toBe(true);
    expect(h.lock?.leaseToken).toBe(mine[0].token);
  });

  it("主副本正常退出 ⇒ 锁行当场释放、进程等它写完才退出;备用副本 30 秒内接手并立刻探活(不等自己的下一个 4 分钟节拍)", async () => {
    await advance(10 * MIN + 4 * SEC); // 此刻 = 10:05
    h.deleteDelayMs = 200;
    hostA.signal("SIGTERM");
    // 信号一到:泵的选主口径立刻为假(不再取新活);框架的处理器虽然同步调了退出,进程还没退
    expect(A.holdsLeaderLease()).toBe(false);
    expect(hostA.exited).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(199);
    expect(hostA.exited).toHaveLength(0);
    expect(h.lock).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.lock).toBeNull();
    expect(hostA.exited).toEqual([{ at: BASE + 10 * MIN + 5 * SEC + 200, code: 0 }]);
    expect(h.events).toEqual(["lock-deleted", "A-exited"]); // 先释放,后退出
    expect(logs.some((l) => l.includes("收到 SIGTERM") && l.includes("选主租约已释放"))).toBe(true);

    const releasedAt = at();
    await vi.advanceTimersByTimeAsync(800); // 回到整秒,后面逐秒采样的时刻才与拍子对齐
    const tookOverAt = await advance(31 * SEC, () => B.holdsLeaderLease());
    expect(tookOverAt).not.toBeNull();
    expect(tookOverAt! - releasedAt).toBeLessThanOrEqual(30 * SEC);
    expect(h.lock?.leaseToken).not.toBe(tokenOfA());
    // 接手那一刻就探活:B 自己的节拍本来要等到 12:31
    const firstProbeAfter = Math.min(...h.envQueries.filter((t) => t - BASE > releasedAt).map((t) => t - BASE));
    expect(firstProbeAfter - tookOverAt!).toBeGreaterThanOrEqual(0);
    expect(firstProbeAfter - tookOverAt!).toBeLessThanOrEqual(1 * SEC); // 同一拍里紧跟着探(计时器最小粒度 1 毫秒)
    expect(firstProbeAfter).toBeLessThan(12 * MIN + 31 * SEC);
    expect(logs.filter((l) => l.includes("本副本成为主副本"))).toHaveLength(2);

    // 退出中的副本不再抢 / 续:此后 6 分钟锁行上再没出现过 A 的凭证
    const mark = h.writes.length;
    await advance(6 * MIN);
    expect(h.writes.slice(mark).filter((w) => w.token === tokenOfA())).toHaveLength(0);
    expect(B.holdsLeaderLease()).toBe(true);
  });

  it("主副本猝死(来不及释放)⇒ 备用副本在租约过期后的下一拍接手:距最后一次续租 ≤ 3.5 分钟;卡死的副本在租约到期前 1 分钟就不再认为自己是主副本", async () => {
    await advance(10 * MIN + 4 * SEC); // 最后一次成功续租在 10:00
    const a = tokenOfA();
    h.updateFault = (token) => (token === a ? "hang" : null);
    const lastRenewal = Math.max(...h.writes.filter((w) => w.token === a && w.ok).map((w) => w.at - BASE));
    expect(lastRenewal).toBe(10 * MIN);
    const lostAt = await advance(2 * MIN, () => !A.holdsLeaderLease());
    expect(lostAt).toBe(lastRenewal + 2 * MIN); // 租约 3 分钟 − 1 分钟安全余量
    const tookOverAt = await advance(2 * MIN, () => B.holdsLeaderLease());
    expect(tookOverAt).not.toBeNull();
    expect(tookOverAt!).toBeGreaterThan(lastRenewal + 3 * MIN); // 没过期不许抢
    expect(tookOverAt!).toBeLessThanOrEqual(lastRenewal + 3 * MIN + 30 * SEC);
    expect(h.lock?.leaseToken).not.toBe(a);
    expect(h.envQueries.some((t) => t - BASE >= tookOverAt! && t - BASE <= tookOverAt! + 1 * SEC)).toBe(true); // 接手即探活
  });

  it("续租偶发失败(连丢两拍)不掉主:主副本口径一直为真,备用副本抢不到,恢复后照常续", async () => {
    await advance(10 * MIN + 4 * SEC);
    const a = tokenOfA();
    let failing = true;
    h.updateFault = (token) => (failing && token === a ? "throw" : null);
    for (let s = 0; s < 70; s++) {
      await advance(1 * SEC);
      expect(A.holdsLeaderLease(), `丢拍期间主副本口径 @${at()}ms`).toBe(true);
    }
    failing = false;
    await advance(3 * MIN);
    expect(A.holdsLeaderLease()).toBe(true);
    expect(writesOfB().filter((w) => w.ok)).toHaveLength(0);
    expect(logs.filter((l) => l.startsWith("ERR") && l.includes("选主拍失败")).length).toBe(2);
  });

  it("退出时正有一次续租在途 ⇒ 等它落地再释放:锁行最终不在(没有被在途的写又写回来)", async () => {
    await advance(9 * MIN + 58 * SEC); // 此刻 = 9:59
    h.updateDelayMs = 400; // 10:00 的续租要到 10:00.4 才落地
    await vi.advanceTimersByTimeAsync(1 * SEC + 200);
    hostA.signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(150);
    expect(hostA.exited).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    const a = tokenOfA();
    const tail = h.writes.filter((w) => w.token === a).slice(-2);
    expect(tail.map((w) => [w.op, w.ok])).toEqual([
      ["update", true],
      ["delete", true],
    ]);
    expect(h.lock).toBeNull();
    expect(hostA.exited).toHaveLength(1);
  });

  it("释放写不出去 ⇒ 进程最多多等 3 秒就退出(租约到期兜底),备用副本照样在过期后接手", async () => {
    await advance(10 * MIN + 4 * SEC);
    h.deleteFault = () => "hang";
    hostA.signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(2999);
    expect(hostA.exited).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(hostA.exited).toEqual([{ at: BASE + 10 * MIN + 5 * SEC + 3000, code: 0 }]);
    expect(logs.some((l) => l.includes("收到 SIGTERM") && l.includes("超时"))).toBe(true);
    expect(h.lock).not.toBeNull();
    const tookOverAt = await advance(4 * MIN, () => B.holdsLeaderLease());
    expect(tookOverAt!).toBeLessThanOrEqual(10 * MIN + 3 * MIN + 30 * SEC);
  });

  it("备用副本退出:没有租约要释放,不发删除,直接退出;主副本不受影响;SIGINT 同样处理", async () => {
    await advance(10 * MIN + 4 * SEC);
    hostB.signal("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(hostB.exited).toEqual([{ at: BASE + 10 * MIN + 5 * SEC, code: 0 }]);
    expect(h.writes.filter((w) => w.op === "delete")).toHaveLength(0);
    expect(logs.some((l) => l.includes("收到 SIGINT") && l.includes("不是主副本"))).toBe(true);
    await advance(2 * MIN);
    expect(A.holdsLeaderLease()).toBe(true);
    // 同一个信号再来一次(容器运行时可能重发)不会重复处理
    hostB.signal("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.filter((l) => l.includes("收到 SIGINT"))).toHaveLength(1);
  });

  it("平稳期的告警评估:只有主副本在评估,每 60 秒一轮;首次当选那一刻就先评估一轮(不等泵自己的第一个周期)", async () => {
    await advance(5 * MIN - 1 * SEC); // 此刻 = 5:00
    expect(postsOf("A")).toEqual([30, 90, 150, 210, 270]);
    expect(postsOf("B")).toEqual([]);
    expect(h.posts.every((p) => p.projectId === "proj-default")).toBe(true);
  });

  it("主副本正常退出 ⇒ 备用副本接手的那一拍就评估一轮(不等自己的下一个 60 秒周期);之后照 60 秒一轮,没有多出来的一轮", async () => {
    await advance(10 * MIN + 4 * SEC); // 此刻 = 10:05;A 上一次评估在 9:30,下一次本该在 10:30
    expect(postsOf("A").slice(-1)).toEqual([570]);
    hostA.signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(1 * SEC);
    const tookOverAt = await advance(31 * SEC, () => B.holdsLeaderLease());
    expect(tookOverAt).not.toBeNull();
    const firstPost = Math.min(...h.posts.filter((p) => p.who === "B").map((p) => p.at - BASE));
    expect(firstPost - tookOverAt!).toBeGreaterThanOrEqual(0);
    expect(firstPost - tookOverAt!).toBeLessThanOrEqual(1 * SEC);
    // B 的泵自己的周期(1 秒起,每 60 秒)下一次在 11:01 —— 不提前的话评估要多断半分钟
    expect(firstPost).toBeLessThan(11 * MIN);
    // 用户看到的评估心跳:9:30(A)→ 10:31(B),断档就是「最后一轮到退出」+「一个选主拍」
    expect(firstPost - 570 * SEC).toBeLessThanOrEqual(60 * SEC + 30 * SEC + 1 * SEC);
    await advance(3 * MIN);
    const first = Math.round(firstPost / SEC);
    expect(postsOf("B")).toEqual([first, first + 60, first + 120, first + 180]); // 提前的那一轮替掉了原来排着的,不是多跑
    expect(postsOf("A").filter((t) => t > 605)).toEqual([]); // 退出中的副本不再评估
  });

  it("接手发生在探活节拍里(不是选主拍)也一样:由选主的唯一作者通知,泵立刻评估一轮;之后的续租不算接手", async () => {
    await advance(10 * MIN + 4 * SEC);
    hostA.signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(5 * SEC); // 此刻 = 10:10;B 的下一个选主拍在 10:31
    expect(B.holdsLeaderLease()).toBe(false);
    const s = await B.runReconcileTick(); // 探活节拍到点时走的就是这个函数
    expect(s.leader).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(postsOf("B")).toEqual([610]);
    await advance(3 * MIN); // 其间 B 续了 6 次租约
    expect(postsOf("B")).toEqual([610, 670, 730, 790]);
    expect(logs.filter((l) => l.includes("本副本成为主副本"))).toHaveLength(2); // A 一次、B 一次
  });
});

describe("🔴 节奏的硬约束与接线", () => {
  it("主副本猝死后的无探活缺口 < 探活过期阈值;租约容得下连丢三拍", async () => {
    const loop = await import("@/lib/exec-env/reconciler-loop");
    const { RECONCILER_LEASE_MS } = await import("@/lib/exec-env/leader-lease");
    const { TARGET_FRESHNESS_MAX_AGE_MS } = await import("@/lib/exec-env/registry");
    // 最后一次探活距今(≤ 一个节拍)+ 租约剩余(≤ 租约)+ 备用副本的一拍(接手即探活)
    expect(loop.TICK_INTERVAL_MS + RECONCILER_LEASE_MS + loop.ELECTION_BEAT_MS).toBeLessThan(TARGET_FRESHNESS_MAX_AGE_MS);
    expect(RECONCILER_LEASE_MS).toBeGreaterThanOrEqual(4 * loop.ELECTION_BEAT_MS + 60 * SEC);
    expect(loop.SHUTDOWN_RELEASE_BUDGET_MS).toBeLessThanOrEqual(5 * SEC); // 远小于容器运行时给的停止宽限
  });

  it("调用点:启动循环真的起了两个计时器并挂了退出释放;释放函数有调用点(不是只 import);三台泵看的是同一个选主口径,接手时三台都被叫起来", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../reconciler-loop.ts"), "utf8");
    const body = (name: string) => {
      const i = src.indexOf(`export function ${name}(`);
      expect(i, name).toBeGreaterThan(-1);
      const j = src.indexOf("\n}\n", i);
      return src.slice(i, j);
    };
    const loops = body("startLeaderLoops");
    expect(loops).toMatch(/startPeriodicLoop\(\{ intervalMs: TICK_INTERVAL_MS, initialDelayMs: INITIAL_DELAY_MS, runOnce \}\)/);
    expect(loops).toMatch(/startPeriodicLoop\(\{ intervalMs: ELECTION_BEAT_MS, runOnce: beat \}\)/);
    expect(loops).toMatch(/installShutdownRelease\(/);
    expect(src).toMatch(/await releaseLeaderLease\(lease\)/);
    expect(body("installShutdownRelease")).toMatch(/prependListener\("SIGTERM"/);
    expect(body("installShutdownRelease")).toMatch(/prependListener\("SIGINT"/);
    // 三台泵:同一个选主口径;启动函数交回的句柄真的接到了「刚接手」上(少接一台 = 那台泵接手后要空等一个周期)
    const start = body("startReconcilerLoop");
    const handles: string[] = [];
    for (const pump of ["startDataplaneJobPump", "startBackfillPump", "startAlertingPump"]) {
      const m = new RegExp(`const (\\w+) = ${pump}\\(\\{ isLeader: \\(\\) => holdsLeaderLease\\(\\) \\}\\);`).exec(start);
      expect(m, pump).not.toBeNull();
      handles.push(m![1]);
    }
    expect(start).toContain(`startLeaderLoops(undefined, () => {\n    for (const pump of [${handles.join(", ")}]) pump.kick();\n  });`);
    // 三台泵与本文件都不自己写周期计时器:计时器代码只有 periodic-loop.ts 一份
    for (const rel of ["../../dataplane-jobs/pump.ts", "../../backfill/pump.ts", "../../alerting/pump.ts"]) {
      const pumpSrc = fs.readFileSync(path.resolve(__dirname, rel), "utf8");
      expect(pumpSrc.match(/return startPeriodicLoop\(\{/g), rel).toHaveLength(1);
      expect(pumpSrc, rel).not.toMatch(/setTimeout\(runOnce/);
    }
    expect(src.match(/setTimeout\(/g)).toHaveLength(1); // 只剩「释放租约限时」那一个
    // 探活节拍不自己抢租约:只经选主的唯一作者;「刚接手」也只从那里通知
    expect(src.match(/acquireOrRenewLeaderLease\(/g)).toHaveLength(1);
    expect(src.match(/onBecameLeader\?\.\(\)/g)).toHaveLength(1);
  });
});
