// 🔴🔴 **「经典 MWAA 下线」不许只做一半:入口关了,`schedulerPreference` 这条旁路也必须关。**
//
// 【缺陷怎么现形的】2026-09-20 我把硬门里一条「⚠️ 登记(双装载体造不出来)」改判成**真跑的负向判据**,
//   它当场逮到:往一个**只装了 airflow-serverless** 的 target 写 `schedulerPreference="mwaa"`
//   ⇒ **HTTP 200**,描述符真写成 `mwaa`。承重行为当时还是对的(发布仍走 serverless、绝不往 MWAA 桶
//   落 DAG —— 同一条判据一起断了),但描述符从此**宣称一个不存在的调度器**,
//   与同步任务「启用调度」空壳是同一类「宣称了没有载体的东西」。
//   用户 2026-09-20 原话:「我们后面所有的调度都走 mwaa serverless」。
//
// 【根因】不是「少了一条『装了没有』的校验」,而是**值域没拆**:`SCHEDULER_PREFERENCES` 一份清单
//   同时当「能读到什么」和「能写进什么」用。关掉了注册 / 补装 / 向导三个入口,唯独漏了这条。
//
// 【这组判据钉四件事】
//   ① 可写值域**从组件停供派生**,不是第二份手写清单(哪天再停供一个调度器,两边自动一起变);
//   ② 停供取值**读得到、写不进**(存量描述符仍合法 ⇒ 零回归);
//   ③ 拒因是**一句人话 + 出路**,且路由与写通道**共用同一句**(不许各写一份);
//   ④ 判「可不可写」**不是类型谓词** —— 否则渲染「已停供」那一项的正当代码会被收窄成 never 而编译不过。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SCHEDULER_PREFERENCES,
  WRITABLE_SCHEDULER_PREFERENCES,
  RETIRED_SCHEDULER_PREFERENCES,
  SCHEDULER_PREFERENCE_COMPONENT,
  isSchedulerPreference,
  isWritableSchedulerPreference,
  retiredSchedulerPreferenceMessage,
} from "@/lib/exec-env/scheduler-preference";
import { RETIRED_COMPONENTS, isComponentRetired } from "@/lib/exec-env/implemented-components";

const SRC = resolve(__dirname, "../../..");   // → platform/src
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("调度器偏好:停供取值读得到、写不进", () => {
  it("① 可写值域从**组件停供**派生 —— 不许是第二份手写清单", () => {
    // 每个偏好取值都必须声明它依赖哪个组件(缺映射 ⇒ 派生不出来)
    for (const p of SCHEDULER_PREFERENCES) {
      expect(SCHEDULER_PREFERENCE_COMPONENT[p], `偏好 ${p} 没声明它依赖的组件`).toBeTruthy();
    }
    // 派生关系逐项成立:可写 ⟺ 它依赖的组件没停供
    for (const p of SCHEDULER_PREFERENCES) {
      expect(isWritableSchedulerPreference(p), `${p} 的可写性没跟着组件停供走`).toBe(
        !isComponentRetired(SCHEDULER_PREFERENCE_COMPONENT[p])
      );
    }
    // 反向:停供组件里有 mwaa ⇒ 偏好里的 mwaa 必须不可写(这是本轮那个缺陷的正脸)
    expect(RETIRED_COMPONENTS).toContain("mwaa");
    expect(isWritableSchedulerPreference("mwaa")).toBe(false);
    expect(RETIRED_SCHEDULER_PREFERENCES).toContain("mwaa");
  });

  it("② 停供取值**读得到**(存量描述符不许被判非法)、**写不进**", () => {
    // 读侧:仍是合法取值 —— 存量双装目标的描述符里就写着它,删掉会把那些环境整片判非法
    expect(isSchedulerPreference("mwaa")).toBe(true);
    expect(SCHEDULER_PREFERENCES).toContain("mwaa");
    // 写侧:只剩 serverless
    expect([...WRITABLE_SCHEDULER_PREFERENCES]).toEqual(["serverless"]);
    expect(isWritableSchedulerPreference("serverless")).toBe(true);
    // 非法输入照旧不可写
    for (const bad of ["", "MWAA", "airflow", null, undefined, 1, {}]) {
      expect(isWritableSchedulerPreference(bad as unknown)).toBe(false);
    }
  });

  it("③ 拒因一句人话 + 出路,且**路由与写通道共用同一句**", () => {
    const msg = retiredSchedulerPreferenceMessage("mwaa");
    expect(msg).toContain("已停止提供");
    expect(msg).toContain("MWAA Serverless");          // 出路:走哪个
    expect(msg).toContain("serverless");                // 当前可写取值
    expect(msg).toContain("存量");                      // 说清「已经存着它的历史目标怎么办」
    // 两处调用方都必须调这个唯一作者,不许各写一份字面
    const route = read("app/api/admin/exec-envs/[targetId]/scheduler-preference/route.ts");
    const lifecycle = read("lib/exec-env/lifecycle.ts");
    for (const [name, src] of [["路由", route], ["写通道 lifecycle", lifecycle]] as const) {
      expect(src, `${name} 没调 isWritableSchedulerPreference ⇒ 停供取值还能写进去`).toContain(
        "isWritableSchedulerPreference"
      );
      // 🔴 必须钉**调用位置**,不是「文件里出现过这个名字」—— 只查名字的话,把调用点换成自己编的
      //   字面量、而 import 行还留着,变异就溜过去了(2026-09-20 变异验证当场抓到:5 处里这一处绿)。
      //   同一个坑今天已经栽过一次(判据 ⑦ 的 MR-CAPABILITY-MATRIX.log)。
      expect(
        /retiredSchedulerPreferenceMessage\(/.test(src.replace(/^import[^;]*;$/gm, "")),
        `${name} 自己编了拒因,没在拒的那一行调唯一作者`
      ).toBe(true);
    }
    // 🔴 写通道里必须有:校验放在唯一写通道上,新调用方才自动被管住(只放路由上会漏第 N+1 个)
    expect(lifecycle).toMatch(/isWritableSchedulerPreference\(preference\)/);
  });

  it("④ 「可不可写」不是类型谓词(否则渲染已停供那一项会被收窄成 never)", () => {
    const src = read("lib/exec-env/scheduler-preference.ts");
    expect(
      /isWritableSchedulerPreference\(v: unknown\): boolean/.test(src),
      "isWritableSchedulerPreference 又写成了类型谓词 ⇒ else 分支被收窄成 never,前端渲染「已停止提供」标签会编译不过"
    ).toBe(true);
  });

  it("⑤ 界面:已停供的那一项**禁用而不是隐藏**(隐藏会让存量目标的当前值凭空消失)", () => {
    const ui = read("app/exec-envs/TargetDetail.tsx");
    expect(ui).toContain("isWritableSchedulerPreference");
    expect(ui).toMatch(/disabled:\s*!isWritableSchedulerPreference\(p\)/);
    expect(ui, "禁用了但没说为什么 —— 最坏的不是点不动,是看不出为什么点不动").toContain("已停止提供");
  });
});
