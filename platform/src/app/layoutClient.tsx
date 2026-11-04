"use client";

import React, { Suspense, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Layout, Spin } from "antd";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";
import MultiTabs from "@/components/layout/MultiTabs";
import { AuthProvider, useAuth } from "@/lib/auth/AuthProvider";
import ThemeProvider from "@/lib/skins/ThemeProvider";
import I18nProvider from "@/lib/i18n/I18nProvider";
// @kf-batch 53-guide-v1 —— 操作指引抽屉挂在壳层(登录页不挂)
import GuideProvider from "@/components/guide/GuideProvider";
// @kf-batch 50-WP4-o1-scope —— 顶栏「执行范围」的 context 与页面壳(50 SPEC §2.6)。
// 🔴 用 Suspense 包住:ScopeProvider 内部用 `useSearchParams()`,App Router 要求它在 Suspense 边界内,
// 否则预渲染阶段会报错(fallback 给 null:范围未定时不渲染壳内内容,避免闪一下全局态)。
import ScopeProvider from "@/components/scope/ScopeProvider";
import ScopeGate from "@/components/scope/ScopeGate";
// 模块 55 / 序 50 —— 长操作全局提示(监听拦截器事件;登录页不挂)
import LongOpIndicator from "@/components/long-ops/LongOpIndicator";

const { Content } = Layout;

// Global login gate: when Cognito is configured, unauthenticated users are redirected to
// /login. The /login page itself is always allowed. When Cognito is not configured
// (local/dev), the gate is open.
function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, configured } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/login";

  useEffect(() => {
    if (!configured || loading) return;
    if (!user && !isLogin) router.replace("/login");
  }, [configured, loading, user, isLogin, router]);

  if (configured && loading && !isLogin) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }
  if (configured && !loading && !user && !isLogin) return null; // redirecting to /login
  return <>{children}</>;
}

export default function RootLayoutClient({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin = pathname === "/login";

  return (
    <I18nProvider>
      <ThemeProvider>
        <AuthProvider>
          <AuthGate>
            {isLogin ? (
              children
            ) : (
              <GuideProvider>
              <LongOpIndicator />
              <Suspense fallback={null}>
              <ScopeProvider>
              <Layout style={{ minHeight: "100vh", background: "transparent" }}>
                <Sidebar />
                <Layout style={{ background: "transparent" }}>
                  <Header />
                  <Content
                    style={{
                      margin: 24,
                      padding: 24,
                      background: "var(--bgp-panel, rgba(12,28,40,0.66))",
                      border: "1px solid var(--bgp-panel-border, rgba(86,224,242,0.22))",
                      borderRadius: "var(--bgp-radius, 12px)",
                      boxShadow: "0 0 24px var(--bgp-glow, rgba(34,211,238,0.05)), inset 0 1px 0 rgba(255,255,255,0.02)",
                      minHeight: "calc(100vh - 112px)",
                    }}
                  >
                    <MultiTabs><ScopeGate>{children}</ScopeGate></MultiTabs>
                  </Content>
                </Layout>
              </Layout>
              </ScopeProvider>
              </Suspense>
              </GuideProvider>
            )}
          </AuthGate>
        </AuthProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
