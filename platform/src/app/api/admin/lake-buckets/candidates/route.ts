// 表桶候选清单 —— **别名**:实现在只读路径 app/api/lake-buckets/candidates/route.ts(2026-11-09 挪出管理面:
// 网关对 /api/admin/** 要求 bgp-admin,页面读请求不再走这里)。本别名保留一版,下一版删。
export { dynamic, GET } from "@/app/api/lake-buckets/candidates/route";
