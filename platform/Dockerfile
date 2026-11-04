FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# 序 39 第二刀 —— 发版号进镜像:四个 build-arg 由 infra/lib/shared/build-info.ts(唯一作者)在 synth 时从 git 事实算出,
# 这里只做 ARG → 同名 ENV,运行时 platform/src/lib/build-info.ts 读回;键名三处逐字一致(守卫 lib/__tests__/build-info.test.ts)。
# 放在 runner 段:builder 段的构建缓存不受版本标签影响。缺省空串 = 「构建信息不可用」,不编造。
ARG BGP_BUILD_RELEASE_TAG=""
ARG BGP_BUILD_PRODUCT_COMMIT=""
ARG BGP_BUILD_PRODUCT_COMMIT_AT=""
ARG BGP_BUILD_VERSION=""
ENV BGP_BUILD_RELEASE_TAG=$BGP_BUILD_RELEASE_TAG BGP_BUILD_PRODUCT_COMMIT=$BGP_BUILD_PRODUCT_COMMIT BGP_BUILD_PRODUCT_COMMIT_AT=$BGP_BUILD_PRODUCT_COMMIT_AT BGP_BUILD_VERSION=$BGP_BUILD_VERSION
# 序 65 ProtoShield(checkov CKV_DOCKER_3):容器以非 root 的 node 用户运行;产物按 node:node 拷入,Next 运行期要写 .next/cache。
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
# checkov:skip=CKV_DOCKER_2: Fargate 不执行镜像 HEALTHCHECK;健康检查在 ALB 目标组(/api/public/version 200)与 ECS 任务定义,见 infra/lib/platform-stack.ts
EXPOSE 3000
CMD ["node", "server.js"]
