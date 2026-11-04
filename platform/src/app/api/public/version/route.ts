export const dynamic = "force-dynamic";
import { apiOk } from "@/lib/api-response";
import { readBuildInfo } from "@/lib/build-info";

// PUBLIC(被 middleware /api/public/* 放行,零改 auth):运行中的平台是哪一版 —— 序 39 第二刀。
// 用处:运维只读核版(AGENTS §9「现网是哪个版本」此前只能靠部署记录推断)、登录页页脚、系统设置「平台版本」卡。
// 不含任何秘密:发版 tag / 产品提交短哈希 / 提交时间 / VERSION 文件内容,全部来自镜像构建期的 git 事实
// (唯一作者 lib/build-info.ts;取不到就如实 known=false,不编造)。
export async function GET() {
  return apiOk(readBuildInfo());
}
