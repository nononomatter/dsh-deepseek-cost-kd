/**
 * dsh-deepseek-usage — 当日累计消费（本机改版新增）。
 *
 * 数据来源：DSH 自己的会话日志（默认 `~/.dsh/sessions/**\/*.jsonl.zstd`）。
 * 每次模型调用都会落一条 `assistant/message`，带 `usage`
 * （inputTokens / cacheReadTokens / cacheWriteTokens / outputTokens）与
 * `source.provider`、`source.model`。把今天这些条目按**发生时刻**逐条套上当时
 * 生效的单价（峰谷随时段变，见 lib/pricing.js 的 unitAt），累加即得当日消费。
 *
 * 为什么不用余额差：余额接口只给"此刻还剩多少"，没有历史。用余额差算当日消费
 * 要求卡片整天都在轮询，开机前的消费会漏掉，充值还会把差值算反。日志是事后可读的，
 * 补一次就能把当天之前的请求全部算进来。
 *
 * 口径（必须对用户说清）：**只算 DSH 本机发起的调用**，不含网页版、手机 App 或
 * 其它工具直接打 API 的消费；只算内置价格表里认识、且走 DeepSeek 官方路由的模型
 * （见 pricing.js 的 isOfficialModel），不认识的模型计入 unpriced 而不是猜一个价。
 *
 * 性能：只扫最近改过的会话文件（当天零点前 12 小时内），按 (mtime, size) 缓存
 * 解析结果，整个结果再按 MEMO_MS 缓存——30 秒心跳下绝大多数请求不碰磁盘。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { SHANGHAI_OFFSET_MS, isPeak, unitAt } from "./pricing.js";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DAY_MS = 24 * 60 * 60 * 1000;
/** 会话文件只改不改名的前提：今天写过的文件 mtime 一定在今天。留 12 小时余量抗时钟漂移。 */
const MTIME_MARGIN_MS = 12 * 60 * 60 * 1000;
/** 结果缓存：心率 30 秒，5 秒足够让连续点击不重复扫盘，又不会让刚聊完的数字迟迟不涨。 */
const MEMO_MS = 5 * 1000;

/** 会话日志目录；尊重 DSH_HOME，缺省 ~/.dsh。 */
function sessionsRoot() {
  const home = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  const base = home !== "" ? home : path.join(os.homedir(), ".dsh");
  return path.join(base, "sessions");
}

/**
 * 多帧 zstd → 文本。会话日志是「一条记录一帧」追加写的，
 * zstdDecompressSync 只吃第一帧，所以按 magic 切帧逐帧解。
 *
 * 返回 consumed = 最后**成功解出**的那一帧的结束偏移。末尾若是写了一半的帧，
 * 下一轮从 consumed 重新读——不吞掉那条记录，也不重复解已读过的字节。
 */
function decodeFrames(buffer) {
  const chunks = [];
  let i = 0;
  let consumed = 0;
  while (i < buffer.length) {
    let next = buffer.indexOf(ZSTD_MAGIC, i + 4);
    if (next < 0) next = buffer.length;
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(i, next)));
      consumed = next;
    } catch {
      break;
    }
    i = next;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), consumed };
}

/** 某时刻所在北京自然日的零点（ms）。 */
function dayStartOf(ms) {
  const local = new Date(ms + SHANGHAI_OFFSET_MS);
  return Date.parse(local.toISOString().slice(0, 10) + "T00:00:00Z") - SHANGHAI_OFFSET_MS;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".jsonl.zstd")) out.push(full);
  }
  return out;
}

/** file → { mtimeMs, size, since, entries }；entries 只留当天、可计价的那些。 */
const fileCache = new Map();
let memo = null;

/**
 * 解析一个会话文件里当天的用量条目（增量）。
 *
 * 日志只追加，所以缓存按字节偏移续读：上一轮已经解到 offset 的帧不再碰，
 * 只解 offset 之后新写进来的帧。文件被重写（变短或内容替换）时 offset 不可信，
 * 退回整文件重读——宁可多花一次，不能漏账。
 *
 * 缓存键带上 since（日期），跨天自动重算。
 */
function entriesOf(file, since) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const hit = fileCache.get(file);
  const incremental = !!hit && hit.since === since && hit.offset > 0 && stat.size >= hit.offset;
  const entries = incremental ? hit.entries : [];
  let offset = incremental ? hit.offset : 0;

  if (offset < stat.size) {
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      return entries;
    }
    const { text, consumed } = decodeFrames(buffer.subarray(offset));
    offset += consumed;
    const until = since + DAY_MS;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = record && record.data ? record.data.usage : null;
      if (!usage) continue;
      const time = Number(record.time);
      if (!Number.isFinite(time) || time < since || time >= until) continue;
      const source = record.data.message && record.data.message.source ? record.data.message.source : {};
      entries.push({
        time,
        provider: typeof source.provider === "string" ? source.provider : "",
        model: typeof source.model === "string" ? source.model : "",
        input: Number(usage.inputTokens) || 0,
        cacheRead: Number(usage.cacheReadTokens) || 0,
        cacheWrite: Number(usage.cacheWriteTokens) || 0,
        output: Number(usage.outputTokens) || 0,
      });
    }
  }

  fileCache.set(file, { since, offset, entries });
  return entries;
}

/**
 * 当日累计消费。
 * @param {number} now 观测时刻（缺省 Date.now()）
 * @returns {{
 *   cost: number, requests: number, tokens: number,
 *   since: number, currency: string, complete: boolean, unpriced: number,
 *   peakTokens: number, offPeakTokens: number
 * }}
 *   cost —— 元，按每一步发生时刻的峰谷价累加；
 *   complete —— false 表示有模型不在价格表里，cost 只是已计价部分；
 *   unpriced —— 没能计价的请求数（界面可据此说明"未含未知模型"）。
 */
export function todaySpend(now = Date.now()) {
  const since = dayStartOf(now);
  if (memo && memo.since === since && now - memo.at < MEMO_MS) return memo.value;

  const root = sessionsRoot();
  const files = walk(root, []).filter((file) => {
    try {
      return fs.statSync(file).mtimeMs >= since - MTIME_MARGIN_MS;
    } catch {
      return false;
    }
  });

  // 同一个文件可能被两次扫描重复读到（同一会话的不同目录），按条目去重代价高，
  // 但会话文件路径本身唯一，walk 结果已无重复。
  let cost = 0;
  let requests = 0;
  let tokens = 0;
  let unpriced = 0;
  let peakTokens = 0;
  let offPeakTokens = 0;

  for (const file of files) {
    for (const entry of entriesOf(file, since)) {
      const unit = unitAt(entry.model, entry.time, entry.provider);
      const total = entry.input + entry.cacheRead + entry.cacheWrite + entry.output;
      requests += 1;
      if (!unit.known) {
        unpriced += 1;
        continue;
      }
      tokens += total;
      if (isPeak(entry.time)) peakTokens += total;
      else offPeakTokens += total;
      cost +=
        (entry.input * unit.input +
          entry.cacheRead * unit.cacheRead +
          entry.cacheWrite * unit.cacheWrite +
          entry.output * unit.output) /
        1e6;
    }
  }

  const value = {
    cost: Math.round(cost * 1e6) / 1e6,
    requests,
    tokens,
    since,
    currency: "CNY",
    complete: unpriced === 0,
    unpriced,
    peakTokens,
    offPeakTokens,
  };
  memo = { since, at: now, value };
  return value;
}

/** 测试与调试用：清掉两级缓存（日期翻转、或单元测试之间）。 */
export function resetTodayCache() {
  fileCache.clear();
  memo = null;
}
