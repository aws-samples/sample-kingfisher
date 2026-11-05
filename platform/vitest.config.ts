import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 单元测试配置。
// 只跑纯逻辑/安全关键模块的单测,与 `next build` 完全解耦:
//  - 测试文件位于 src/**/__tests__/*.test.ts,已在 tsconfig.json 的 exclude 中,故 next build
//    不会去类型检查它们;
//  - 这里用 vite 自己的别名解析 `@` -> ./src,与 Next 的 paths 对齐。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // 🔴 tsconfig 的 `jsx: "preserve"` 是给 Next 编译用的;vite 照它就解析不了 .tsx ⇒ 单测里无法真渲染组件。
  //   这里只让**测试**的转换用自动 JSX 运行时(不碰 next build);用途:组件级判据钉真渲染出来的 DOM 事实
  //   (首例 components/lake/__tests__/table-bucket-picker-form-id.test.ts)。
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    // 🔴 生产上线批次 A:「没配 Cognito」不再等于放开 ⇒ 单测显式声明「本进程关闭鉴权」
    //   (保持既有单测的演示身份语义;fail-closed 本身由 auth-mode 的专门判据删掉它来验)。
    env: { BGP_AUTH_DISABLED: "1" },
    // 🔴 单测与运行机器的 AWS 凭证隔离(假静态凭证 + 关掉所有真凭证来源),见文件头注释。
    setupFiles: ["./vitest.setup.ts"],
    // 🔴 单测超时是安全网不是判据:全量并行跑时路由测试要 import 整条 Next 路由模块,满载机 / 2 vCPU 的 CI runner 上 5 秒缺省会被调度抖动抢跑
    //   (2026-11-05 两次全量各随机红一例,单跑都 <1 秒)。真要钉时长的判据自己用 Date.now 断言。
    testTimeout: 20_000,
    include: ["src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      // 只统计被测的业务逻辑层,避免页面/组件拉低噪声。
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/__tests__/**"],
    },
  },
});
