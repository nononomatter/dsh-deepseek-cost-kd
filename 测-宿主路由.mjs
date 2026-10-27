// 宿主路由端到端测试：给 index.js 搭一个假 ctx / 假 req / 假 res，
// 验证 /api/kd-deepseek-cost 的响应里带上 today，且余额失败不影响今日消费。
// DSH 的 @deepseek-ai/dsh-credentials 在沙盒里不可解析，所以造一个只导出
// credentialRef 的桩包，把 lib 复制到临时目录再 import（不改动本目录）。
// 用法：node 测-宿主路由.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-usage-host-"));

fs.mkdirSync(path.join(sandbox, "lib"), { recursive: true });
for (const file of fs.readdirSync(path.join(here, "lib"))) {
  fs.copyFileSync(path.join(here, "lib", file), path.join(sandbox, "lib", file));
}
fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ type: "module" }));

const stubDir = path.join(sandbox, "node_modules", "@deepseek-ai", "dsh-credentials");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-credentials", type: "module", main: "index.js" }));
fs.writeFileSync(path.join(stubDir, "index.js"), "export const credentialRef = (name) => ({ name });\n");

const { apply } = await import(pathToFileURL(path.join(sandbox, "lib", "index.js")).href);

const routes = new Map();
const warnings = [];
const ctx = {
  effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
  logger: { warn: (...args) => warnings.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")) },
  get: (name) => {
    if (name === "agentDefaultModel") return { currentSelection: () => ({ model: "deepseek-flash", provider: "deepseek-official" }) };
    return undefined;
  },
  // 凭据一律解析不到（undefined，与 DSH 凭据服务"没配"时的返回值一致）：
  // 模拟"未配置 Key"，用来验证余额失败时 today 仍然成立。
  credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
  webServer: {
    host: "127.0.0.1",
    register: (def) => { routes.set(def.path, def.handler); return () => {}; },
  },
};
apply(ctx);

assert.ok(routes.has("/api/kd-deepseek-cost"), "主路由应已注册");
assert.ok(routes.has("/api/kd-deepseek-cost/holidays"), "节假日路由应已注册");

/** 假 res：收集状态码与 body。 */
function makeRes() {
  return {
    headersSent: false,
    status: 0,
    body: "",
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk); },
  };
}

async function call(pathname) {
  const req = { method: "GET", url: pathname, headers: { host: "127.0.0.1:3049", "sec-fetch-site": "same-origin" } };
  const res = makeRes();
  await routes.get(pathname.split("?")[0])(req, res);
  return { status: res.status, body: res.body === "" ? null : JSON.parse(res.body) };
}

const main = await call("/api/kd-deepseek-cost?lang=zh");
if (warnings.length > 0) console.log("宿主告警:", warnings);
assert.equal(main.status, 200, "主路由应返回 200");
assert.equal(main.body.ok, true);
assert.ok(main.body.today, "响应里应带 today");
assert.ok(Number.isFinite(main.body.today.cost), "today.cost 应是有限数");
assert.ok(main.body.today.cost > 0, `今天用过 DSH，cost 应大于 0，实得 ${main.body.today.cost}`);
assert.ok(main.body.today.requests > 0);
assert.equal(main.body.today.currency, "CNY");
console.log("today =", JSON.stringify(main.body.today));
console.log("balance =", JSON.stringify(main.body.balance), "errors =", JSON.stringify(main.body.errors));

// 没配 Key 时余额是空的，但今日消费不能跟着变空——两者互不依赖。
assert.equal(main.body.balance.total, null, "无 Key 时余额应为 null");
assert.ok(Array.isArray(main.body.errors) && main.body.errors.length > 0, "无 Key 时应有错误说明");
assert.ok(main.body.today.cost > 0, "余额失败不得连带 today 归零");

// 语言参数只影响错误文案
const en = await call("/api/kd-deepseek-cost?lang=en");
assert.equal(en.status, 200);
assert.notEqual(en.body.errors[0], main.body.errors[0], "中英文错误文案应不同");

// 非本机 Host 必须被拒
const bad = { method: "GET", url: "/api/kd-deepseek-cost", headers: { host: "evil.example.com" } };
const badRes = makeRes();
await routes.get("/api/kd-deepseek-cost")(bad, badRes);
assert.equal(badRes.status, 403, "异源 Host 应被拒");

// 节假日路由
const holidays = await call("/api/kd-deepseek-cost/holidays");
assert.equal(holidays.status, 200);
assert.ok(Array.isArray(holidays.body.ranges) && holidays.body.ranges.length > 0);

fs.rmSync(sandbox, { recursive: true, force: true });
console.log("宿主路由测试全部通过：today 字段 / 余额失败不连带 / 中英文 / 异源拒绝 / 节假日");
