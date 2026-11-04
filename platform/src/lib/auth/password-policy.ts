// 页面「修改密码」的前端预校验。🔴 必须与用户池策略同口径(infra/lib/auth-stack.ts 的 passwordPolicy;
//   判据 password-policy-parity 读那个文件逐项比)。最终以 Cognito 服务端校验为准。
export const PASSWORD_MIN_LENGTH = 12;

export function passwordPolicyError(pw: string): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH) return `至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (!/[a-z]/.test(pw)) return "需包含小写字母";
  if (!/[A-Z]/.test(pw)) return "需包含大写字母";
  if (!/[0-9]/.test(pw)) return "需包含数字";
  if (!/[^A-Za-z0-9]/.test(pw)) return "需包含符号";
  return null;
}
