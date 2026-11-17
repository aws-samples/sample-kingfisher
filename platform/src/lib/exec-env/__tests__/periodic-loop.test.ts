// 进程内周期循环(探活节拍与三台后台泵共用的那一份计时器代码)的判据。
// 钉的是事实:哪一刻真的跑了一轮、有没有两轮重叠、提前跑一轮之后节奏还对不对。时钟是假的,没有任何 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startPeriodicLoop } from "@/lib/exec-env/periodic-loop";

const SEC = 1000;
let starts: number[] = [];
let inFlight = 0;
let maxInFlight = 0;
/** 一轮的工作:记下开始时刻,占用 durationMs,并数同时在跑的轮数。 */
const work = (durationMs: number) => async () => {
  starts.push(Date.now());
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise<void>((r) => setTimeout(r, durationMs));
  inFlight--;
};

beforeEach(() => {
  starts = [];
  inFlight = 0;
  maxInFlight = 0;
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("周期循环", () => {
  it("一轮跑完才排下一轮:间隔从上一轮结束算起,任何时刻最多一轮在跑", async () => {
    startPeriodicLoop({ intervalMs: 60 * SEC, runOnce: work(10 * SEC) });
    await vi.advanceTimersByTimeAsync(300 * SEC);
    expect(starts).toEqual([60 * SEC, 130 * SEC, 200 * SEC, 270 * SEC]);
    expect(maxInFlight).toBe(1);
  });

  it("第一轮的延迟可以单独给;不给就是一个间隔", async () => {
    const instant = async () => void starts.push(Date.now()); // 一轮不占时间:下一轮的时刻只由间隔决定
    startPeriodicLoop({ intervalMs: 240 * SEC, initialDelayMs: 30 * SEC, runOnce: instant });
    await vi.advanceTimersByTimeAsync(300 * SEC);
    expect(starts).toEqual([30 * SEC, 270 * SEC]);
    starts = [];
    startPeriodicLoop({ intervalMs: 240 * SEC, runOnce: instant }); // 此刻 = 300 秒
    await vi.advanceTimersByTimeAsync(250 * SEC);
    expect(starts.filter((t) => t !== 510 * SEC)).toEqual([540 * SEC]); // 510 是上一个循环的第三轮
  });

  it("kick:把等着的那一轮提到现在;原来排着的那一次不再跑(不是多跑一轮),下一轮在提前的这一轮结束后一个间隔", async () => {
    const loop = startPeriodicLoop({ intervalMs: 60 * SEC, runOnce: work(5 * SEC) });
    await vi.advanceTimersByTimeAsync(20 * SEC);
    expect(starts).toEqual([]);
    loop.kick();
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([20 * SEC]);
    await vi.advanceTimersByTimeAsync(200 * SEC);
    // 20(提前)→ 结束 25 → 85 → 结束 90 → 150 → 结束 155 → 215;原来排在 60 的那一次没有出现
    expect(starts).toEqual([20 * SEC, 85 * SEC, 150 * SEC, 215 * SEC]);
    expect(maxInFlight).toBe(1);
  });

  it("kick 时正有一轮在跑:不插队,节奏不变", async () => {
    const loop = startPeriodicLoop({ intervalMs: 60 * SEC, runOnce: work(10 * SEC) });
    await vi.advanceTimersByTimeAsync(65 * SEC); // 第一轮 60 开始,此刻在跑
    expect(inFlight).toBe(1);
    loop.kick();
    await vi.advanceTimersByTimeAsync(200 * SEC);
    expect(starts).toEqual([60 * SEC, 130 * SEC, 200 * SEC]);
    expect(maxInFlight).toBe(1);
  });

  it("连着 kick 两次:只提前跑一轮", async () => {
    const loop = startPeriodicLoop({ intervalMs: 60 * SEC, runOnce: work(5 * SEC) });
    await vi.advanceTimersByTimeAsync(20 * SEC);
    loop.kick();
    loop.kick();
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(starts).toEqual([20 * SEC]);
    expect(maxInFlight).toBe(1);
  });

  it("一轮真抛了异常:记一行错误,循环不断,下一轮照排", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
    let n = 0;
    startPeriodicLoop({
      intervalMs: 60 * SEC,
      runOnce: async () => {
        starts.push(Date.now());
        if (++n === 1) throw new Error("boom");
      },
    });
    await vi.advanceTimersByTimeAsync(130 * SEC);
    expect(starts).toEqual([60 * SEC, 120 * SEC]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("boom");
  });

  it("计时器不阻止进程退出(unref)", () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((() => ({ unref })) as unknown as typeof setTimeout);
    startPeriodicLoop({ intervalMs: 60 * SEC, runOnce: async () => {} });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
