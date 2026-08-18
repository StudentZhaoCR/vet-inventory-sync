/* ============================================================
   兽药出入库记录可追溯系统  v2.0 多端同步版
   前端：localStorage 本地缓存 + 后端 /api 实时同步
   （本地版逻辑见 kc/，本版共用同一套 UI 与业务逻辑）
   ============================================================ */
(function () {
  "use strict";

  const STORE_KEY = "vet_inventory_v1";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------------- 工具函数 ---------------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const today = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const fmtNum = (n) => (Number(n) || 0).toLocaleString("zh-CN");
  const daysUntil = (dateStr) => {
    if (!dateStr) return null;
    const a = new Date(dateStr), b = new Date(today());
    return Math.round((a - b) / 86400000);
  };
  const typeTagClass = (t) => (t === "疫苗" ? "tag-blue" : t === "器械耗材" ? "tag-info" : "tag-green");
  const srcClass = (s) => "src-pill src-" + (s || "其他");

  /* ---------------- 默认状态 ---------------- */
  function defaultState() {
    return {
      meta: { name: "兽药出入库记录可追溯系统", version: 1, createdAt: Date.now() },
      settings: {
        handlers: ["张保管", "李库管"],
        receivingUnits: ["第一防疫站", "第二防疫站", "养殖一场", "养殖二场"],
        drugTypes: ["疫苗", "普通药品", "器械耗材"],
        units: ["支", "瓶", "盒", "袋", "箱", "头份"],
        drugs: [], // 目录 {id,name,spec,type,unit,storageTemp,validityDays}
      },
      inbound: [],
      outbound: [],
      slips: [],
    };
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      // 兼容补全
      const d = defaultState();
      return Object.assign(d, s, {
        settings: Object.assign(d.settings, s.settings || {}),
        meta: s.meta || d.meta,
        inbound: s.inbound || [],
        outbound: s.outbound || [],
        slips: s.slips || [],
      });
    } catch (e) {
      console.error(e);
      return defaultState();
    }
  }
  /* 本地持久化（不触发同步） */
  function saveLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { console.error(e); }
  }

  /* 标记：下一次 save 是否整体覆盖服务器（用于载入示例/导入/清空） */
  let REPLACE_NEXT = false;

  /* save(): 写本地 + 安排向服务器同步 */
  function save() {
    saveLocal();
    Sync.schedulePush(REPLACE_NEXT);
    REPLACE_NEXT = false;
  }

  /* ---------------- 多端同步引擎 ---------------- */
  const Sync = (function () {
    const API = "/api";
    let timer = null, syncing = false, online = (typeof navigator !== "undefined" ? navigator.onLine : true), lastSync = 0;
    function token() { try { return new URLSearchParams(location.search).get("token") || ""; } catch (e) { return ""; } }
    function headers() { const h = { "Content-Type": "application/json" }; const t = token(); if (t) h["x-token"] = t; return h; }
    function setStatus(s, detail) { updateSyncUI(s, detail); }
    function req(path, body) {
      let url = API + path;
      const t = token();
      if (t && path === "/state") url += "?token=" + encodeURIComponent(t);
      const opt = { method: body ? "POST" : "GET", headers: headers(), cache: "no-store" };
      if (body) opt.body = JSON.stringify(body);
      return fetch(url, opt).then((r) => {
        if (r.status === 403) throw new Error("token");
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    }
    /* 给缺失 _u 的记录补时间戳，便于按记录级合并 */
    function touch(s) {
      const stamp = Date.now();
      ["inbound", "outbound", "slips"].forEach((c) => (s[c] || []).forEach((r) => { if (r && !r._u) r._u = stamp; }));
      (s.settings.drugs || []).forEach((r) => { if (r && !r._u) r._u = stamp; });
      return s;
    }
    function stateSig(s) {
      const d = s.settings.drugs ? s.settings.drugs.length : 0;
      const h = (s.inbound.length) + "|" + (s.outbound.length) + "|" + (s.slips.length) + "|" + d + "|" +
        (s.settings.handlers || []).join(",") + "|" + (s.settings.receivingUnits || []).join(",");
      return h + "|" + (s.meta && s.meta.updatedAt ? s.meta.updatedAt : 0);
    }
    function normalize(remote) {
      const d = defaultState();
      const s = {
        meta: Object.assign({}, d.meta, remote.meta || {}),
        settings: Object.assign({}, d.settings, remote.settings || {}, { drugs: (remote.settings && remote.settings.drugs) || [] }),
        inbound: remote.inbound || [],
        outbound: remote.outbound || [],
        slips: remote.slips || [],
      };
      return s;
    }
    function adopt(remote) {
      const prev = stateSig(state);
      state = normalize(remote);
      saveLocal();
      if (stateSig(state) !== prev) render();
      lastSync = Date.now();
    }
    async function push(replace) {
      if (!online) { setStatus("offline"); return; }
      if (syncing) return;
      syncing = true; setStatus("syncing");
      try {
        touch(state);
        const merged = await req(replace ? "/replace" : "/sync", state);
        adopt(merged);
        setStatus("online");
      } catch (e) {
        if (e.message === "token") setStatus("token", "令牌错误");
        else setStatus("error", "同步失败");
      } finally { syncing = false; }
    }
    function schedulePush(replace) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => push(replace), 800);
    }
    function init() {
      window.addEventListener("online", () => { online = true; push(false); });
      window.addEventListener("offline", () => { online = false; setStatus("offline"); });
      setInterval(() => { if (online && !syncing) push(false); }, 30000);
      setStatus(online ? "online" : "offline");
      push(false); // 启动即与服务器对齐一次
    }
    return { init, push, schedulePush, isOnline: () => online };
  })();

  /* 同步状态 UI */
  function updateSyncUI(status, detail) {
    const el = $("#sync-status");
    if (!el) return;
    const map = { syncing: ["syncing", "同步中…"], online: ["online", "已同步"], offline: ["offline", "离线(本地)"], error: ["error", "同步失败"], token: ["error", "令牌错误"] };
    const [cls, txt] = map[status] || ["online", "已同步"];
    el.className = "sync-status " + cls;
    el.textContent = detail || txt;
    const btn = $("#btn-sync");
    if (btn) btn.disabled = status === "syncing";
  }

  /* ---------------- 示例数据（含一笔账实差异场景） ---------------- */
  function loadSample() {
    const s = defaultState();
    s.settings.handlers = ["张保管", "李库管", "王防疫"];
    s.settings.receivingUnits = ["第一防疫站", "第二防疫站", "养殖一场", "养殖二场"];
    s.settings.drugs = [
      { id: uid(), name: "猪瘟活疫苗", spec: "20头份/瓶", type: "疫苗", unit: "瓶", storageTemp: "冷藏2-8℃", validityDays: 540 },
      { id: uid(), name: "口蹄疫灭活疫苗", spec: "50ml/瓶", type: "疫苗", unit: "瓶", storageTemp: "冷藏2-8℃", validityDays: 365 },
      { id: uid(), name: "阿莫西林粉", spec: "100g/袋", type: "普通药品", unit: "袋", storageTemp: "阴凉", validityDays: 720 },
      { id: uid(), name: "伊维菌素注射液", spec: "10ml/支", type: "普通药品", unit: "支", storageTemp: "常温", validityDays: 900 },
      { id: uid(), name: "一次性注射器", spec: "5ml", type: "器械耗材", unit: "支", storageTemp: "常温", validityDays: 0 },
    ];
    const D = s.settings.drugs;
    const d = (n) => D.find((x) => x.name === n);
    const d1 = d("猪瘟活疫苗"), d2 = d("口蹄疫灭活疫苗"), d3 = d("阿莫西林粉"), d4 = d("伊维菌素注射液"), d5 = d("一次性注射器");

    // 入库
    s.inbound = [
      { id: uid(), date: "2026-08-01", drugName: d1.name, spec: d1.spec, type: d1.type, unit: d1.unit, batch: "V2608001", quantity: 200, supplier: "生物制品厂", handler: "张保管", expiry: "2027-12-31", note: "冷链到货" },
      { id: uid(), date: "2026-08-02", drugName: d2.name, spec: d2.spec, type: d2.type, unit: d2.unit, batch: "V2608002", quantity: 120, supplier: "生物制品厂", handler: "张保管", expiry: "2027-06-30", note: "" },
      { id: uid(), date: "2026-08-03", drugName: d3.name, spec: d3.spec, type: d3.type, unit: d3.unit, batch: "P2608003", quantity: 300, supplier: "兽药公司", handler: "李库管", expiry: "2028-01-15", note: "" },
      { id: uid(), date: "2026-08-05", drugName: d4.name, spec: d4.spec, type: d4.type, unit: d4.unit, batch: "P2608004", quantity: 500, supplier: "兽药公司", handler: "李库管", expiry: "2028-09-01", note: "" },
      { id: uid(), date: "2026-08-05", drugName: d5.name, spec: d5.spec, type: d5.type, unit: d5.unit, batch: "M2608005", quantity: 1000, supplier: "器械公司", handler: "李库管", expiry: "", note: "" },
      { id: uid(), date: "2026-08-10", drugName: d1.name, spec: d1.spec, type: d1.type, unit: d1.unit, batch: "V2608010", quantity: 150, supplier: "生物制品厂", handler: "张保管", expiry: "2027-12-31", note: "补货" },
    ];

    // 领用单
    const slip1 = {
      id: uid(), code: "LY20260806-01", date: "2026-08-06", receivingUnit: "第一防疫站", handler: "王防疫",
      note: "月度常规免疫", items: [
        { drugName: d1.name, spec: d1.spec, unit: d1.unit, expectedQty: 100 },
        { drugName: d2.name, spec: d2.spec, unit: d2.unit, expectedQty: 60 },
        { drugName: d5.name, spec: d5.spec, unit: d5.unit, expectedQty: 200 },
      ],
    };
    const slip2 = {
      id: uid(), code: "LY20260808-02", date: "2026-08-08", receivingUnit: "养殖一场", handler: "王防疫",
      note: "紧急补免", items: [
        { drugName: d4.name, spec: d4.spec, unit: d4.unit, expectedQty: 80 },
        { drugName: d3.name, spec: d3.spec, unit: d3.unit, expectedQty: 50 },
      ],
    };
    s.slips = [slip1, slip2];

    // 出库：slip1 实际发放（猪瘟少发10 + 注射器多发50 = 账实差异）
    s.outbound = [
      { id: uid(), date: "2026-08-06", slipId: slip1.id, drugName: d1.name, spec: d1.spec, type: d1.type, unit: d1.unit, batch: "V2608001", quantity: 90, receivingUnit: slip1.receivingUnit, handler: "张保管", sourceType: "领用单", note: "按单发放，少10" },
      { id: uid(), date: "2026-08-06", slipId: slip1.id, drugName: d2.name, spec: d2.spec, type: d2.type, unit: d2.unit, batch: "V2608002", quantity: 60, receivingUnit: slip1.receivingUnit, handler: "张保管", sourceType: "领用单", note: "" },
      { id: uid(), date: "2026-08-06", slipId: null, drugName: d5.name, spec: d5.spec, type: d5.type, unit: d5.unit, batch: "M2608005", quantity: 250, receivingUnit: slip1.receivingUnit, handler: "张保管", sourceType: "增补", note: "现场多领，未计入领用单" },
      { id: uid(), date: "2026-08-07", slipId: null, drugName: d1.name, spec: d1.spec, type: d1.type, unit: d1.unit, batch: "V2608001", quantity: 5, receivingUnit: "第二防疫站", handler: "张保管", sourceType: "私发", note: "领导特批直发，无领用单" },
      { id: uid(), date: "2026-08-08", slipId: slip2.id, drugName: d4.name, spec: d4.spec, type: d4.type, unit: d4.unit, batch: "P2608004", quantity: 80, receivingUnit: slip2.receivingUnit, handler: "李库管", sourceType: "领用单", note: "" },
      { id: uid(), date: "2026-08-08", slipId: slip2.id, drugName: d3.name, spec: d3.spec, type: d3.type, unit: d3.unit, batch: "P2608003", quantity: 50, receivingUnit: slip2.receivingUnit, handler: "李库管", sourceType: "领用单", note: "" },
    ];

    state = s;
    REPLACE_NEXT = true;
    save();
  }

  /* ---------------- 库存计算 ---------------- */
  function computeInventory() {
    const map = new Map();
    const key = (n, sp, b) => `${n}||${sp}||${b}`;
    state.inbound.forEach((r) => {
      const k = key(r.drugName, r.spec, r.batch);
      if (!map.has(k)) map.set(k, { drugName: r.drugName, spec: r.spec, batch: r.batch, type: r.type, unit: r.unit, inboundQty: 0, outboundQty: 0, expiry: r.expiry, storageTemp: "", lastInbound: r.date });
      const o = map.get(k);
      o.inboundQty += Number(r.quantity) || 0;
      if (r.expiry && (!o.expiry || r.expiry < o.expiry)) o.expiry = r.expiry;
      if (r.storageTemp) o.storageTemp = r.storageTemp;
      if (r.date > o.lastInbound) o.lastInbound = r.date;
    });
    state.outbound.forEach((r) => {
      const k = key(r.drugName, r.spec, r.batch);
      if (!map.has(k)) map.set(k, { drugName: r.drugName, spec: r.spec, batch: r.batch, type: r.type, unit: r.unit, inboundQty: 0, outboundQty: 0, expiry: r.expiry, storageTemp: "", lastInbound: "" });
      const o = map.get(k);
      o.outboundQty += Number(r.quantity) || 0;
      if (r.date > (o.lastOutbound || "")) o.lastOutbound = r.date;
    });
    const arr = Array.from(map.values()).map((o) => ({ ...o, stock: o.inboundQty - o.outboundQty }));
    arr.sort((a, b) => a.drugName.localeCompare(b.drugName, "zh") || a.batch.localeCompare(b.batch));
    return arr;
  }

  /* ---------------- 渲染框架 ---------------- */
  let currentView = "dashboard";
  const titles = { dashboard: "总览", inbound: "入库管理", outbound: "出库管理", vaccine: "疫苗专项", inventory: "库存查询", slips: "领用单", reconcile: "账实核对", settings: "设置", data: "数据备份" };

  function render() {
    $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === currentView));
    $("#view-title").textContent = titles[currentView];
    const root = $("#view-root");
    if (VIEWS[currentView]) VIEWS[currentView](root);
    updateTopbar();
  }

  function updateTopbar() {
    const inv = computeInventory();
    const neg = inv.filter((i) => i.stock < 0).length;
    const vExp = inv.filter((i) => i.type === "疫苗" && i.expiry && daysUntil(i.expiry) !== null && daysUntil(i.expiry) < 0).length;
    $("#topbar-stat").textContent = `入库 ${state.inbound.length} 笔 · 出库 ${state.outbound.length} 笔 · 库存 ${inv.length} 批次 · 负库存 ${neg} · 过期疫苗 ${vExp}`;
  }

  /* ---------------- 通用弹层 ---------------- */
  function openModal(title, bodyHtml, footHtml, wide) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHtml;
    $("#modal-foot").innerHTML = footHtml || "";
    const m = $("#modal");
    m.classList.toggle("wide", !!wide);
    $("#modal-mask").hidden = false;
  }
  function closeModal() { $("#modal-mask").hidden = true; }
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-mask").addEventListener("click", (e) => { if (e.target.id === "modal-mask") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2200);
  }

  /* ---------------- datalist 助手 ---------------- */
  function drugNameOptions() {
    const names = new Set(state.inbound.concat(state.outbound).map((r) => r.drugName));
    state.settings.drugs.forEach((d) => names.add(d.name));
    return Array.from(names).filter(Boolean).map((n) => `<option value="${esc(n)}">`).join("");
  }
  function batchOptions(name, spec) {
    const bs = new Set();
    state.inbound.forEach((r) => { if ((!name || r.drugName === name) && (!spec || r.spec === spec)) bs.add(r.batch); });
    return Array.from(bs).filter(Boolean).map((b) => `<option value="${esc(b)}">`).join("");
  }
  function unitOptions() { return state.settings.units.map((u) => `<option value="${esc(u)}">`).join(""); }
  function handlerOptions() { return state.settings.handlers.map((h) => `<option value="${esc(h)}">`).join(""); }
  function unitOptionsSel(sel) { return `<select>${state.settings.units.map((u) => `<option ${u === sel ? "selected" : ""}>${esc(u)}</option>`).join("")}</select>`; }

  /* ============================================================
     视图：总览
     ============================================================ */
  function V_dashboard(root) {
    const inv = computeInventory();
    const totalStock = inv.reduce((a, b) => a + b.stock, 0);
    const negStock = inv.filter((i) => i.stock < 0);
    const expSoon = inv.filter((i) => i.type === "疫苗" && i.expiry && daysUntil(i.expiry) >= 0 && daysUntil(i.expiry) <= 90);
    const expired = inv.filter((i) => i.type === "疫苗" && i.expiry && daysUntil(i.expiry) < 0);
    const zeroStock = inv.filter((i) => i.stock === 0);
    const srcStats = {};
    state.outbound.forEach((r) => { srcStats[r.sourceType] = (srcStats[r.sourceType] || 0) + 1; });
    const privateOut = state.outbound.filter((r) => r.sourceType === "私发" || r.sourceType === "增补").length;

    root.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">库存批次</div><div class="stat-val">${inv.length}</div><div class="stat-sub">${totalStock} ${"件"} 累计在库</div></div>
        <div class="stat info"><div class="stat-label">入库 / 出库</div><div class="stat-val">${state.inbound.length} / ${state.outbound.length}</div><div class="stat-sub">历史出入笔数</div></div>
        <div class="stat ${negStock.length ? "danger" : ""}"><div class="stat-label">负库存批次</div><div class="stat-val">${negStock.length}</div><div class="stat-sub">${negStock.length ? "需核查溢发/短收" : "账实正常"}</div></div>
        <div class="stat ${expired.length ? "danger" : expSoon.length ? "warn" : ""}"><div class="stat-label">疫苗临期/过期</div><div class="stat-val">${expSoon.length + expired.length}</div><div class="stat-sub">${expired.length} 过期 · ${expSoon.length} 临期90天内</div></div>
        <div class="stat warn"><div class="stat-label">私发/增补出库</div><div class="stat-val">${privateOut}</div><div class="stat-sub">领用单外来源，需重点追溯</div></div>
      </div>

      <div class="callout">
        <b>系统定位：</b>兽药保管台账 + 账实核对 + 批号级追溯。当库存出现账实不符，进入 <b>账实核对</b> 选择对应领用单，系统自动将「领用单明细」与「实际出库记录」逐笔比对，并单列「私发 / 增补」等非单来源出库，快速定位差异来源。
      </div>

      <div class="card">
        <div class="card-head"><h3>最近出入库动态</h3><span class="db-stat">共 ${state.inbound.length + state.outbound.length} 笔</span></div>
        <div class="card-body">
          ${recentActivity()}
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head"><h3>出库来源构成</h3></div>
        <div class="card-body">
          <div style="display:flex;gap:18px;flex-wrap:wrap">
            ${(["领用单", "私发", "增补", "其他"]).map((t) => `<div><span class="src-pill src-${t}">${t}</span> <b style="margin-left:6px">${srcStats[t] || 0}</b> 笔</div>`).join("")}
          </div>
          <p class="hint" style="margin-top:10px">「私发 / 增补」属于领用单之外的多样化来源，每笔均可在出库时填写来源说明，便于事后核查与责任追溯。</p>
        </div>
      </div>
    `;
  }

  function recentActivity() {
    const rows = state.inbound.map((r) => ({ ...r, io: "in", label: "入库" }))
      .concat(state.outbound.map((r) => ({ ...r, io: "out", label: "出库" })))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, 12);
    if (!rows.length) return `<div class="empty"><div class="empty-ic">▦</div>暂无记录，先去「入库管理」登记第一批兽药吧<div class="empty-tip">或点击左下角「载入示例数据」体验完整流程</div></div>`;
    return `<div class="table-wrap"><table class="data">
      <thead><tr><th>日期</th><th>类型</th><th>兽药名称</th><th>规格</th><th>批号</th><th class="num">数量</th><th>领用/来源</th><th>经办人</th></tr></thead>
      <tbody>
      ${rows.map((r) => `<tr>
        <td class="mono">${esc(r.date)}</td>
        <td>${r.io === "in" ? '<span class="tag tag-green">入库</span>' : '<span class="tag tag-orange">出库</span>'}</td>
        <td class="cell-strong">${esc(r.drugName)}</td>
        <td>${esc(r.spec)}</td>
        <td class="mono">${esc(r.batch)}</td>
        <td class="num">${fmtNum(r.quantity)}</td>
        <td>${r.io === "in" ? esc(r.supplier || "—") : (r.sourceType === "领用单" ? esc(r.receivingUnit) : `<span class="${srcClass(r.sourceType)}">${esc(r.sourceType)}</span>`)}</td>
        <td>${esc(r.handler)}</td>
      </tr>`).join("")}
      </tbody></table></div>`;
  }

  /* ============================================================
     视图：入库管理
     ============================================================ */
  function V_inbound(root) {
    let q = "";
    renderList();
    function renderList() {
      const rows = state.inbound
        .filter((r) => !q || (r.drugName + r.batch + r.handler + r.spec).toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      root.innerHTML = `
        <div class="toolbar">
          <input type="search" id="in-search" placeholder="搜索兽药/批号/经办人" value="${esc(q)}">
          <button class="btn btn-primary" id="in-add">+ 新增入库</button>
          <span class="spacer"></span>
          <span class="db-stat">共 ${state.inbound.length} 笔入库</span>
        </div>
        <div class="card"><div class="card-body" style="padding:0">
          ${rows.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>日期</th><th>兽药名称</th><th>规格</th><th>类型</th><th>批号</th><th class="num">数量</th><th>单位</th><th>有效期</th><th>供货方</th><th>经办人</th><th>备注</th><th></th></tr></thead>
            <tbody>${rows.map((r) => `<tr>
              <td class="mono">${esc(r.date)}</td>
              <td class="cell-strong">${esc(r.drugName)}</td>
              <td>${esc(r.spec)}</td>
              <td><span class="tag ${typeTagClass(r.type)}">${esc(r.type)}</span></td>
              <td class="mono">${esc(r.batch)}</td>
              <td class="num">${fmtNum(r.quantity)}</td>
              <td>${esc(r.unit)}</td>
              <td>${expCell(r.expiry)}</td>
              <td>${esc(r.supplier || "—")}</td>
              <td>${esc(r.handler)}</td>
              <td>${esc(r.note || "")}</td>
              <td><button class="btn btn-xs btn-danger" data-del-in="${r.id}">删</button></td>
            </tr>`).join("")}</tbody></table></div>` : emptyState("暂无入库记录")}
        </div></div>`;
      bindList();
    }
    function bindList() {
      $("#in-search").addEventListener("input", (e) => { q = e.target.value; renderList(); });
      $("#in-add").addEventListener("click", () => openInboundForm());
      $$("[data-del-in]").forEach((b) => b.addEventListener("click", () => {
        if (confirm("确认删除该入库记录？")) { state.inbound = state.inbound.filter((x) => x.id !== b.dataset.delIn); save(); render(); toast("已删除"); }
      }));
    }
  }

  function openInboundForm(rec) {
    const r = rec || {};
    const isEdit = !!rec;
    openModal(isEdit ? "编辑入库" : "新增入库", `
      <div class="form-grid">
        <div class="field"><label>入库日期 <span class="req">*</span></label><input type="date" id="f-date" value="${esc(r.date || today())}"></div>
        <div class="field"><label>兽药名称 <span class="req">*</span></label><input list="dl-drugs" id="f-name" value="${esc(r.drugName || "")}" placeholder="如：猪瘟活疫苗"><datalist id="dl-drugs">${drugNameOptions()}</datalist></div>
        <div class="field"><label>规格</label><input id="f-spec" value="${esc(r.spec || "")}" placeholder="如：20头份/瓶"></div>
        <div class="field"><label>类型</label><select id="f-type">${state.settings.drugTypes.map((t) => `<option ${t === (r.type || "疫苗") ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        <div class="field"><label>批号 <span class="req">*</span></label><input id="f-batch" list="dl-batch" value="${esc(r.batch || "")}" placeholder="如：V2608001"><datalist id="dl-batch">${batchOptions(r.drugName, r.spec)}</datalist></div>
        <div class="field"><label>数量 <span class="req">*</span></label><input type="number" min="0" step="any" id="f-qty" value="${esc(r.quantity != null ? r.quantity : "")}"></div>
        <div class="field"><label>单位</label><input list="dl-units" id="f-unit" value="${esc(r.unit || "瓶")}"><datalist id="dl-units">${unitOptions()}</datalist></div>
        <div class="field"><label>有效期</label><input type="date" id="f-expiry" value="${esc(r.expiry || "")}"><span class="hint">疫苗必填，用于临期/过期预警</span></div>
        <div class="field"><label>供货方</label><input id="f-supplier" value="${esc(r.supplier || "")}"></div>
        <div class="field"><label>经办人 <span class="req">*</span></label><input list="dl-h" id="f-handler" value="${esc(r.handler || (state.settings.handlers[0] || ""))}"><datalist id="dl-h">${handlerOptions()}</datalist></div>
        <div class="field" style="grid-column:1/-1"><label>备注</label><textarea id="f-note" placeholder="如：冷链到货、补货等">${esc(r.note || "")}</textarea></div>
      </div>`, `
      <button class="btn btn-outline" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-save">保存</button>`);
    $("#m-cancel").addEventListener("click", closeModal);
    $("#m-save").addEventListener("click", () => {
      const name = $("#f-name").value.trim();
      const batch = $("#f-batch").value.trim();
      const qty = parseFloat($("#f-qty").value);
      const date = $("#f-date").value;
      const handler = $("#f-handler").value.trim();
      if (!name || !batch || !(qty >= 0) || !date || !handler) { toast("请填写必填项（名称/批号/数量/日期/经办人）"); return; }
      const recData = {
        date, drugName: name, spec: $("#f-spec").value.trim(), type: $("#f-type").value,
        batch, quantity: qty, unit: $("#f-unit").value.trim() || "瓶",
        expiry: $("#f-expiry").value, supplier: $("#f-supplier").value.trim(),
        handler, note: $("#f-note").value.trim(),
      };
      if (isEdit) { Object.assign(rec, recData); } else { recData.id = uid(); state.inbound.push(recData); }
      maybeAddDrug(recData);
      maybeAddHandler(handler);
      save(); closeModal(); render(); toast(isEdit ? "已更新" : "入库已登记");
    });
  }

  /* ============================================================
     视图：出库管理
     ============================================================ */
  function V_outbound(root) {
    let q = "", srcFilter = "全部";
    renderList();
    function renderList() {
      const rows = state.outbound
        .filter((r) => (srcFilter === "全部" || r.sourceType === srcFilter))
        .filter((r) => !q || (r.drugName + r.batch + r.receivingUnit + r.handler).toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      root.innerHTML = `
        <div class="toolbar">
          <input type="search" id="out-search" placeholder="搜索兽药/批号/领用单位" value="${esc(q)}">
          <select id="out-src">${["全部", "领用单", "私发", "增补", "其他"].map((t) => `<option ${t === srcFilter ? "selected" : ""}>${t}</option>`).join("")}</select>
          <button class="btn btn-accent" id="out-add">+ 新增出库</button>
          <span class="spacer"></span>
          <span class="db-stat">共 ${state.outbound.length} 笔出库</span>
        </div>
        <div class="card"><div class="card-body" style="padding:0">
          ${rows.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>日期</th><th>兽药名称</th><th>规格</th><th>批号</th><th class="num">数量</th><th>领用单位</th><th>来源</th><th>经办人</th><th>来源说明</th><th></th></tr></thead>
            <tbody>${rows.map((r) => `<tr>
              <td class="mono">${esc(r.date)}</td>
              <td class="cell-strong">${esc(r.drugName)}</td>
              <td>${esc(r.spec)}</td>
              <td class="mono">${esc(r.batch)}</td>
              <td class="num">${fmtNum(r.quantity)}</td>
              <td>${esc(r.receivingUnit || "—")}</td>
              <td><span class="${srcClass(r.sourceType)}">${esc(r.sourceType)}</span></td>
              <td>${esc(r.handler)}</td>
              <td>${esc(r.note || "")}</td>
              <td><button class="btn btn-xs btn-danger" data-del-out="${r.id}">删</button></td>
            </tr>`).join("")}</tbody></table></div>` : emptyState("暂无出库记录")}
        </div></div>`;
      bindList();
    }
    function bindList() {
      $("#out-search").addEventListener("input", (e) => { q = e.target.value; renderList(); });
      $("#out-src").addEventListener("change", (e) => { srcFilter = e.target.value; renderList(); });
      $("#out-add").addEventListener("click", () => openOutboundForm());
      $$("[data-del-out]").forEach((b) => b.addEventListener("click", () => {
        if (confirm("确认删除该出库记录？")) { state.outbound = state.outbound.filter((x) => x.id !== b.dataset.delOut); save(); render(); toast("已删除"); }
      }));
    }
  }

  function openOutboundForm(rec) {
    const r = rec || {};
    const isEdit = !!rec;
    const srcType = r.sourceType || "领用单";
    openModal(isEdit ? "编辑出库" : "新增出库", `
      <div class="callout">出库来源说明：<b>领用单</b>按单发放；<b>私发</b>为未在领用单中的直接发放；<b>增补</b>为领用单之外额外补发；<b>其他</b>自定义。每笔均可在备注写明来源依据。</div>
      <div class="form-grid">
        <div class="field"><label>出库日期 <span class="req">*</span></label><input type="date" id="f-date" value="${esc(r.date || today())}"></div>
        <div class="field"><label>兽药名称 <span class="req">*</span></label><input list="dl-drugs" id="f-name" value="${esc(r.drugName || "")}"><datalist id="dl-drugs">${drugNameOptions()}</datalist></div>
        <div class="field"><label>规格</label><input id="f-spec" value="${esc(r.spec || "")}"></div>
        <div class="field"><label>类型</label><select id="f-type">${state.settings.drugTypes.map((t) => `<option ${t === (r.type || "疫苗") ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        <div class="field"><label>批号 <span class="req">*</span></label><input list="dl-batch" id="f-batch" value="${esc(r.batch || "")}"><datalist id="dl-batch">${batchOptions(r.drugName, r.spec)}</datalist></div>
        <div class="field"><label>数量 <span class="req">*</span></label><input type="number" min="0" step="any" id="f-qty" value="${esc(r.quantity != null ? r.quantity : "")}"></div>
        <div class="field"><label>单位</label><input list="dl-units" id="f-unit" value="${esc(r.unit || "瓶")}"><datalist id="dl-units">${unitOptions()}</datalist></div>
        <div class="field"><label>领用单位 <span class="req">*</span></label><input list="dl-units2" id="f-unit2" value="${esc(r.receivingUnit || "")}" placeholder="领用单位"><datalist id="dl-units2">${state.settings.receivingUnits.map((u) => `<option value="${esc(u)}">`).join("")}</datalist></div>
        <div class="field"><label>来源类型</label><select id="f-src">${["领用单", "私发", "增补", "其他"].map((t) => `<option ${t === srcType ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        <div class="field"><label>关联领用单</label><select id="f-slip"><option value="">— 不关联 —</option>${state.slips.map((s) => `<option value="${s.id}" ${r.slipId === s.id ? "selected" : ""}>${esc(s.code)} · ${esc(s.receivingUnit)}</option>`).join("")}</select></div>
        <div class="field"><label>经办人 <span class="req">*</span></label><input list="dl-h" id="f-handler" value="${esc(r.handler || (state.settings.handlers[0] || ""))}"><datalist id="dl-h">${handlerOptions()}</datalist></div>
        <div class="field" style="grid-column:1/-1"><label>来源说明 / 备注</label><textarea id="f-note" placeholder="如：领导特批直发、现场多领未计单、紧急补发等">${esc(r.note || "")}</textarea></div>
      </div>`, `
      <button class="btn btn-outline" id="m-cancel">取消</button>
      <button class="btn btn-accent" id="m-save">保存</button>`);
    $("#m-cancel").addEventListener("click", closeModal);
    $("#m-save").addEventListener("click", () => {
      const name = $("#f-name").value.trim();
      const batch = $("#f-batch").value.trim();
      const qty = parseFloat($("#f-qty").value);
      const date = $("#f-date").value;
      const handler = $("#f-handler").value.trim();
      const receivingUnit = $("#f-unit2").value.trim();
      const sourceType = $("#f-src").value;
      const slipId = $("#f-slip").value || null;
      if (!name || !batch || !(qty >= 0) || !date || !handler || !receivingUnit) { toast("请填写必填项（名称/批号/数量/日期/经办人/领用单位）"); return; }
      if (sourceType === "领用单" && !slipId) { toast("来源为「领用单」时请选择关联领用单"); return; }
      const recData = {
        date, drugName: name, spec: $("#f-spec").value.trim(), type: $("#f-type").value,
        batch, quantity: qty, unit: $("#f-unit").value.trim() || "瓶",
        receivingUnit, sourceType, slipId, handler, note: $("#f-note").value.trim(),
      };
      if (isEdit) { Object.assign(rec, recData); } else { recData.id = uid(); state.outbound.push(recData); }
      // 校验库存
      const inv = computeInventory().find((i) => i.drugName === name && i.spec === (recData.spec) && i.batch === batch);
      if (inv && inv.stock < 0) toast("⚠ 该批号出库后库存为负，请核查入库是否漏登");
      maybeAddDrug(recData);
      maybeAddHandler(handler);
      maybeAddUnit(receivingUnit);
      save(); closeModal(); render(); toast(isEdit ? "已更新" : "出库已登记");
    });
  }

  /* ============================================================
     视图：疫苗专项
     ============================================================ */
  function V_vaccine(root) {
    const inv = computeInventory().filter((i) => i.type === "疫苗");
    const expired = inv.filter((i) => i.expiry && daysUntil(i.expiry) < 0);
    const soon = inv.filter((i) => i.expiry && daysUntil(i.expiry) >= 0 && daysUntil(i.expiry) <= 90);
    root.innerHTML = `
      <div class="callout">疫苗属特殊管制兽用生物制品，需<b>批号级</b>管理与<b>有效期</b>预警，并遵循冷链储存要求。下表按批号展示账存与效期状态。</div>
      <div class="stat-grid">
        <div class="stat info"><div class="stat-label">疫苗批次</div><div class="stat-val">${inv.length}</div></div>
        <div class="stat ${expired.length ? "danger" : ""}"><div class="stat-label">已过期</div><div class="stat-val">${expired.length}</div><div class="stat-sub">${expired.length ? "须隔离停用" : "无"}</div></div>
        <div class="stat ${soon.length ? "warn" : ""}"><div class="stat-label">90天内临期</div><div class="stat-val">${soon.length}</div><div class="stat-sub">${soon.length ? "尽快先用" : "无"}</div></div>
        <div class="stat"><div class="stat-label">在库总量</div><div class="stat-val">${fmtNum(inv.reduce((a, b) => a + b.stock, 0))}</div></div>
      </div>
      <div class="card"><div class="card-body" style="padding:0">
        ${inv.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>兽药名称</th><th>规格</th><th>批号</th><th class="num">账存</th><th>储存条件</th><th>有效期</th><th>效期状态</th><th>最近入库</th></tr></thead>
          <tbody>${inv.map((i) => {
            const d = daysUntil(i.expiry);
            const st = !i.expiry ? '<span class="tag tag-gray">未填</span>' : d < 0 ? '<span class="tag tag-danger">已过期</span>' : d <= 90 ? `<span class="tag tag-warn">临期${d}天</span>` : `<span class="tag tag-green">正常${d}天</span>`;
            return `<tr><td class="cell-strong">${esc(i.drugName)}</td><td>${esc(i.spec)}</td><td class="mono">${esc(i.batch)}</td><td class="num">${fmtNum(i.stock)}</td><td>${esc(i.storageTemp || "—")}</td><td class="mono">${esc(i.expiry || "—")}</td><td>${st}</td><td class="mono">${esc(i.lastInbound)}</td></tr>`;
          }).join("")}</tbody></table></div>` : emptyState("暂无疫苗库存")}
      </div></div>`;
  }

  /* ============================================================
     视图：库存查询 + 批号追溯台账
     ============================================================ */
  function V_inventory(root) {
    let q = "";
    renderList();
    function renderList() {
      const inv = computeInventory().filter((i) => !q || (i.drugName + i.batch + i.spec).toLowerCase().includes(q.toLowerCase()));
      root.innerHTML = `
        <div class="toolbar">
          <input type="search" id="inv-search" placeholder="搜索兽药/批号" value="${esc(q)}">
          <span class="spacer"></span>
          <span class="db-stat">${inv.filter((i) => i.stock < 0).length} 个负库存 · ${inv.filter((i) => i.stock === 0).length} 个零库存</span>
        </div>
        <div class="card"><div class="card-body" style="padding:0">
          ${inv.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>兽药名称</th><th>类型</th><th>规格</th><th>批号</th><th class="num">入库</th><th class="num">出库</th><th class="num">账存</th><th>单位</th><th>效期</th><th>操作</th></tr></thead>
            <tbody>${inv.map((i) => `<tr class="${i.stock < 0 ? "diff-bad" : ""}">
              <td class="cell-strong">${esc(i.drugName)}</td>
              <td><span class="tag ${typeTagClass(i.type)}">${esc(i.type)}</span></td>
              <td>${esc(i.spec)}</td>
              <td class="mono">${esc(i.batch)}</td>
              <td class="num">${fmtNum(i.inboundQty)}</td>
              <td class="num">${fmtNum(i.outboundQty)}</td>
              <td class="num">${fmtNum(i.stock)}</td>
              <td>${esc(i.unit)}</td>
              <td>${expCell(i.expiry)}</td>
              <td><button class="btn btn-xs btn-soft" data-ledger="${esc(i.drugName)}||${esc(i.spec)}||${esc(i.batch)}">逐笔追溯</button></td>
            </tr>`).join("")}</tbody></table></div>` : emptyState("暂无库存")}
        </div></div>`;
      $("#inv-search").addEventListener("input", (e) => { q = e.target.value; renderList(); });
      $$("[data-ledger]").forEach((b) => b.addEventListener("click", () => openLedger(b.dataset.ledger)));
    }
  }

  function openLedger(key) {
    const [name, spec, batch] = key.split("||");
    const ins = state.inbound.filter((r) => r.drugName === name && r.spec === spec && r.batch === batch).sort((a, b) => a.date.localeCompare(b.date));
    const outs = state.outbound.filter((r) => r.drugName === name && r.spec === spec && r.batch === batch).sort((a, b) => a.date.localeCompare(b.date));
    // 合并并按日期排序，计算滚动结存
    const events = [];
    ins.forEach((r) => events.push({ date: r.date, io: "in", qty: r.quantity, handler: r.handler, ref: "入库", src: r.supplier || "", note: r.note }));
    outs.forEach((r) => events.push({ date: r.date, io: "out", qty: r.quantity, handler: r.handler, ref: r.sourceType === "领用单" ? "出库·" + (r.slipId ? "领用单" : "") : "出库·" + r.sourceType, src: r.receivingUnit || r.note || "", note: r.note }));
    events.sort((a, b) => a.date.localeCompare(b.date) || (a.io === "in" ? -1 : 1));
    let bal = 0;
    const rows = events.map((e) => { bal += e.io === "in" ? e.qty : -e.qty; return { ...e, bal }; });
    const dupIn = ins.length > 1;
    openModal(`批号追溯台账 · ${name} (${spec})`, `
      <div class="callout">批号 <b class="mono">${esc(batch)}</b> 全流向台账。入库为来源，出库逐笔标注来源（领用单/私发/增补）。滚动结存 = 累计入库 − 累计出库，用于定位账实差异落在哪一笔记账。</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>日期</th><th>业务</th><th>来源/去向</th><th class="num">数量</th><th class="num">结存</th><th>经办人</th><th>说明</th></tr></thead>
        <tbody>${rows.map((e) => `<tr>
          <td class="mono">${esc(e.date)}</td>
          <td>${e.io === "in" ? '<span class="tag tag-green">入库</span>' : '<span class="tag tag-orange">出库</span>'}</td>
          <td>${esc(e.src || "—")}</td>
          <td class="num">${e.io === "in" ? "+" : "−"}${fmtNum(e.qty)}</td>
          <td class="num ${e.bal < 0 ? "diff-bad" : ""}">${fmtNum(e.bal)}</td>
          <td>${esc(e.handler)}</td>
          <td>${esc(e.note || "")}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      <p class="hint" style="margin-top:10px">当前结存：<b>${fmtNum(bal)}</b> ${esc(ins[0]?.unit || "")}。${bal < 0 ? "⚠ 结存为负，存在出库多于入库，请核查是否漏登入库或重复出库。" : ""}${dupIn ? " ℹ 该批号存在多笔入库，已合并计入。" : ""}</p>
    `, `<button class="btn btn-primary" id="m-ok">关闭</button>`, true);
    $("#m-ok").addEventListener("click", closeModal);
  }

  /* ============================================================
     视图：领用单
     ============================================================ */
  function V_slips(root) {
    renderList();
    function renderList() {
      const slips = state.slips.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      root.innerHTML = `
        <div class="toolbar">
          <button class="btn btn-primary" id="slip-add">+ 新建领用单</button>
          <span class="spacer"></span>
          <span class="db-stat">共 ${state.slips.length} 张领用单</span>
        </div>
        <div class="card"><div class="card-body" style="padding:0">
          ${slips.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>单号</th><th>日期</th><th>领用单位</th><th>品项</th><th>经办人</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>${slips.map((s) => `<tr>
              <td class="mono cell-strong">${esc(s.code)}</td>
              <td class="mono">${esc(s.date)}</td>
              <td>${esc(s.receivingUnit)}</td>
              <td>${s.items.length} 项</td>
              <td>${esc(s.handler)}</td>
              <td>${esc(s.note || "")}</td>
              <td>
                <button class="btn btn-xs btn-soft" data-view-slip="${s.id}">查看</button>
                <button class="btn btn-xs btn-danger" data-del-slip="${s.id}">删</button>
              </td>
            </tr>`).join("")}</tbody></table></div>` : emptyState("暂无领用单，先创建一张")}
        </div></div>`;
      $("#slip-add").addEventListener("click", () => openSlipForm());
      $$("[data-view-slip]").forEach((b) => b.addEventListener("click", () => viewSlip(b.dataset.viewSlip)));
      $$("[data-del-slip]").forEach((b) => b.addEventListener("click", () => {
        if (confirm("删除领用单将同时解除其关联出库的引用，确认？")) {
          state.slips = state.slips.filter((x) => x.id !== b.dataset.delSlip);
          state.outbound.forEach((o) => { if (o.slipId === b.dataset.delSlip) o.slipId = null; });
          save(); render(); toast("已删除领用单");
        }
      }));
    }
  }

  function openSlipForm() {
    const slip = { id: uid(), code: "LY" + today().replace(/-/g, "") + "-" + String(state.slips.length + 1).padStart(2, "0"), date: today(), receivingUnit: state.settings.receivingUnits[0] || "", handler: state.settings.handlers[0] || "", note: "", items: [{ drugName: "", spec: "", unit: "瓶", expectedQty: "" }] };
    openModal("新建领用单", slipFormHtml(slip), `
      <button class="btn btn-outline" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-save">保存领用单</button>`, true);
    bindSlipForm(slip);
  }

  function viewSlip(id) {
    const s = state.slips.find((x) => x.id === id);
    if (!s) return;
    openModal("领用单 " + s.code, `
      <div class="form-grid" style="margin-bottom:12px">
        <div><b>单号</b><br><span class="mono">${esc(s.code)}</span></div>
        <div><b>日期</b><br>${esc(s.date)}</div>
        <div><b>领用单位</b><br>${esc(s.receivingUnit)}</div>
        <div><b>经办人</b><br>${esc(s.handler)}</div>
      </div>
      <p style="margin-bottom:8px">${esc(s.note || "")}</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>兽药名称</th><th>规格</th><th>单位</th><th class="num">计划数量</th></tr></thead>
        <tbody>${s.items.map((it) => `<tr><td class="cell-strong">${esc(it.drugName)}</td><td>${esc(it.spec)}</td><td>${esc(it.unit)}</td><td class="num">${fmtNum(it.expectedQty)}</td></tr>`).join("")}</tbody>
      </table></div>
      <div style="margin-top:14px;display:flex;gap:10px">
        <button class="btn btn-accent" id="slip-to-recon">去账实核对 →</button>
        <button class="btn btn-outline" id="slip-close">关闭</button>
      </div>
    `, "", true);
    $("#slip-close").addEventListener("click", closeModal);
    $("#slip-to-recon").addEventListener("click", () => { closeModal(); currentView = "reconcile"; render(); setTimeout(() => { const sel = $("#recon-slip"); if (sel) { sel.value = id; sel.dispatchEvent(new Event("change")); } }, 50); });
  }

  function slipFormHtml(slip) {
    return `
      <div class="form-grid">
        <div class="field"><label>单号</label><input id="s-code" value="${esc(slip.code)}"></div>
        <div class="field"><label>日期 <span class="req">*</span></label><input type="date" id="s-date" value="${esc(slip.date)}"></div>
        <div class="field"><label>领用单位 <span class="req">*</span></label><input list="s-units" id="s-unit" value="${esc(slip.receivingUnit)}"><datalist id="s-units">${state.settings.receivingUnits.map((u) => `<option value="${esc(u)}">`).join("")}</datalist></div>
        <div class="field"><label>经办人</label><input list="s-h" id="s-handler" value="${esc(slip.handler)}"><datalist id="s-h">${handlerOptions()}</datalist></div>
        <div class="field" style="grid-column:1/-1"><label>备注</label><input id="s-note" value="${esc(slip.note)}"></div>
      </div>
      <div class="section-title">领用明细</div>
      <div id="s-items">${slip.items.map((it, i) => slipLineHtml(it, i)).join("")}</div>
      <button class="btn btn-soft btn-sm" id="s-add-line" style="margin-top:6px">+ 增加一项</button>
    `;
  }
  function slipLineHtml(it, i) {
    return `<div class="line-item" data-line="${i}">
      <div class="field"><label>兽药名称</label><input list="dl-drugs" data-k="drugName" value="${esc(it.drugName)}"><datalist id="dl-drugs">${drugNameOptions()}</datalist></div>
      <div class="field"><label>规格</label><input data-k="spec" value="${esc(it.spec)}"></div>
      <div class="field"><label>单位</label><input list="dl-u" data-k="unit" value="${esc(it.unit)}"><datalist id="dl-u">${unitOptions()}</datalist></div>
      <div class="field"><label>计划数量</label><input type="number" min="0" step="any" data-k="expectedQty" value="${esc(it.expectedQty)}"></div>
      <div class="col-del"><button class="line-del" data-del-line="${i}">×</button></div>
    </div>`;
  }
  function bindSlipForm(slip) {
    $("#m-cancel").addEventListener("click", closeModal);
    function reindex() { $$("#s-items .line-item").forEach((el, i) => { el.dataset.line = i; const del = el.querySelector("[data-del-line]"); if (del) del.dataset.delLine = i; }); }
    $("#s-add-line").addEventListener("click", () => {
      const wrap = $("#s-items");
      const idx = wrap.children.length;
      const div = document.createElement("div");
      div.innerHTML = slipLineHtml({ drugName: "", spec: "", unit: "瓶", expectedQty: "" }, idx);
      wrap.appendChild(div.firstElementChild);
      div.firstElementChild.querySelector("[data-del-line]").addEventListener("click", function () { this.closest(".line-item").remove(); reindex(); });
    });
    $$("[data-del-line]").forEach((b) => b.addEventListener("click", function () { this.closest(".line-item").remove(); reindex(); }));
    $("#m-save").addEventListener("click", () => {
      const date = $("#s-date").value;
      const receivingUnit = $("#s-unit").value.trim();
      if (!date || !receivingUnit) { toast("请填写日期与领用单位"); return; }
      const items = Array.from($$("#s-items .line-item")).map((el) => ({
        drugName: el.querySelector('[data-k="drugName"]').value.trim(),
        spec: el.querySelector('[data-k="spec"]').value.trim(),
        unit: el.querySelector('[data-k="unit"]').value.trim() || "瓶",
        expectedQty: parseFloat(el.querySelector('[data-k="expectedQty"]').value) || 0,
      })).filter((it) => it.drugName);
      if (!items.length) { toast("请至少填写一项领用明细"); return; }
      slip.code = $("#s-code").value.trim() || slip.code;
      slip.date = date; slip.receivingUnit = receivingUnit; slip.handler = $("#s-handler").value.trim();
      slip.note = $("#s-note").value.trim(); slip.items = items;
      state.slips.push(slip);
      maybeAddUnit(receivingUnit);
      save(); closeModal(); render(); toast("领用单已保存");
    });
  }

  /* ============================================================
     视图：账实核对（核心）
     ============================================================ */
  function V_reconcile(root) {
    if (!state.slips.length) {
      root.innerHTML = `<div class="card"><div class="card-body">${emptyState("请先在「领用单」中创建领用单，再进行账实核对")}</div></div>`;
      return;
    }
    root.innerHTML = `
      <div class="callout">选择一张领用单，系统将<b>领用单计划明细</b>与<b>实际出库记录</b>逐笔关联比对，自动标注 <b class="diff-ok">一致</b> / <b class="diff-bad">短少</b> / <b class="diff-warn">溢发</b> / <b class="diff-bad">未发</b>，并单列该单位的<b>私发 / 增补</b>等非单来源出库，帮助快速定位账实差异来源。</div>
      <div class="toolbar">
        <label>选择领用单：</label>
        <select id="recon-slip" style="min-width:280px">${state.slips.map((s) => `<option value="${s.id}">${esc(s.code)} · ${esc(s.receivingUnit)} · ${esc(s.date)}</option>`).join("")}</select>
      </div>
      <div id="recon-result"></div>
    `;
    const sel = $("#recon-slip");
    sel.addEventListener("change", () => renderRecon(sel.value, $("#recon-result")));
    renderRecon(sel.value, $("#recon-result"));
  }

  function renderRecon(slipId, container) {
    const slip = state.slips.find((s) => s.id === slipId);
    if (!slip) { container.innerHTML = emptyState("领用单不存在"); return; }
    // 该单实际出库（按 slipId 关联）
    const linked = state.outbound.filter((o) => o.slipId === slipId);
    // 按 兽药+规格 聚合实际数量
    const actualMap = {};
    linked.forEach((o) => { const k = o.drugName + "||" + o.spec; actualMap[k] = (actualMap[k] || 0) + (Number(o.quantity) || 0); });
    // 该单位、未关联本单的出库（私发/增补/其他单）=> 额外出库
    const extra = state.outbound.filter((o) => o.receivingUnit === slip.receivingUnit && o.slipId !== slipId);

    let okN = 0, shortN = 0, overN = 0, missN = 0;
    const itemRows = slip.items.map((it) => {
      const actual = actualMap[it.drugName + "||" + it.spec] || 0;
      const diff = actual - Number(it.expectedQty);
      let status, cls;
      if (actual === 0) { status = "未发"; cls = "diff-bad"; missN++; }
      else if (diff < 0) { status = "短少 " + fmtNum(-diff); cls = "diff-bad"; shortN++; }
      else if (diff > 0) { status = "溢发 " + fmtNum(diff); cls = "diff-warn"; overN++; }
      else { status = "一致"; cls = "diff-ok"; okN++; }
      return `<tr>
        <td class="cell-strong">${esc(it.drugName)}</td>
        <td>${esc(it.spec)}</td>
        <td>${esc(it.unit)}</td>
        <td class="num">${fmtNum(it.expectedQty)}</td>
        <td class="num">${fmtNum(actual)}</td>
        <td class="num ${cls}">${cls === "diff-ok" ? "0" : fmtNum(diff)}</td>
        <td class="${cls}">${status}</td>
      </tr>`;
    }).join("");

    const extraRows = extra.length ? extra.map((o) => `<tr>
      <td class="mono">${esc(o.date)}</td>
      <td class="cell-strong">${esc(o.drugName)}</td>
      <td>${esc(o.spec)}</td>
      <td class="mono">${esc(o.batch)}</td>
      <td class="num">${fmtNum(o.quantity)}</td>
      <td><span class="${srcClass(o.sourceType)}">${esc(o.sourceType)}</span></td>
      <td>${esc(o.note || "—")}</td>
      <td>${esc(o.handler)}</td>
    </tr>`).join("") : `<tr><td colspan="8" style="color:var(--text-faint);text-align:center;padding:14px">该单位无领用单之外的出库（无私发/增补）</td></tr>`;

    container.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">领用单项数</div><div class="stat-val">${slip.items.length}</div></div>
        <div class="stat"><div class="stat-label">一致</div><div class="stat-val diff-ok">${okN}</div></div>
        <div class="stat danger"><div class="stat-label">短少/未发</div><div class="stat-val">${shortN + missN}</div></div>
        <div class="stat warn"><div class="stat-label">溢发</div><div class="stat-val">${overN}</div></div>
        <div class="stat info"><div class="stat-label">额外出库(私发/增补)</div><div class="stat-val">${extra.length}</div></div>
      </div>

      <div class="card" style="margin-bottom:18px">
        <div class="card-head"><h3>领用单明细 vs 实际出库</h3><span class="db-stat">${esc(slip.code)} · ${esc(slip.receivingUnit)}</span></div>
        <div class="card-body" style="padding:0">
          <div class="legend">
            <span><span class="dot" style="background:var(--primary)"></span>一致：实发=计划</span>
            <span><span class="dot" style="background:var(--danger)"></span>短少/未发：实发<计划</span>
            <span><span class="dot" style="background:var(--warn)"></span>溢发：实发>计划</span>
          </div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>兽药名称</th><th>规格</th><th>单位</th><th class="num">计划</th><th class="num">实发</th><th class="num">差异</th><th>核对结论</th></tr></thead>
            <tbody>${itemRows}</tbody>
          </table></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>该单位「领用单之外」出库（私发 / 增补）</h3><span class="db-stat">差异来源重点排查区</span></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap"><table class="data">
            <thead><tr><th>日期</th><th>兽药名称</th><th>规格</th><th>批号</th><th class="num">数量</th><th>来源</th><th>来源说明</th><th>经办人</th></tr></thead>
            <tbody>${extraRows}</tbody>
          </table></div>
          <p class="hint" style="margin-top:10px">说明：领用单之外的出库（私发/增补）虽属合规场景，但若未同步登记领用单，会造成「账面无对应单据」的账实不符假象。建议对每笔填写来源说明，必要时补开领用单。</p>
        </div>
      </div>
    `;
  }

  /* ============================================================
     视图：设置
     ============================================================ */
  function V_settings(root) {
    const s = state.settings;
    root.innerHTML = `
      <div class="card" style="margin-bottom:18px">
        <div class="card-head"><h3>经办人</h3></div>
        <div class="card-body">
          <div id="set-handlers" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            ${s.handlers.map((h) => chip(h, "handler")).join("")}
          </div>
          <div style="display:flex;gap:8px"><input id="new-handler" placeholder="新增经办人" style="padding:8px 11px;border:1px solid var(--border-strong);border-radius:9px;flex:1"><button class="btn btn-soft btn-sm" id="add-handler">添加</button></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:18px">
        <div class="card-head"><h3>领用单位</h3></div>
        <div class="card-body">
          <div id="set-units" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            ${s.receivingUnits.map((u) => chip(u, "unit")).join("")}
          </div>
          <div style="display:flex;gap:8px"><input id="new-unit" placeholder="新增领用单位" style="padding:8px 11px;border:1px solid var(--border-strong);border-radius:9px;flex:1"><button class="btn btn-soft btn-sm" id="add-unit">添加</button></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:18px">
        <div class="card-head"><h3>计量单位</h3></div>
        <div class="card-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${s.units.map((u) => chip(u, "uom")).join("")}</div>
          <div style="display:flex;gap:8px"><input id="new-uom" placeholder="新增单位" style="padding:8px 11px;border:1px solid var(--border-strong);border-radius:9px;flex:1"><button class="btn btn-soft btn-sm" id="add-uom">添加</button></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>兽药目录（用于快速录入与疫苗默认参数）</h3></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap"><table class="data">
            <thead><tr><th>兽药名称</th><th>规格</th><th>类型</th><th>单位</th><th>储存条件</th><th>有效期(天)</th><th></th></tr></thead>
            <tbody id="drug-catalog">${s.drugs.map((d) => drugRow(d)).join("") || `<tr><td colspan="7" style="text-align:center;color:var(--text-faint);padding:14px">暂无目录，录入记录时会自动收录</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>
    `;
    // 绑定
    $("#add-handler").addEventListener("click", () => { const v = $("#new-handler").value.trim(); if (v && !s.handlers.includes(v)) { s.handlers.push(v); save(); render(); } $("#new-handler").value = ""; });
    $("#add-unit").addEventListener("click", () => { const v = $("#new-unit").value.trim(); if (v && !s.receivingUnits.includes(v)) { s.receivingUnits.push(v); save(); render(); } $("#new-unit").value = ""; });
    $("#add-uom").addEventListener("click", () => { const v = $("#new-uom").value.trim(); if (v && !s.units.includes(v)) { s.units.push(v); save(); render(); } $("#new-uom").value = ""; });
    bindChips();
    bindDrugCatalog();
  }
  function chip(v, kind) {
    return `<span class="tag tag-gray" style="padding:5px 10px;font-size:13px">${esc(v)} <button class="chip-x" data-del="${kind}" data-val="${esc(v)}" style="background:none;border:none;color:inherit;cursor:pointer;margin-left:4px;font-size:14px">×</button></span>`;
  }
  function bindChips() {
    $$("[data-del]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.del, v = b.dataset.val;
      if (k === "handler") state.settings.handlers = state.settings.handlers.filter((x) => x !== v);
      if (k === "unit") state.settings.receivingUnits = state.settings.receivingUnits.filter((x) => x !== v);
      if (k === "uom") state.settings.units = state.settings.units.filter((x) => x !== v);
      save(); render();
    }));
  }
  function drugRow(d) {
    return `<tr data-drug="${d.id}">
      <td><input class="cat-in" data-f="name" value="${esc(d.name)}" style="width:130px"></td>
      <td><input class="cat-in" data-f="spec" value="${esc(d.spec)}" style="width:100px"></td>
      <td><select class="cat-in" data-f="type">${state.settings.drugTypes.map((t) => `<option ${t === d.type ? "selected" : ""}>${t}</option>`).join("")}</select></td>
      <td><input class="cat-in" data-f="unit" value="${esc(d.unit)}" style="width:60px"></td>
      <td><input class="cat-in" data-f="storageTemp" value="${esc(d.storageTemp)}" style="width:110px" placeholder="如：冷藏2-8℃"></td>
      <td><input class="cat-in" data-f="validityDays" type="number" value="${esc(d.validityDays)}" style="width:70px"></td>
      <td><button class="btn btn-xs btn-danger" data-del-drug="${d.id}">删</button></td>
    </tr>`;
  }
  function bindDrugCatalog() {
    $$(".cat-in").forEach((el) => el.addEventListener("change", () => {
      const id = el.closest("tr").dataset.drug;
      const d = state.settings.drugs.find((x) => x.id === id);
      if (d) { d[el.dataset.f] = el.type === "number" ? (parseInt(el.value) || 0) : el.value.trim(); save(); }
    }));
    $$("[data-del-drug]").forEach((b) => b.addEventListener("click", () => {
      state.settings.drugs = state.settings.drugs.filter((x) => x.id !== b.dataset.delDrug); save(); render();
    }));
  }

  /* ============================================================
     视图：数据备份（导出/导入）
     ============================================================ */
  function V_data(root) {
    root.innerHTML = `
      <div class="callout">所有数据保存在本机浏览器（localStorage）。建议<b>定期导出备份</b>，用于事后核查、交接或防止误删。CSV 可用于 Excel 进一步分析；JSON 为完整备份可原样导入恢复。</div>
      <div class="card" style="margin-bottom:18px">
        <div class="card-head"><h3>导出</h3></div>
        <div class="card-body" style="display:flex;gap:12px;flex-wrap:wrap">
          <button class="btn btn-primary" id="ex-inv">导出库存 CSV</button>
          <button class="btn btn-primary" id="ex-in">导出入库 CSV</button>
          <button class="btn btn-primary" id="ex-out">出库出库 CSV</button>
          <button class="btn btn-accent" id="ex-json">完整备份 JSON</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>导入 / 恢复</h3></div>
        <div class="card-body">
          <p class="hint" style="margin-bottom:10px">导入 JSON 备份将<b>覆盖</b>当前数据；请先导出当前数据以防丢失。</p>
          <input type="file" id="imp-file" accept=".json,application/json">
          <button class="btn btn-outline" id="imp-btn" style="margin-top:10px">导入并恢复</button>
        </div>
      </div>
      <div class="card" style="margin-top:18px">
        <div class="card-head"><h3>清空数据</h3></div>
        <div class="card-body">
          <button class="btn btn-danger" id="clear-all">清空全部本地数据</button>
          <p class="hint" style="margin-top:8px">仅清空当前浏览器数据，不影响已导出的备份文件。</p>
        </div>
      </div>
    `;
    $("#ex-inv").addEventListener("click", () => exportCSV("库存", computeInventory().map((i) => ({ 兽药名称: i.drugName, 类型: i.type, 规格: i.spec, 批号: i.batch, 入库: i.inboundQty, 出库: i.outboundQty, 账存: i.stock, 单位: i.unit, 有效期: i.expiry || "", 储存条件: i.storageTemp || "" }))));
    $("#ex-in").addEventListener("click", () => exportCSV("入库", state.inbound.map((r) => ({ 日期: r.date, 兽药名称: r.drugName, 规格: r.spec, 类型: r.type, 批号: r.batch, 数量: r.quantity, 单位: r.unit, 有效期: r.expiry || "", 供货方: r.supplier || "", 经办人: r.handler, 备注: r.note || "" }))));
    $("#ex-out").addEventListener("click", () => exportCSV("出库", state.outbound.map((r) => ({ 日期: r.date, 兽药名称: r.drugName, 规格: r.spec, 类型: r.type, 批号: r.batch, 数量: r.quantity, 单位: r.unit, 领用单位: r.receivingUnit || "", 来源类型: r.sourceType, 关联单: r.slipId || "", 经办人: r.handler, 来源说明: r.note || "" }))));
    $("#ex-json").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      download(blob, "兽药台账备份_" + today() + ".json");
      toast("已导出完整备份");
    });
    $("#imp-btn").addEventListener("click", () => {
      const f = $("#imp-file").files[0];
      if (!f) { toast("请先选择 JSON 备份文件"); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try { const s = JSON.parse(reader.result); if (!s.settings) throw 0; state = s; REPLACE_NEXT = true; save(); render(); toast("导入成功（已同步至服务器）"); }
        catch (e) { toast("文件格式不正确，导入失败"); }
      };
      reader.readAsText(f);
    });
    $("#clear-all").addEventListener("click", () => {
      if (confirm("确认清空全部数据？将同时清空服务器（请先备份）")) { localStorage.removeItem(STORE_KEY); state = defaultState(); REPLACE_NEXT = true; save(); render(); toast("已清空（服务器同步清空）"); }
    });
  }

  function exportCSV(name, rows) {
    if (!rows.length) { toast("无数据可导出"); return; }
    const cols = Object.keys(rows[0]);
    const head = "﻿" + cols.join(",");
    const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
    download(new Blob([head + "\n" + body], { type: "text/csv;charset=utf-8" }), name + "_" + today() + ".csv");
    toast("已导出 " + name);
  }
  function csvCell(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function download(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------------- 辅助：自动收录 ---------------- */
  function maybeAddDrug(r) {
    const exists = state.settings.drugs.some((d) => d.name === r.drugName && d.spec === r.spec);
    if (!exists) state.settings.drugs.push({ id: uid(), name: r.drugName, spec: r.spec, type: r.type, unit: r.unit, storageTemp: "", validityDays: 0 });
  }
  function maybeAddHandler(h) { if (h && !state.settings.handlers.includes(h)) state.settings.handlers.push(h); }
  function maybeAddUnit(u) { if (u && !state.settings.receivingUnits.includes(u)) state.settings.receivingUnits.push(u); }

  /* ---------------- 小部件 ---------------- */
  function emptyState(msg) { return `<div class="empty"><div class="empty-ic">▤</div>${esc(msg)}</div>`; }
  function expCell(expiry) {
    if (!expiry) return "—";
    const d = daysUntil(expiry);
    const cls = d < 0 ? "diff-bad" : d <= 90 ? "diff-warn" : "";
    return `<span class="${cls} mono">${esc(expiry)}</span>`;
  }

  /* ---------------- 视图路由表 ---------------- */
  const VIEWS = { dashboard: V_dashboard, inbound: V_inbound, outbound: V_outbound, vaccine: V_vaccine, inventory: V_inventory, slips: V_slips, reconcile: V_reconcile, settings: V_settings, data: V_data };

  /* ---------------- 导航绑定 ---------------- */
  $$(".nav-item").forEach((n) => n.addEventListener("click", () => {
    currentView = n.dataset.view; render();
    closeDrawer(); // 移动端点选后收起抽屉
  }));
  $("#btn-sample").addEventListener("click", () => {
    if (state.inbound.length || state.outbound.length) { if (!confirm("载入示例数据将覆盖当前数据，确认？")) return; }
    loadSample(); render(); toast("示例数据已载入，可前往「账实核对」体验差异追溯");
  });
  $("#btn-sync").addEventListener("click", () => Sync.push(false));

  /* ---------------- 移动端抽屉 ---------------- */
  const drawer = $("#sidebar"), overlay = $("#drawer-overlay");
  function openDrawer() { drawer.classList.add("open"); overlay.hidden = false; }
  function closeDrawer() { drawer.classList.remove("open"); overlay.hidden = true; }
  $("#hamburger").addEventListener("click", openDrawer);
  overlay.addEventListener("click", closeDrawer);

  /* ---------------- 启动 ---------------- */
  function boot() {
    render();        // 先用本地缓存即时渲染
    Sync.init();     // 与服务器对齐（拉取远端、定时同步）
  }
  boot();
})();
