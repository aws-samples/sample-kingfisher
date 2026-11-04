// L1 探测短期缓存 — 同一 (region, vpc 范围, 目标签名) 在 TTL 内复用 EnvironmentFacts，
// 省去重复 EC2/RDS Describe（一次 advise 多轮 + 多目标会反复探测同一 VPC）。
// 进程内 Map（Fargate 单容器足够；多副本各自缓存，TTL 短，无一致性问题）。
//
// EnvironmentFacts 带 capturedAt——Phase 2 apply 前据此查陈旧。

import { NET_ADVISOR } from "./config";
import type { EnvironmentFacts } from "./types";

interface Entry {
  facts: EnvironmentFacts;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function cacheKey(region: string, scopeVpcId: string | undefined, targetSig: string): string {
  return `${region}|${scopeVpcId || "all"}|${targetSig}`;
}

export function getCached(key: string): EnvironmentFacts | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return e.facts;
}

export function setCached(key: string, facts: EnvironmentFacts): void {
  store.set(key, { facts, expiresAt: Date.now() + NET_ADVISOR.cacheTtlSec * 1000 });
  // 防无界增长：超过 200 条时清理已过期项。
  if (store.size > 200) {
    const now = Date.now();
    store.forEach((v, k) => { if (now > v.expiresAt) store.delete(k); });
  }
}

export function clearCache(): void {
  store.clear();
}
