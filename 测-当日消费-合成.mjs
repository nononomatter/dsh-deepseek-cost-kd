// 当日消费的合成测试：造一个假会话目录，验证计费、跨天过滤、增量续读、未计价标记。
// 不碰真实会话；用 DSH_HOME 指到临时目录。
// 用法：node 测-当日消费-合成.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "today-test-"));
process.env.DSH_HOME = root;

const { todaySpend, resetTodayCache } = await import("./lib/today.js");

const dir = path.join(root, "sessions", "--ws--", "session-1");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "session.v4.jsonl.zstd");

/** 一条 assistant/message 记录，按帧追加。 */
function append(record) {
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(JSON.stringify(record) + "\n")));
}
function record(time, usage, provider, model) {
  return {
    type: "assistant/message",
    time,
    data: { usage, message: { source: { kind: "model", provider, model } } },
  };
}
const USAGE = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 };
const at = (iso) => Date.parse(iso);

// 今天（2026-10-27）北京时间 10:00，高峰：1×2 + 1×0.04 + 1×8 = 10.04 元
append(record(at("2026-10-27T10:00:00+08:00"), USAGE, "deepseek-official", "deepseek-flash"));
// 昨天 20:00 的记录必须被跨天过滤掉
append(record(at("2026-10-26T20:00:00+08:00"), USAGE, "deepseek-official", "deepseek-flash"));

resetTodayCache();
const now = at("2026-10-27T16:00:00+08:00");
let r = todaySpend(now);
assert.equal(r.requests, 1, "昨天的记录不该计入");
assert.ok(Math.abs(r.cost - 10.04) < 1e-9, `高峰价应为 10.04，实得 ${r.cost}`);
assert.equal(r.complete, true);

// 增量：再追加一条今天的闲时记录（20:00 之后的第二天？必须仍属今天）
// 用 12:30（12:00–14:00 是闲时）：1×1 + 1×0.02 + 1×4 = 5.02
append(record(at("2026-10-27T12:30:00+08:00"), USAGE, "deepseek-official", "deepseek-flash"));
resetTodayCache();
r = todaySpend(at("2026-10-27T16:00:00+08:00"));
assert.equal(r.requests, 2, "追加的记录应被计入");
assert.ok(Math.abs(r.cost - 15.06) < 1e-9, `累计应为 15.06，实得 ${r.cost}`);

// 未计价模型：官方路由但表里没有 → 不进 cost，但会把 complete 置 false
append(record(at("2026-10-27T15:00:00+08:00"), USAGE, "deepseek-official", "deepseek-v9-unknown"));
resetTodayCache();
r = todaySpend(at("2026-10-27T16:00:00+08:00"));
assert.equal(r.requests, 3);
assert.equal(r.unpriced, 1);
assert.equal(r.complete, false);
assert.ok(Math.abs(r.cost - 15.06) < 1e-9, `未计价模型不得改动手工算出的金额，实得 ${r.cost}`);

// 第三方路由上的同名模型不计价（内置表对它不成立）
append(record(at("2026-10-27T15:30:00+08:00"), USAGE, "workbuddy-gateway", "deepseek-flash"));
resetTodayCache();
r = todaySpend(at("2026-10-27T16:00:00+08:00"));
assert.equal(r.unpriced, 2, "第三方路由不该按官方价计费");

// 缓存：同一天内第二次调用直接命中
const t0 = process.hrtime.bigint();
todaySpend(at("2026-10-27T16:00:10+08:00"));
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert.ok(ms < 5, `memo 命中应 <5ms，实得 ${ms.toFixed(1)}ms`);

fs.rmSync(root, { recursive: true, force: true });
console.log("合成测试全部通过：跨天过滤 / 峰谷计价 / 增量续读 / 未计价标记 / memo 命中");
