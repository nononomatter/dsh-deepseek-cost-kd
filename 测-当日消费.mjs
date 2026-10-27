// 真实数据冒烟测试：读本机 DSH 会话，打印当日消费与耗时。
// 用法：node 测-当日消费.mjs
import { todaySpend, resetTodayCache } from "./lib/today.js";

const time = (label, run) => {
  const t0 = process.hrtime.bigint();
  const value = run();
  console.log(`${label}: ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms`);
  return value;
};

const first = time("整盘首读", () => todaySpend());
console.log(JSON.stringify(first, null, 2));
time("memo 命中", () => todaySpend());

resetTodayCache();
const again = time("清缓存后重读（用于验证逐帧增量：除活跃会话外都应命中 offset）", () => todaySpend());
console.log("两次结果一致:", JSON.stringify(first) === JSON.stringify(again));
console.log(`均摊到每次请求: ${(first.cost / Math.max(1, first.requests)).toFixed(4)} 元`);
