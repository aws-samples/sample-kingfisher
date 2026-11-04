// 模块47 L2 — core 内联 AWS 常量的【漂移守卫】。
//
// core/catalog.ts 为脱离 @/ 编译成 CJS 给容器 import,内联了 worker/EMR 规格常量(AWS 客观事实)。
// 内联换取"消灭容器 CATALOG_TEXT 6401 字手抄"(高危副本),但引入"AWS 事实常量在 core 有一份副本"(低危)。
// 本单测把那份低危副本的一致性【机器守卫】:同时 import core 内联值与平台真源,toEqual 比对。
// 真源(worker-types / emr spec)一旦新增档位、这里没跟 → 单测立即红(CI 拦截),取代"两处手动同步"。
//
// 注:core/catalog 主体逻辑(catalogFor/renderCatalogForPrompt)另由 heuristics.test.ts 覆盖(re-export 保持)。

import { describe, it, expect } from "vitest";
import {
  CORE_GLUE_WORKER_VALUES,
  CORE_GLUE_MAX_WORKERS,
  CORE_GLUE_VERSIONS,
  CORE_GLUE_VERSION_DEFAULT,
  CORE_EMR_RELEASE_LABELS,
  CORE_EMR_ARCHITECTURES,
  CORE_EMR_CPU_OPTIONS,
  CORE_EMR_MEMORY_OPTIONS,
  CORE_EMR_MAX_EXECUTORS,
  CORE_EMR_SPEC_DEFAULT,
} from "../core/catalog";
// 平台真源(catalog.ts 抽 core 前从这里 import;现由本单测充当一致性锚)。
import { GLUE_WORKER_VALUES, GLUE_MAX_WORKERS } from "@/lib/etl/worker-types";
// 序 53:Glue 版本清单 / 缺省的真源(缺省最高、可降版)
import { GLUE_VERSIONS, GLUE_VERSION_DEFAULT } from "@/lib/sync/glue-version";
import {
  EMR_RELEASE_LABELS,
  EMR_ARCHITECTURES,
  EMR_CPU_OPTIONS,
  EMR_MEMORY_OPTIONS,
  EMR_MAX_EXECUTORS,
  EMR_SPEC_DEFAULT,
} from "@/lib/engines/emr/spec";

describe("core 内联 AWS 常量 vs 平台真源(漂移守卫)", () => {
  describe("Glue worker 规格(源 @/lib/etl/worker-types)", () => {
    it("worker value 列表逐项一致", () => {
      expect(CORE_GLUE_WORKER_VALUES).toEqual([...GLUE_WORKER_VALUES]);
    });
    it("worker 数量上限一致", () => {
      expect(CORE_GLUE_MAX_WORKERS).toBe(GLUE_MAX_WORKERS);
    });
  });

  describe("Glue 版本清单与缺省(源 @/lib/sync/glue-version;序 53 缺省最高、可降版)", () => {
    it("版本清单逐项一致(含 6.0)", () => {
      expect(CORE_GLUE_VERSIONS).toEqual([...GLUE_VERSIONS]);
      expect(CORE_GLUE_VERSIONS).toContain("6.0");
    });
    it("缺省一致", () => {
      expect(CORE_GLUE_VERSION_DEFAULT).toBe(GLUE_VERSION_DEFAULT);
    });
  });

  describe("EMR Serverless 规格(源 @/lib/engines/emr/spec)", () => {
    it("release 版本列表逐项一致(含默认 emr-spark-8.0.0 与序 53 加的 emr-7.14.0,防容器旧手抄 emr-7.5.0 漂移复现)", () => {
      expect(CORE_EMR_RELEASE_LABELS).toEqual([...EMR_RELEASE_LABELS]);
      expect(CORE_EMR_RELEASE_LABELS).toContain("emr-7.14.0");
    });
    it("架构选项一致", () => {
      expect(CORE_EMR_ARCHITECTURES).toEqual([...EMR_ARCHITECTURES]);
    });
    it("CPU 档位一致", () => {
      expect(CORE_EMR_CPU_OPTIONS).toEqual([...EMR_CPU_OPTIONS]);
    });
    it("内存档位一致", () => {
      expect(CORE_EMR_MEMORY_OPTIONS).toEqual([...EMR_MEMORY_OPTIONS]);
    });
    it("executor 上限一致", () => {
      expect(CORE_EMR_MAX_EXECUTORS).toBe(EMR_MAX_EXECUTORS);
    });
    it("默认规格(catalog 用到的字段)一致", () => {
      // catalog 只取 releaseLabel/architecture/driver/executor/executorCount(不含 executionRoleArn)。
      expect(CORE_EMR_SPEC_DEFAULT.releaseLabel).toBe(EMR_SPEC_DEFAULT.releaseLabel);
      expect(CORE_EMR_SPEC_DEFAULT.architecture).toBe(EMR_SPEC_DEFAULT.architecture);
      expect(CORE_EMR_SPEC_DEFAULT.driver).toEqual(EMR_SPEC_DEFAULT.driver);
      expect(CORE_EMR_SPEC_DEFAULT.executor).toEqual(EMR_SPEC_DEFAULT.executor);
      expect(CORE_EMR_SPEC_DEFAULT.executorCount).toBe(EMR_SPEC_DEFAULT.executorCount);
    });
  });
});
