/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // 2a:src/instrumentation.ts 的 register() 挂载"进程内 lease 单例"周期 reconciler(SPEC §3.5a / DESIGN §20.24);
  // Next 15 起 instrumentation 为稳定能力,不再需要 experimental.instrumentationHook。
};
module.exports = nextConfig;
