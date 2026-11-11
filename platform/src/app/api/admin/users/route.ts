export const dynamic = "force-dynamic";
import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { NextRequest } from "next/server";
import { CognitoIdentityProviderClient, ListUsersCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand, AdminListGroupsForUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { passwordPolicyError } from "@/lib/auth/password-policy";
import { recordAudit } from "@/lib/audit";
import { ADMIN_REQUIRED_MESSAGE } from "@/lib/auth/forbidden-messages";

const cognito = sdkClient("control-plane", CognitoIdentityProviderClient, { region: homeRegion() });
const POOL_ID = process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "";

// 用户管理是平台级敏感操作(列出所有用户 / 建号 / 改角色-可提权 / 禁用)。每个方法都必须
// 校验调用者为平台管理员(bgp-admin);中间件对 /api/admin 无角色门控,守卫在此路由内强制。
async function requireAdmin(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401);
  if (!identity.isPlatformAdmin) return apiError(ADMIN_REQUIRED_MESSAGE, 403);
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  if (!POOL_ID) return apiOk([]);
  try {
    const { Users = [] } = await cognito.send(new ListUsersCommand({ UserPoolId: POOL_ID }));
    const users = [];
    for (const u of Users) {
      let groups: string[] = [];
      try {
        const { Groups = [] } = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: POOL_ID, Username: u.Username! }));
        groups = Groups.map((g) => g.GroupName!);
      } catch {}
      const email = u.Attributes?.find((a) => a.Name === "email")?.Value || "";
      users.push({
        username: u.Username, email, status: u.UserStatus, enabled: u.Enabled,
        groups, createdAt: u.UserCreateDate?.toISOString(),
        role: groups.includes("bgp-admin") ? "Admin" : groups.includes("bgp-developer") ? "Developer" : "Viewer",
      });
    }
    return apiOk(users);
  } catch (e: any) {
    // 读失败不许呈成「空列表」(页面会把它当成「没有用户」):如实回上游错误,页面红字说明
    return apiError(`读取用户列表失败:${e?.message ?? String(e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  if (!POOL_ID) return apiError("Cognito 未配置");
  const { username, email, password, role } = await req.json();
  if (!username || !password) return apiError("缺少 username 或 password");

  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: POOL_ID, Username: username, MessageAction: "SUPPRESS",
      TemporaryPassword: password,
      UserAttributes: email ? [{ Name: "email", Value: email }] : [],
    }));
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL_ID, Username: username, Password: password, Permanent: true }));

    // Ensure groups exist and assign
    const groupName = role === "Admin" ? "bgp-admin" : role === "Developer" ? "bgp-developer" : "bgp-viewer";
    try {
      const { CreateGroupCommand } = await import("@aws-sdk/client-cognito-identity-provider");
      await cognito.send(new (CreateGroupCommand as any)({ UserPoolId: POOL_ID, GroupName: groupName }));
    } catch {}
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL_ID, Username: username, GroupName: groupName }));
    // 审计只记谁建了谁、给了哪个角色,绝不记口令 / 邮箱
    recordAudit(req, "user.create", { resourceType: "user", resourceId: String(username), detail: { role, groupName } });

    return apiOk({ username, role });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function PUT(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  if (!POOL_ID) return apiError("Cognito 未配置");
  const { username, action, role, password } = await req.json();
  if (!username) return apiError("缺少 username");
  // 🔴 未知动作原来被静默当成功(页面提示「操作成功」而什么都没做)⇒ 一律 400
  if (!["disable", "enable", "changeRole", "resetPassword"].includes(action)) return apiError(`未知操作:${action}`);
  // 平台管理员给任何用户(含 admin 自己)设新密码。
  //   服务端按用户池同一份策略先校验(前端预校验可被绕过);设成**永久**口令,对方下次直接用它登录。
  if (action === "resetPassword") {
    const bad = passwordPolicyError(String(password ?? ""));
    if (bad) return apiError(`新密码不符合要求:${bad}`);
  }

  try {
    if (action === "resetPassword") {
      await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL_ID, Username: username, Password: password, Permanent: true }));
      // 审计只记谁给谁改了,绝不记口令
      recordAudit(req, "user.password.reset", { resourceType: "user", resourceId: String(username) });
    }
    // 用户管理的每个写动作都进审计(「全部写操作进 bgp-audit」):此前只有重置密码记了
    if (action === "disable") {
      await cognito.send(new AdminDisableUserCommand({ UserPoolId: POOL_ID, Username: username }));
      recordAudit(req, "user.disable", { resourceType: "user", resourceId: String(username) });
    }
    if (action === "enable") {
      await cognito.send(new AdminEnableUserCommand({ UserPoolId: POOL_ID, Username: username }));
      recordAudit(req, "user.enable", { resourceType: "user", resourceId: String(username) });
    }
    if (action === "changeRole" && role) {
      for (const g of ["bgp-admin", "bgp-developer", "bgp-viewer"]) {
        try { await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: POOL_ID, Username: username, GroupName: g })); } catch {}
      }
      const groupName = role === "Admin" ? "bgp-admin" : role === "Developer" ? "bgp-developer" : "bgp-viewer";
      try {
        const { CreateGroupCommand } = await import("@aws-sdk/client-cognito-identity-provider");
        await cognito.send(new (CreateGroupCommand as any)({ UserPoolId: POOL_ID, GroupName: groupName }));
      } catch {}
      await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL_ID, Username: username, GroupName: groupName }));
      recordAudit(req, "user.role.change", { resourceType: "user", resourceId: String(username), detail: { role, groupName } });
    }
    return apiOk({ success: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
