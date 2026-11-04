// AgentCore Runtime 容器入口：实现契约 /invocations(POST) + /ping(GET)，端口 8080。
import http from "node:http";
import { runAgent } from "./agent.js";

const PORT = 8080;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/ping") {
    return send(res, 200, { status: "healthy" });
  }
  if (req.method === "POST" && req.url === "/invocations") {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on("end", async () => {
      let payload = {};
      try { payload = data ? JSON.parse(data) : {}; } catch { return send(res, 400, { error: "invalid JSON" }); }
      // 兼容 {input:{...}} 或直接 {...}
      const input = payload.input && typeof payload.input === "object" ? payload.input : payload;
      const prompt = (input.prompt || input.question || "").toString().trim();
      if (!prompt) return send(res, 400, { error: "缺少 prompt" });
      try {
        const out = await runAgent({
          prompt,
          // 项目范围:透传前端(经 x-bgp-project header→execute.ts→invoke payload)带来的 projectId。
          // 缺此透传时 agent.js 下游 lookup_business_context/list_registered_skills/工具转发的
          // input.projectId 恒 undefined→塌缩成 proj-default,多项目下项目专属口径/技能过滤失效。
          projectId: typeof input.projectId === "string" ? input.projectId : undefined,
          engine: input.engine === "athena" ? "athena" : "redshift",
          database: input.database || "dev",
          // 取数落点(平台解析好的;缺省 = 主控区)
          place: input.place && typeof input.place === "object" ? input.place : undefined,
          // 容器唯一读的落点(PlaceWire v1);agent.js 用 readPlaceWire 校验,缺 / 不合法即拒
          placeWire: input.placeWire,
          published: Array.isArray(input.published) ? input.published : [],
          history: Array.isArray(input.history) ? input.history : [],
          memory: typeof input.memory === "string" ? input.memory : "",
          // 平台按运行时配置透传的模型(顶层 payload.modelId,兼容 input.modelId)。
          modelId: typeof payload.modelId === "string" ? payload.modelId : (typeof input.modelId === "string" ? input.modelId : undefined),
        });
        return send(res, 200, { output: out });
      } catch (e) {
        return send(res, 500, { error: e && e.message ? e.message : String(e) });
      }
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`genbi-agent listening on :${PORT}`));
