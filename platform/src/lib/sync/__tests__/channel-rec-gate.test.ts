// 同步向导「通道推荐」取数闸(lib/sync/channel-rec-gate.ts):纯逻辑判据,零 mock。
//   闸在向导里的接线(换源当下就作废并重取、应答落地前过闸)在 app/sync/__tests__/wizard-ux-guard.test.ts。
import { describe, it, expect } from "vitest";
import { createChannelRecGate } from "@/lib/sync/channel-rec-gate";

const HOME_DS = "ds-home";
const WEST_DS = "ds-west";
const THIRD_DS = "ds-third";

describe("通道推荐取数闸:只认最后一次请求,且数据源没换", () => {
  it("同一个数据源连发两次(改同步模式再改目标类型)⇒ 先发的那次回来不作数,后发的作数 —— 不论谁先回来", () => {
    const gate = createChannelRecGate();
    const first = gate.begin(HOME_DS);
    const second = gate.begin(HOME_DS);
    expect(gate.accepts(first, HOME_DS)).toBe(false);
    expect(gate.accepts(second, HOME_DS)).toBe(true);
    // 后发的先回来、先发的晚到:晚到的仍然不作数
    expect(gate.accepts(first, HOME_DS)).toBe(false);
  });

  it("应答回来时表单里的数据源已经不是发请求时的那个 ⇒ 不作数(即使它是最后一次请求)", () => {
    const gate = createChannelRecGate();
    const ticket = gate.begin(HOME_DS);
    expect(gate.accepts(ticket, WEST_DS)).toBe(false);
    expect(gate.accepts(ticket, undefined)).toBe(false);
    expect(gate.accepts(ticket, HOME_DS)).toBe(true);
  });

  it("还没选数据源就取推荐(数据源为空)⇒ 表单里仍为空时作数,选了源之后不作数", () => {
    const gate = createChannelRecGate();
    const ticket = gate.begin(undefined);
    expect(gate.accepts(ticket, undefined)).toBe(true);
    expect(gate.accepts(ticket, HOME_DS)).toBe(false);
  });
});

describe("通道推荐取数闸:换数据源时要不要按新源重取", () => {
  it("向导刚打开、从没取过推荐 ⇒ 不用重取;取过一次(哪怕还在路上)⇒ 之后每次换源都要重取", () => {
    const gate = createChannelRecGate();
    expect(gate.wanted).toBe(false);
    gate.begin(HOME_DS);
    expect(gate.wanted).toBe(true);
    gate.begin(WEST_DS);
    expect(gate.wanted).toBe(true);
  });

  it("连换两次数据源(主控区源 → 执行区源 → 第三个源):只有按最后那个源取的应答作数,前两次的晚到也不作数", () => {
    const gate = createChannelRecGate();
    const forHome = gate.begin(HOME_DS); // 页面上显示着主控区源的推荐
    // 换到执行区源:推荐还在路上,用户又换到第三个源 —— 第二次换源时页面上没有推荐,但「正在取」也算要重取
    const forWest = gate.begin(WEST_DS);
    expect(gate.wanted).toBe(true);
    const forThird = gate.begin(THIRD_DS);
    expect(gate.accepts(forWest, THIRD_DS)).toBe(false);
    expect(gate.accepts(forHome, THIRD_DS)).toBe(false);
    expect(gate.accepts(forThird, THIRD_DS)).toBe(true);
  });

  it("向导重新打开 / 恢复草稿(reset)⇒ 回到「没取过」;重置之前发出的请求回来不作数,哪怕数据源相同", () => {
    const gate = createChannelRecGate();
    const before = gate.begin(HOME_DS);
    gate.reset();
    expect(gate.wanted).toBe(false);
    expect(gate.accepts(before, HOME_DS)).toBe(false);
    const after = gate.begin(HOME_DS);
    expect(gate.accepts(after, HOME_DS)).toBe(true);
  });

  it("两个向导各自一把闸,互不影响", () => {
    const a = createChannelRecGate();
    const b = createChannelRecGate();
    const ta = a.begin(HOME_DS);
    b.begin(HOME_DS);
    b.begin(HOME_DS);
    expect(a.accepts(ta, HOME_DS)).toBe(true);
    expect(b.wanted).toBe(true);
  });
});
