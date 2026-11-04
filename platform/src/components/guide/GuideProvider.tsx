"use client";
// 「操作指引」—— 全局状态(打开 / 关闭 / 当前 tab)+ 首次登录自动打开。
// 挂在 layoutClient 的壳层里(登录页不挂);Header 的 ❓ 与首页「新手引导」卡都经 useGuide() 打开同一个抽屉。
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { GUIDE_AUTO_KEY, GUIDE_SEEN_KEY } from "@/lib/guide/content";
import OperationGuideDrawer from "./OperationGuideDrawer";
import { TOUR_PROGRESS_KEY, TOUR_DONE_KEY, readProgress } from "@/lib/guide/tour";
import TourRunner from "./TourRunner";

export type GuideTab = "page" | "start" | "region";

interface GuideCtx {
  open: boolean;
  tab: GuideTab;
  openGuide: (tab?: GuideTab) => void;
  close: () => void;
  setTab: (t: GuideTab) => void;
  // 交互式导览(用户 2026-09-14:「一步一步引导人家」)
  /** 正在跑的动线 key(null = 没在跑)。 */
  tourJourney: string | null;
  tourIndex: number;
  /** 从第一步开始跑某条动线(说明书抽屉的「带我走一遍」/ 首页卡片 / 首次进站都走它)。 */
  startTour: (journeyKey: string) => void;
  stopTour: () => void;
}

const Ctx = createContext<GuideCtx | null>(null);

export function useGuide(): GuideCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useGuide 必须在 GuideProvider 内使用");
  return c;
}

export default function GuideProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<GuideTab>("page");
  const pathname = usePathname();
  // 导览状态 + **跨页续跑**(进度存 localStorage,换页不从头开始)
  const [tourJourney, setTourJourney] = useState<string | null>(null);
  const [tourIndex, setTourIndex] = useState(0);

  const persist = useCallback((j: string | null, i: number) => {
    try {
      if (j) localStorage.setItem(TOUR_PROGRESS_KEY, JSON.stringify({ journeyKey: j, index: i }));
      else localStorage.removeItem(TOUR_PROGRESS_KEY);
    } catch { /* 隐私模式:导览仍能在本次会话里跑,只是换页不续 */ }
  }, []);

  const startTour = useCallback((journeyKey: string) => {
    setOpen(false);              // 🔴 导览开始就把说明书抽屉关掉(抽屉盖住页面 = 聚光灯照不到控件)
    setTourJourney(journeyKey);
    setTourIndex(0);
    persist(journeyKey, 0);
  }, [persist]);

  const stopTour = useCallback(() => {
    setTourJourney((j) => {
      try {
        const done = JSON.parse(localStorage.getItem(TOUR_DONE_KEY) || "[]") as string[];
        if (j && !done.includes(j)) localStorage.setItem(TOUR_DONE_KEY, JSON.stringify([...done, j]));
      } catch { /* 同上 */ }
      return null;
    });
    setTourIndex(0);
    persist(null, 0);
  }, [persist]);

  const onTourIndex = useCallback((i: number) => {
    setTourIndex(i);
    setTourJourney((j) => { persist(j, i); return j; });
  }, [persist]);

  // 🔴 跨页续跑:壳层挂载/换页时,若 localStorage 里有未完成的进度就接着跑(**不重置 index**)
  useEffect(() => {
    if (tourJourney) return;
    const p = readProgress((k) => { try { return localStorage.getItem(k); } catch { return null; } });
    if (p) { setTourJourney(p.journeyKey); setTourIndex(p.index); }
  }, [pathname, tourJourney]);

  const openGuide = useCallback((t?: GuideTab) => {
    if (t) setTab(t);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  // 首次进站自动打开「快速上手」(每个指引版本一次;用户关掉「登录后自动打开」后不再弹)。
  useEffect(() => {
    if (pathname === "/login") return;
    try {
      const auto = localStorage.getItem(GUIDE_AUTO_KEY);
      const seen = localStorage.getItem(GUIDE_SEEN_KEY);
      if (auto !== "0" && !seen) {
        localStorage.setItem(GUIDE_SEEN_KEY, new Date().toISOString());
        // 🔴 首次进站**直接开始导览**(不再只弹一本说明书)。
        //    用户 2026-09-14:「不是给一个操作说明放在那里不动的东西」。
        //    抽屉仍然留着,由 ❓ 随时打开当参考手册。
        setTourJourney("dev");
        setTourIndex(0);
        try { localStorage.setItem(TOUR_PROGRESS_KEY, JSON.stringify({ journeyKey: "dev", index: 0 })); } catch { /* 隐私模式 */ }
      }
    } catch {
      /* localStorage 不可用(隐私模式)⇒ 不自动弹,不报错 */
    }
  }, [pathname]);

  const value = useMemo(
    () => ({ open, tab, openGuide, close, setTab, tourJourney, tourIndex, startTour, stopTour }),
    [open, tab, openGuide, close, tourJourney, tourIndex, startTour, stopTour]
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <OperationGuideDrawer />
      <TourRunner journeyKey={tourJourney} index={tourIndex} onIndex={onTourIndex} onFinish={stopTour} />
    </Ctx.Provider>
  );
}
