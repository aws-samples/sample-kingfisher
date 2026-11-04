"use client";
// @kf-batch 50-WP4-o1-scope
// 顶栏「执行范围」的 context(合同 SPEC v3.36 §2.6.2 / §2.6.5a / §2.6.5b;交互 INTERACTION §9)。
//
// 本组件**只负责三件事**:取参数(URL / localStorage / 可用清单)、把决策交给纯函数
// `lib/scope/bootstrap.ts`、按结果渲染与改地址栏。所有分支取舍都在那个纯函数里(有穷举单测)。
//
// 🔴 三条不许破的:
// ① **切范围不重载、不离开当前页**(护栏 4)⇒ 用 `router.replace/push`,**绝不** `window.location.reload()`
//    (项目/环境切换是 reload 的,那是既有行为;范围切换不是)。
// ② **URL 是权威**:URL 带了就听 URL;不带才用 localStorage 播种,且播种后**立刻把参数写回地址栏**,
//    让地址栏与视图永远一致(用户拍板:刷新不能丢选择)。
// ③ **下拉只列已安装好的**:清单来自 `/api/exec-targets?component=any`(= `listActiveTargets` ∩ 项目授权)。

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { message } from "antd";
import { GLOBAL_SCOPE, SCOPE_PARAM, serializeScope, toScopeParam, type TargetScope } from "@/lib/scope/scope";
import {
  resolveInitialScope,
  scopeStorageKey,
  staleScopeNotice,
  type InitialScopeResult,
} from "@/lib/scope/bootstrap";
import type { ScopeDecl } from "@/lib/scope/capability";
import { getActiveEnv, getActiveProject } from "@/lib/projects/active";
import { fetchScopeTargets } from "@/lib/exec-env/exec-targets-client";

/**
 * 下拉一项。🔴 由 `exec-targets-client.ts` 的 `ExecTargetOption` 归一而来 ——
 * 那是 `/api/exec-targets` 的**唯一**客户端读法(wiring 守卫钉住:页面不许自己 fetch 这条路由)。
 */
export interface ScopeTargetOption {
  targetId: string;
  region: string;
  jurisdiction: string;
  isHome: boolean;
  displayName: string;
  components: string[];
  /** 此刻能否承接新工作。🔴 **不是**是否进下拉的条件 —— 装好了就得看得见(否则「东西不见了」) */
  serviceable: boolean;
  unusableReason: string | null;
}

interface ScopeContextValue {
  /** 当前范围(URL 权威)。 */
  scope: TargetScope;
  /** 本次解析走了哪条分支 —— ScopeGate 据它渲染错误壳。 */
  decision: InitialScopeResult;
  /** 已安装好且本项目可见的执行环境;`null` = 还在拉。 */
  targets: ScopeTargetOption[] | null;
  /** 拉清单失败的原因(🔴 失败**不当成空列表**:空列表在顶栏上等于「只有主控区」)。 */
  targetsError: string | null;
  /** 切范围:改 URL + 记住选择,**不重载**。 */
  setScope: (next: TargetScope) => void;
  /**
   * 给「单 target 等价规则」用(§2.6.7):`target-only` 的页在 global 视角下,
   * 若可见 target 恰好 1 个 ⇒ 按那一个渲染,不弹「请选择」。
   * 这不是回落 home —— 只有一个区时「全部」与「那一个区」在集合上完全相同。
   */
  effectiveScope: (cap?: ScopeDecl | null) => TargetScope;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

export function useScope(): ScopeContextValue {
  const v = useContext(ScopeContext);
  if (!v) throw new Error("useScope 必须在 <ScopeProvider> 内使用");
  return v;
}

export default function ScopeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlParam = params.get(SCOPE_PARAM);

  const [targets, setTargets] = useState<ScopeTargetOption[] | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const storageKey = useMemo(() => scopeStorageKey(getActiveProject(), getActiveEnv()), []);
  const [stored, setStored] = useState<string | null>(null);
  const noticed = useRef<string | null>(null);

  useEffect(() => {
    try {
      setStored(window.localStorage.getItem(storageKey));
    } catch {
      setStored(null);
    }
  }, [storageKey]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetchScopeTargets();
        if (!alive) return;
        setTargets(
          list.map((x) => ({
            targetId: x.targetId,
            region: x.region,
            jurisdiction: x.jurisdiction ?? "home",
            isHome: x.isHome,
            displayName: x.displayName ?? x.targetId,
            components: x.components ?? [],
            serviceable: x.serviceable !== false,
            unusableReason: x.unusableReason ?? null,
          }))
        );
        setTargetsError(null);
      } catch (e) {
        // 🔴 失败**不当成空列表**:空列表在顶栏上等于「只有主控区」,用户会以为第二区域没建好。
        if (alive) setTargetsError((e as Error)?.message || "读取执行范围清单失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const available = useMemo(() => (targets === null ? null : targets.map((t) => t.targetId)), [targets]);

  const decision = useMemo(
    () => resolveInitialScope({ urlParam, stored, available }),
    [urlParam, stored, available]
  );
  const scope = "scope" in decision ? decision.scope : GLOBAL_SCOPE;

  /** 写地址栏(保住其它 query 参数;global ⇒ 删掉该参数,保住「缺省不带参数」的回滚点)。 */
  const pushScopeToUrl = useCallback(
    (next: TargetScope, mode: "push" | "replace") => {
      const sp = new URLSearchParams(params.toString());
      const v = toScopeParam(next);
      if (v === null) sp.delete(SCOPE_PARAM);
      else sp.set(SCOPE_PARAM, v);
      const qs = sp.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "replace") router.replace(url, { scroll: false });
      else router.push(url, { scroll: false });
    },
    [params, pathname, router]
  );

  // ④ 从 localStorage 恢复 ⇒ 立刻把参数写回地址栏(地址栏与视图永远一致)
  useEffect(() => {
    if (decision.kind === "restored") pushScopeToUrl(decision.scope, "replace");
  }, [decision, pushScopeToUrl]);

  // ⑤ 上次选择已失效 ⇒ 落回「全部」+ **明确告知**(同一个值只提示一次,别刷屏)
  useEffect(() => {
    if (decision.kind !== "restored-stale") return;
    if (noticed.current === decision.staleRaw) return;
    noticed.current = decision.staleRaw;
    message.warning(staleScopeNotice(decision.staleRaw), 6);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [decision, storageKey]);

  // URL 赢的分支:把它记成「上次选择」
  useEffect(() => {
    if (decision.kind !== "url") return;
    const v = serializeScope(decision.scope);
    try {
      window.localStorage.setItem(storageKey, v);
    } catch {
      /* ignore */
    }
  }, [decision, storageKey]);

  // 🔴 **刻意没有第二个「再校验」effect**:`resolveInitialScope` 的入参里就有 `available`,
  // 清单拉回来的那一刻它会自己重算 —— localStorage 播种的坏值走 `restored-stale`(落回全部 + 告知),
  // URL 点名的坏值走 `url-unavailable`(报错壳、不改 URL)。再加一个 effect 去改 URL 只会多一条
  // 与它抢方向盘的路径(而这类「两处都在改同一个状态」正是最难查的一类 bug)。
  // ⚠️ 已知边界:清单**只拉一次**。会话中途某个 target 被删,顶栏不会自己变 ——
  // 下一次页面调 API 时由服务端拒(404/403/409),那是权威判定所在。切项目/切环境本身会整页 reload。

  const setScope = useCallback(
    (next: TargetScope) => {
      try {
        window.localStorage.setItem(storageKey, serializeScope(next));
      } catch {
        /* ignore */
      }
      setStored(serializeScope(next));
      pushScopeToUrl(next, "push"); // 🔴 push 不 reload:不离开当前页(护栏 4)
    },
    [pushScopeToUrl, storageKey]
  );

  const effectiveScope = useCallback(
    (cap?: ScopeDecl | null): TargetScope => {
      if (!cap || cap.scope !== "target-only") return scope;
      if (scope.kind !== "global") return scope;
      if (targets && targets.length === 1) return { kind: "target", targetId: targets[0].targetId };
      return scope;
    },
    [scope, targets]
  );

  const value = useMemo<ScopeContextValue>(
    () => ({ scope, decision, targets, targetsError, setScope, effectiveScope }),
    [scope, decision, targets, targetsError, setScope, effectiveScope]
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}
