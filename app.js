// Nudge — 自分専用の TODO リスト（外部ライブラリなし）
// データは端末の localStorage に置き、GitHub の非公開リポジトリの tasks.json と同期する。
"use strict";

(() => {
  const APP_VERSION = 1;          // データの形の版。これより大きいデータには書かない
  const K = { data: "nudge:data", meta: "nudge:meta", settings: "nudge:settings", ui: "nudge:ui" };
  const TASK_FIELDS = ["title", "due", "category", "done", "deleted"];
  const CAT_FIELDS = ["name", "color", "order", "deleted"];
  const COMPANION = { done: ["doneAt"], deleted: ["deletedAt"] };
  const ZERO = "000000000000000:0";
  const TOMB_SHRINK_MS = 60 * 1000;            // 消してから1分たったら中身を捨てて墓石だけにする
  const TOMB_KEEP_MS = 365 * 24 * 3600 * 1000; // 墓石は1年残す
  const COLORS = ["purple", "green", "gray", "blue", "teal", "pink", "indigo", "brown"];
  const COLOR_NAMES = { purple: "紫", green: "緑", gray: "灰", blue: "青", teal: "青緑", pink: "桃", indigo: "藍", brown: "茶" };
  const DEFAULT_CATS = [
    { id: "sotsuken", name: "卒研", color: "purple", order: 0 },
    { id: "nyusha", name: "入社準備", color: "green", order: 1 },
    { id: "other", name: "その他", color: "gray", order: 2 }
  ];
  const SECTIONS = [
    { key: "overdue", label: "期限切れ" },
    { key: "today", label: "今日" },
    { key: "tomorrow", label: "明日" },
    { key: "week", label: "1週間以内" },
    { key: "later", label: "それ以降" },
    { key: "nodate", label: "期日なし" }
  ];
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const isDev = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const API = isDev ? location.origin + "/api" : "https://api.github.com";

  // ---------- 保存（localStorage） ----------
  let storageOk = true;      // localStorage が使えるか
  let dataBroken = false;    // 中身が読めなかったら、上書きしない
  const memStore = {};
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { storageOk = false; return memStore[key] ?? null; }
  }
  function lsSet(key, val) {
    memStore[key] = val;
    try { localStorage.setItem(key, val); } catch (e) { storageOk = false; }
  }
  function readJSON(key, fallback) {
    const s = lsGet(key);
    if (s == null) return fallback;
    try { return JSON.parse(s); } catch (e) { return undefined; }
  }

  function defaultData() {
    return {
      version: APP_VERSION,
      tasks: [],
      categories: DEFAULT_CATS.map((c) => ({ ...c, deleted: false, t: {} }))
    };
  }
  function loadData() {
    const d = readJSON(K.data, null);
    if (d === undefined || (d && (!Array.isArray(d.tasks) || !Array.isArray(d.categories)))) {
      dataBroken = true;
      return defaultData();
    }
    if (!d) return defaultData();
    if (d.version > APP_VERSION) dataBroken = true;
    return d;
  }
  function saveData(d) {
    if (dataBroken) return false;
    lsSet(K.data, JSON.stringify(d));
    return true;
  }
  function getMeta() {
    const m = readJSON(K.meta, null) || {};
    if (!m.deviceId) {
      m.deviceId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 8);
      lsSet(K.meta, JSON.stringify(m));
    }
    return Object.assign({ lastSeen: 0, lastSyncAt: 0, dirtySeq: 0, syncedSeq: 0, sha: null, lastResult: null, lastSyncTime: null }, m);
  }
  function setMeta(patch) {
    const m = Object.assign(getMeta(), patch);
    lsSet(K.meta, JSON.stringify(m));
    return m;
  }
  function getSettings() { return readJSON(K.settings, null) || {}; }
  function setSettings(s) { lsSet(K.settings, JSON.stringify(s)); }
  function getUI() { return readJSON(K.ui, null) || {}; }
  function setUI(patch) { lsSet(K.ui, JSON.stringify(Object.assign(getUI(), patch))); }

  // ---------- 時刻（項目ごとの更新時刻） ----------
  // 形: "000001763350000000:端末ID"（15桁のミリ秒 + 端末ID）。文字列の大小で新しさを比べる
  function tick() {
    const m = getMeta();
    const ms = Math.max(Date.now(), (m.lastSeen || 0) + 1);
    setMeta({ lastSeen: ms });
    return ms;
  }
  function stamp() { return String(tick()).padStart(15, "0") + ":" + getMeta().deviceId; }
  const stampMs = (s) => parseInt(String(s || ZERO).slice(0, 15), 10) || 0;
  const st = (o, f) => (o && o.t && o.t[f]) || ZERO;
  function maxStamp(o) {
    let m = 0;
    for (const v of Object.values((o && o.t) || {})) m = Math.max(m, stampMs(v));
    return m;
  }

  // ---------- マージ（項目ごとに新しいほうを残す） ----------
  function mergeItem(a, b, fields) {
    if (!a) return JSON.parse(JSON.stringify(b));
    if (!b) return JSON.parse(JSON.stringify(a));
    const r = Object.assign({}, b, a); // 知らない項目も残す
    r.t = Object.assign({}, b.t || {}, a.t || {});
    for (const f of fields) {
      const w = st(a, f) >= st(b, f) ? a : b;
      for (const k of [f, ...(COMPANION[f] || [])]) {
        if (k in w) r[k] = w[k]; else delete r[k];
      }
      if (w.t && w.t[f]) r.t[f] = w.t[f]; else delete r.t[f];
    }
    return r;
  }
  function shrink(item, now) {
    if (!item.deleted) return item;
    const at = item.deletedAt ? Date.parse(item.deletedAt) : stampMs(st(item, "deleted"));
    if (now - at < TOMB_SHRINK_MS) return item;
    return { id: item.id, deleted: true, deletedAt: item.deletedAt || new Date(at).toISOString(), t: { deleted: st(item, "deleted") } };
  }
  function tombExpired(item, now) {
    if (!item.deleted) return false;
    const at = item.deletedAt ? Date.parse(item.deletedAt) : stampMs(st(item, "deleted"));
    return now - at > TOMB_KEEP_MS;
  }
  function mergeList(local, remote, fields, lastSyncAt, now) {
    const map = new Map();
    const remoteIds = new Set((remote || []).map((x) => x.id));
    for (const x of remote || []) map.set(x.id, x);
    const out = [];
    const seen = new Set();
    for (const a of local) {
      seen.add(a.id);
      const b = map.get(a.id);
      // 手元にだけあり、最後の同期より古いもの = ほかの端末で墓石まで片付いたもの。捨てる
      if (!b && remote && lastSyncAt && !remoteIds.has(a.id) && maxStamp(a) < lastSyncAt) continue;
      out.push(mergeItem(a, b, fields));
    }
    for (const b of remote || []) if (!seen.has(b.id)) out.push(JSON.parse(JSON.stringify(b)));
    return out.filter((x) => !tombExpired(x, now)).map((x) => shrink(x, now));
  }
  function mergeData(local, remote, lastSyncAt) {
    const now = Date.now();
    const r = remote || null;
    const merged = Object.assign({}, r || {}, local);
    merged.version = APP_VERSION;
    merged.tasks = mergeList(local.tasks || [], r && r.tasks, TASK_FIELDS, lastSyncAt, now);
    merged.categories = mergeList(local.categories || [], r && r.categories, CAT_FIELDS, lastSyncAt, now);
    for (const c of DEFAULT_CATS) { // 最初の3つは必ずある（決まった id）
      if (!merged.categories.some((x) => x.id === c.id)) merged.categories.push({ ...c, deleted: false, t: {} });
    }
    return merged;
  }
  function seenMax(d) {
    let m = 0;
    for (const x of [...(d.tasks || []), ...(d.categories || [])]) m = Math.max(m, maxStamp(x));
    return m;
  }

  // 並びと鍵の順を決めた JSON（同じ中身なら同じ文字列になる）
  function sortDeep(v) {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortDeep(v[k]);
      return o;
    }
    return v;
  }
  function canonical(d) {
    if (!d) return "";
    const c = Object.assign({}, d);
    c.tasks = [...(d.tasks || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    c.categories = [...(d.categories || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    return JSON.stringify(sortDeep(c), null, 1);
  }

  // ---------- 状態 ----------
  let data = loadData();
  let selectedTab = getUI().tab || "all";
  let showDone = !!getUI().showDone;
  let draftDue = null;
  let draftCat = null;
  let draftCatAuto = false; // 絞り込みから自動で入れたカテゴリか
  let flashId = null;
  let checkingIds = new Set();
  let syncing = false;
  let lastError = null;    // { kind: 'offline'|'auth'|'notfound'|'other'|'newer', msg }

  function reload() { data = loadData(); }

  function mutate(fn) {
    reload();
    if (dataBroken) { render(); return; }
    fn(data);
    saveData(data);
    const m = getMeta();
    setMeta({ dirtySeq: (m.dirtySeq || 0) + 1 });
    render();
    scheduleSync();
  }

  function catList(includeDeleted) {
    return (data.categories || []).filter((c) => includeDeleted || !c.deleted)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.name).localeCompare(String(b.name), "ja"));
  }
  function catOf(task) {
    const c = (data.categories || []).find((x) => x.id === task.category && !x.deleted);
    return c || (data.categories || []).find((x) => x.id === "other") || DEFAULT_CATS[2];
  }
  function liveTasks() { return (data.tasks || []).filter((t) => !t.deleted && typeof t.title === "string"); }

  // ---------- 日付（端末の時刻で YYYY-MM-DD を作り、文字列で比べる） ----------
  const pad = (n) => String(n).padStart(2, "0");
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function addDays(base, n) { const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + n); return d; }
  function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function dayDiff(a, b) { // b - a（日）
    const pa = a.split("-").map(Number), pb = b.split("-").map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }
  function todayYmd() { return ymd(new Date()); }
  function sectionOf(due, today) {
    if (!due) return "nodate";
    const diff = dayDiff(today, due);
    if (diff < 0) return "overdue";
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff <= 7) return "week";
    return "later";
  }
  function shortDate(s) {
    const d = parseYmd(s);
    const y = d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + "/" : "";
    return y + (d.getMonth() + 1) + "/" + d.getDate() + "(" + WD[d.getDay()] + ")";
  }
  function dueLabel(due, today) {
    const sec = sectionOf(due, today);
    if (sec === "overdue") return -dayDiff(today, due) + "日超過";
    if (sec === "today") return "今日";
    if (sec === "tomorrow") return "明日";
    if (sec === "week") return WD[parseYmd(due).getDay()] + "曜";
    if (sec === "later") return shortDate(due);
    return "";
  }
  function nextMonday() {
    const now = new Date();
    const n = ((8 - now.getDay()) % 7) || 7;
    return ymd(addDays(now, n));
  }
  function pickLabel(due) {
    if (!due) return "";
    const today = todayYmd();
    const diff = dayDiff(today, due);
    if (diff === 0) return "今日";
    if (diff === 1) return "明日";
    return shortDate(due);
  }

  // ---------- DOM の小道具 ----------
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids) if (kid != null && kid !== false) e.append(kid);
    return e;
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function icon(name) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("class", "ic");
    s.setAttribute("aria-hidden", "true");
    const u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", "#i-" + name);
    s.append(u);
    return s;
  }
  function chip(cat) { return el("span", { class: "chip c-" + (COLORS.includes(cat.color) ? cat.color : "gray"), text: cat.name }); }

  // ---------- 描画 ----------
  function renderTabs() {
    const tabs = $("tabs");
    tabs.textContent = "";
    const cats = catList();
    if (selectedTab !== "all" && !cats.some((c) => c.id === selectedTab)) selectedTab = "all";
    const mk = (id, name) => el("button", {
      class: "tab", type: "button", role: "tab", "aria-selected": String(selectedTab === id),
      onclick: () => selectTab(id)
    }, name);
    tabs.append(mk("all", "すべて"));
    for (const c of cats) tabs.append(mk(c.id, c.name));
  }

  function selectTab(id) {
    selectedTab = id;
    setUI({ tab: id });
    if (id === "all") {
      if (draftCatAuto) { draftCat = null; draftCatAuto = false; }
    } else if (!draftCat || draftCatAuto) {
      draftCat = id; draftCatAuto = true;
    }
    renderComposer();
    render();
    const btn = [...$("tabs").children].find((b) => b.getAttribute("aria-selected") === "true");
    if (btn) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function taskRow(t, today, filtered) {
    const sec = t.done ? "done" : sectionOf(t.due, today);
    const cls = ["row"];
    if (t.done) cls.push("done");
    else if (sec === "overdue" || sec === "today") cls.push(sec);
    if (checkingIds.has(t.id)) cls.push("checking");
    const meta = el("span", { class: "meta" });
    if (!filtered) meta.append(chip(catOf(t)));
    if (t.due) {
      const label = t.done ? shortDate(t.due) : dueLabel(t.due, today);
      meta.append(el("span", { class: "due " + (t.done ? "" : sec), text: label }));
    }
    const ring = el("span", { class: "ring" }, icon("check"));
    const row = el("li", { class: cls.join(" "), "data-id": t.id },
      el("button", {
        class: "check", type: "button",
        "aria-label": t.done ? "「" + t.title + "」を未完了に戻す" : "「" + t.title + "」を完了にする",
        onclick: () => (t.done ? undoneTask(t.id) : completeTask(t.id))
      }, ring),
      el("button", { class: "body", type: "button", "aria-label": "「" + t.title + "」を編集", onclick: () => openEdit(t.id) },
        el("span", { class: "title", text: t.title }),
        meta)
    );
    return row;
  }

  function render() {
    renderTabs();
    renderBanner();
    const list = $("list");
    const scroll = list.scrollTop;
    list.textContent = "";
    const today = todayYmd();
    const filtered = selectedTab !== "all";
    const all = liveTasks();
    const inTab = filtered ? all.filter((t) => catOf(t).id === selectedTab) : all;
    const open = inTab.filter((t) => !t.done || checkingIds.has(t.id));
    const done = inTab.filter((t) => t.done && !checkingIds.has(t.id))
      .sort((a, b) => String(b.doneAt || "").localeCompare(String(a.doneAt || "")));

    if (open.length === 0) {
      let msg;
      if (all.length === 0) {
        msg = el("div", { class: "empty" },
          el("strong", { text: "まだ TODO がありません" }),
          "下の欄に書いて、送るボタンで追加します。",
          el("br"),
          getSettings().token ? null : el("button", { class: "link-btn", type: "button", onclick: () => openSettings() }, "スマホと PC で同期する設定"));
      } else if (inTab.length === 0 && filtered) {
        msg = el("div", { class: "empty" }, el("strong", { text: "「" + catOf({ category: selectedTab }).name + "」の TODO はありません" }), "下の欄から追加すると、このカテゴリに入ります。");
      } else {
        msg = el("div", { class: "empty" }, el("strong", { text: "すべて完了しました" }), "おつかれさまでした。");
      }
      list.append(msg);
    }

    const groups = {};
    for (const t of open) {
      const s = t.done ? sectionOf(t.due, today) : sectionOf(t.due, today);
      (groups[s] = groups[s] || []).push(t);
    }
    for (const s of SECTIONS) {
      const items = groups[s.key];
      if (!items || !items.length) continue;
      items.sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
      list.append(el("h2", { class: "section-h " + s.key }, s.label, el("span", { class: "count", text: String(items.length) })));
      const ul = el("ul", { class: "rows" });
      for (const t of items) ul.append(taskRow(t, today, filtered));
      list.append(ul);
    }

    if (done.length) {
      list.append(el("button", {
        class: "done-toggle", type: "button", "aria-expanded": String(showDone),
        onclick: () => { showDone = !showDone; setUI({ showDone }); render(); }
      }, icon("chev"), "完了したもの " + done.length));
      if (showDone) {
        const ul = el("ul", { class: "rows" });
        for (const t of done) ul.append(taskRow(t, today, filtered));
        list.append(ul);
      }
    }
    list.scrollTop = scroll;

    if (flashId) {
      const row = list.querySelector('[data-id="' + CSS.escape(flashId) + '"]');
      flashId = null;
      if (row) {
        row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        row.classList.add("flash");
        setTimeout(() => row.classList.remove("flash"), 1000);
      }
    }
    renderSync();
    updateBadge(all, today);
  }

  function renderBanner() {
    const b = $("banner");
    let msg = "";
    if (dataBroken) {
      const raw = readJSON(K.data, null);
      msg = raw && raw.version > APP_VERSION
        ? "このデータは新しい版の Nudge で作られています。ページを読み込み直してください（壊さないよう、書き込みを止めています）。"
        : "保存したデータが読めませんでした。上書きしないよう、書き込みを止めています。";
    } else if (!storageOk) {
      msg = "この端末に保存できません（ブラウザの設定を確認してください）。閉じると消えます。";
    }
    b.hidden = !msg;
    b.textContent = msg;
  }

  function updateBadge(all, today) {
    if (!("setAppBadge" in navigator)) return;
    const n = all.filter((t) => !t.done && t.due && dayDiff(today, t.due) <= 0).length;
    try { (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch (e) { /* 使えない端末 */ }
  }

  // ---------- 入力欄 ----------
  function renderComposer() {
    const dueBtn = $("dueBtn"), catBtn = $("catBtn");
    dueBtn.classList.toggle("set", !!draftDue);
    dueBtn.querySelector(".tool-label").textContent = draftDue ? pickLabel(draftDue) : "";
    dueBtn.setAttribute("aria-label", draftDue ? "期日: " + pickLabel(draftDue) + "（変える）" : "期日を選ぶ");
    $("dueClear").hidden = !draftDue;
    const cat = draftCat ? (data.categories || []).find((c) => c.id === draftCat && !c.deleted) : null;
    if (draftCat && !cat) { draftCat = null; draftCatAuto = false; }
    catBtn.classList.toggle("set", !!cat);
    catBtn.querySelector(".tool-label").textContent = cat ? cat.name : "";
    catBtn.setAttribute("aria-label", cat ? "カテゴリ: " + cat.name + "（変える）" : "カテゴリを選ぶ");
    $("catClear").hidden = !cat;
    $("addBtn").disabled = !$("newTitle").value.trim();
  }

  function addTask(ev) {
    ev.preventDefault();
    const input = $("newTitle");
    const title = input.value.trim();
    if (!title) return;
    const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    mutate((d) => {
      const s = stamp();
      d.tasks.push({
        id, title, due: draftDue, category: draftCat || "other", done: false, doneAt: null,
        createdAt: new Date().toISOString(), deleted: false,
        t: { title: s, due: s, category: s, done: s, deleted: s }
      });
    });
    input.value = "";
    draftDue = null;
    if (!draftCatAuto) draftCat = null;
    renderComposer();
    flashId = id;
    render();
    input.focus(); // キーボードを閉じない
  }

  function setField(id, fields) {
    mutate((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t) return;
      const s = stamp();
      t.t = t.t || {};
      for (const [k, v] of Object.entries(fields)) {
        t[k] = v;
        if (TASK_FIELDS.includes(k)) t.t[k] = s;
      }
    });
  }

  function completeTask(id) {
    if (checkingIds.has(id)) return;
    checkingIds.add(id);
    render();
    setTimeout(() => {
      checkingIds.delete(id);
      setField(id, { done: true, doneAt: new Date().toISOString() });
      const t = (data.tasks || []).find((x) => x.id === id);
      showToast("完了しました", () => setField(id, { done: false, doneAt: null }));
      if (!t) render();
    }, 700);
  }
  function undoneTask(id) { setField(id, { done: false, doneAt: null }); }

  function deleteTask(id) {
    setField(id, { deleted: true, deletedAt: new Date().toISOString() });
    showToast("削除しました", () => setField(id, { deleted: false, deletedAt: null }));
  }

  // ---------- 「元に戻す」 ----------
  let toastTimer = null, toastUndo = null;
  function showToast(text, undo) {
    $("toastText").textContent = text;
    toastUndo = undo;
    $("toastUndo").hidden = !undo;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() { $("toast").hidden = true; toastUndo = null; }

  // ---------- シート（Android の「戻る」で閉じる） ----------
  let sheet = null; // { name, onClose }
  function openSheet(name, build, onClose) {
    const wrap = $("sheetWrap"), box = $("sheet");
    if (sheet) {
      runClose();
      history.replaceState({ nudgeSheet: name }, "");
    } else {
      history.pushState({ nudgeSheet: name }, "");
    }
    sheet = { name, onClose };
    box.textContent = "";
    box.append(el("div", { class: "grabber" }));
    build(box);
    wrap.hidden = false;
    const first = box.querySelector("[data-autofocus]");
    if (first && matchMedia("(min-width: 720px)").matches) first.focus();
  }
  function runClose() {
    if (sheet && sheet.onClose) { try { sheet.onClose(); } catch (e) { console.error(e); } }
  }
  function hideSheet() {
    if (!sheet) return;
    runClose();
    sheet = null;
    $("sheetWrap").hidden = true;
    $("sheet").textContent = "";
  }
  function closeSheet() {
    if (!sheet) return;
    if (history.state && history.state.nudgeSheet) history.back();
    else hideSheet();
  }
  window.addEventListener("popstate", () => { if (sheet) hideSheet(); });

  function sheetHead(title, extra) {
    return el("div", { class: "sheet-head" },
      el("h2", { id: "sheetTitle", text: title }),
      extra || null,
      el("button", { class: "icon-btn", type: "button", "aria-label": "閉じる", onclick: closeSheet }, icon("x")));
  }

  // 期日の選択肢（入力欄と編集で共通）
  function dueOptions(current, onPick, allowNone) {
    const today = todayYmd();
    const tomorrow = ymd(addDays(new Date(), 1));
    const mon = nextMonday();
    const box = el("div", { class: "opts" });
    const opt = (label, val) => el("button", {
      class: "opt", type: "button", "aria-pressed": String(current === val), onclick: () => onPick(val)
    }, label);
    box.append(opt("今日", today), opt("明日", tomorrow), opt("来週の月曜 (" + shortDate(mon).replace(/\(.\)$/, "") + ")", mon));
    const custom = current && ![today, tomorrow, mon].includes(current);
    const date = el("input", { type: "date", "aria-label": "日付を選ぶ", value: custom ? current : "" });
    date.addEventListener("change", () => { if (date.value) onPick(date.value); });
    box.append(el("label", { class: "opt date-opt", "aria-pressed": String(!!custom) }, icon("cal"), date));
    if (allowNone) box.append(opt("期日なし", null));
    return box;
  }

  function catOptions(current, onPick) {
    const box = el("div", { class: "opts" });
    for (const c of catList()) {
      box.append(el("button", {
        class: "opt", type: "button", "aria-pressed": String(current === c.id), onclick: () => onPick(c.id)
      }, chip(c)));
    }
    return box;
  }

  function openDuePicker() {
    openSheet("due", (box) => {
      box.append(sheetHead("期日"));
      box.append(dueOptions(draftDue, (v) => { draftDue = v; renderComposer(); closeSheet(); $("newTitle").focus(); }, !!draftDue));
    });
  }
  function openCatPicker() {
    openSheet("cat", (box) => {
      box.append(sheetHead("カテゴリ"));
      box.append(catOptions(draftCat, (v) => { draftCat = v; draftCatAuto = false; renderComposer(); closeSheet(); $("newTitle").focus(); }));
    });
  }

  // ---------- 編集シート（自動保存） ----------
  function openEdit(id) {
    reload();
    const t = (data.tasks || []).find((x) => x.id === id);
    if (!t || t.deleted) return;
    const original = t.title;
    let timer = null;
    const ta = el("textarea", { class: "field-title", rows: "2", "aria-label": "TODO の名前", maxlength: "300", "data-autofocus": true });
    ta.value = t.title;
    const commitTitle = () => {
      clearTimeout(timer);
      const v = ta.value.trim().replace(/\s*\n\s*/g, " ");
      const cur = (data.tasks || []).find((x) => x.id === id);
      if (!cur || cur.deleted) return;
      if (v && v !== cur.title) setField(id, { title: v });
    };
    ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(commitTitle, 600); });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); ta.blur(); } });
    ta.addEventListener("blur", commitTitle);

    const build = (box) => {
      const cur = (data.tasks || []).find((x) => x.id === id) || t;
      box.append(sheetHead("TODO の編集"));
      box.append(ta);
      box.append(el("h3", { text: "期日" }));
      box.append(dueOptions(cur.due, (v) => { setField(id, { due: v }); refresh(); }, true));
      box.append(el("h3", { text: "カテゴリ" }));
      box.append(catOptions(catOf(cur).id, (v) => { setField(id, { category: v }); refresh(); }));
      const info = [];
      if (cur.createdAt) info.push("作成 " + new Date(cur.createdAt).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" }));
      if (cur.done && cur.doneAt) info.push("完了 " + new Date(cur.doneAt).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" }));
      box.append(el("div", { class: "actions" },
        el("button", { class: "danger", type: "button", onclick: () => { commitTitle(); closeSheet(); deleteTask(id); } }, icon("trash"), "削除")));
      if (info.length) box.append(el("p", { class: "note", text: info.join("　") }));
      box.append(el("p", { class: "note", text: "変更はすぐ保存されます。" }));
    };
    const refresh = () => {
      const box = $("sheet");
      const keep = ta;
      box.textContent = "";
      box.append(el("div", { class: "grabber" }));
      build(box);
      if (keep !== ta) return;
    };
    openSheet("edit", build, () => {
      commitTitle(); // 名前を空にしたら元のまま
      if (!ta.value.trim()) ta.value = original;
    });
  }

  // ---------- 設定 ----------
  function openSettings() {
    openSheet("settings", (box) => {
      box.append(sheetHead("設定"));
      box.append(el("h3", { text: "カテゴリ" }));
      const catBox = el("div");
      const drawCats = () => {
        catBox.textContent = "";
        for (const c of catList()) {
          const name = el("input", { class: "cat-name", type: "text", value: c.name, "aria-label": "カテゴリの名前", maxlength: "30" });
          name.addEventListener("change", () => {
            const v = name.value.trim();
            if (!v) { name.value = c.name; return; }
            setCat(c.id, { name: v });
          });
          const sw = el("div", { class: "swatches", role: "group", "aria-label": "色" });
          for (const col of COLORS) {
            sw.append(el("button", {
              class: "swatch", type: "button", "aria-pressed": String(c.color === col), "aria-label": COLOR_NAMES[col],
              onclick: () => { setCat(c.id, { color: col }); drawCats(); }
            }, el("span", { class: "swatch-dot dot-" + col })));
          }
          const del = el("button", {
            class: "mini-x", type: "button", "aria-label": "「" + c.name + "」を削除", disabled: c.id === "other",
            onclick: () => {
              const n = liveTasks().filter((t) => catOf(t).id === c.id && !t.done).length;
              const msg = "「" + c.name + "」を削除しますか？" + (n ? "\nこのカテゴリの TODO " + n + " 件は「その他」に入ります。" : "");
              if (!confirm(msg)) return;
              setCat(c.id, { deleted: true });
              drawCats();
              showToast("「" + c.name + "」を削除しました", () => { setCat(c.id, { deleted: false }); if (sheet && sheet.name === "settings") drawCats(); });
            }
          }, icon("trash"));
          catBox.append(el("div", { class: "cat-row" }, name, sw, del));
        }
        catBox.append(el("div", { class: "actions" }, el("button", {
          class: "secondary", type: "button", onclick: () => {
            const nm = prompt("新しいカテゴリの名前");
            if (!nm || !nm.trim()) return;
            const used = new Set(catList().map((c) => c.color));
            const color = COLORS.find((x) => !used.has(x)) || "blue";
            const id = "c" + Date.now().toString(36);
            mutate((d) => {
              const s = stamp();
              d.categories.push({ id, name: nm.trim().slice(0, 30), color, order: Math.max(0, ...d.categories.map((x) => x.order || 0)) + 1, deleted: false, t: { name: s, color: s, order: s, deleted: s } });
            });
            drawCats();
          }
        }, icon("plus"), " カテゴリを追加")));
      };
      drawCats();
      box.append(catBox);

      box.append(el("h3", { text: "スマホと PC の同期（GitHub）" }));
      box.append(githubForm());
    });
  }

  function setCat(id, fields) {
    mutate((d) => {
      const c = d.categories.find((x) => x.id === id);
      if (!c) return;
      const s = stamp();
      c.t = c.t || {};
      for (const [k, v] of Object.entries(fields)) { c[k] = v; c.t[k] = s; }
    });
  }

  function githubForm() {
    const box = el("div");
    const s = getSettings();
    const ghUser = /\.github\.io$/.test(location.hostname) ? location.hostname.split(".")[0] : "";
    const owner = el("input", { type: "text", id: "ghOwner", value: s.owner || ghUser, autocapitalize: "off", spellcheck: "false" });
    const repo = el("input", { type: "text", id: "ghRepo", value: s.repo || "nudge-data", autocapitalize: "off", spellcheck: "false" });
    const result = el("p", { class: "note" });
    box.append(
      el("div", { class: "field" }, el("label", { for: "ghOwner", text: "GitHub のユーザー名" }), owner),
      el("div", { class: "field" }, el("label", { for: "ghRepo", text: "データを置く非公開リポジトリ" }), repo)
    );
    const tokenField = el("div", { class: "field" });
    const drawToken = () => {
      tokenField.textContent = "";
      const cur = getSettings().token;
      tokenField.append(el("label", { for: "ghToken", text: "トークン（GitHub に入るための鍵）" }));
      if (cur) {
        tokenField.append(el("div", { class: "token-saved" },
          el("code", { text: "••••••••" + cur.slice(-4) }),
          el("button", { class: "secondary", type: "button", onclick: () => { const n = getSettings(); delete n.token; setSettings(n); drawToken(); renderSync(); } }, "外す")));
      } else {
        const tok = el("input", { type: "password", id: "ghToken", autocomplete: "off", placeholder: "github_pat_… を貼り付け", spellcheck: "false" });
        tok.addEventListener("change", () => save(tok.value.trim()));
        tokenField.append(tok);
      }
    };
    const save = async (token) => {
      const n = Object.assign(getSettings(), { owner: owner.value.trim(), repo: repo.value.trim() || "nudge-data" });
      const changedRepo = s.owner !== n.owner || s.repo !== n.repo;
      if (token) n.token = token;
      setSettings(n);
      if (changedRepo) setMeta({ sha: null, lastSyncAt: 0 });
      drawToken();
      if (!n.token || !n.owner) { result.className = "note"; result.textContent = n.owner ? "トークンを貼ると、接続を確かめます。" : "ユーザー名を入れてください。"; return; }
      result.className = "note"; result.textContent = "接続を確かめています…";
      const r = await testConnection();
      result.className = "note " + (r.ok ? "ok" : "err");
      result.textContent = r.msg;
      if (r.ok) requestSync(0);
    };
    owner.addEventListener("change", () => save());
    repo.addEventListener("change", () => save());
    drawToken();
    box.append(tokenField);
    box.append(el("div", { class: "actions" },
      el("button", { class: "secondary", type: "button", onclick: () => save() }, "接続を確かめる"),
      el("button", { class: "primary", type: "button", onclick: () => { requestSync(0); closeSheet(); } }, "今すぐ同期")));
    box.append(result);
    box.append(syncDetails());
    box.append(helpSteps());
    return box;
  }

  function helpSteps() {
    return el("details", { class: "help" },
      el("summary", { text: "トークンの作り方（GitHub の画面は英語です）" }),
      el("ol", {},
        el("li", { text: "PC で github.com にログインし、右上の自分のアイコン → Settings（設定）→ 左の一番下の Developer settings（開発者向け設定）を開く" }),
        el("li", { text: "Personal access tokens → Fine-grained tokens（細かく権限を決められる鍵）→ Generate new token（新しく作る）" }),
        el("li", { text: "Token name（名前）に「nudge」、Expiration（期限）は 1 year（1年）を選ぶ" }),
        el("li", { text: "Repository access で Only select repositories（選んだリポジトリだけ）→ nudge-data を選ぶ" }),
        el("li", { text: "Permissions の Repository permissions で Contents（中身）を Read and write（読み書き）にする。ほかは触らない" }),
        el("li", { text: "一番下の Generate token（作る）を押し、出てきた github_pat_… をコピーして、上の欄に貼る" })),
      el("p", { class: "note", text: "トークンはこの端末にだけ保存します。1年で切れるので、切れたら同じ手順で作り直して貼り直します。" }));
  }

  function syncDetails() {
    const m = getMeta();
    const dl = el("dl", { class: "kv" });
    const add = (k, v) => dl.append(el("dt", { text: k }), el("dd", { text: v }));
    add("最後に同期", m.lastSyncTime ? new Date(m.lastSyncTime).toLocaleString("ja-JP") : "まだ");
    add("最後の結果", m.lastResult || "—");
    add("送信待ち", (m.dirtySeq || 0) > (m.syncedSeq || 0) ? "あり" : "なし");
    return dl;
  }

  function openSyncSheet() {
    openSheet("sync", (box) => {
      box.append(sheetHead("同期"));
      const s = getSettings();
      const st = syncState();
      box.append(el("p", { class: "note" + (st.state === "error" ? " err" : ""), text: st.long }));
      box.append(syncDetails());
      const acts = el("div", { class: "actions" });
      if (s.token && s.owner) acts.append(el("button", { class: "primary", type: "button", onclick: () => { requestSync(0); closeSheet(); } }, "今すぐ同期"));
      acts.append(el("button", { class: "secondary", type: "button", onclick: () => openSettings() }, "設定を開く"));
      box.append(acts);
    });
  }

  // ---------- 同期 ----------
  function configured() { const s = getSettings(); return !!(s.token && s.owner && s.repo); }
  function syncState() {
    const m = getMeta();
    const pending = (m.dirtySeq || 0) > (m.syncedSeq || 0);
    if (!configured()) return { state: "local", text: "端末だけに保存中", long: "まだ GitHub とつないでいません。この端末にだけ保存しています。" };
    if (syncing) return { state: "syncing", text: "同期中…", long: "同期しています。" };
    if (!navigator.onLine || (lastError && lastError.kind === "offline")) return { state: "offline", text: pending ? "オフライン（送信待ち）" : "オフライン", long: "ネットにつながっていません。この端末に保存してあり、つながったら送ります。" };
    if (lastError) return { state: "error", text: "同期エラー", long: lastError.msg };
    if (pending) return { state: "pending", text: "送信待ち", long: "まだ送っていない変更があります。" };
    return { state: "synced", text: "同期済み", long: "GitHub と同じ内容です。" };
  }
  function renderSync() {
    const st = syncState();
    const b = $("syncBtn");
    b.dataset.state = st.state;
    $("syncText").textContent = st.text;
    b.setAttribute("aria-label", "同期の状態: " + st.text);
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  class HttpError extends Error {
    constructor(kind, msg, status) { super(msg); this.kind = kind; this.status = status; }
  }
  async function gh(path, opts) {
    const s = getSettings();
    let res;
    try {
      res = await fetch(API + path, Object.assign({
        cache: "no-store",
        headers: Object.assign({
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + s.token,
          "X-GitHub-Api-Version": "2022-11-28"
        }, (opts && opts.body) ? { "Content-Type": "application/json" } : {})
      }, opts || {}));
    } catch (e) {
      throw new HttpError("offline", "ネットにつながりません。", 0);
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* 中身なし */ }
    return { status: res.status, body, headers: res.headers };
  }
  function repoPath() { const s = getSettings(); return "/repos/" + encodeURIComponent(s.owner) + "/" + encodeURIComponent(s.repo); }

  async function testConnection() {
    try {
      const r = await gh(repoPath());
      if (r.status === 200) return { ok: true, msg: "つながりました（リポジトリ " + getSettings().repo + " が見えます）。" };
      if (r.status === 401) return { ok: false, msg: "トークンが正しくないか、期限が切れています（HTTP 401）。作り直して貼り直してください。" };
      if (r.status === 404) return { ok: false, msg: "リポジトリが見つかりません（HTTP 404）。ユーザー名・リポジトリ名と、トークンにそのリポジトリを選んだかを確かめてください。" };
      if (r.status === 403) return { ok: false, msg: "権限が足りないか、回数の上限に達しました（HTTP 403）。" };
      return { ok: false, msg: "接続に失敗しました（HTTP " + r.status + "）。" };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  }

  function errorFor(status, body) {
    const m = body && body.message ? "（" + String(body.message).split("\n")[0] + "）" : "";
    if (status === 401) return new HttpError("auth", "トークンが正しくないか、期限が切れています（HTTP 401）。設定から貼り直してください。", status);
    if (status === 404) return new HttpError("notfound", "リポジトリが見つかりません（HTTP 404）。設定のユーザー名・リポジトリ名と、トークンの対象を確かめてください。", status);
    if (status === 403) return new HttpError("forbidden", "権限が足りないか、回数の上限に達しました（HTTP 403）" + m + "。しばらく待ってからもう一度試します。", status);
    return new HttpError("other", "同期に失敗しました（HTTP " + status + "）" + m + "。", status);
  }

  async function syncOnce() {
    const FILE = repoPath() + "/contents/tasks.json";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt - 1) + Math.random() * 200));
      // 1. GitHub の tasks.json を読む（毎回ここから）
      const g = await gh(FILE);
      let remote = null, sha = null;
      if (g.status === 200) {
        try { remote = JSON.parse(b64decode(g.body.content)); } catch (e) { throw new HttpError("other", "GitHub の tasks.json が読めません。手で直していないか確かめてください。", 200); }
        sha = g.body.sha;
      } else if (g.status === 404) {
        const r = await gh(repoPath()); // ファイルがないのか、リポジトリが見えないのか
        if (r.status !== 200) throw errorFor(r.status === 200 ? 404 : r.status, r.body);
      } else {
        throw errorFor(g.status, g.body);
      }
      if (remote && remote.version > APP_VERSION) throw new HttpError("newer", "GitHub のデータが新しい版の Nudge で作られています。ページを読み込み直してください。", 200);

      // 2. 手元と合わせる（ここは同期的に一気に行い、ほかのタブの変更と混ざらないようにする）
      reload();
      if (dataBroken) throw new HttpError("other", "この端末のデータが読めないため、同期を止めています。", 0);
      const meta = getMeta();
      const merged = mergeData(data, remote, meta.lastSyncAt);
      const buildStamp = Math.max(tick(), seenMax(merged));
      setMeta({ lastSeen: Math.max(getMeta().lastSeen, seenMax(merged)) });
      const seqAtMerge = meta.dirtySeq || 0;
      if (canonical(merged) !== canonical(data)) { saveData(merged); data = merged; }

      // 3. 中身が同じなら書かない
      const body = canonical(merged);
      if (remote && canonical(remote) === body) {
        return { seqAtMerge, buildStamp, sha, wrote: false, status: g.status };
      }
      // 4. 書き戻す（sha を付ける。間にほかの端末が書いていたら 409/422 でやり直し）
      const p = await gh(FILE, {
        method: "PUT",
        body: JSON.stringify(Object.assign({
          message: "Nudge: " + new Date().toISOString() + " (" + meta.deviceId + ")",
          content: b64encode(body + "\n")
        }, sha ? { sha } : {}))
      });
      if (p.status === 200 || p.status === 201) {
        return { seqAtMerge, buildStamp, sha: p.body && p.body.content && p.body.content.sha, wrote: true, status: p.status };
      }
      const msg = (p.body && p.body.message) || "";
      if (p.status === 409 || (p.status === 422 && /sha/i.test(msg))) continue;
      throw errorFor(p.status, p.body);
    }
    throw new HttpError("other", "ほかの端末と同時に書き込みが続き、同期できませんでした。少し待ってからもう一度試します。", 409);
  }

  let pauseUntil = 0;
  async function runSync() {
    if (!configured()) { renderSync(); return; }
    if (Date.now() < pauseUntil) return;
    syncing = true;
    renderSync();
    const work = async () => {
      try {
        const r = await syncOnce();
        const m = getMeta();
        setMeta({
          syncedSeq: Math.max(m.syncedSeq || 0, r.seqAtMerge), lastSyncAt: r.buildStamp, sha: r.sha,
          lastSyncTime: new Date().toISOString(),
          lastResult: (r.wrote ? "送信しました" : "変更なし") + "（HTTP " + r.status + "）"
        });
        lastError = null;
      } catch (e) {
        lastError = { kind: e.kind || "other", msg: e.message || String(e) };
        setMeta({ lastResult: e.status ? "失敗（HTTP " + e.status + "）" : (e.kind === "offline" ? "オフライン" : "失敗") });
        if (e.kind === "forbidden") pauseUntil = Date.now() + 60 * 1000;
        if (e.kind !== "offline" && e.kind !== "forbidden") console.warn("Nudge sync:", e);
      }
    };
    try {
      if (navigator.locks) await navigator.locks.request("nudge-sync", work); // タブの間で1本だけ
      else await work();
    } finally {
      syncing = false;
      reload();
      render();
    }
  }

  // 同期は同時に1本。走っている間の依頼は、終わったあと1回だけ
  let running = null, again = false, timer = null, firstPendingAt = 0;
  function requestSync(delay) {
    clearTimeout(timer);
    timer = setTimeout(kick, delay || 0);
  }
  async function kick() {
    timer = null;
    firstPendingAt = 0;
    if (running) { again = true; return; }
    running = runSync();
    await running;
    running = null;
    if (again) { again = false; kick(); }
  }
  // 変更のあと: 最後の変更から1.5秒、最長10秒
  function scheduleSync() {
    if (!configured()) { renderSync(); return; }
    const now = Date.now();
    if (!firstPendingAt) firstPendingAt = now;
    const wait = Math.max(0, Math.min(1500, firstPendingAt + 10000 - now));
    requestSync(wait);
  }

  // ---------- 画面の高さ（キーボードが出たら入力欄をその上に） ----------
  function fitViewport() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-h", h + "px");
  }

  // ---------- 日付が変わったら描き直す ----------
  let lastDay = todayYmd();
  function checkDay() {
    const d = todayYmd();
    if (d !== lastDay) { lastDay = d; render(); }
  }

  // ---------- はじめ ----------
  function init() {
    $("composer").addEventListener("submit", addTask);
    $("newTitle").addEventListener("input", renderComposer);
    $("dueBtn").addEventListener("click", openDuePicker);
    $("catBtn").addEventListener("click", openCatPicker);
    $("dueClear").addEventListener("click", () => { draftDue = null; renderComposer(); $("newTitle").focus(); });
    $("catClear").addEventListener("click", () => { draftCat = null; draftCatAuto = false; renderComposer(); $("newTitle").focus(); });
    $("settingsBtn").addEventListener("click", openSettings);
    $("syncBtn").addEventListener("click", openSyncSheet);
    $("sheetBackdrop").addEventListener("click", closeSheet);
    $("toastUndo").addEventListener("click", () => { const u = toastUndo; hideToast(); if (u) u(); });

    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === "Escape" && sheet) { e.preventDefault(); closeSheet(); return; }
      if (e.key === "/" && !typing && !sheet) { e.preventDefault(); $("newTitle").focus(); }
    });

    // ほかのタブが保存したら読み直す
    window.addEventListener("storage", (e) => {
      if (e.key && !e.key.startsWith("nudge:")) return;
      reload();
      if (!sheet || sheet.name !== "edit") render(); else renderSync();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { reload(); checkDay(); render(); requestSync(0); }
    });
    window.addEventListener("online", () => { lastError = null; requestSync(0); });
    window.addEventListener("offline", renderSync);
    setInterval(checkDay, 60 * 1000);

    if (window.visualViewport) {
      visualViewport.addEventListener("resize", fitViewport);
      visualViewport.addEventListener("scroll", fitViewport);
    }
    window.addEventListener("resize", fitViewport);
    fitViewport();

    if (selectedTab !== "all") { draftCat = selectedTab; draftCatAuto = true; }
    if (!dataBroken && !lsGet(K.data)) saveData(data); // 最初のカテゴリを保存しておく
    renderComposer();
    render();
    requestSync(0);

    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
    }
  }

  // 試験用（コンソールから中身を見る）
  window.__nudge = { mergeData, canonical, b64encode, b64decode, sectionOf, dueLabel, getMeta, loadData, requestSync };
  init();
})();
