/**
 * dsh-deepseek-usage — 定价表（元 / 百万 tokens）。
 *
 * 价格唯一来源：下方 PRICE_TABLE 内置表——DeepSeek 官方峰谷定价快照
 * （2026-09-10 官方价格页）。官方调价时随插件版本更新本表。
 *
 * 模型改名（0.6.0 起）：官方会把模型改名并把旧名保留为别名（如
 * deepseek-v4-flash / deepseek-v4-flash-vision-exp → deepseek-flash）。旧名若
 * 落到内置表就会长期显示过期价且无从察觉，因此 MODEL_ALIASES 维护"旧名 → 现名"
 * 的显式映射，unitAt() 的 via 字段标出来源，供排查，避免静默算错。
 *
 * 不做"同家族唯一匹配"（flash / pro / chat / reasoner）：家族词没有词边界，
 * deepseek-v5-pro、deepseek-prompt-helper 都会命中 pro 并按上代价格计价；官方发布
 * 下一代模型后，卡片会自信地显示旧价而不是隐藏。表里没有的模型一律 known=false。
 *
 * 只对 DeepSeek 官方路由 + 官方模型计价（isOfficialModel）：第三方供应商的模型、
 * 路由器把供应商名当模型名上报的情况（codebuddy、workbuddy 的 deepseek-v4.1-flash）
 * 一律 known=false，界面据此隐藏档单价与峰谷指示灯——官方价格表与峰谷时段对它们不成立。
 *
 * 峰谷（官方口径）：高峰时段为北京时间周一至周五（**不含中国法定节假日**）
 * 9:00–12:00、14:00–18:00，其余（含整个周末、法定节假日全天、以及调休上班的
 * 周末）为空闲时段；缓存写暂不计费（cacheWrite = 0）。
 * 因此只有"落在工作日里的法定节假日"会改变判定结果——周末无论是否调休上班都
 * 是空闲，见 HOLIDAY_RANGES。
 *
 * 本文件用于卡片"当前档单价"展示、峰谷指示灯，以及 nextChange() 给出的
 * 「距下次峰谷切换倒计时」（卡片上显示为 `2d 15h` / `5h 47m` 这类英文单位时长）。
 *
 * 时区（0.1.7 起）：峰谷判定与"每日"边界均按北京时间（Asia/Shanghai，固定
 * UTC+8，无夏令时）计算，不随服务器本地时区变化——在任何时区部署的 DSH 上
 * 显示一致。
 */

/** 北京时间固定偏移（上海无夏令时）。 */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 价格表：input（缓存未命中）/ cacheRead（缓存命中）/ output 均为 [高峰, 空闲]
 * 二元组；cacheWrite 为常量 0。官方改价时更新本表并发布新版本。
 */
const PRICE_TABLE = {
  'deepseek-flash': { input: [2, 1], cacheRead: [0.04, 0.02], cacheWrite: 0, output: [8, 4] },
  'deepseek-v4-pro': { input: [9, 4.5], cacheRead: [0.3, 0.15], cacheWrite: 0, output: [27, 13.5] },
  'deepseek-chat': { input: [2, 2], cacheRead: [0.5, 0.5], cacheWrite: 0, output: [8, 8] },
  'deepseek-reasoner': { input: [4, 4], cacheRead: [1, 1], cacheWrite: 0, output: [16, 16] },
};

/**
 * 旧模型名 → 现模型名（官方改名后旧名仍可调用，且按现模型价格计费）。
 * 见官方价格页脚注：deepseek-v4-flash / deepseek-v4-flash-vision-exp 由
 * DeepSeek-V4.1-Flash 提供服务，按 Flash 价格计费。
 */
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/** 默认模型（当 agentDefaultModel 不可用时的展示默认）。 */
export const DEFAULT_MODEL = 'deepseek-flash';

/**
 * DeepSeek 官方模型路由的 provider id。官方有两条：API Key 路由
 * （`@deepseek-ai/dsh-llm-deepseek-api-key`）与账号路由
 * （`@deepseek-ai/dsh-llm-deepseek-account`）。
 *
 * 只按模型名前缀判官方是不够的：Qwen token-plan、NVIDIA、opencode、workbuddy 这些
 * 第三方路由上都有 `deepseek-*` 同名模型，它们按各自的计价规则扣费。provider 缺失
 * （旧宿主、路由未上报）时按"非官方"处理——宁可隐藏价格，也不显示一个与实际账单
 * 无关的数字。
 */
export const OFFICIAL_PROVIDERS = ['deepseek-official', 'deepseek-account'];

/** 高峰时段窗口（北京时间，含起点不含终点）。 */
export const PEAK_WINDOWS = [[9, 12], [14, 18]];
/** 官方口径：高峰仅限周一至周五（北京时间），周末整天为空闲时段。 */
export const PEAK_WEEKDAYS_ONLY = true;

/**
 * 中国法定节假日放假日期（含起止，闭区间；北京时间的日历日）。
 * 来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7号）。
 * 官方口径：法定节假日全天、调休上班的周末均为空闲时段——周末本来就空闲，所以
 * 只需列"放假日期"，落在工作日里的那几天才会把判定从高峰翻成空闲。
 * 下一年的安排通常在前一年 11 月发布，届时更新本表与 HOLIDAY_TABLE_THROUGH_YEAR；
 * 当前年份未被覆盖时由 lib/index.js 告警（见 hasHolidayCoverage）。
 */
export const HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明节
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午节
  ['2026-09-25', '2026-09-27'], // 中秋节
  ['2026-10-01', '2026-10-07'], // 国庆节
];

/**
 * 把 [起, 止] 闭区间展开成日期键集合（`yyyy-mm-dd`，O(1) 查表）。
 *
 * 非法日期（如 2027-02-30）会被 Date.parse 滚到 03-02，把一个不存在的日子变成
 * 真的假日。这里先校验解析结果与输入一致，不一致就跳过该段。
 */
export function expandHolidayRanges(ranges) {
  const set = new Set();
  const DAY = 24 * 60 * 60 * 1000;
  for (const [from, to] of ranges) {
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    // 解析结果必须与输入同一天，否则说明输入本身不是合法日期（已滚动到别的日子）。
    if (new Date(start).toISOString().slice(0, 10) !== from) continue;
    if (new Date(end).toISOString().slice(0, 10) !== to) continue;
    for (let t = start; t <= end; t += DAY) set.add(new Date(t).toISOString().slice(0, 10));
  }
  return set;
}

const HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

/** 某时刻的北京时间日期键（`yyyy-mm-dd`）。 */
function beijingDateKey(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 放假日期表覆盖到的年份（含）。
 *
 * 国务院办公厅通常在前一年 11 月发布次年安排，届时更新 HOLIDAY_RANGES 并把这个
 * 常量 +1。不能用"表里有没有这一年的某一天"来判定覆盖：只补一条元旦记录就会让
 * 判定通过，而春节、国庆仍然按工作日计价。
 */
export const HOLIDAY_TABLE_THROUGH_YEAR = 2026;

/** 该时刻所在的北京时间年份是否已被放假日期表覆盖。 */
export function hasHolidayCoverage(ms = Date.now()) {
  const year = new Date(ms + SHANGHAI_OFFSET_MS).getUTCFullYear();
  return year <= HOLIDAY_TABLE_THROUGH_YEAR;
}

/** 某时刻是否为高峰时段（按北京时间；法定节假日全天与周末恒为空闲）。
 *
 * `holidays` 可选：浏览器侧镜像无法 import 本模块，测试与宿主以外的调用方可以传入
 * 自己的日期集合；缺省用内置表，保证 `isPeak(ms)` 的既有语义不变。
 */
export function isPeak(ms, holidays = HOLIDAY_DAYS) {
  const now = Number.isFinite(ms) ? ms : Date.now();
  if (holidays.has(beijingDateKey(now))) return false; // 法定节假日：全天空闲
  const d = new Date(now + SHANGHAI_OFFSET_MS);
  if (PEAK_WEEKDAYS_ONLY) {
    const dow = d.getUTCDay(); // 0 = 周日
    if (dow === 0 || dow === 6) return false;
  }
  const h = d.getUTCHours();
  return PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
}

/**
 * 可能的切换时刻（北京时间的整点）：高峰窗口的起止整点。
 * 翻转只可能发生在这些整点上——窗口外的整点不改变 isPeak，工作日之外则整天不变。
 */
const BOUNDARY_HOURS = [...new Set(PEAK_WINDOWS.flat())].sort((a, b) => a - b);

/**
 * 距下一个计费时段边界的剩余时间（供卡片显示倒计时）。
 *
 * 与 isPeak 同源同口径（北京时间、工作日、PEAK_WINDOWS 半开区间），只是换一个视图：
 * 返回「下一次 isPeak 结果发生翻转」的时刻。注意空闲时段里的下一次切换**不等于**下一个
 * 整点：
 *   · 12:00–14:00 午休 → 下一次切换是 14:00（高峰开始）；
 *   · 周五 18:00 之后、整个周末 → 下一次切换是下周一 09:00（跨 2 天多）。
 * 因此倒计时必须能显示「天」。
 *
 * 实现：候选时刻就是 BOUNDARY_HOURS 落在各天的那些整点，从今天起逐日枚举、取第一个
 * 让 isPeak 翻转的，因此返回的是**精确**时刻。纯算术，无时区/日历依赖。
 * （旧实现逐分钟探测，返回的 at 最多晚 59.75 秒，倒计时会因此多显示 1m 或
 * 提前进入 switching。）
 *
 * 任何口径变更必须同时改 isPeak / PEAK_WINDOWS / PEAK_WEEKDAYS_ONLY / HOLIDAY_RANGES，
 * 以及 lib/client.js 里为浏览器侧镜像的同名常量（那边无法 import 本模块）。
 *
 * @returns {{ peak: boolean, at: number, ms: number }} peak=切换后所处的时段，
 *   at=切换发生的时刻（ms 时间戳，新时段在此刻生效），ms=剩余毫秒（不会为负）。
 *   找不到切换点时返回 `at: null`——调用方据此判断"不知道"，不要把它当成"此刻"。
 */
export function nextChange(ms, holidays = HOLIDAY_DAYS) {
  const now = Number.isFinite(ms) ? ms : Date.now();
  const current = isPeak(now, holidays);
  const DAY = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  // 北京时间的今天零点
  const dayStart = Date.parse(`${beijingDateKey(now)}T00:00:00Z`) - SHANGHAI_OFFSET_MS;
  // 上限 32 天：远超"长假最后一天 18:00 → 假期后第一个工作日 09:00"的最长空档
  // （2026 年春节假期 9 天，空档 10.7 天）
  for (let day = 0; day < 32; day += 1) {
    const base = dayStart + day * DAY;
    for (const hour of BOUNDARY_HOURS) {
      const at = base + hour * hourMs;
      if (at <= now) continue;
      const peak = isPeak(at, holidays);
      if (peak !== current) return { peak, at, ms: at - now };
    }
  }
  // 理论上不可达（不变量：一个月内必有工作日整点边界）。返回 at:null 而不是 now，
  // 否则调用方会显示 switching 并永久卡住。
  return { peak: !current, at: null, ms: 0 };
}

/**
 * 是否是 DeepSeek 官方路由上的官方模型（官方价格表与峰谷时段只对它们成立）。
 *
 * 两道条件缺一不可：
 *   1. provider 是官方两条路由之一（见 OFFICIAL_PROVIDERS）。Qwen token-plan、
 *      NVIDIA、opencode、workbuddy 这些第三方路由上都有 `deepseek-*` 同名模型，
 *      它们按各自的计价规则扣费，用官方表算出来的数字与账单无关。
 *   2. 模型名以 `deepseek-` / `deepseek.` 开头，排除同一路由下的其它模型。
 *
 * provider 缺失（旧宿主、路由未上报）时按非官方处理：宁可隐藏，也不显示错价。
 */
export function isOfficialModel(model, provider) {
  if (typeof provider !== 'string' || !OFFICIAL_PROVIDERS.includes(provider.trim().toLowerCase())) return false;
  return typeof model === 'string' && /^deepseek[-.]/i.test(model.trim());
}

const has = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

/** 别名（旧名 → 现名）。 */
function aliasOf(id) {
  if (typeof id !== 'string' || id === '') return undefined;
  return MODEL_ALIASES[id];
}

/** 在价格表里找模型：精确 → 别名。表里没有就是不知道，不做家族猜测。 */
function lookupId(id) {
  if (typeof id !== 'string' || id === '') return null;
  const key = id.trim().toLowerCase();
  if (has(PRICE_TABLE, key)) return { id: key, via: 'exact' };
  const alias = aliasOf(key);
  if (alias && has(PRICE_TABLE, alias)) return { id: alias, via: 'alias' };
  return null;
}

/**
 * 解析模型的计价条目：精确 → 别名 → chat 档兜底（known=false）。
 * 非官方模型（见 isOfficialModel）不查表，直接按 known=false 返回，由调用方隐藏
 * 档单价与峰谷指示灯。
 * @returns {{ price: object, id: string, via: 'exact'|'alias'|'fallback', known: boolean }}
 */
function lookup(model, provider) {
  const found = isOfficialModel(model, provider) ? lookupId(model) : null;
  if (found) return { price: PRICE_TABLE[found.id], id: found.id, via: found.via, known: true };
  return { price: PRICE_TABLE['deepseek-chat'], id: 'deepseek-chat', via: 'fallback', known: false };
}

/**
 * 某模型在某一时刻的单位价格（元/百万 tokens）。
 * 非官方模型与不在表里的官方模型都会走 chat 档兜底，但 known=false 会把这件事告诉
 * 调用方：那份兜底价与它们的实际账单无关，界面应隐藏。
 * via 说明取价路径（exact / alias / fallback），供排查与回归测试。
 */
export function unitAt(model, ms, provider, holidays = HOLIDAY_DAYS) {
  const found = lookup(model, provider);
  const p = found.price;
  const tier = isPeak(ms, holidays) ? 0 : 1;
  return {
    input: p.input[tier],
    cacheRead: p.cacheRead[tier],
    cacheWrite: p.cacheWrite,
    output: p.output[tier],
    model: found.id,
    requested: typeof model === 'string' ? model : '',
    provider: typeof provider === 'string' ? provider : '',
    known: found.known,
    via: found.via,
  };
}
