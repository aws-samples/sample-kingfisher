// Cognito 用户查询辅助：按用户名解析其稳定 sub / email。
// 用于项目成员管理——经 UI 添加成员时只输入用户名，这里在服务端补全 sub，
// 使后续"按 sub 精确授权"（如需求指派 isAssignee）可靠工作。Best-effort：失败返回空。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = sdkClient("control-plane", CognitoIdentityProviderClient, { region: homeRegion() });
const POOL_ID = process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "";

export async function resolveUserSub(
  username: string
): Promise<{ sub?: string; email?: string }> {
  if (!POOL_ID || !username) return {};
  try {
    const u = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: POOL_ID, Username: username })
    );
    const sub = u.UserAttributes?.find((a) => a.Name === "sub")?.Value;
    const email = u.UserAttributes?.find((a) => a.Name === "email")?.Value;
    return { sub, email };
  } catch {
    return {};
  }
}

// (问数)
/**
 * 一个用户**此刻**的账号状态(定时动作替作者执行前要重验:作者被禁用 / 降权 / 移出项目,定时就该停)。
 * 🔴 与上面那个 best-effort 不同:这里**查不到就抛**(fail-closed)—— 拿不到状态不许当成「还有权限」。
 */
export async function getUserAuthState(username: string): Promise<{ sub: string; enabled: boolean; groups: string[] }> {
  if (!POOL_ID) throw new Error("没有配置 Cognito 用户池,无法重验作者身份");
  if (!username) throw new Error("缺用户名,无法重验作者身份");
  const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL_ID, Username: username }));
  const sub = u.UserAttributes?.find((a) => a.Name === "sub")?.Value || "";
  const groups: string[] = [];
  let token: string | undefined;
  do {
    const r = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: POOL_ID, Username: username, NextToken: token }));
    for (const g of r.Groups ?? []) if (g.GroupName) groups.push(g.GroupName);
    token = r.NextToken;
  } while (token);
  return { sub, enabled: u.Enabled !== false, groups };
}
