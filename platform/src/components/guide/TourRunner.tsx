"use client";

// @kf-batch 53-guide-tour
// 新手引导的**导览运行器**:antd `Tour` 聚光灯高亮**真实控件** + 气泡 + 上一步/下一步/跳过 + 进度 + 跨页续跑。
//
// 🔴 三条护栏(都是「静默」类缺陷的正面反例):
//  ① **锚点找不到不许静默跳过** —— 静默跳过会让用户以为导览走完了。这里显式提示「这一步的控件当前
//     不在页面上」并给出原因与两个出口(跳过这一步 / 结束导览),同时 console.warn 便于排障。
//  ② **跨页续跑不许从头开始** —— 进度存在 localStorage,导航到目标页后**接着第 N 步**。
//  ③ **不许替用户点** —— 导览只高亮与解释,点击永远由用户做(替他点会在真环境里造出他没同意的副作用)。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Space, Tour, Typography } from "antd";
import type { TourProps } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/useT";
import {
  anchorIsUsable, anchorRectSignature, anchorSettled, expandJourney, journeyByKey,
  shouldAdvanceAfterNavigation, type AnchorProbe, type TourStep, missingAnchorAdvice } from "@/lib/guide/tour";

const { Text } = Typography;

export interface TourRunnerProps {
  /** 正在跑的动线;null = 没在跑。 */
  journeyKey: string | null;
  index: number;
  onIndex: (i: number) => void;
  onFinish: () => void;
}

function elFor(testid: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

/**
 * 量测锚点:找到了没 + 多大 + 是不是渲染不出来。
 * 🔴 `offsetParent === null` 对 `position: fixed` 的元素也成立 ⇒ 要把 fixed 排除掉,
 *    否则弹层里的锚点会被误判成「不在页面上」。
 */
function probeAnchor(testid: string): AnchorProbe {
  const el = elFor(testid);
  if (!el) return { found: false, x: 0, y: 0, width: 0, height: 0, hidden: true };
  const r = el.getBoundingClientRect();
  const fixed = typeof window !== "undefined" && window.getComputedStyle(el).position === "fixed";
  return { found: true, x: r.x, y: r.y, width: r.width, height: r.height, hidden: el.offsetParent === null && !fixed };
}

/** 能打聚光灯的元素:找到**且看得见**才算(收起过的菜单分类会留下 0×0 的隐藏子项)。 */
function usableElFor(testid: string): HTMLElement | null {
  return anchorIsUsable(probeAnchor(testid)) ? elFor(testid) : null;
}

export default function TourRunner({ journeyKey, index, onIndex, onFinish }: TourRunnerProps) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  // 🔴🔴 三态:pending(锚点还没稳定,**先不挂 Tour**)/ ready(挂出来,此刻量到的位置一定是对的)/ missing(响亮报出来)。
  //   为什么不能只用一个 missing 布尔:antd Tour **只在步变化的那一瞬量目标**(rc-tour 的 useTarget 靠
  //   `useLayoutEffect` + 自身 re-render,没有 ResizeObserver)。菜单分类展开有动画 ⇒ 那一瞬量到的是 null,
  //   而 `setMissing(null)`(值没变)**不会触发重渲染** ⇒ 它再也不会重量,聚光灯整步停在屏幕正中间。
  //   三态让「稳定了」这件事本身产生一次重渲染,Tour 挂出来时才第一次量 —— 量的就是稳定后的位置。
  const [status, setStatus] = useState<"pending" | "ready" | "missing">("pending");

  const steps: TourStep[] = useMemo(() => {
    const j = journeyKey ? journeyByKey(journeyKey) : null;
    return j ? expandJourney(j) : [];
  }, [journeyKey]);

  const cur = steps[index] ?? null;

  // 跨页续跑:`action` 步要求已经在目标页 ⇒ 不在就先导航过去(**不重置 index**)
  useEffect(() => {
    if (!cur) return;
    if (cur.kind === "action" && pathname !== cur.path) {
      router.push(cur.path);
    }
  }, [cur, pathname, router]);

  // @kf-batch 53-guide-tour-reach
  // 🔴 **用户照着做了就前进** —— nav 步说的是「点左侧菜单进入这一页」;用户真去点了(页面已经换了),
  //    气泡却还停在同一句上,导览就成了死循环般的复读机。这不是「替用户点」(§护栏③):
  //    动作是**用户自己**做的,这里只是回应它。
  // 🔴 只在「这一步开始时不在目标页、之后到了」才前进 —— 否则「上一步」退回一个已经到过的 nav 步会
  //    被立刻又推回去(上一步等于失效)。步一变就记下起点,判据靠这个起点区分两种情形。
  const stepEnteredPath = useRef<string | null>(null);
  useEffect(() => { stepEnteredPath.current = pathname; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [index, journeyKey]);
  useEffect(() => {
    if (!cur || cur.kind !== "nav") return;
    if (shouldAdvanceAfterNavigation({
      kind: cur.kind, stepPath: cur.path, currentPath: pathname,
      enteredPath: stepEnteredPath.current, index, total: steps.length,
    })) {
      onIndex(index + 1);
    }
  }, [pathname, cur, index, steps.length, onIndex]);

  // 锚点在不在:不在就显式说,不静默跳过
  useEffect(() => {
    if (!cur) { setStatus("pending"); return; }
    if (cur.kind === "action" && pathname !== cur.path) { setStatus("pending"); return; }
    setStatus("pending");
    let cancelled = false;
    // 页面刚导航过来时控件可能还没渲染 ⇒ 给一小段重试窗口(不是无限等)
    const deadline = Date.now() + 4000;
    // 🔴 等**位置稳定**再放行:菜单分类展开有动画,而 rc-tour 量目标没有 ResizeObserver
    //    ⇒ 中途量到就一直偏着(见 anchorSettled 的注释)。连续两次 rect 一致才算稳。
    let lastSig: string | null = null;
    const tick = () => {
      if (cancelled) return;
      const p = probeAnchor(cur.testid);
      if (anchorSettled(lastSig, p)) { setStatus("ready"); return; }
      lastSig = anchorIsUsable(p) ? anchorRectSignature(p) : null;
      if (Date.now() > deadline) { setStatus("missing"); console.warn(`[guide/tour] 锚点缺失:${cur.testid}(第 ${index + 1} 步「${cur.title}」)`); return; }
      setTimeout(tick, 200);
    };
    tick();
    return () => { cancelled = true; };
  }, [cur, pathname, index]);

  const close = useCallback(() => { setStatus("pending"); onFinish(); }, [onFinish]);

  if (!cur) return null;

  if (status === "missing") {
    // @kf-batch 50-WP23-guide-scope-gate —— 说什么由纯函数 `missingAnchorAdvice` 决定(离线可钉);
    //   这里只认「页面上有没有 ScopeGate 的空壳」这一个事实,以及把话显示出来。
    const advice = missingAnchorAdvice({
      index, total: steps.length, title: cur.title, testid: cur.testid,
      scopeGated: typeof document !== "undefined" && !!document.querySelector('[data-testid="scope-need-target"]'),
    });
    return (
      <div style={{ position: "fixed", right: 24, bottom: 24, zIndex: 2000, maxWidth: 420 }} data-testid="guide-tour-anchor-missing">
        <Alert
          type="warning" showIcon
          message={advice.headline}
          description={
            <Space direction="vertical" size={4}>
              <Text data-testid={advice.kind === "need-scope" ? "guide-tour-need-scope" : "guide-tour-anchor-what"}>
                {advice.what}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{advice.next}</Text>
              <Space>
                <Button size="small" data-testid="guide-tour-skip-step" onClick={() => onIndex(Math.min(index + 1, steps.length - 1))}>{t("跳过这一步")}</Button>
                <Button size="small" data-testid="guide-tour-quit" onClick={close}>{t("结束导览")}</Button>
              </Space>
            </Space>
          }
        />
      </div>
    );
  }

  // pending:锚点还没稳定 ⇒ 先不挂 Tour(挂了会以「屏幕正中」量一次,之后不再纠正)
  if (status !== "ready") return null;

  const tourSteps: TourProps["steps"] = steps.map((s, i) => ({
    title: s.title,
    description: (
      <Space direction="vertical" size={2}>
        <Text>{s.body}</Text>
        <Text type="secondary" style={{ fontSize: 12 }} data-testid={i === index ? "guide-tour-progress" : undefined}>
          {`第 ${i + 1} / ${steps.length} 步`}
        </Text>
      </Space>
    ),
    target: () => usableElFor(s.testid) as HTMLElement,
  }));

  return (
    <Tour
      open
      current={index}
      steps={tourSteps}
      onChange={onIndex}
      onClose={close}
      onFinish={close}
      indicatorsRender={(c, total) => <span data-testid="guide-tour-indicator">{`${c + 1} / ${total}`}</span>}
      // 🔴 出口必须是**我们自己的**控件:antd 面板的关闭图标是否渲染取决于 `closable`(框架默认值随版本变),
      //    而「随时能跳过」是本产品对用户的承诺 ⇒ 自己给一个带稳定锚点的按钮(判据也钉它)。
      actionsRender={(originNode) => (
        <Space>
          <Button size="small" type="text" data-testid="guide-tour-skip" onClick={close}>{t("跳过导览")}</Button>
          {originNode}
        </Space>
      )}
    />
  );
}
