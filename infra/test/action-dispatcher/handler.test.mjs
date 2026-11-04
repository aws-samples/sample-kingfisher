// 分发 Lambda 的离线判据(真 import 部署进 Lambda 的那份 index.mjs,注入假依赖)。
//   ① 只分发 INSERT + pending 的命令(MODIFY / REMOVE / 非 pending 一律忽略 —— 平台写终态也会产生流事件);
//   ② 请求只带 commandId,带内部密钥头 + 来源头,打到 ALB 的**私网地址**;
//   ③ 202 / 409 / 4xx(平台已处理)⇒ 完成,不判 failed;
//   ④ 一直 5xx / 网络错 ⇒ 换地址 + 重读密钥重试,用完 ⇒ 把命令判 failed 并写清原因(DAG 立刻看得到);
//   ⑤ ALB 网卡 → 私网地址的提取。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHandler, pendingCommandIds, albPrivateIps, INTERNAL_KEY_HEADER } from "../../lambda/action-dispatcher/index.mjs";

const ev = (...recs) => ({ Records: recs });
const ins = (id, status = "pending") => ({ eventName: "INSERT", dynamodb: { NewImage: { commandId: { S: id }, status: { S: status } } } });

test("① 只分发 INSERT + pending", () => {
  const e = ev(ins("a"), ins("b", "running"), { eventName: "MODIFY", dynamodb: { NewImage: { commandId: { S: "c" }, status: { S: "pending" } } } }, { eventName: "REMOVE" }, ins(""));
  assert.deepEqual(pendingCommandIds(e), ["a"]);
});

function deps(over = {}) {
  const calls = { posts: [], failed: [], keyForce: [] };
  return {
    calls,
    d: {
      port: 80,
      sleep: async () => {},
      getKey: async (force) => {
        calls.keyForce.push(force);
        return "k-123";
      },
      getAlbIps: async () => ["10.0.1.5", "10.0.2.7"],
      post: async (a) => {
        calls.posts.push(a);
        return { status: 202, text: "{}" };
      },
      failCommand: async (id, reason) => calls.failed.push({ id, reason }),
      ...over,
    },
  };
}

test("② ③ 请求形状 + 202 即完成", async () => {
  const { calls, d } = deps();
  const r = await makeHandler(d)(ev(ins("cmd-1")));
  assert.deepEqual(r, { batchItemFailures: [] });
  assert.equal(calls.posts.length, 1);
  assert.deepEqual(calls.posts[0].body, { commandId: "cmd-1" });
  assert.equal(calls.posts[0].key, "k-123");
  assert.equal(calls.posts[0].ip, "10.0.1.5");
  assert.equal(calls.failed.length, 0);
  assert.equal(INTERNAL_KEY_HEADER, "x-bgp-internal-key");
});

test("③ 409 / 403 / 404 / 400 都算已处理(平台已收口或判死),不重试、不判 failed", async () => {
  for (const s of [409, 403, 404, 400]) {
    const { calls, d } = deps({ post: async (a) => (calls.posts.push(a), { status: s, text: "" }) });
    await makeHandler(d)(ev(ins("x")));
    assert.equal(calls.posts.length, 1, String(s));
    assert.equal(calls.failed.length, 0, String(s));
  }
});

test("④ 一直 503 / 401 / 网络错 ⇒ 换地址 + 强制重读密钥重试,用完把命令判 failed 并写原因", async () => {
  const { calls, d } = deps({ post: async (a) => (calls.posts.push(a), { status: a.ip === "10.0.1.5" ? 503 : 0, text: "boom" }) });
  await makeHandler(d)(ev(ins("cmd-2")));
  assert.equal(calls.posts.length, 6); // 3 轮 × 2 个地址
  assert.deepEqual(calls.keyForce, [false, true, true]);
  assert.equal(calls.failed.length, 1);
  assert.equal(calls.failed[0].id, "cmd-2");
  assert.match(calls.failed[0].reason, /没能把命令交给平台/);
});

test("④b 第二个地址成功 ⇒ 完成,不判 failed", async () => {
  const { calls, d } = deps({ post: async (a) => (calls.posts.push(a), { status: a.ip === "10.0.1.5" ? 502 : 202, text: "" }) });
  await makeHandler(d)(ev(ins("cmd-3")));
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.failed.length, 0);
});

test("④c 查不到 ALB 地址 ⇒ 重试后判 failed(不静默丢命令)", async () => {
  const { calls, d } = deps({ getAlbIps: async () => [] });
  await makeHandler(d)(ev(ins("cmd-4")));
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.failed.length, 1);
  assert.match(calls.failed[0].reason, /ALB 的私网地址/);
});

test("⑤ ALB 网卡 → 私网地址", () => {
  assert.deepEqual(
    albPrivateIps([{ PrivateIpAddress: "10.0.2.9", Status: "in-use" }, { PrivateIpAddress: "10.0.1.3" }, { Status: "in-use" }, { PrivateIpAddress: "10.0.3.1", Status: "detaching" }]),
    ["10.0.1.3", "10.0.2.9"]
  );
});
