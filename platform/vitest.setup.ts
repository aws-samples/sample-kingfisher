// 单测进程与运行机器的 AWS 凭证隔离(每个测试文件进程启动时执行一次)。
//
// 为什么:本机通常有 ~/.aws、AWS_PROFILE 或 EC2 实例角色。没 mock 到的 SDK 客户端会沿默认凭证链拿到**真凭证**并真打 AWS,
// 于是单测在本机「过」、在没有凭证的 CI 上红(2026-11-05 GitHub Actions 首次真跑:凭证工厂判据与 SDK 客户端判据
// 在 CI 上抛 CredentialsProviderError,本机却一直绿 —— 本机其实在用开发者的真凭证做 DescribeSecret)。
//
// 做法:关掉所有真凭证来源(profile / 共享配置 / 实例元数据 / 容器与 Web Identity),再给一套假的静态凭证。
//   · 判据里「有凭证才能走到网络插桩」的路径(sdk-client 的 net-stub)拿到的是假凭证,在本机与 CI 行为一致;
//   · 任何漏 mock 的 SDK 调用会带着假凭证出网并被 AWS 以签名错误拒绝,而不是用真凭证静默成功 ——
//     这类失败是**判据缺 mock**,修判据,不要在这里放开真凭证。
// 本文件只管 AWS 凭证环境;各判据自己设置的 AWS_REGION / 表名等不受影响(它们在本文件之后运行)。
for (const k of [
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_SESSION_TOKEN",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
]) {
  delete process.env[k];
}
process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTEST"; // 假的静态凭证:短于真实 AKIA 密钥格式,红线扫描不会把它当真密钥
process.env.AWS_SECRET_ACCESS_KEY = "unit-test-only-not-a-real-secret";
process.env.AWS_EC2_METADATA_DISABLED = "true";
process.env.AWS_CONFIG_FILE = "/dev/null";
process.env.AWS_SHARED_CREDENTIALS_FILE = "/dev/null";
