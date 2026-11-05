"use client";
// 🔴 (2026-11-02 …2951 升 Next 15 / React 19 后页面驱动 p50 段 P50-K 抓到 pageerror「Minified React error #418」= 水合不一致):
//   客户端组件在 **useState 初值函数 / 组件体** 里读 `window.location` / `localStorage`(`typeof window !== "undefined" ? 读 : 缺省`)
//   ⇒ 服务端首帧按「缺省」渲染,浏览器首帧按「读到的值」渲染,两份 HTML 不一致。React 18 只在控制台记一条可恢复错误(没人看见);
//   React 19 把它上报成 window error ⇒ 无头判据的 pageerror 必红,用户侧表现为首帧闪一下再重画。
//   ⇒ 唯一作者:首帧一律用服务端也能算出的缺省值,挂载后再读浏览器状态(一次 effect),与 I18nProvider 同口径。
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * 水合安全的「浏览器初值」:首帧 = `serverDefault`(服务端与客户端一致),挂载后用 `readOnClient()` 的结果覆盖一次。
 * `readOnClient` 抛错 / 返回 undefined ⇒ 保持缺省。只在挂载时读一次(与原来「初值函数读一次」的语义相同)。
 *
 * 第三个元素 `resolved`:挂载后已经读过一次浏览器状态(不论读到没读到)。🔴 **按这个值发请求的 effect 必须等它为 true**
 *   (2026-11-05 任务监控页页面驱动真撞:补数抽屉「去监控页定位」带 `?name=&triggeredBy=backfill` 跳过来,首个 `/api/monitor/runs`
 *   请求与本 hook 的挂载 effect 在同一次提交里跑、拿的还是服务端缺省筛选 ⇒ 列表先按空筛选渲染,要等 10 秒自动刷新才对上;
 *   关掉自动刷新就永远对不上)。
 */
export function useBrowserInitialState<T>(serverDefault: T, readOnClient: () => T | undefined): [T, Dispatch<SetStateAction<T>>, boolean] {
  const [value, setValue] = useState<T>(serverDefault);
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    try {
      const v = readOnClient();
      if (v !== undefined) setValue(v);
    } catch {
      /* 浏览器状态读不到就保持缺省 */
    }
    setResolved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [value, setValue, resolved];
}
