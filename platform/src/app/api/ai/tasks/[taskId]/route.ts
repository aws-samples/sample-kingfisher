// 序 46 B-107 的轮询路径 `GET /api/ai/tasks/[taskId]` —— 模块 55 起**只是别名**(同一个 handler),保留一版给写死了该路径的
// 本机量具(p46 / p51)过渡;下一发版后删除。实现与文档以 `app/api/long-ops/[taskId]/route.ts` 为准。
// Next 15(序 68):被转出的 GET 已在 long-ops 路由里 `await props.params`,这里只是别名,无需再改。
export { dynamic, GET } from "@/app/api/long-ops/[taskId]/route";
