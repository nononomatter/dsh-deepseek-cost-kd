// dsh-deepseek-usage — browser half.
//
// 侧边栏底部用量卡片（注册进 `sidebar.footer.action` 槽位，独占一行，位于
// Cordis 面板按钮下方）。每 30 秒心跳一次：重算倒计时并重新拉取宿主路由
// `/api/kd-deepseek-cost`（见 lib/index.js），因此余额、档单价与峰谷指示灯都随心跳更新，
// 跨过峰谷切换点后最多滞后一次心跳；点击卡片任意位置可立即刷新；还没拿到余额
// （宿主刚重启/接口刚起来）时按 QUICK_RETRY_MS 阶梯快速补几次请求，卡片几秒内收敛。
// 两种形态：
//   · 侧边栏展开——完整卡片：余额（放大显示，符号随币种）+ 当前模型档单价
//     （输入/输入缓存/输出，图标 + 数字，位于卡片右下角）+ 峰谷指示灯（右上角，
//     只有颜色）+ 距下次峰谷切换的倒计时（`2d 15h` / `5h 47m` / `23m`，与指示灯同行、
//     位于其左侧）。
//   · 侧边栏折叠——36px 图标栏里只有峰谷指示灯（见下方 `if (!wide)` 分支）。
//
// 设计约束（用户只关心"我还能花多少、这会儿什么价"）：
//   · 插件的内部信息——取价路径、模型改名、放假日期来源——一律不出现在 UI 上
//     （历史上圆点的 title 里塞过这些，已删除）。
//   · 唯一的交互是「点击卡片刷新」；没有可切换的提示态。
//   · 只有余额类错误（未配置 Key / 余额接口或网络失败）才置空卡片说明原因。
//   · 档单价与峰谷指示灯只对 DeepSeek 官方路由上的官方模型展示（宿主已按 provider
//     过滤）；其他模型不适用官方峰谷定价，整组隐藏，卡片只留余额。
//   · 没有数据时不编数字：余额与单价显示「—」，而不是 0.00 / 0。
// 样式仅使用 `--dsw-*` 主题变量（含兜底值），跟随明暗主题。
window.__ModuleLoader__.load({
	id: "dsh-deepseek-cost-kd",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useCallback, useRef, useMemo } = react;
		const h = react.createElement;

		// ---- constants -------------------------------------------------
		// 卡片心跳：每 30 秒重算一次倒计时并重新取一次数（余额 + 当前档单价）。
		// 峰谷切换也因此不需要额外的检测逻辑——每次心跳都重新取数，切换后最多 30 秒翻正。
		const POLL_MS = 30 * 1000;
		const USAGE_PATH = "/api/kd-deepseek-cost";
		// 本包名：`plugins.detail.section` 是所有插件详情页共用的 slot，靠它认出
		// 自己的页面（见 apply 里的注册）。
		const PACKAGE_NAME = "dsh-deepseek-cost-kd";
		// 放假日期：宿主路由（见 lib/index.js），浏览器启动时读一次，覆盖内置镜像表；
		// 读不到就继续用内置表（两边都是同一份国务院办公厅日期表）。
		const HOLIDAYS_PATH = "/api/kd-deepseek-cost/holidays";
		// 常态卡片高度：上下 padding 8+12 + 金额行 minHeight 28 + 边框 2 = 50。
		// 无头 Chromium 实测常态卡片 50px，异常态用同一个 minHeight 兜住，侧边栏不跳动。
		const CARD_MIN_HEIGHT = 50;
		// 卡片还没拿到余额时的快速重试节奏（宿主刚重启、接口刚起来、或本次请求失败）：
		// 让空卡片在几秒内收敛，而不必等满下一次心跳。
		const QUICK_RETRY_MS = [4000, 8000, 15000, 30000];
		// 宿主错误文案的长度上限：上游异常文本可能很长，卡片高度不应被它撑开。
		const ERROR_MAX_CHARS = 120;

		// ---- i18n（DSH locale 服务；zh 为兜底）----
		// 注意：卡片上只出现「输入 / 输入缓存 / 输出」这三个标签。峰谷灯没有文字、
		// 没有 hover；倒计时统一用英文单位（d/h/m）且不带前缀，中英界面完全一致——
		// 插件内部的取价路径等一概不进 UI。
		const NS = "dsh-deepseek-cost-kd";
		const ZH = {
			"price.input": "输入",
			"price.cache": "输入缓存",
			"price.output": "输出",
			"status.peak": "高峰时段",
			"status.idle": "空闲时段",
			"status.error": "余额读取失败",
			"status.unavailable": "该提供商不支持查询",
			"card.label": "账户用量，点击刷新",
			"card.today": "今日",
			"card.todayTitle": "今日消费（DSH 本机，按峰谷价逐次累加）",
			"card.todayPartial": "，不含价格表未收录的模型",
			"accounts.title": "余额与用量查询状态",
			"accounts.intro": "当前 DSH 里已配置的模型提供商，哪些能查到余额或订阅用量。",
			"accounts.refresh": "刷新",
			"accounts.empty": "没有可显示的提供商。",
			"accounts.unavailable": "无法读取已配置的提供商列表。",
			"accounts.current": "当前",
			"accounts.kind.balance": "余额",
			"accounts.kind.usage": "订阅用量",
			"accounts.kind.oauth": "订阅余量（OAuth）",
			"accounts.status.ok": "可查询",
			"accounts.status.noKey": "未配置密钥",
			"accounts.status.noToken": "未填写令牌",
			"accounts.status.error": "查询失败",
			"accounts.status.unsupported": "不适用",
			"accounts.status.pending": "查询中…",
			"accounts.window.5h": "5 小时",
			"accounts.window.7d": "7 天",
			"accounts.window.30d": "30 天",
			"accounts.window.cycle": "当前周期",
			"accounts.reason.oauthOnly": "只有 OAuth 订阅令牌可读，本插件不支持",
			"accounts.reason.cloudAuthOnly": "需要云厂商 AK/SK 签名，本插件不支持",
			"accounts.reason.unsupported": "没有可用的查询接口",
			"accounts.gateway": "经第三方网关访问的模型按网关规则计费，厂商接口反映的是你自己的账户，与网关消耗无关。",
			"token.title": "订阅令牌",
			"token.intro": "粘贴 Claude Code / Codex 的 OAuth 令牌后，卡片与上面的提供商卡片就能显示订阅余量。令牌只保存在本机凭据里，不会离开这台机器。",
			"token.placeholder": "粘贴 OAuth 令牌",
			"token.accountPlaceholder": "账号 ID（可选，Codex 的 ChatGPT-Account-Id）",
			"token.save": "保存",
			"token.clear": "清除",
			"token.configured": "已填写",
			"token.missing": "未填写",
			"token.saved": "已保存",
			"token.cleared": "已清除",
			"token.failed": "保存失败",
			"token.source.claude": "在装有 Claude Code 的机器上运行 claude setup-token 之外的登录流程：从 ~/.claude/.credentials.json 的 claudeAiOauth.accessToken 复制（macOS 在钥匙串 Claude Code-credentials 里）。setup-token 产的令牌只能读 5 小时与 7 天两个窗口。",
			"token.source.codex": "从 ~/.codex/auth.json 的 tokens.access_token 复制，并把 tokens.account_id 填进账号 ID 一栏。",
		};
		const EN = {
			"price.input": "Input",
			"price.cache": "Input cache",
			"price.output": "Output",
			"status.peak": "Peak hours",
			"status.idle": "Off-peak hours",
			"status.error": "Balance unavailable",
			"status.unavailable": "This provider has no query API",
			"card.label": "Account usage, click to refresh",
			"card.today": "Today",
			"card.todayTitle": "Today's spend (this DSH, priced per call at peak/off-peak rates)",
			"card.todayPartial": ", excluding models with no known price",
			"accounts.title": "Balance & usage query status",
			"accounts.intro": "Which of the model providers configured in DSH can report a balance or subscription usage.",
			"accounts.refresh": "Refresh",
			"accounts.empty": "No providers to show.",
			"accounts.unavailable": "The configured provider list could not be read.",
			"accounts.current": "Current",
			"accounts.kind.balance": "Balance",
			"accounts.kind.usage": "Subscription usage",
			"accounts.kind.oauth": "Subscription quota (OAuth)",
			"accounts.status.ok": "Queryable",
			"accounts.status.noKey": "No API key",
			"accounts.status.noToken": "No token",
			"accounts.status.error": "Query failed",
			"accounts.status.unsupported": "Not applicable",
			"accounts.status.pending": "Querying…",
			"accounts.window.5h": "5-hour",
			"accounts.window.7d": "7-day",
			"accounts.window.30d": "30-day",
			"accounts.window.cycle": "Current cycle",
			"accounts.reason.oauthOnly": "Readable only with an OAuth subscription token, which this plugin does not use",
			"accounts.reason.cloudAuthOnly": "Needs a cloud-provider AK/SK signature, which this plugin does not use",
			"accounts.reason.unsupported": "No query API available",
			"accounts.gateway": "Models reached through a third-party gateway are billed by that gateway; a vendor API reports your own account, not the gateway spend.",
			"token.title": "Subscription token",
			"token.intro": "Paste a Claude Code or Codex OAuth token and the card plus the provider cards above start reporting subscription quota. The token stays in this machine's credential store and never leaves it.",
			"token.placeholder": "Paste the OAuth token",
			"token.accountPlaceholder": "Account ID (optional, Codex's ChatGPT-Account-Id)",
			"token.save": "Save",
			"token.clear": "Clear",
			"token.configured": "Saved",
			"token.missing": "Not saved",
			"token.saved": "Saved",
			"token.cleared": "Cleared",
			"token.failed": "Could not save",
			"token.source.claude": "On a machine signed in to Claude Code, copy claudeAiOauth.accessToken from ~/.claude/.credentials.json (on macOS: the Claude Code-credentials keychain item). A claude setup-token token reads the 5-hour and 7-day windows only.",
			"token.source.codex": "Copy tokens.access_token from ~/.codex/auth.json and put tokens.account_id in the account ID field.",
		};

		// ---- 倒计时文案（语言无关，故不进词典）----
		const SWITCHING = "switching";

		// ---- 峰谷规则（必须与 lib/pricing.js 的 isPeak / PEAK_WINDOWS /
		// PEAK_WEEKDAYS_ONLY / HOLIDAY_RANGES 保持一致；浏览器侧无法 import 宿主模块，
		// 只能镜像。2026 年起官方口径：法定节假日全天、调休上班的周末都是空闲时段，
		// 所以放假日期必须一起镜像，否则中秋/国庆白天会被误显示成高峰价）----
		const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
		const PEAK_WINDOWS = [[9, 12], [14, 18]];
		const PEAK_WEEKDAYS_ONLY = true;
		/** 可能的切换时刻（北京时间整点）：高峰窗口的起止整点，nextChange 逐日枚举它们。 */
		const BOUNDARY_HOURS = [...new Set(PEAK_WINDOWS.flat())].sort((a, b) => a - b);
		// 放假日期（含起止，闭区间）：国务院办公厅 2026 年节假日安排。
		const HOLIDAY_RANGES = [
			['2026-01-01', '2026-01-03'],
			['2026-02-15', '2026-02-23'],
			['2026-04-04', '2026-04-06'],
			['2026-05-01', '2026-05-05'],
			['2026-06-19', '2026-06-21'],
			['2026-09-25', '2026-09-27'],
			['2026-10-01', '2026-10-07'],
		];
		const DAY_MS = 24 * 60 * 60 * 1000;

		/** 把 [起, 止] 闭区间展开成日期键集合（`yyyy-mm-dd`）。 */
		function expandHolidayRanges(ranges) {
			const set = new Set();
			for (const [from, to] of ranges) {
				if (typeof from !== "string" || typeof to !== "string") continue;
				if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
				const start = Date.parse(from + 'T00:00:00Z');
				const end = Date.parse(to + 'T00:00:00Z');
				if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
				// 解析结果必须与输入同一天，否则输入本身不是合法日期（已滚动到别的日子）。
				if (new Date(start).toISOString().slice(0, 10) !== from) continue;
				if (new Date(end).toISOString().slice(0, 10) !== to) continue;
				for (let t = start; t <= end; t += DAY_MS) set.add(new Date(t).toISOString().slice(0, 10));
			}
			return set;
		}

		/** 内置镜像表：宿主不可达时的兜底，也是 isPeak/nextChange 的缺省集合。 */
		const BUILTIN_HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

		/** 该时刻所在北京时间日历日是否为法定节假日（放假日期）。 */
		function isHoliday(ms, days) {
			return days.has(new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10));
		}

		/**
		 * 某时刻是否为高峰时段（按北京时间；节假日全天与周末恒为空闲）。与 lib/pricing.js 的 isPeak 等价。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 isPeak 同一口径。
		 */
		function isPeak(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			if (isHoliday(now, days)) return false;
			const d = new Date(now + SHANGHAI_OFFSET_MS);
			if (PEAK_WEEKDAYS_ONLY) {
				const dow = d.getUTCDay();
				if (dow === 0 || dow === 6) return false;
			}
			const h = d.getUTCHours();
			return PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
		}

		/**
		 * 距下一个计费时段边界的剩余时间；与 lib/pricing.js 的 nextChange 等价。
		 * 候选时刻是 PEAK_WINDOWS 起止整点落在各天的那些点，逐日枚举取第一个让 isPeak
		 * 翻转的，因此返回精确时刻（上限 32 天，覆盖春节长假 → 假期后首个工作日早晨）。
		 * 找不到切换点时 at 为 null——调用方据此显示「—」，不要当成"此刻在切换"。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 nextChange 同一口径。
		 */
		function nextChange(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			const current = isPeak(now, days);
			const hourMs = 60 * 60 * 1000;
			const dayStart = Date.parse(new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10) + 'T00:00:00Z') - SHANGHAI_OFFSET_MS;
			for (let day = 0; day < 32; day += 1) {
				const base = dayStart + day * DAY_MS;
				for (const hour of BOUNDARY_HOURS) {
					const at = base + hour * hourMs;
					if (at <= now) continue;
					const peak = isPeak(at, days);
					if (peak !== current) return { peak, at, ms: at - now };
				}
			}
			return { peak: !current, at: null, ms: 0 };
		}

		/** m/h/d 三档短标签（语言无关）。 */
		const _u = (v, u) => `${v}${u}`;

		/**
		 * 剩余毫秒 → 英文单位时长，最多两级：`2d 15h` / `5h 47m` / `23m` / `switching`。
		 * 不足 1 分钟显示 `switching`。向下取整，避免"还剩 59 秒却显示 1m"的反向偏差。
		 */
		function fmtCountdown(ms) {
			const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 60000));
			const days = Math.floor(total / 1440);
			const hours = Math.floor((total % 1440) / 60);
			const minutes = total % 60;
			if (days > 0) return _u(days, "d") + " " + _u(hours, "h");
			if (hours > 0) return _u(hours, "h") + " " + _u(minutes, "m");
			return minutes > 0 ? _u(minutes, "m") : SWITCHING;
		}

		/**
		 * 金额 → 两位小数字符串。
		 * null / undefined / 空串都表示"没有拿到"，显示「—」：Number(null) 是 0，
		 * 直接转换会把"读不到余额"显示成"余额 0 元"。
		 */
		function money(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return n.toFixed(2);
		}

		/** 单价 → 去掉多余尾零的字符串；同样把"没有值"显示成「—」。 */
		function fmtPrice(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(parseFloat(n.toFixed(2)));
		}

		/** 币种 → 符号。未知币种显示代码本身（如 HKD 10.00），不假装成人民币。 */
		function currencySymbol(currency) {
			if (typeof currency !== "string" || currency === "") return "¥";
			const code = currency.trim().toUpperCase();
			if (code === "CNY" || code === "RMB") return "¥";
			if (code === "USD") return "$";
			if (code === "EUR") return "€";
			if (code === "JPY") return "¥";
			if (code === "GBP") return "£";
			return code + " ";
		}

		/**
		 * 账户读数 → 卡片金额行要显示的两截：符号 + 数值。
		 *
		 * 三种 kind：
		 *   · balance —— 币种符号 + 金额（`¥` / `$`，金额缺失时显示「—」）；
		 *   · usage / oauth —— 窗口标签 + 已用百分比（最紧的窗口：百分比最高者）；
		 *   · 拿不到 —— 都是「—」，绝不显示 0.00 或 0%（那是"读到了 0"的意思）。
		 *
		 * @param kind     provider.kind
		 * @param account  { balance, usage }
		 * @param t        本地化函数（窗口标签需要它）
		 * @returns {{ symbol: string, value: string }}
		 */
		function accountLead(kind, account, t) {
			if (kind === "balance") {
				const balance = account && account.balance ? account.balance : null;
				return {
					symbol: currencySymbol(balance ? balance.currency : ""),
					value: money(balance ? balance.total : null),
				};
			}
			if (kind === "usage" || kind === "oauth") {
				const usage = account && account.usage ? account.usage : null;
				const windows = usage && Array.isArray(usage.windows) ? usage.windows : [];
				// 取已用百分比最高的窗口：它最先撞限，是用户最该看到的那个。
				let best = null;
				for (const w of windows) {
					if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) continue;
					if (best === null || w.percent > best.percent) best = w;
				}
				if (best === null) return { symbol: "", value: "—" };
				return {
					symbol: (t && t("accounts.window." + best.key)) || best.key,
					value: percentText(best.percent),
				};
			}
			return { symbol: "", value: "—" };
		}

		/**
		 * 百分比 → 整数字符串。null / 非数字是"没读到"，显示「—」而不是 0%
		 * （0% 是一个真实读数，含义完全相反）。
		 */
		function percentText(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(Math.round(n)) + "%";
		}

		// 主题变量（带兜底值）
		const C = {
			bg: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))",
			border: "var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
			label: "var(--dsw-alias-label-primary, #111)",
			sub: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
			err: "var(--dsw-alias-state-error-primary, rgb(200,40,40))",
			peak: "var(--dsw-alias-state-warn-primary, rgb(230,120,0))",
			idle: "var(--dsw-alias-state-success-primary, rgb(34,160,80))",
			muted: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.35))",
			// 今日消费的蓝色：用 DSH 自己的链接色 token（亮色 #4176e6 / 暗色自动换成
			// deepseek-400），不写死色值，免得在暗色主题下发灰。
			link: "var(--dsw-alias-link, #4176e6)",
		};

		const svgBase = {
			width: 12,
			height: 12,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2.2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			style: { flex: "none", display: "block" },
		};
		// 输入：右箭头指向右边界（→|，数据进入边界）
		const IconIn = () => h("svg", svgBase,
			h("path", { d: "M20 4v16" }),
			h("path", { d: "M20 12H6" }),
			h("path", { d: "M10 7l5 5-5 5" }));
		// 输出：左边界发出右箭头（|→，数据从边界流出）
		const IconOut = () => h("svg", svgBase,
			h("path", { d: "M4 4v16" }),
			h("path", { d: "M4 12h14" }),
			h("path", { d: "M14 7l5 5-5 5" }));
		// 缓存：闪电（缓存命中，快）
		const IconCache = () => h("svg", svgBase,
			h("path", { d: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" }));
		// 硬币：侧边栏放不下「¥ + 余额 + 今日消费」时，替掉 ¥ 符号。
		// 币面上仍是 ¥ 的笔画（竖 + 两撇 + 一横），所以"这是钱"的读法不变，
		// 只把 20px 的文字位压成 14px 的图形位。
		const IconCoin = () => h("svg", { ...svgBase, width: 14, height: 14 },
			h("circle", { cx: 12, cy: 12, r: 9 }),
			h("path", { d: "M12 7.4v9.2" }),
			h("path", { d: "M8.6 10 12 13 15.4 10" }),
			h("path", { d: "M8.6 15.2h6.8" }));

		// ---- the widget -------------------------------------------------
		function UsageCell(props) {
			const ctx = props.ctx;
			const wide = !!props.wide;
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			// 倒计时走字用的心跳：每 30 秒 bump 一次，渲染时按当前时刻重算剩余时间。
			const [tick, setTick] = useState(0);
			const [holidayRanges, setHolidayRanges] = useState(() => HOLIDAY_RANGES);
			// 放假日期表：组件实例自己的集合（不做成模块级可变对象——同一页面挂两个实例
			// 时会互相覆盖，峰谷判定会无声翻转）。
			const holidayDays = useMemo(() => expandHolidayRanges(holidayRanges), [holidayRanges]);
			const mounted = useRef(true);
			// 请求序号：只有最后一次请求的结果可以写进 state。心跳、点击、设置事件
			// 会并发触发 load()，慢的旧响应回来得更晚，会把新数据盖掉。
			const requestSeq = useRef(0);
			// 快速重试：阶梯下标 + 定时器（宿主刚起来、余额接口还没返回时，几秒后自己再看一眼）。
			const retryStep = useRef(0);
			const retryTimer = useRef(null);
			// 页面可见性：后台标签页不做心跳（宿主每次都会真打一次官方余额接口）。
			const visible = useRef(typeof document === "undefined" || document.visibilityState !== "hidden");
			const locale = ctx && ctx.locale;
			// 卡片的实际可用宽度（contentRect，已扣掉边框与内边距）。
			// 余额与今日消费两个 24px 数字要不要并排、¥ 要不要换成硬币图标，由它决定——
			// 侧边栏可拖宽、中英文标签长度也不同，写死阈值不比实测准。
			// 用 callback ref 而不是 useRef：卡片首次渲染时数据还没到，元素可能后挂上来。
			const [cardEl, setCardEl] = useState(null);
			const [cardWidth, setCardWidth] = useState(0);
			useEffect(() => {
				if (!cardEl || typeof ResizeObserver === "undefined") return;
				const observer = new ResizeObserver((records) => {
					for (const record of records) {
						const width = Math.round(record.contentRect.width);
						setCardWidth((prev) => (prev === width ? prev : width));
					}
				});
				observer.observe(cardEl);
				return () => observer.disconnect();
			}, [cardEl]);

			// 订阅语言变化（DSH locale 服务；不可用时回退中文）。
			// 回退快照必须是同一个对象：每次调用返回新对象会让 useSyncExternalStore
			// 认为快照一直在变，触发无限重渲染。
			const FALLBACK_LOCALE_SNAPSHOT = { active: "zh", locales: [], revision: 0 };
			const lcSnap = react.useSyncExternalStore(
				(cb) => (locale && typeof locale.subscribe === "function" ? locale.subscribe(cb) : () => {}),
				() => (locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : FALLBACK_LOCALE_SNAPSHOT),
			);
			const lang = lcSnap && lcSnap.active === "en" ? "en" : "zh";
			// locale.bind(ns) 返回绑定命名空间的翻译函数；不可用时回退中文词典。
			const boundT = locale && typeof locale.bind === "function" ? locale.bind(NS) : null;
			const t = (key) => {
				try {
					if (boundT) {
						const v = boundT(key);
						if (typeof v === "string" && v !== key) return v;
					}
				} catch (e) { /* 词典不可用，回退中文 */ }
				return ZH[key] || key;
			};

			// 宿主还在后台忙（重启后首次余额、接口刚起来）时按 QUICK_RETRY_MS 阶梯补几次请求，
			// 让卡片几秒内收敛，不必等下一次心跳（POLL_MS）。失败同样按此节奏重试。
			// 判断依据只看"有没有拿到余额"，不依赖宿主内部字段。
			const cancelRetry = useCallback(() => {
				if (retryTimer.current !== null) {
					clearTimeout(retryTimer.current);
					retryTimer.current = null;
				}
			}, []);

			// 语言放进 ref：load 的身份不随语言变化，切中英文时不会重建心跳定时器、
			// 也不会让旧语言的在途请求回填到新语言的界面上。
			const langRef = useRef(lang);
			langRef.current = lang;

			// loadRef 让下面两个回调可以互相引用而不必谁先声明。
			const loadRef = useRef(null);

			/** 按 QUICK_RETRY_MS 阶梯安排一次补请求（用 ref 记录进度；卸载时清理）。 */
			const scheduleRetry = useCallback(() => {
				if (!mounted.current) return;
				const delay = QUICK_RETRY_MS[retryStep.current];
				if (delay === undefined) return;
				retryStep.current += 1;
				cancelRetry();
				retryTimer.current = setTimeout(() => {
					retryTimer.current = null;
					const run = loadRef.current;
					if (run) run();
				}, delay);
			}, [cancelRetry]);

			const load = useCallback(async () => {
				const seq = ++requestSeq.current;
				try {
					const res = await fetch(USAGE_PATH + "?lang=" + langRef.current, { cache: "no-store" });
					let body = null;
					try {
						body = await res.json();
					} catch (e) {
						body = null;
					}
					if (!res.ok || body === null || typeof body !== "object" || body.ok !== true) {
						// 失败原因优先用宿主给的文案（未配置 Key / 余额接口异常，用户看得懂）；
						// 拿不到就用一句人话兜底——不把 HTTP 状态码这类传输细节摆到卡片上。
						throw new Error(body && typeof body.message === "string" && body.message !== "" ? body.message : "刷新失败，请稍后重试");
					}
					// 过期响应直接丢弃：晚到的旧结果不能盖掉新数据，也不能把刚填好的
					// 余额整个抹成错误态。
					if (!mounted.current || seq !== requestSeq.current) return;
					setData(body);
					setError("");
					// 成功即取消待发的补请求并复位阶梯，否则上一次失败排下的定时器会
					// 在几秒后再打一发，可能把这份好数据换成错误态。
					cancelRetry();
					retryStep.current = 0;
				} catch (e) {
					if (!mounted.current || seq !== requestSeq.current) return;
					const message = e instanceof Error ? e.message : String(e);
					setError(message.length > ERROR_MAX_CHARS ? message.slice(0, ERROR_MAX_CHARS) + "…" : message);
					scheduleRetry();
				}
			}, [cancelRetry, scheduleRetry]);

			loadRef.current = load;

			useEffect(() => {
				mounted.current = true;
				load();
				// 模型切换（写入 settings 触发 document-updated）时立即刷新，单价跟着变。
				let off = null;
				try {
					if (ctx && ctx.remote && typeof ctx.remote.$on === "function") {
						off = ctx.remote.$on("settings/document-updated", () => {
							load().catch(() => {});
						});
					}
				} catch (e) {
					off = null;
				}
				return () => {
					mounted.current = false;
					cancelRetry();
					try {
						if (typeof off === "function") off();
					} catch (e) { /* 忽略退订错误 */ }
				};
			}, [load, ctx, cancelRetry]);

			// ---- 放假日期表（宿主是唯一权威：启动时拉一次，只用于本地兜底计算）----
			// 浏览器侧必须镜像峰谷规则（无法 import 宿主模块），放假日期也就不该各写一份，
			// 否则放假那几天两边会算出不同结果。这里用组件自己的 holidayDays 集合，
			// 宿主返回的表覆盖内置镜像。
			useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch(HOLIDAYS_PATH, { cache: "no-store" });
						let body = null;
						try { body = await res.json(); } catch (e) { body = null; }
						if (cancelled || !res.ok || !body || body.ok !== true) return;
						if (Array.isArray(body.ranges) && body.ranges.length > 0) setHolidayRanges(body.ranges);
					} catch (e) { /* 读不到就用内置表继续 */ }
				})();
				return () => { cancelled = true; };
			}, []);

			// 页面可见性：隐藏时停心跳，回到前台补一次。
			useEffect(() => {
				if (typeof document === "undefined") return;
				const onChange = () => {
					visible.current = document.visibilityState !== "hidden";
					if (visible.current) load().catch(() => {});
				};
				document.addEventListener("visibilitychange", onChange);
				return () => document.removeEventListener("visibilitychange", onChange);
			}, [load]);

			// 心跳：每 POLL_MS 重算一次倒计时（setTick 触发重渲染）并重新取一次数。
			// 取数会带回最新的余额、峰谷状态与档单价，所以跨过峰谷切换点后单价与指示灯
			// 最多滞后一次心跳——不需要单独检测切换时刻。页面隐藏时不发请求。
			useEffect(() => {
				const timer = setInterval(() => {
					setTick((v) => v + 1);
					if (!visible.current) return;
					load().catch(() => {});
				}, POLL_MS);
				return () => clearInterval(timer);
			}, [load]);

			const tier = data && data.tier ? data.tier : null;
			// 当前 provider 的查询能力：balance 显示金额，usage/oauth 显示最紧窗口的
			// 已用百分比，none 表示这个 provider 没有可查的接口（卡片置空说明原因）。
			const kind = data && data.provider && typeof data.provider.kind === "string" ? data.provider.kind : "balance";
			const lead = accountLead(kind, data, t);
			const symbol = lead.symbol;
			const amount = lead.value;
			// 【本机改版】今日消费：只有余额型提供商才和"钱"并排显示；
			// 订阅制（usage/oauth）的读数是一个百分比，旁边再挂一个金额只会让人误读。
			// 宿主没给（读日志失败）就是 null——不显示，绝不显示 0.00。
			const todayInfo = data && data.today && typeof data.today === "object" ? data.today : null;
			const todayCost =
				kind === "balance" && todayInfo && Number.isFinite(Number(todayInfo.cost)) ? Number(todayInfo.cost) : null;
			// 宽度分两档：宽档「¥ 123.45  今日 3.89」，窄档「(硬币) 123.45 今日 3.89」。
			// 200px 是按 24px 字号实测算下来的：¥+7 位小数金额+「今日」+同字号金额 ≈ 183px，
			// 留一点余量。未测到宽度（首帧）先按窄档画，宁可先挤一点也不要溢出。
			const roomy = cardWidth >= 200;
			// 档单价与峰谷指示灯只对官方路由上的官方模型有意义：宿主已按 provider 过滤，
			// known=false 表示"这个模型的价格插件不知道"，档单价与峰谷都无从展示。
			// 数据还没到（tier 为 null）时同样不显示——宁可少显示，也不要显示 0。
			const priced = !!tier && tier.known !== false;
			// 卡片只显示"用户要的数字"：账户读数、当前档单价、状态圆点、距下次切换的倒计时。
			// 插件的内部信息（取价路径、模型改名）一律不进 UI，
			// 唯一的交互是点击卡片刷新。只有"账户类错误"（未配置密钥 / 接口或网络失败 /
			// 该 provider 没有可查接口）才把卡片置空并说明原因——否则读数是空的，
			// 用户无从判断。
			const errs = (Array.isArray(data && data.errors) ? data.errors : []).concat(error ? [error] : []);
			const blanked = errs.length > 0;
			// 每次渲染都以"当前时刻"求剩余时间；tick 每 30 秒 bump 一次触发这次重算。
			const nowMs = Date.now();
			const nextAt = (() => {
				const raw = data && data.next ? Number(data.next.at) : NaN;
				// 宿主给的切换时刻必须还在将来：旧响应或时钟漂移会让它落在过去，
				// 那样倒计时会卡在 switching。
				if (Number.isFinite(raw) && raw > nowMs) return raw;
				const age = data && Number(data.updatedAt) > 0 ? Math.max(0, nowMs - Number(data.updatedAt)) : 0;
				const local = nextChange(nowMs - age, holidayDays);
				return local.at !== null && local.at > nowMs ? local.at : null;
			})();
			void tick; // tick 只用来触发重渲染，值本身不参与计算
			const countdown = nextAt === null ? "—" : fmtCountdown(nextAt - nowMs);
			const dot = {
				width: 8,
				height: 8,
				borderRadius: "50%",
				flex: "none",
				background: data ? (data.peak ? C.peak : C.idle) : C.muted,
				boxShadow: "0 0 4px rgba(0,0,0,.3)",
			};
			// 圆点自身没有任何 hover（历史上的 title 里塞了价格表路径等内部信息，
			// 对用户毫无意义，已删除）；它只表达"现在是高峰还是空闲"，切换时刻由旁边的
			// 倒计时承担。
			// 点击卡片：唯一动作 = 刷新。
			const onCardClick = () => {
				load().catch(() => {});
			};

			// 订阅用量形态下 symbol 是窗口标签（如「5 小时」），字号随正文，
			// 不再用 24px 的货币符号尺寸——标签比符号长，放大后会挤掉百分比。
			const usageLead = kind === "usage" || kind === "oauth";
			const leadStyle = usageLead
				? { fontWeight: 600, fontSize: 12, color: C.sub, lineHeight: "28px", marginRight: 1, flex: "none", whiteSpace: "nowrap" }
				: { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px", marginRight: 3, flex: "none" };
			const amountStyle = { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

			// 折叠态（图标栏）：内容宽 36px（侧边栏 56px − 折叠态左右各 10px 内边距），
			// 只容得下峰谷指示灯，没有外框也没有底色（直接坐在侧边栏背景上）。
			// 指示灯仍是"点击刷新"的落点。
			// 渲染条件：这个 provider 有可查的账户接口（kind 不是 none），或已经报了真错误。
			// 二者都不成立时这个栏里没有任何有意义的内容，整块不渲染。
			// 账户读不到时圆点用错误色——绿灯会被读成"一切正常"；但 `kind === 'none'`
			// 不是错误（插件本就不查它），那种情况用中性灰点。
			if (!wide) {
				if (kind === "none" && !blanked) return null;
				const failed = blanked && kind !== "none";
				const neutral = kind === "none";
				return h("div", {
					style: {
						boxSizing: "border-box",
						flex: "none",
						padding: "4px 8px",
						cursor: "pointer",
						display: "flex",
						flexDirection: "row",
						alignItems: "center",
						userSelect: "none",
					},
					role: "button",
					tabIndex: 0,
					"aria-label": t("card.label"),
					onClick: () => load().catch(() => {}),
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							load().catch(() => {});
						}
					},
				}, h("span", {
					style: { ...dot, background: failed ? C.err : (neutral ? C.muted : dot.background) },
					role: "img",
					"aria-label": failed
						? t("status.error")
						: (neutral
							? t("status.unavailable")
							: (data && data.peak ? t("status.peak") : t("status.idle"))),
				}));
			}

			// 只有"账户类错误"（未配置密钥 / 接口或网络失败 / 该 provider 没有可查
			// 接口）才走到这里：卡片置空、只显示原因文字，不画读数/单价/圆点/倒计时。
			// minHeight 兜住常态卡片高度（CARD_MIN_HEIGHT），侧边栏不跳动；
			// 文字多行时卡片自然变高。
			// 注意：这里不显示任何插件内部信息（取价路径、放假日期来源），历史上那批
			// 良性提示已随"去技术化"一起删除。
			// 折叠态（!wide）早在上面就返回了：它只有峰谷指示灯，没有文字空间。
			if (blanked) {
				// 配色分流：`kind === 'none'` 不是错误——本插件就没打算查这个提供商，
				// 用户的账户没有任何问题。把它标红会让人以为出故障了，所以用常规
				// 次要文字色陈述事实；只有真去查过并失败（网络/认证/形状不认）才用红色。
				const unsupported = kind === "none";
				return h("div", {
					style: {
						boxSizing: "border-box",
						flex: "1 1 100%",
						minWidth: 0,
						minHeight: CARD_MIN_HEIGHT,
						padding: "8px 10px",
						borderRadius: 10,
						border: "1px solid " + C.border,
						background: C.bg,
						color: C.label,
						cursor: "pointer",
						userSelect: "none",
						display: "flex",
						flexDirection: "column",
						justifyContent: "center",
						gap: 3,
						marginTop: 4,
						fontSize: "12px",
						lineHeight: "15px",
					},
					role: "button",
					tabIndex: 0,
					"aria-label": t("card.label"),
					onClick: onCardClick,
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onCardClick();
						}
					},
				},
					h("div", {
						style: {
							color: unsupported ? C.sub : C.err,
							fontSize: 12,
							lineHeight: "16px",
							whiteSpace: "pre-wrap",
							overflowWrap: "anywhere",
						},
					}, errs.join(" | ")));
			}

			// 今日消费：蓝色、与余额同字号（24px / 700），紧贴余额右侧。
			// 宿主标 complete=false（有模型不在价格表里）时，在 title 里写明"不含"，不悄悄少算。
			const todayNode = todayCost === null ? null : h("span", {
				style: {
					display: "inline-flex",
					alignItems: "baseline",
					gap: roomy ? 4 : 3,
					minWidth: 0,
					flex: "0 0 auto",
					// 靠右：auto 左外边距把这一组推到顶行最右侧，与左侧余额分开站。
					// 侧边栏压窄时 auto 先被吃掉，两组贴在一起但都不压缩。
					marginLeft: "auto",
					color: C.link,
				},
				title:
					todayInfo && todayInfo.complete === false
						? t("card.todayTitle") + t("card.todayPartial")
						: t("card.todayTitle"),
			},
				h("span", {
					style: { fontSize: roomy ? 11 : 10, fontWeight: 600, lineHeight: "28px", opacity: 0.9, flex: "none" },
				}, t("card.today")),
				h("span", {
					style: {
						fontWeight: 700,
						fontSize: 24,
						lineHeight: "28px",
						minWidth: 0,
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
					},
				}, money(todayCost)));

			const Price = (icon, label, value) =>
				h("span", { style: { display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0, color: C.sub, whiteSpace: "nowrap" } },
					h("span", { style: { display: "inline-flex", alignItems: "center" }, title: label, "aria-hidden": "true" }, icon),
					h("span", { style: { fontWeight: 600 } }, fmtPrice(value)));

			return h("div", {
				style: {
					boxSizing: "border-box",
					flex: "1 1 100%",
					minWidth: 0,
					// 上 8 下 10。顶部保持 8px 不动，圆点才能继续紧贴右上角。
					// 下内边距 10 是单价行自己那行的呼吸空间。
					padding: "8px 10px 10px",
					borderRadius: 10,
					border: "1px solid " + C.border,
					background: C.bg,
					color: C.label,
					cursor: "pointer",
					userSelect: "none",
					display: "flex",
					flexDirection: "column",
					gap: 2,
					marginTop: 4,
					position: "relative",
					fontSize: "12px",
					lineHeight: "15px",
				},
				role: "button",
				tabIndex: 0,
				ref: setCardEl,
				"aria-label": t("card.label"),
				onClick: onCardClick,
				onKeyDown: (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onCardClick();
					}
				},
			},
				// 金额行：只有钱——账户读数 +（本机改版）今日消费。
				// 倒计时与峰谷灯已挪到下面那一行（见底行注释）：侧边栏压到最窄时，
				// 顶行再挂一个倒计时会把这两个数字挤扁，而钱比倒计时重要。
				// 今日消费 flex:0 0 auto 永不压缩；余额可截断（它是"还剩多少"，
				// 位数多了截一位仍能看出量级；今日消费被截则等于没有这个数）。
				h("div", { style: { display: "flex", alignItems: "baseline", minHeight: 28, minWidth: 0, gap: 6 } },
					// 窄档把 ¥ 换成硬币图标（图形位 14px，省下的宽度留给两个数字）；
					// 宽档保留币种符号——符号本身是可读的信息，非到放不下不该丢。
					kind === "balance" && !roomy && symbol !== ""
						? h("span",
							{ style: { display: "inline-flex", alignItems: "center", color: C.sub, flex: "none" }, title: symbol, "aria-label": symbol },
							h(IconCoin, null))
						: h("span", { style: leadStyle }, symbol),
					h("span", { style: amountStyle }, amount),
					todayNode),
				// 底行：左边「峰谷灯 + 倒计时」，右边「当前档单价」。
				// 倒计时原来在顶行右侧，侧边栏压到最窄时会把余额与今日消费挤扁；
				// 挪到底行后顶行整行留给钱，两行各管一件事：
				//   顶行 = 现在有多少（余额 + 今日消费）
				//   底行 = 现在什么价（距下次档位切换 + 输入/缓存/输出）
				// 左对齐 vs 右对齐用 space-between，两侧各自 flex:none，中间倒计时可截断。
				// 非官方模型时整行不渲染（内置价格表算出的数字与它们的实际账单无关）。
				// marginTop:-10 把这一行提到金额行下方的空档里，卡片高度与原来一致。
				priced && h("div", {
					style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0, marginTop: -10 },
				},
					// 左：峰谷灯 + 倒计时（`2d 15h` / `5h 47m` / `23m` / `switching`）。
					// 纯英文单位、无前缀，中英界面一致。
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, flex: "1 1 auto" } },
						h("span", { style: dot, role: "img", "aria-label": data && data.peak ? t("status.peak") : t("status.idle") }),
						h("span", {
							style: {
								fontWeight: 600,
								color: C.sub,
								minWidth: 0,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							},
						}, countdown)),
					// 右：当前档单价，恒靠右，不参与压缩。
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, flex: "0 0 auto" } },
						Price(h(IconIn, null), t("price.input"), tier.input),
						Price(h(IconCache, null), t("price.cache"), tier.cacheRead),
						Price(h(IconOut, null), t("price.output"), tier.output))));
		}

		// ---- 插件页：余额与用量查询状态 ----------------------------------
		// 渲染在 Plugins 面板的本 bundle 详情页（plugins.detail.section）。
		// 内容来自宿主的 GET /api/kd-deepseek-cost/accounts：每个已配置/受支持/当前的
		// 提供商一张小卡片（自适应网格），可查的显示数值，不可查的显示原因。
		// 只有宿主确实检测到 Claude / Codex 时才会返回对应卡片，并在这张卡旁给出
		// 令牌填写卡——它们只有 OAuth 订阅令牌能读，令牌经 POST /token 写入凭证
		// 服务，响应里永不回传。
		const ACCOUNTS_PATH = "/api/kd-deepseek-cost/accounts";
		const TOKEN_PATH = "/api/kd-deepseek-cost/token";
		/**
		 * OAuth 提供商的令牌来源说明 key（token.source.<key>）。
		 * 按 provider 路由 id 映射：接口返回的是 `anthropic` / `openai-codex`，
		 * 词典里按刻意的短名命名（claude / codex）。
		 */
		const TOKEN_SOURCE_KEYS = { anthropic: "claude", "openai-codex": "codex" };

		function AccountsSection(props) {
			const t = props.t;
			const [rows, setRows] = useState(null);
			// load 是稳定回调（依赖只有 t），不能直接读 rows 的最新值——用 ref 记住
			// "卡片是否已经画出来过"，以免每次刷新都重新走一遍清单请求。
			const rowsRef = useRef(null);
			rowsRef.current = rows;
			const [notice, setNotice] = useState("");
			const [note, setNote] = useState("");
			const [busy, setBusy] = useState(false);
			// 令牌卡的草稿：{ claude: '', codex: '' } 与账号 ID { codex: '' }。
			const [draft, setDraft] = useState({});
			const [accountDraft, setAccountDraft] = useState({});
			const [saving, setSaving] = useState("");
			const mountedRef = useRef(true);

			useEffect(() => () => { mountedRef.current = false; }, []);

			// 两段式加载：先用 `?list=1` 拿到提供商清单（宿主不查上游，几十毫秒），
			// 把卡片立刻画出来并显示"查询中"；再请求完整读数，逐卡把状态填上。
			// 否则面板打开后要等所有上游接口返回，卡片才一起冒出来。
			const applyBody = (body) => {
				setRows(Array.isArray(body.accounts) ? body.accounts : []);
				setNote("");
			};

			const load = useCallback(async () => {
				setBusy(true);
				try {
					// 第一段：清单。已经有卡片时不重复请求，避免闪成"查询中"。
					// 清单失败不阻断第二段——完整请求会再报一次，也能给出同样准确的结论。
					if (rowsRef.current === null) {
						try {
							const res = await fetch(ACCOUNTS_PATH + "?list=1", { cache: "no-store" });
							let body = null;
							try { body = await res.json(); } catch (e) { body = null; }
							if (!mountedRef.current) return;
							if (res.ok && body && body.ok === true) applyBody(body);
						} catch (e) { /* 清单拿不到就等完整请求 */ }
					}
					// 第二段：完整读数。慢没关系——卡片已经在场，状态位由它来填。
					const res = await fetch(ACCOUNTS_PATH, { cache: "no-store" });
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					if (!res.ok || !body || body.ok !== true) {
						setNote(t("accounts.unavailable"));
						return;
					}
					applyBody(body);
				} catch (e) {
					if (mountedRef.current) setNote(t("accounts.unavailable"));
				} finally {
					if (mountedRef.current) setBusy(false);
				}
			}, [t]);

			useEffect(() => { load().catch(() => {}); }, [load]);

			// 令牌保存/清除。`override` 用于清除：那时草稿还没清空，不能读 state
			// （setState 是异步的，读到的仍是旧值）。
			const submitToken = useCallback(async (provider, override) => {
				const token = override !== undefined ? override : (draft[provider] ?? "").trim();
				setSaving(provider);
				try {
					const payload = { provider, token };
					// Codex 的账号 ID 与令牌一并提交（缺了它上游可能拒绝请求）；
					// 清除时不带，宿主会连带 unset。
					const accountId = (accountDraft[provider] ?? "").trim();
					if (token !== "" && accountId !== "") payload.accountId = accountId;
					const res = await fetch(TOKEN_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					});
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					if (!res.ok || !body || body.ok !== true) {
						setNotice(t("token.failed"));
						return;
					}
					setNotice(body.configured ? t("token.saved") : t("token.cleared"));
					setDraft((d) => ({ ...d, [provider]: "" }));
					if (!body.configured) setAccountDraft((d) => ({ ...d, [provider]: "" }));
					await load();
				} catch (e) {
					if (mountedRef.current) setNotice(t("token.failed"));
				} finally {
					if (mountedRef.current) setSaving("");
				}
			}, [draft, accountDraft, t, load]);

			const section = {
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				gap: 12,
				color: "var(--dsw-alias-label-primary, #111)",
			};
			const head = { display: "flex", alignItems: "center", gap: 8 };
			const title = { margin: 0, fontSize: 14, fontWeight: 500, lineHeight: "22px" };
			// 提供商卡片：一行五列。列宽取 `(容器宽 − 4 条间隙) / 5`，所以只要容器
			// 放得下，就一定排满五张、不留多余空白；容器窄于 5×8.5rem 时退回 8.5rem
			// 的下限并自动减列，卡片不会被挤扁。
			// 行高统一：每张卡都是同样高度的 flex 列，名称靠顶、状态靠底、读数居中，
			// 所以第一行、第二行乃至"不适用"卡都等高对齐。高度 = 上下内边距 6+6 +
			// 名称 16 + 读数 20 + 状态 16 + 两条行距 2×2 + 边框 2 = 70，三行内容放得下。
			const gridStyle = {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(max(8.5rem, calc((100% - 24px) / 5)), 1fr))",
				gap: 6,
			};
			const cardStyle = {
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				justifyContent: "space-between",
				height: 70,
				gap: 2,
				minWidth: 0,
				overflow: "hidden",
				padding: "6px 8px",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
				background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
				fontSize: 12,
				lineHeight: "16px",
			};
			const cardHeadStyle = { display: "flex", alignItems: "center", gap: 4, minWidth: 0, minHeight: 16 };
			const cardNameStyle = {
				fontWeight: 500,
				fontSize: 12,
				lineHeight: "16px",
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			};
			const cardValueStyle = {
				fontVariantNumeric: "tabular-nums",
				fontSize: 13,
				lineHeight: "20px",
				fontWeight: 600,
				minHeight: 20,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			};
			const cardStatusStyle = { fontSize: 11, lineHeight: "16px", minHeight: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
			const cardReasonStyle = {
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};
			const tagStyle = {
				flex: "none",
				borderRadius: "var(--dsw-radius-xs, 4px)",
				border: "1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))",
				color: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
				padding: "0 4px",
				fontSize: 10,
				lineHeight: "14px",
			};
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 26,
				padding: "0 10px",
				cursor: "pointer",
			};
			const inputStyle = {
				boxSizing: "border-box",
				width: "100%",
				minWidth: 0,
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				padding: "4px 8px",
			};

			/** 一行的读数文本：余额金额或最紧窗口的百分比。 */
			const valueText = (item) => {
				if (item.status !== "ok") return "";
				if (item.kind === "balance" && item.balance) {
					return currencySymbol(item.balance.currency) + money(item.balance.total);
				}
				if (item.usage && Array.isArray(item.usage.windows) && item.usage.windows.length > 0) {
					let best = null;
					for (const w of item.usage.windows) {
						if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) continue;
						if (best === null || w.percent > best.percent) best = w;
					}
					if (best !== null) return (t("accounts.window." + best.key) || best.key) + " " + percentText(best.percent);
				}
				return "";
			};

			// 状态文案与配色。
			//
			// kind=none 的行（本插件没有可查接口的提供商）单独走一套中性说法：
			// 它不是"查询失败"——没去查，也不该查。把它标红会让用户以为插件出错了。
			// 红色只留给"真去查了但失败"（网络、认证、形状不认）。
			const statusText = (item) => {
				if (item.kind === "none") return t("accounts.status.unsupported");
				if (item.status === "ok") return t("accounts.status.ok");
				if (item.status === "pending") return t("accounts.status.pending");
				if (item.status === "no-key") return t("accounts.status.noKey");
				if (item.status === "no-token") return t("accounts.status.noToken");
				return t("accounts.status.error");
			};
			const statusColor = (item) => {
				// 不支持、未配置都是"这一行没数据"的常态，用三级文字色；
				// 只有真失败才用错误色；查询中同样是中性色，等结果回来再定色。
				if (item.kind === "none") return "var(--dsw-alias-label-tertiary, rgba(0,0,0,.4))";
				if (item.status === "ok") return "var(--dsw-alias-state-success-primary, rgb(34,160,80))";
				if (item.status === "no-key" || item.status === "no-token" || item.status === "pending") return "var(--dsw-alias-label-tertiary, rgba(0,0,0,.4))";
				return "var(--dsw-alias-state-error-primary, rgb(200,40,40))";
			};

			return h("section", { style: section },
				h("div", { style: head },
					h("h4", { style: title }, t("accounts.title")),
					h("button", {
						type: "button",
						style: { ...buttonStyle, marginLeft: "auto" },
						disabled: busy,
						onClick: () => { setNotice(""); load().catch(() => {}); },
					}, t("accounts.refresh")),
				),
				h("p", {
					style: {
						margin: 0,
						fontSize: 12,
						lineHeight: "18px",
						color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
					},
				}, t("accounts.intro")),
				note ? h("p", {
					style: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-error-primary, rgb(200,40,40))" },
				}, note) : null,
				notice ? h("p", {
					style: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))" },
				}, notice) : null,
				rows === null
					? h("p", { style: { margin: 0, fontSize: 13, color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))" } }, "…")
					: rows.length === 0
						? h("p", { style: { margin: 0, fontSize: 13, color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))" } }, t("accounts.empty"))
						: h("div", { style: gridStyle }, rows.map((item) => h("div", {
							key: item.id,
							// 不支持的行整卡降不透明度：它是"这项不支持"的说明，不是故障，
							// 也不该和能查的提供商抢注意力。
							style: item.kind === "none" ? { ...cardStyle, opacity: 0.75 } : cardStyle,
						},
							h("div", { style: cardHeadStyle },
								h("span", { style: cardNameStyle }, item.displayName || item.id),
								item.current ? h("span", { style: tagStyle }, t("accounts.current")) : null,
							),
							// 读数与状态分两行：读数放大、状态退成辅助信息，缩成五列卡片
							// 时名字与状态也不会挤成一团。"不适用"卡没有读数，第三行换成
							// 原因说明——三张卡永远只占三个槽位，固定高度不会被第四行撑破。
							item.kind === "none"
								? null
								: h("span", { style: cardValueStyle }, valueText(item)),
							h("span", { style: { ...cardStatusStyle, color: statusColor(item) } }, statusText(item)),
							item.kind === "none"
								? h("span", { style: cardReasonStyle }, t("accounts.reason." + (item.reason || "unsupported")))
								: null,
						))),
				h("p", {
					style: {
						margin: 0,
						fontSize: 12,
						lineHeight: "18px",
						color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
					},
				}, t("accounts.gateway")),
				// OAuth 令牌填写卡：只对 kind=oauth 的提供商渲染。
				rows && rows.length > 0
					? h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
						rows.filter((item) => item.kind === "oauth").map((item) => {
							const sourceKey = TOKEN_SOURCE_KEYS[item.id] ?? item.id;
							return h("div", {
								key: "token-" + item.id,
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 6,
									padding: 10,
									borderRadius: "var(--dsw-radius-md, 6px)",
									border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
									background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
								},
							},
								h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
									h("span", { style: cardNameStyle }, item.displayName || item.id),
									h("span", { style: { ...tagStyle, marginLeft: "auto" } },
										item.token && item.token.configured ? t("token.configured") : t("token.missing")),
								),
								h("p", {
									style: {
										margin: 0,
										fontSize: 12,
										lineHeight: "18px",
										color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
									},
								}, t("token.source." + sourceKey)),
								h("textarea", {
									style: { ...inputStyle, minHeight: 52, resize: "vertical", fontFamily: "inherit" },
									placeholder: t("token.placeholder"),
									value: draft[item.id] ?? "",
									onChange: (e) => setDraft((d) => ({ ...d, [item.id]: e.target.value })),
								}),
								item.id === "openai-codex"
									? h("input", {
										type: "text",
										style: inputStyle,
										placeholder: t("token.accountPlaceholder"),
										value: accountDraft[item.id] ?? "",
										onChange: (e) => setAccountDraft((d) => ({ ...d, [item.id]: e.target.value })),
									})
									: null,
								h("div", { style: { display: "flex", gap: 8 } },
									h("button", {
										type: "button",
										style: buttonStyle,
										disabled: saving === item.id,
										onClick: () => submitToken(item.id).catch(() => {}),
									}, t("token.save")),
									h("button", {
										type: "button",
										style: buttonStyle,
										disabled: saving === item.id,
										onClick: () => submitToken(item.id, "").catch(() => {}),
									}, t("token.clear")),
								),
							);
						}))
					: null,
			);
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots", "remote", "locale"];

		function apply(ctx) {
			// 注册 i18n 词典（DSH locale 服务；不可用时组件回退中文）。
			// 用 ctx.effect 管理生命周期：插件卸载时词典随之撤销。
			try {
				if (ctx.effect && ctx.locale && typeof ctx.locale.register === "function") {
					ctx.effect(
						() => ctx.locale.register(NS, { zh: ZH, en: EN }),
						"dsh-deepseek-cost: dictionaries",
					);
				} else if (ctx.locale && typeof ctx.locale.register === "function") {
					ctx.locale.register(NS, { zh: ZH, en: EN });
				}
			} catch (e) { /* 词典注册失败不影响卡片 */ }
			// 注入本包样式：footerActions 换行（卡片独占一行）。
			const tagId = "dsh-deepseek-cost-kd";
			if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-deepseek-usage";
				style.dataset.pluginCss = tagId;
				style.textContent = 'div[class*="footerActions"]{flex-wrap:wrap}';
				document.head.appendChild(style);
			}
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "dsh-cost-kd", order: 100, label: "账户用量" },
				(props) => h(UsageCell, { wide: props.wide, ctx }),
			));
			// 插件页（Plugins → 本 bundle 详情页）的余额与用量查询状态区。
			//
			// `plugins.detail.section` 是**所有** bundle / 行 / 官方插件详情页共用的
			// 列表 slot：只判断 `subject.kind === 'bundle'` 会让这块面板出现在别人的
			// 页面上。必须再比对包名，只有本插件的详情页才渲染。
			ctx.slots.inject("plugins.detail.section", () => ctx.slots.register(
				{ name: "plugins.detail.section", id: "dsh-cost-accounts-kd", locale: NS, order: 100 },
				(props) => {
					const subject = props && props.subject;
					if (!subject || subject.kind !== "bundle") return null;
					// subject.pkg 是 packageRef：{ name, version?, … }。名字不符就交给
					// 别的贡献者，本插件不画任何东西。
					const pkg = subject.pkg;
					if (!pkg || pkg.name !== PACKAGE_NAME) return null;
					const t = props.t;
					return h(AccountsSection, { t });
				},
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数透出（供 test/client-layout.test.mjs 直接做确定性断言，不必模拟计时器）。
		exports.__internals = {
			nextChange,
			isPeak,
			fmtCountdown,
			money,
			fmtPrice,
			currencySymbol,
			expandHolidayRanges,
			isHoliday,
			accountLead,
			percentText,
		};
		return module.exports;
	}
});
