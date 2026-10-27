// 卡片结构渲染测试：在假 DOM 上跑 lib/client.js 的真组件，断言
//   1) 余额与今日消费都画出来了；2) 今日消费是蓝色、与余额同字号；
//   3) 宽档显示 ¥、窄档显示硬币图标；4) 订阅制（usage）不显示今日消费。
// 只验证结构与样式值，不验证像素位置——像素要重启 DSH 后人眼看。
// 用法：node 测-卡片结构.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.join(here, "lib", "client.js"), "utf8");

// ---- 假 DOM ----
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attrs = {}; this.dataset = {}; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [];
    for (const n of nodes) this.children.push(n); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener() {}
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = v; }
}
function documentShim() {
  return {
    createElement: (tag) => new El(tag),
    createTextNode: (text) => ({ text: String(text) }),
    getElementById: () => new El("div"),
    head: new El("head"),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible",
  };
}

/** 深度遍历：找满足条件的元素。 */
function walk(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.tag) { out.push(node); for (const c of node.children) walk(c, out); }
  return out;
}
const textOf = (node) =>
  typeof node === "string" ? node
    : !node || typeof node !== "object" ? ""
      : node.text !== undefined ? node.text
        : (node.children || []).map(textOf).join("");

/**
 * 跑一个用例：真组件 + 假 React + 假 DOM。
 * @param {{width:number, sample:object}} opts
 */
function renderCase({ width, sample }) {
  const hooks = [];
  let hookIndex = 0;
  let effects = [];
  let prevEffects = [];
  let mounted = null;
  let scheduled = false;

  const doc = documentShim();
  let root = new El("div");
  const calledRefs = new Set();
  const changes = [];
  let renders = 0;
  const setters = [];

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; renderTree(); });
  };
  const useState = (init) => {
    const i = hookIndex++;
    if (!(i in hooks)) hooks[i] = { value: typeof init === "function" ? init() : init };
    // setter 必须跨渲染保持同一个身份（真 React 就是这样）：组件把它当 callback ref
    // 传给卡片，身份一变就会被当成"换了个 ref"重新挂载 → setState → 重渲染 → 死循环。
    if (!setters[i]) {
      setters[i] = (v) => {
        const next = typeof v === "function" ? v(hooks[i].value) : v;
        if (Object.is(next, hooks[i].value)) return;
        hooks[i].value = next;
        changes.push([i, JSON.stringify(next).slice(0, 80)]);
        schedule();
      };
    }
    return [hooks[i].value, setters[i]];
  };
  const useRef = (v) => { const i = hookIndex++; if (!(i in hooks)) hooks[i] = { current: v }; return hooks[i]; };
  // useMemo / useCallback 必须真的记忆：组件的 load 是 useCallback 出来的，身份一变，
  // 心跳 effect 的依赖就变 → effect 重跑 → 再 fetch → 再 setState，无限循环。
  const depsSame = (a, b) => !!a && !!b && a.length === b.length && a.every((d, k) => Object.is(d, b[k]));
  const useMemo = (fn, deps) => {
    const i = hookIndex++;
    const prev = hooks[i];
    if (prev && depsSame(prev.deps, deps)) return prev.value;
    const value = fn();
    hooks[i] = { value, deps };
    return value;
  };
  const useCallback = (fn, deps) => useMemo(() => fn, deps);
  const react = {
    createElement(type, props, ...children) {
      if (typeof type === "function") return type(Object.assign({}, props || {}, { children }));
      const el = new El(type);
      for (const [k, v] of Object.entries(props || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "style") Object.assign(el.style, v);
        else if (k === "ref") continue;
        else if (k.startsWith("on") && typeof v === "function") el.attrs[k] = v;
        else if (k === "className") el.className = v;
        else el.setAttribute(k, v);
      }
      for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false || c === true) continue;
        el.append(c instanceof El || (c && c.text !== undefined) ? c : { text: String(c) });
      }
      // 真 React 只在 ref 函数**身份变化**时重挂，所以同一函数只调一次；
      // 每次渲染都调会让 setCardEl → 重渲染 → 再调，直接死循环。
      if (props && typeof props.ref === "function" && !calledRefs.has(props.ref)) {
        calledRefs.add(props.ref);
        props.ref(el);
      }
      return el;
    },
    useState,
    useRef,
    useMemo,
    useCallback,
    useEffect: (fn, deps) => { const i = hookIndex++; effects.push({ i, fn, deps }); },
    useSyncExternalStore: (sub, snap) => snap(),
  };

  const sandbox = {
    console,
    Promise,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    Error,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask,
    document: doc,
    // 假 ResizeObserver：一观察就立刻回一个固定宽度，模拟侧边栏实际宽度。
    ResizeObserver: class { observe() { this.cb([{ contentRect: { width } }]); } disconnect() {} constructor(cb) { this.cb = cb; } },
    fetch: async () => ({ ok: true, json: async () => sample }),
  };
  sandbox.window = sandbox;
  sandbox.window.__ModuleLoader__ = {
    load(def) { sandbox.__plugin = def.factory((name) => { if (name === "react") return react; throw new Error("unexpected require: " + name); }); },
  };

  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox);

  const ctx = {
    effect: (fn) => fn(),
    // 两个 slot 都会注册：只留侧边栏卡片（id=dsh-usage），否则会被插件页那个覆盖。
    slots: {
      inject: (name, fn) => fn(),
      register: (def, comp) => { if (def.id === "dsh-cost-kd") sandbox.__card = comp; return () => {}; },
    },
    remote: undefined,
    locale: undefined,
  };
  sandbox.__plugin.apply(ctx);

  function renderTree() {
    if (++renders > 40) throw new Error('渲染不收敛，最近 12 次变化：' + JSON.stringify(changes.slice(-12)));
    hookIndex = 0;
    effects = [];
    const node = sandbox.__card({ wide: true, ctx });
    root = new El("div");
    root.append(node);
    const next = [];
    for (const e of effects) {
      const prev = prevEffects.find((p) => p.i === e.i);
      if (prev && e.deps && prev.deps && e.deps.length === prev.deps.length && e.deps.every((d, k) => Object.is(d, prev.deps[k]))) {
        next.push(prev);
        continue;
      }
      const cleanup = e.fn();
      next.push({ i: e.i, deps: e.deps, cleanup });
    }
    prevEffects = next;
  }

  renderTree();
  // 把微任务（load 的 Promise、setState 的调度）跑完，直到树稳定。
  // 返回取值函数而不是节点：每次重渲染都会换一棵新树。
  return new Promise((resolve) => {
    setTimeout(() => resolve(() => root), 60);
  });
}

const now = Date.now();
const baseSample = {
  ok: true,
  provider: { id: "deepseek-official", displayName: "DeepSeek", kind: "balance", reason: null },
  balance: { isAvailable: true, total: 412.35, currency: "CNY" },
  usage: null,
  peak: true,
  next: { peak: false, at: now + 5 * 3600e3, ms: 5 * 3600e3 },
  tier: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8, model: "deepseek-flash", known: true },
  today: { cost: 3.89, requests: 306, tokens: 41e6, since: now - 3600e3, currency: "CNY", complete: true, unpriced: 0 },
  updatedAt: now,
  errors: [],
};

for (const width of [150, 170, 240]) {
  const getRoot = await renderCase({ width, sample: baseSample });
  const root = getRoot();
  const els = walk(root);
  const allText = textOf(root);
  assert.ok(allText.includes("412.35"), `余额应渲染（${width}px），实得：${allText}`);
  assert.ok(allText.includes("3.89"), `今日消费应渲染（${width}px），实得：${allText}`);
  assert.ok(allText.includes("今日"), "应有「今日」标签");

  // 两行分工：顶行只放钱，底行 = 倒计时（左）+ 档单价（右）
  const card = root.children[0];
  const [topRow, bottomRow] = card.children;
  const topText = textOf(topRow);
  const bottomText = textOf(bottomRow);
  assert.ok(topText.includes("412.35") && topText.includes("3.89"), `顶行应只放余额与今日消费，实得：${topText}`);
  assert.ok(!/\dh \d+m|\d+d \d+h/.test(topText), `顶行不该再有倒计时，实得：${topText}`);
  assert.ok(/\dh \d+m/.test(bottomText), `底行应有倒计时，实得：${bottomText}`);
  assert.equal(bottomRow.style.justifyContent, "space-between", "底行应左右分开（左倒计时、右单价）");
  const dotIn = (row) => walk(row).some((e) => e.style && e.style.borderRadius === "50%");
  assert.ok(dotIn(bottomRow), "峰谷灯应在底行与倒计时同侧");
  assert.ok(!dotIn(topRow), "顶行不该再有峰谷灯");

  // 今日消费靠右：它那一组用 marginLeft:auto 顶到顶行右端
  const todayGroup = walk(topRow).find((e) => e.style && String(e.style.marginLeft) === "auto");
  assert.ok(todayGroup, "今日消费应靠右（marginLeft:auto）");
  assert.ok(textOf(todayGroup).includes("3.89"), "靠右的那一组应是今日消费");

  const isCoin = els.some((e) => e.tag === "circle");
  const hasYen = els.some((e) => (e.children || []).some((c) => c.text === "¥"));
  if (width >= 200) {
    assert.ok(hasYen, "宽档应显示 ¥ 符号");
    assert.ok(!isCoin, "宽档不该出现硬币图标");
  } else {
    assert.ok(!hasYen, "窄档应把 ¥ 换成硬币图标");
    assert.ok(isCoin, "窄档应出现硬币图标");
  }

  // 今日消费的数字：蓝色、24px、700
  const blue = els.find((e) => e.style && String(e.style.color).includes("--dsw-alias-link"));
  assert.ok(blue, "今日消费应使用链接色 token");
  const blueNumbers = walk(blue).filter((e) => (e.children || []).some((c) => c.text === "3.89"));
  assert.ok(blueNumbers.length > 0, "蓝色那一组里应有今日消费数字");
  const amountSpan = blueNumbers[0];
  assert.equal(amountSpan.style.fontSize, 24, `今日消费字号应与余额一致（24px），实得 ${amountSpan.style.fontSize}`);
  assert.equal(amountSpan.style.fontWeight, 700, "今日消费字重应与余额一致");

  // 余额仍是主色、24px
  const balanceSpan = els.find((e) => e.style && e.style.fontSize === 24 && (e.children || []).some((c) => c.text === "412.35"));
  assert.ok(balanceSpan, "余额应以 24px 渲染");
  console.log(`${width}px：余额 + 今日 ${blueNumbers[0] && textOf(blue)}，${isCoin ? "硬币图标" : "¥ 符号"} —— 通过`);
}

// 订阅制：只显示窗口百分比，不显示今日消费（旁边挂金额会让人误读）
const usageSample = {
  ...baseSample,
  provider: { id: "kimi-coding", displayName: "Kimi For Coding", kind: "usage", reason: null },
  balance: { isAvailable: null, total: null, currency: null },
  usage: { plan: "pro", windows: [{ key: "5h", percent: 23, resetsAt: now + 3600e3 }] },
};
const getUsageRoot = await renderCase({ width: 240, sample: usageSample });
const usageRoot = getUsageRoot();
const usageText = textOf(usageRoot);
assert.ok(usageText.includes("23%"), `订阅制应显示窗口百分比，实得：${usageText}`);
assert.ok(!usageText.includes("3.89"), "订阅制不该渲染今日消费");
console.log("订阅制：只显示 23%，不显示今日消费 —— 通过");

console.log("结构渲染测试全部通过");




