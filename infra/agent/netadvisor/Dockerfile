# NetAdvisor Agent — AgentCore Runtime 容器（必须 linux/arm64，端口 8080，/invocations + /ping）
# 上 Strands + agent-runner(②runtime 件)+ core-dist(消 RULES_TEXT 手抄)。
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:20-slim

WORKDIR /app
# ProtoShield(CVE 扫描「无锁文件」):package-lock.json 入库,npm ci 按锁安装,依赖树可复现、可扫描。
COPY package.json package-lock.json ./
# --omit=optional:@strands-agents/sdk 的可选子树(@tobilu/qmd → node-llama-cpp → simple-git …,本地模型工具)带 7 条 CVE 且运行期不用,不进镜像。
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund
# _runtime = 平台级共享 Strands 装配模板 + MCP 客户端(prebuild 分发进本目录内);
# core-dist = @netadvisor/core 编译产物(rules/renderRulesForPrompt,消手抄)。
COPY _runtime ./_runtime
COPY core-dist ./core-dist
COPY agent.js index.js ./

# ProtoShield(checkov CKV_DOCKER_3):以非 root 的 node 用户运行(镜像自带);代码只读、运行期不落盘。
USER node
# checkov:skip=CKV_DOCKER_2: AgentCore Runtime 用 /ping 探活,不执行镜像 HEALTHCHECK
EXPOSE 8080
CMD ["node", "index.js"]
