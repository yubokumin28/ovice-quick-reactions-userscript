// ==UserScript==
// @name         Ovice Quick Reactions
// @namespace    https://github.com/yubokumin28/ovice-quick-reactions-userscript
// @version      1.7.0
// @description  Oviceのリアクションを、ショートカットキー（Ctrl+Shift+数字）・常に手前に出る小窓・画面に浮かぶパネルから送ります。
// @author       遊牧民
// @match        https://app.ovice.com/*
// @icon         https://raw.githubusercontent.com/yubokumin28/ovice-quick-reactions-userscript/main/icon128.png
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @run-at       document-idle
// @noframes
// @homepageURL  https://yubokumin28.github.io/ovice-quick-reactions-userscript/
// @updateURL    https://raw.githubusercontent.com/yubokumin28/ovice-quick-reactions-userscript/main/ovice-quick-reactions.user.js
// @downloadURL  https://raw.githubusercontent.com/yubokumin28/ovice-quick-reactions-userscript/main/ovice-quick-reactions.user.js
// ==/UserScript==
// ⛔ このファイルは tools/build_userscript.py が作る。直接直さない(正本は拡張 ovice_reaction/ の中)
(function () {
'use strict';
// ---------- labels.js ----------
// Shared by content.js and sidepanel.js: display names and shortcut-slot storage.
// `var` so the file can be injected again into an already-open tab.
var OQR_SLOT_COUNT = 10;

// Keys are test-id suffixes or asset names (final_<name>_still-*.png).
var OQR_LABELS = {
  okay: "OK", good: "いいね", love: "ハート", heart: "ハート", haha: "笑い",
  down: "がっかり", dissappointed: "がっかり", blue: "泣き", cry: "泣き", nope: "ダメ",
  em: "！", exclamation: "！", qm: "？", question: "？", hi: "挙手", hand: "挙手",
  handsup: "バンザイ", wait: "待って", hourglass: "待って", clap: "拍手",
  tada: "お祝い", party: "お祝い", drum: "ドラム",
};

// Names the user typed (chrome.storage.sync "names"), keyed by oqrNameId.
// Load with oqrLoadNames() before rendering.
var OQR_NAMES = {};

// Custom reactions are "index-N" by position, which shifts when the list
// changes, so name them by their image file instead.
function oqrNameId(key, src) {
  if (/^index-\d+$/.test(key) && /^https?:/.test(src || "")) {
    return "img:" + new URL(src).pathname.split("/").pop();
  }
  return key;
}

async function oqrLoadNames() {
  const { names } = await chrome.storage.sync.get("names");
  OQR_NAMES = names || {};
}

// An empty name goes back to the built-in one.
async function oqrSetName(key, src, name) {
  const { names = {} } = await chrome.storage.sync.get("names");
  const id = oqrNameId(key, src);
  name = (name || "").trim().slice(0, 20);
  if (name) names[id] = name;
  else delete names[id];
  await chrome.storage.sync.set({ names });
}

function oqrDefaultLabel(key, src) {
  const id = key.replace(/^reactions-/, "");
  if (OQR_LABELS[id]) return OQR_LABELS[id];
  const m = /final_([a-z]+)_still/.exec(src || "");
  if (m && OQR_LABELS[m[1]]) return OQR_LABELS[m[1]];
  const idx = /^index-(\d+)$/.exec(key);
  if (idx) return `独自${Number(idx[1]) + 1}`;
  return id;
}

function oqrLabel(key, src) {
  return OQR_NAMES[oqrNameId(key, src)] || oqrDefaultLabel(key, src);
}

// Returns an array of 10 reaction keys (or null). Without saved settings,
// slots follow the toolbar order.
async function oqrGetSlots(reactions) {
  const { slots } = await chrome.storage.sync.get("slots");
  const out = [];
  for (let i = 0; i < OQR_SLOT_COUNT; i++) {
    if (Array.isArray(slots)) out[i] = slots[i] || null;
    else out[i] = (reactions[i] && reactions[i].key) || null;
  }
  return out;
}

// Assign reaction `key` to slot n (1-10), or unassign it when n is 0.
async function oqrAssign(key, n, reactions) {
  const s = await oqrGetSlots(reactions);
  for (let i = 0; i < OQR_SLOT_COUNT; i++) if (s[i] === key) s[i] = null;
  if (n >= 1 && n <= OQR_SLOT_COUNT) s[n - 1] = key;
  await chrome.storage.sync.set({ slots: s });
}

function oqrSlotOf(key, slots) {
  const i = slots.indexOf(key);
  return i >= 0 ? i + 1 : 0;
}

// ---------- shim.js ----------
// Tampermonkey 版の土台: 拡張の labels.js / content.js / sidepanel.js がそのまま動くよう、
// chrome.* を Tampermonkey の GM_* と同じページ内の呼び出しで代わりに用意する。
// - chrome.storage(sync / local)→ GM_getValue / GM_setValue。キー名は拡張と同じ(slots / names / reactions / oqrView)
// - 別タブで変えた時は GM_addValueChangeListener で chrome.storage.onChanged と同じ形で知らせる
// - background.js の仲介(send-reaction・get-commands・open-window)→ 同じページの関数呼び出し
// - chrome.commands(ショートカットキー)→ ページ内の keydown(panel.js)。キーは Ctrl+Shift+1〜9・0 に固定
const OQR_US_HOME = "https://yubokumin28.github.io/ovice-quick-reactions-userscript/";
const OQR_IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

// 拡張では sync に置いていたキー(それ以外は local)。onChanged の area を合わせるためだけに使う
const OQR_SYNC_KEYS = ["slots", "names"];
// 別タブの変更を拾うキー
const OQR_WATCH_KEYS = ["slots", "names", "reactions", "oqrView"];

const oqrChangeListeners = new Set();
const oqrMessageListeners = [];

function oqrAreaOf(key) {
  return OQR_SYNC_KEYS.includes(key) ? "sync" : "local";
}

function oqrClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function oqrFireChange(key, oldValue, newValue) {
  const changes = { [key]: { oldValue, newValue } };
  for (const fn of [...oqrChangeListeners]) {
    try { fn(changes, oqrAreaOf(key)); } catch (e) { console.warn("[ovice-quick-reactions]", e); }
  }
}

function oqrStorageArea() {
  return {
    get(keys, cb) {
      const list = keys == null ? OQR_WATCH_KEYS : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) {
        const v = GM_getValue(k);
        if (v !== undefined) out[k] = oqrClone(v);
        else if (keys && typeof keys === "object" && !Array.isArray(keys) && keys[k] !== undefined) out[k] = keys[k];
      }
      if (typeof cb === "function") setTimeout(() => cb(out), 0);
      return Promise.resolve(out);
    },
    set(obj, cb) {
      for (const k of Object.keys(obj)) {
        const oldValue = GM_getValue(k);
        const newValue = oqrClone(obj[k]);
        GM_setValue(k, newValue);
        // chrome は変わった時だけ、書いた本人にも知らせる
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          setTimeout(() => oqrFireChange(k, oldValue, newValue), 0);
        }
      }
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of typeof keys === "string" ? [keys] : keys) {
        const oldValue = GM_getValue(k);
        if (typeof GM_deleteValue === "function") GM_deleteValue(k); else GM_setValue(k, undefined);
        if (oldValue !== undefined) setTimeout(() => oqrFireChange(k, oldValue, undefined), 0);
      }
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
  };
}

// 他のタブ(別の Ovice タブ)で変えた分
if (typeof GM_addValueChangeListener === "function") {
  for (const k of OQR_WATCH_KEYS) {
    GM_addValueChangeListener(k, (name, oldValue, newValue, remote) => {
      if (remote) oqrFireChange(name, oldValue, newValue);
    });
  }
}

// キーは固定: 01〜09 = Ctrl+Shift+1〜9、10 = Ctrl+Shift+0(Mac は ⌘)
function oqrShortcutList() {
  const mod = OQR_IS_MAC ? "⌘" : "Ctrl";
  return Array.from({ length: 10 }, (_, i) => ({
    name: "react-" + String(i + 1).padStart(2, "0"),
    shortcut: `${mod}+Shift+${(i + 1) % 10}`,
  }));
}

// content.js の chrome.runtime.onMessage へ、同じページの中で直接渡す(拡張では background.js が中継していた)
function oqrDeliver(msg) {
  return new Promise((resolve) => {
    let answered = false;
    const respond = (v) => { if (!answered) { answered = true; resolve(v); } };
    let waits = false;
    for (const fn of oqrMessageListeners) {
      try { if (fn(msg, {}, respond) === true) waits = true; } catch (e) { console.warn("[ovice-quick-reactions]", e); }
    }
    if (!waits) respond(undefined);
  });
}

// 別窓・サイドパネルの代わりの「ページ内に浮かぶパネル」(panel.js が中身を入れる)
const oqrPanelHooks = {
  bounds: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  move: () => {},
  setHidden: () => {},
};

const chrome = {
  storage: {
    sync: oqrStorageArea(),
    local: oqrStorageArea(),
    session: oqrStorageArea(),
    onChanged: {
      addListener(fn) { oqrChangeListeners.add(fn); },
      removeListener(fn) { oqrChangeListeners.delete(fn); },
    },
  },
  runtime: {
    id: "oqr-userscript",
    onMessage: { addListener(fn) { oqrMessageListeners.push(fn); } },
    async sendMessage(msg) {
      if (!msg) return undefined;
      if (msg.type === "get-commands") return oqrShortcutList();
      if (msg.type === "send-reaction") {
        if (!oqrMessageListeners.length) return { result: "no-script" };
        const res = await oqrDeliver({ type: "react-key", key: msg.key });
        return res && res.result ? res : { result: "no-script" };
      }
      if (msg.type === "open-window") {
        // 「別窓」= パネルを細い表示に切り替える(panel.js が window.close() で作り直す)
        await chrome.storage.local.set({ oqrView: "window" });
        return { ok: true };
      }
      return undefined;
    },
  },
  commands: { getAll: async () => oqrShortcutList() },
  windows: {
    getCurrent: async () => ({ id: 1, ...oqrPanelHooks.bounds() }),
    get: async () => ({ id: 1, ...oqrPanelHooks.bounds() }),
    getLastFocused: async () => ({ id: 1, ...oqrPanelHooks.bounds() }),
    async update(id, info) {
      if (info.state === "minimized") oqrPanelHooks.setHidden(true);
      if (info.state === "normal") oqrPanelHooks.setHidden(false);
      if (typeof info.left === "number" || typeof info.top === "number") oqrPanelHooks.move(info.left, info.top);
      return { id: 1, ...oqrPanelHooks.bounds() };
    },
  },
  sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
  tabs: {
    // 拡張では chrome://extensions/shortcuts を開いていた。Tampermonkey 版はキーが固定なので使い方ページへ
    async create({ url }) {
      const to = /^chrome:/.test(url || "") ? OQR_US_HOME + "#keys" : url;
      if (typeof GM_openInTab === "function") GM_openInTab(to, { active: true });
      else window.open(to, "_blank", "noopener");
    },
  },
};

// ---------- content.js ----------
// Ovice Quick Reactions - content script
// Reads reaction buttons from the Ovice toolbar at runtime (no hard-coded list),
// so it works for any account / space layout.

(() => {
  // Extension and Tampermonkey versions both installed: only the one that ran
  // first works (otherwise two ⚡ buttons and two sends per key). A newer copy
  // of the same kind (extension reloaded) still takes over, see alive() below.
  const KIND = typeof GM_info === "undefined" ? "extension" : "userscript";
  const root = document.documentElement;
  if (root.dataset.oqrRunning && root.dataset.oqrRunning !== KIND) return;
  root.dataset.oqrRunning = KIND;

  const REPEAT_DELAY_MS = 350; // hold time before auto-repeat starts
  const REPEAT_MS = 200;       // auto-repeat interval (~5 per second)
  const SLOT_COUNT = 10;

  let pipWin = null;
  let sentCount = 0;

  // ---------- reaction discovery ----------

  function findReactionButtons() {
    return [...document.querySelectorAll("button.reactionButton")]
      .filter((b) => b.querySelector("img"));
  }

  function keyOf(btn, index) {
    return btn.dataset.testid || `index-${index}`;
  }

  function getReactions() {
    return findReactionButtons().map((btn, i) => ({
      key: keyOf(btn, i),
      src: btn.querySelector("img").src, // absolute URL or data: URI
      disabled: btn.disabled,
      el: btn,
    }));
  }

  function findButtonByKey(key) {
    const list = findReactionButtons();
    const byId = list.find((b) => b.dataset.testid === key);
    if (byId) return byId;
    const m = /^index-(\d+)$/.exec(key);
    return m ? list[Number(m[1])] || null : null;
  }

  // A bare .click() sent the reaction but skipped Ovice's sound, which is
  // likely bound to pointer/mouse handlers. Replay the full sequence a real
  // mouse press produces, ending with a single click.
  function pressLikeUser(btn) {
    const r = btn.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
    };
    const P = (type, extra) => btn.dispatchEvent(new PointerEvent(type, { ...base, ...extra }));
    const M = (type, extra) => btn.dispatchEvent(new MouseEvent(type, { ...base, ...extra }));
    P("pointerover"); P("pointerenter", { bubbles: false }); M("mouseover");
    P("pointerdown", { buttons: 1 }); M("mousedown", { buttons: 1 });
    P("pointerup"); M("mouseup");
    btn.click();
    P("pointerout"); P("pointerleave", { bubbles: false }); M("mouseout");
  }

  // When the user has closed the reaction bar, Ovice removes its buttons from
  // the page. Open it via the emoji (reactions-menu) button, and close it again
  // once sending has been idle for a moment, so rapid-fire does not flicker.
  const AUTO_CLOSE_MS = 1500;
  let openedByUs = false;
  let closeTimer = null;

  function menuButton() {
    return document.querySelector('[data-testid="reactions-menu"]');
  }

  // Shared so concurrent sends (rapid-fire) do not toggle the menu twice.
  // Waits with a MutationObserver rather than polling: when the Ovice tab is in
  // the background (side panel sends while another tab is shown), Chrome slows
  // timers down, but DOM changes are still reported right away.
  let opening = null;
  function ensureBarOpen() {
    if (findReactionButtons().length) return Promise.resolve(true);
    if (opening) return opening;
    const menu = menuButton();
    if (!menu) return Promise.resolve(false);
    opening = new Promise((resolve) => {
      const done = (ok) => { obs.disconnect(); clearTimeout(timer); if (ok) openedByUs = true; resolve(ok); };
      const obs = new MutationObserver(() => { if (findReactionButtons().length) done(true); });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => done(findReactionButtons().length > 0), 1500);
      pressLikeUser(menu);
    }).finally(() => { opening = null; });
    return opening;
  }

  function scheduleClose() {
    if (!openedByUs) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      const menu = menuButton();
      if (openedByUs && menu && findReactionButtons().length) pressLikeUser(menu);
      openedByUs = false;
    }, AUTO_CLOSE_MS);
  }

  // Returns "ok", or why nothing was sent: "no-bar" | "not-found" | "busy"
  // (busy = Ovice is holding off repeated reactions for a moment).
  async function sendReaction(key) {
    if (!(await ensureBarOpen())) return "no-bar";
    const btn = findButtonByKey(key);
    scheduleClose();
    if (!btn) return "not-found";
    if (btn.disabled) return "busy";
    pressLikeUser(btn);
    sentCount++;
    updateCounter();
    return "ok";
  }

  // Custom reactions live on assets.ovice.io, which refuses requests that do not
  // come from app.ovice.com (403), so the side panel cannot show them by URL.
  // Fetch them here (allowed for this page) and hand over a small copy instead.
  const ICON_PX = 64;
  const iconCache = new Map(); // src -> data URL, or null while converting / failed
  function needsCopy(src) {
    try { return !src.startsWith("data:") && new URL(src).host !== location.host; } catch (e) { return false; }
  }
  async function smallCopy(src) {
    const blob = await (await fetch(src, { credentials: "omit" })).blob();
    const bmp = await createImageBitmap(blob);
    const s = Math.min(ICON_PX / bmp.width, ICON_PX / bmp.height, 1);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }
  function iconFor(src) {
    if (!needsCopy(src)) return src;
    if (iconCache.has(src)) return iconCache.get(src) || src;
    iconCache.set(src, null);
    smallCopy(src)
      .then((url) => { iconCache.set(src, url); lastPublished = ""; publishReactions(); })
      .catch(() => {});
    return src;
  }

  // Publish the detected list so the side panel can show it without messaging.
  // src = Ovice's own image URL (used to match rows in リアクション設定),
  // icon = what the side panel shows.
  let lastPublished = "";
  function publishReactions() {
    const list = getReactions().map(({ key, src }) => ({ key, src, icon: iconFor(src) }));
    if (!list.length) return;
    const json = JSON.stringify(list);
    if (json === lastPublished) return;
    lastPublished = json;
    chrome.storage.local.set({ reactions: list });
  }

  // ---------- shortcut slots ----------

  async function keyForSlot(slot) {
    const slots = await oqrGetSlots(await knownReactions());
    return slots[slot - 1];
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!alive()) return;
    if (msg && msg.type === "react-slot" && msg.slot >= 1 && msg.slot <= SLOT_COUNT) {
      keyForSlot(msg.slot).then((key) => key && sendReaction(key));
    }
    // From the side panel's "押して送る" buttons (relayed by background.js).
    if (msg && msg.type === "react-key" && typeof msg.key === "string") {
      sendReaction(msg.key).then((result) => sendResponse({ result }));
      return true; // async response
    }
  });

  // ---------- always-on-top palette (Document Picture-in-Picture) ----------

  const PER_ROW = 9;
  const CELL_W = 60;
  const CELL_H = 70;

  const PIP_CSS = `
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f5f7; font-family: "Meiryo", sans-serif; color: #333;
           user-select: none; overflow-x: hidden; overflow-y: auto; }
    /* auto-fill: drag the window narrow and the icons line up in one column. */
    #grid { display: grid; grid-template-columns: repeat(auto-fill, ${CELL_W - 4}px);
            gap: 4px; padding: 6px; justify-content: center; }
    .r { position: relative; width: ${CELL_W - 4}px; height: ${CELL_H - 4}px; border: 1px solid #d6d9de;
         border-radius: 10px; padding: 3px 0 0; background: #fff; cursor: pointer;
         touch-action: none; display: flex; flex-direction: column; align-items: center; }
    .r:hover { border-color: #2d6cdf; background: #eef4ff; }
    .r.firing { background: #2d6cdf; border-color: #2d6cdf; }
    .r.firing .n { color: #fff; }
    .r.off { opacity: .3; }
    .r img { width: 40px; height: 40px; pointer-events: none; }
    .n { font-size: 10px; line-height: 1.2; margin-top: 2px; white-space: nowrap;
         overflow: hidden; max-width: ${CELL_W - 8}px; pointer-events: none; }
    .k { position: absolute; top: -3px; left: -3px; min-width: 17px; height: 17px;
         border-radius: 9px; background: #e8453c; color: #fff; font-size: 11px;
         font-weight: bold; line-height: 17px; text-align: center; pointer-events: none; }
    #bar { display: flex; flex-wrap: wrap; gap: 4px; justify-content: space-between; align-items: center;
           padding: 0 8px 6px; font-size: 11px; color: #666; }
    #reload { background: #fff; border: 1px solid #bbb; color: #333; border-radius: 4px;
              font-size: 11px; cursor: pointer; }
  `;

  const labelOf = oqrLabel; // from labels.js

  async function slotMap() {
    const slots = await oqrGetSlots(await knownReactions());
    const map = {};
    slots.forEach((key, i) => { if (key && !(key in map)) map[key] = i + 1; });
    return map;
  }

  function stopFiring(state) {
    clearTimeout(state.t);
    clearInterval(state.i);
    state.t = state.i = null;
    if (state.btn) state.btn.classList.remove("firing");
  }

  async function buildPalette() {
    if (!pipWin || pipWin.closed) return;
    const doc = pipWin.document;
    const slots = await slotMap();
    doc.body.innerHTML = "";

    const grid = doc.createElement("div");
    grid.id = "grid";
    const state = { t: null, i: null, btn: null };

    for (const r of await knownReactions()) {
      const b = doc.createElement("button");
      b.className = "r";
      b.dataset.key = r.key;
      const label = labelOf(r.key, r.src);
      const slot = slots[r.key];
      b.title = slot ? `${label}（キー${slot}番）` : label;
      const img = doc.createElement("img");
      img.src = r.src;
      const name = doc.createElement("span");
      name.className = "n";
      name.textContent = label;
      b.append(img, name);
      if (slot) {
        const k = doc.createElement("span");
        k.className = "k";
        k.textContent = slot;
        b.appendChild(k);
      }

      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        stopFiring(state);
        state.btn = b;
        b.classList.add("firing");
        sendReaction(r.key);
        state.t = setTimeout(() => {
          state.i = setInterval(() => sendReaction(r.key), REPEAT_MS);
        }, REPEAT_DELAY_MS);
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
        b.addEventListener(ev, () => stopFiring(state));
      }
      grid.appendChild(b);
    }

    const bar = doc.createElement("div");
    bar.id = "bar";
    bar.innerHTML = `<span>長押しで連打　送信 <b id="cnt">${sentCount}</b></span>`;
    const reload = doc.createElement("button");
    reload.id = "reload";
    reload.textContent = "再読込";
    reload.addEventListener("click", buildPalette);
    bar.appendChild(reload);

    doc.body.append(grid, bar);
    pipWin.addEventListener("blur", () => stopFiring(state));
  }

  function updateCounter() {
    if (!pipWin || pipWin.closed) return;
    const c = pipWin.document.getElementById("cnt");
    if (c) c.textContent = sentCount;
  }

  // Mirror Ovice's cooldown (disabled) state onto the palette buttons.
  function syncDisabled() {
    if (!pipWin || pipWin.closed) return;
    const barShown = findReactionButtons().length > 0; // closed bar ≠ cooldown
    for (const b of pipWin.document.querySelectorAll(".r")) {
      const src = barShown ? findButtonByKey(b.dataset.key) : null;
      b.classList.toggle("off", barShown && (!src || src.disabled));
    }
  }

  async function openPalette() {
    if (pipWin && !pipWin.closed) { pipWin.focus(); return; }
    if (!("documentPictureInPicture" in window)) {
      alert("このChromeは小窓表示に対応していません。Chromeを最新版に更新してください。");
      return;
    }
    const list = await knownReactions();
    if (!list.length) {
      alert("リアクションボタンが見つかりません。画面下の絵文字ボタンでリアクション列を一度表示してから押してください。");
      return;
    }
    const rows = Math.ceil(list.length / PER_ROW);
    try {
      pipWin = await documentPictureInPicture.requestWindow({
        width: PER_ROW * CELL_W + 12 + 16, // + room for a scrollbar so 9 still fit
        height: rows * CELL_H + 44,
      });
    } catch (e) {
      console.warn("[ovice-quick-reactions] requestWindow failed", e);
      alert("小窓を開けませんでした。Oviceのページを一度クリックしてから、もう一度 ⚡ を押してください。");
      return;
    }
    const style = pipWin.document.createElement("style");
    style.textContent = PIP_CSS;
    pipWin.document.head.appendChild(style);
    pipWin.document.title = "リアクション";
    buildPalette();

    const timer = setInterval(syncDisabled, 300);
    pipWin.addEventListener("pagehide", () => { clearInterval(timer); pipWin = null; });
  }

  // ---------- "キー" column inside Ovice's own リアクション設定 dialog ----------
  // Rows are matched to toolbar buttons by image URL. Controls are appended as
  // the last child of each row so React's own children are left untouched.

  const COL_W = 130;
  const SELECT_STYLE = `width:${COL_W}px;height:36px;border:1px solid #c9ccd1;border-radius:6px;` +
    "background:#fff;font-size:13px;padding:0 4px;cursor:pointer;flex-shrink:0";

  // The toolbar is unmounted while the settings dialog is open, so fall back
  // to the last list seen (memory, then storage written by publishReactions).
  let lastReactions = [];
  async function knownReactions() {
    const live = getReactions().map(({ key, src }) => ({ key, src }));
    if (live.length) { lastReactions = live; return live; }
    if (lastReactions.length) return lastReactions;
    const { reactions = [] } = await chrome.storage.local.get("reactions");
    lastReactions = reactions;
    return reactions;
  }

  // Actual key combos ("Ctrl+Shift+1") come from the background worker.
  let shortcutNames = null;
  async function getShortcutNames() {
    if (shortcutNames) return shortcutNames;
    try {
      const list = await chrome.runtime.sendMessage({ type: "get-commands" });
      const names = {};
      for (const c of list || []) {
        const m = /^react-(\d+)$/.exec(c.name);
        if (m) names[Number(m[1])] = c.shortcut || "";
      }
      shortcutNames = names;
    } catch (e) {
      shortcutNames = {};
    }
    return shortcutNames;
  }

  function optionText(n, names) {
    const s = names[n];
    return s ? `${n}：${s}` : `${n}：キー未設定`;
  }

  // The 使用 column is the child holding the checkbox; insert before it.
  function useColumnOf(row) {
    return [...row.children].find((c) => c.querySelector('input[type="checkbox"]')) || null;
  }

  function place(parent, node, before) {
    if (node.parentElement === parent && node.nextElementSibling === before) return;
    if (before) parent.insertBefore(node, before); else parent.appendChild(node);
  }

  async function enhanceSettings() {
    if (!alive()) return;
    const handles = document.querySelectorAll('[aria-roledescription="sortable"]');
    if (!handles.length) return;

    const reactions = await knownReactions();
    const bySrc = new Map(reactions.map((r) => [r.src, r.key]));
    const slots = await oqrGetSlots(reactions);
    const names = await getShortcutNames();

    let usedIndex = 0; // position among rows whose 使用 is checked = toolbar order
    for (const handle of handles) {
      const iconBox = handle.parentElement;
      const row = iconBox && iconBox.parentElement;
      const img = iconBox && iconBox.querySelector('img[alt="reaction icon"]');
      if (!row || !img) continue;

      const box = row.querySelector('input[type="checkbox"]');
      const used = !box || box.checked;
      let key = bySrc.get(img.src) || null;
      if (!key && used && reactions[usedIndex]) key = reactions[usedIndex].key;
      if (used) usedIndex++;
      if (!used) key = null;
      let sel = row.querySelector(":scope > select.oqr-slot");
      if (!sel) {
        sel = document.createElement("select");
        sel.className = "oqr-slot";
        sel.style.cssText = SELECT_STYLE;
        sel.addEventListener("change", () => {
          const k = sel.dataset.key;
          if (k) knownReactions().then((list) => oqrAssign(k, Number(sel.value), list));
        });
      }
      const html = `<option value="0">－</option>` +
        Array.from({ length: OQR_SLOT_COUNT }, (_, i) =>
          `<option value="${i + 1}">${optionText(i + 1, names)}</option>`).join("");
      if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
      place(row, sel, useColumnOf(row));

      sel.dataset.key = key || "";
      sel.disabled = !key;
      sel.style.opacity = key ? "1" : "0.4";
      sel.title = key ? "このリアクションを送るショートカットキー" : "「使用」がオフのため割り当てできません";
      sel.value = String(key ? oqrSlotOf(key, slots) : 0);
    }

    // Column header placed before 使用.
    const useHead = [...document.querySelectorAll("p")].find((p) => p.textContent.trim() === "使用" &&
      p.parentElement && p.parentElement.textContent.includes("削除"));
    if (useHead) {
      let h = useHead.parentElement.querySelector(":scope > .oqr-head");
      if (!h) {
        h = document.createElement("p");
        h.className = useHead.className + " oqr-head";
        h.textContent = "ショートカット";
        h.style.cssText = `width:${COL_W}px;flex-shrink:0;text-align:center`;
      }
      place(useHead.parentElement, h, useHead);
    }
  }

  // ---------- lifecycle ----------
  // After the extension is reloaded, the old copy of this script keeps running
  // in open tabs but can no longer reach the extension. Each copy stamps a
  // generation number; older copies stop themselves.
  const myGen = (window.__oqrGen = (window.__oqrGen || 0) + 1);
  function alive() {
    return window.__oqrGen === myGen && !!(chrome.runtime && chrome.runtime.id);
  }

  let enhanceQueued = false;
  const observer = new MutationObserver(() => {
    if (!alive()) { observer.disconnect(); return; }
    if (enhanceQueued) return;
    enhanceQueued = true;
    setTimeout(() => { enhanceQueued = false; enhanceSettings(); }, 100);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Refresh badges and the settings column when assignments change.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.slots) { buildPalette(); enhanceSettings(); }
    if (area === "sync" && changes.names) oqrLoadNames().then(buildPalette);
  });
  oqrLoadNames().then(buildPalette);

  // ---------- launcher button on the Ovice page ----------

  function addLauncher() {
    const existing = document.getElementById("oqr-launcher");
    if (existing && existing.dataset.gen === String(myGen)) return;
    if (existing) existing.remove(); // left by an older copy of this script
    const b = document.createElement("button");
    b.id = "oqr-launcher";
    b.dataset.gen = String(myGen);
    b.textContent = "⚡";
    b.title = "リアクション板を開く（常に手前に表示）";
    Object.assign(b.style, {
      position: "fixed", right: "12px", top: "45%", zIndex: 2147483647,
      width: "40px", height: "40px", borderRadius: "50%", border: "0",
      background: "#2d6cdf", color: "#fff", fontSize: "20px", cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,.3)", opacity: "0.85",
    });
    b.addEventListener("click", openPalette);
    document.body.appendChild(b);
  }

  addLauncher();
  publishReactions();
  enhanceSettings();
  const tick = setInterval(() => {
    if (!alive()) { clearInterval(tick); return; }
    addLauncher();
    publishReactions();
    shortcutNames = null; // pick up shortcut changes made in chrome://extensions
  }, 3000);
})();

// ---------- sidepanel.html / sidepanel.js ----------
const OQR_PANEL_CSS_RAW = `
  /* Narrow side panel: keep everything compact so the main page keeps its room. */
  body { margin: 0; padding: 6px 6px 12px; font: 12px "Meiryo", sans-serif; color: #222; background: #fff; }
  .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .top b { font-size: 12px; margin-right: auto; }
  .top .manual { display: inline-flex; align-items: center; gap: 3px; margin-right: 4px; padding: 1px 7px; border: 1px solid #0a7c9e; border-radius: 4px; background: #e3f6fa; color: #0a5f79; font-size: 11px; font-weight: bold; text-decoration: none; }
  .top .manual:hover { background: #c9eef6; }
  .top .manual svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .top button { font-size: 11px; padding: 1px 6px; border: 1px solid #ccc; border-radius: 4px; background: #f7f7f7; cursor: pointer; }
  #empty { color: #b00; font-size: 11px; }

  .legend { font-size: 10px; color: #b26b00; margin: 0 0 2px; }
  table { width: 100%; border-collapse: collapse; }
  td { border-bottom: 1px solid #eee; padding: 0 3px; height: 22px; white-space: nowrap; }
  td.no { display: none; color: #888; font-size: 11px; }
  body.names td.no { display: table-cell; }
  td.no, td.key { width: 1%; } /* shrink to content; reaction column takes the rest */
  td.key { font-family: monospace; font-size: 12px; padding-right: 6px; }
  td.key.local { color: #b26b00; }
  td.key.none { color: #c33; font-family: inherit; font-size: 11px; }
  td.what { cursor: pointer; }
  td.what:hover { background: #eef4ff; }
  td.what img { width: 18px; height: 18px; vertical-align: middle; margin-right: 3px; }
  td.what .empty { color: #bbb; }
  td.what .edit { float: right; color: #aaa; font-size: 10px; }
  tr.open td.what { background: #dbe7ff; }
  /* inline icon picker under a row */
  td.picker { padding: 3px; background: #f5f8ff; white-space: normal; }
  td.picker button { width: 28px; height: 28px; padding: 1px; margin: 1px; border: 1px solid #d6d9de; border-radius: 5px; background: #fff; cursor: pointer; vertical-align: middle; }
  td.picker button.on { border-color: #2d6cdf; background: #dbe7ff; }
  td.picker button img { width: 22px; height: 22px; }
  td.picker button.clear { width: auto; padding: 0 6px; font-size: 11px; }

  details { margin-top: 8px; border-top: 1px solid #ddd; padding-top: 4px; }
  summary { cursor: pointer; font-weight: bold; font-size: 12px; }
  .note { color: #666; font-size: 11px; line-height: 1.4; margin: 3px 0; }
  .scope b { color: #2d6cdf; }

  .row { display: flex; align-items: center; gap: 4px; padding: 1px 0; border-bottom: 1px solid #eee; }
  .row img { width: 22px; height: 22px; flex-shrink: 0; }
  .row .name { flex: 1; min-width: 0; height: 20px; padding: 0 3px; border: 1px solid transparent; border-radius: 3px;
               background: transparent; font: inherit; color: inherit; text-overflow: ellipsis; }
  .row .name:hover { border-color: #cfd8dc; background: #fff; }
  .row .name:focus { border-color: #0a7c9e; background: #fff; outline: none; }
  .row select { width: 96px; height: 24px; font-size: 11px; flex-shrink: 0; }
  .row.on { background: #f0f5ff; }
  button.link { margin-top: 6px; width: 100%; padding: 4px; font-size: 11px; cursor: pointer; }

  /* "押して送る": works from any tab in this window (the panel stays open). */
  #sendBox { margin: 0 0 8px; padding: 5px; border: 1px solid #b9dce8; border-radius: 6px; background: #f0fafd; }
  #sendBox .head { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 6px; margin-bottom: 3px; }
  #sendBox .head b { font-size: 12px; color: #0a5f79; white-space: nowrap; }
  #sendBox .head small { font-size: 10px; color: #5a7a85; }
  #send { display: flex; flex-wrap: wrap; gap: 3px; }
  #send button { position: relative; width: 34px; height: 34px; padding: 2px; border: 1px solid #cfd8dc; border-radius: 7px;
                 background: #fff; cursor: pointer; touch-action: none; }
  #send button:hover { border-color: #0a7c9e; background: #e3f6fa; }
  #send button.firing { border-color: #0a7c9e; background: #0a7c9e; }
  #send button img { width: 28px; height: 28px; pointer-events: none; }
  #send button .k { position: absolute; top: -4px; left: -4px; min-width: 14px; height: 14px; padding: 0 2px; border-radius: 7px;
                    background: #e8453c; color: #fff; font-size: 9px; font-weight: bold; line-height: 14px; text-align: center; pointer-events: none; }
  #sendStatus { min-height: 14px; margin-top: 3px; font-size: 10px; color: #5a7a85; }
  #sendStatus.ng { color: #b00; }

  /* シンプル表示: only the send buttons, for the narrowest panel. */
  .top #toggleSimple { margin-right: 4px; border-color: #0a7c9e; color: #0a5f79; background: #fff; font-weight: bold; }
  body.simple .top b, body.simple #toggleNames, body.simple .legend, body.simple table,
  body.simple details, body.simple #sendBox .head { display: none; }
  body.simple .top { justify-content: flex-start; gap: 4px; }
  body.simple #toggleSimple { background: #0a7c9e; color: #fff; }
  body.simple #sendBox { margin: 0; padding: 3px; border: 0; background: transparent; }
  body.simple #send { flex-direction: column; flex-wrap: nowrap; align-items: flex-start; gap: 4px; }

  /* 別窓: the side panel cannot be narrower than Chrome's minimum, so simple
     view can pop out into its own narrow window (sidepanel.html?win=1). */
  #popOut, #backToPanel, #grip, #pinTop { display: none; }
  body.simple #popOut { display: inline-block; }
  body.win .top .manual, body.win #toggleSimple, body.win #popOut { display: none; }
  body.win #backToPanel { display: inline-block; }
  body.win.canpin #pinTop { display: inline-block; padding: 1px 3px; }
  /* Chrome's title bar is nearly all caption buttons at this width, so the
     top bar doubles as the move handle. */
  body.win .top { position: sticky; top: 0; z-index: 1; background: #fff; gap: 3px; padding-bottom: 3px; }
  body.win #grip { display: flex; flex: 1; align-items: center; justify-content: center; height: 20px; border-radius: 4px;
                   background: #e3eef2; color: #5a7a85; font-size: 11px; cursor: move; user-select: none; touch-action: none; }
  body.win #grip.moving { background: #0a7c9e; color: #fff; }
  body.win { padding: 4px 4px 8px; }
  body.win #send { align-items: center; }
  body.win #sendStatus { word-break: break-all; }
`;
const OQR_PANEL_CSS = `
  /* Narrow side panel: keep everything compact so the main page keeps its room. */
  .oqr-body { margin: 0; padding: 6px 6px 12px; font: 12px "Meiryo", sans-serif; color: #222; background: #fff; }
  .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .top b { font-size: 12px; margin-right: auto; }
  .top .manual { display: inline-flex; align-items: center; gap: 3px; margin-right: 4px; padding: 1px 7px; border: 1px solid #0a7c9e; border-radius: 4px; background: #e3f6fa; color: #0a5f79; font-size: 11px; font-weight: bold; text-decoration: none; }
  .top .manual:hover { background: #c9eef6; }
  .top .manual svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .top button { font-size: 11px; padding: 1px 6px; border: 1px solid #ccc; border-radius: 4px; background: #f7f7f7; cursor: pointer; }
  #empty { color: #b00; font-size: 11px; }

  .legend { font-size: 10px; color: #b26b00; margin: 0 0 2px; }
  table { width: 100%; border-collapse: collapse; }
  td { border-bottom: 1px solid #eee; padding: 0 3px; height: 22px; white-space: nowrap; }
  td.no { display: none; color: #888; font-size: 11px; }
  .oqr-body.names td.no { display: table-cell; }
  td.no, td.key { width: 1%; } /* shrink to content; reaction column takes the rest */
  td.key { font-family: monospace; font-size: 12px; padding-right: 6px; }
  td.key.local { color: #b26b00; }
  td.key.none { color: #c33; font-family: inherit; font-size: 11px; }
  td.what { cursor: pointer; }
  td.what:hover { background: #eef4ff; }
  td.what img { width: 18px; height: 18px; vertical-align: middle; margin-right: 3px; }
  td.what .empty { color: #bbb; }
  td.what .edit { float: right; color: #aaa; font-size: 10px; }
  tr.open td.what { background: #dbe7ff; }
  /* inline icon picker under a row */
  td.picker { padding: 3px; background: #f5f8ff; white-space: normal; }
  td.picker button { width: 28px; height: 28px; padding: 1px; margin: 1px; border: 1px solid #d6d9de; border-radius: 5px; background: #fff; cursor: pointer; vertical-align: middle; }
  td.picker button.on { border-color: #2d6cdf; background: #dbe7ff; }
  td.picker button img { width: 22px; height: 22px; }
  td.picker button.clear { width: auto; padding: 0 6px; font-size: 11px; }

  details { margin-top: 8px; border-top: 1px solid #ddd; padding-top: 4px; }
  summary { cursor: pointer; font-weight: bold; font-size: 12px; }
  .note { color: #666; font-size: 11px; line-height: 1.4; margin: 3px 0; }
  .scope b { color: #2d6cdf; }

  .row { display: flex; align-items: center; gap: 4px; padding: 1px 0; border-bottom: 1px solid #eee; }
  .row img { width: 22px; height: 22px; flex-shrink: 0; }
  .row .name { flex: 1; min-width: 0; height: 20px; padding: 0 3px; border: 1px solid transparent; border-radius: 3px;
               background: transparent; font: inherit; color: inherit; text-overflow: ellipsis; }
  .row .name:hover { border-color: #cfd8dc; background: #fff; }
  .row .name:focus { border-color: #0a7c9e; background: #fff; outline: none; }
  .row select { width: 96px; height: 24px; font-size: 11px; flex-shrink: 0; }
  .row.on { background: #f0f5ff; }
  button.link { margin-top: 6px; width: 100%; padding: 4px; font-size: 11px; cursor: pointer; }

  /* "押して送る": works from any tab in this window (the panel stays open). */
  #sendBox { margin: 0 0 8px; padding: 5px; border: 1px solid #b9dce8; border-radius: 6px; background: #f0fafd; }
  #sendBox .head { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 6px; margin-bottom: 3px; }
  #sendBox .head b { font-size: 12px; color: #0a5f79; white-space: nowrap; }
  #sendBox .head small { font-size: 10px; color: #5a7a85; }
  #send { display: flex; flex-wrap: wrap; gap: 3px; }
  #send button { position: relative; width: 34px; height: 34px; padding: 2px; border: 1px solid #cfd8dc; border-radius: 7px;
                 background: #fff; cursor: pointer; touch-action: none; }
  #send button:hover { border-color: #0a7c9e; background: #e3f6fa; }
  #send button.firing { border-color: #0a7c9e; background: #0a7c9e; }
  #send button img { width: 28px; height: 28px; pointer-events: none; }
  #send button .k { position: absolute; top: -4px; left: -4px; min-width: 14px; height: 14px; padding: 0 2px; border-radius: 7px;
                    background: #e8453c; color: #fff; font-size: 9px; font-weight: bold; line-height: 14px; text-align: center; pointer-events: none; }
  #sendStatus { min-height: 14px; margin-top: 3px; font-size: 10px; color: #5a7a85; }
  #sendStatus.ng { color: #b00; }

  /* シンプル表示: only the send buttons, for the narrowest panel. */
  .top #toggleSimple { margin-right: 4px; border-color: #0a7c9e; color: #0a5f79; background: #fff; font-weight: bold; }
  .oqr-body.simple .top b, .oqr-body.simple #toggleNames, .oqr-body.simple .legend, .oqr-body.simple table,
  .oqr-body.simple details, .oqr-body.simple #sendBox .head { display: none; }
  .oqr-body.simple .top { justify-content: flex-start; gap: 4px; }
  .oqr-body.simple #toggleSimple { background: #0a7c9e; color: #fff; }
  .oqr-body.simple #sendBox { margin: 0; padding: 3px; border: 0; background: transparent; }
  .oqr-body.simple #send { flex-direction: column; flex-wrap: nowrap; align-items: flex-start; gap: 4px; }

  /* 別窓: the side panel cannot be narrower than Chrome's minimum, so simple
     view can pop out into its own narrow window (sidepanel.html?win=1). */
  #popOut, #backToPanel, #grip, #pinTop { display: none; }
  .oqr-body.simple #popOut { display: inline-block; }
  .oqr-body.win .top .manual, .oqr-body.win #toggleSimple, .oqr-body.win #popOut { display: none; }
  .oqr-body.win #backToPanel { display: inline-block; }
  .oqr-body.win.canpin #pinTop { display: inline-block; padding: 1px 3px; }
  /* Chrome's title bar is nearly all caption buttons at this width, so the
     top bar doubles as the move handle. */
  .oqr-body.win .top { position: sticky; top: 0; z-index: 1; background: #fff; gap: 3px; padding-bottom: 3px; }
  .oqr-body.win #grip { display: flex; flex: 1; align-items: center; justify-content: center; height: 20px; border-radius: 4px;
                   background: #e3eef2; color: #5a7a85; font-size: 11px; cursor: move; user-select: none; touch-action: none; }
  .oqr-body.win #grip.moving { background: #0a7c9e; color: #fff; }
  .oqr-body.win { padding: 4px 4px 8px; }
  .oqr-body.win #send { align-items: center; }
  .oqr-body.win #sendStatus { word-break: break-all; }
`;
const OQR_PANEL_HTML = `
  <div class="top">
    <b>キー → リアクション</b>
    <a class="manual" href="https://yubokumin28.github.io/ovice-quick-reactions-userscript/" target="_blank" title="使い方を開く">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>使い方
    </a>
    <button id="toggleSimple" title="送るボタンだけの表示と、詳しい表示を切り替える">シンプル</button>
    <button id="popOut" title="サイドパネルを閉じて、細い別窓で開く">別窓</button>
    <button id="backToPanel" title="サイドパネルに戻す">戻す</button>
    <button id="pinTop" title="他のアプリより常に手前に出す小窓にする">📌</button>
    <span id="grip" title="ここをつかんで窓を動かす">⠿ 移動</span>
    <button id="toggleNames" title="Chromeのショートカット画面での名前（リアクション 01 など）を表示">名前 ▸</button>
  </div>
  <div id="empty" hidden>Oviceのスペースを開くと表示されます。</div>
  <div id="sendBox">
    <div class="head"><b>押して送る</b><small>長押しで連打</small></div>
    <div id="send"></div>
    <div id="sendStatus"></div>
  </div>
  <p class="legend">リアクションを押すと変更 ／ <span>キーは Ovice の画面を見ている時だけ効く</span></p>
  <table><tbody id="slots"></tbody></table>

  <details id="assign" open>
    <summary>割り当てを変える</summary>
    <p class="note">Oviceの「リアクション設定」の「ショートカット」欄と連動。同じ番号を選ぶと、前の方は「－」に戻ります。名前は押すと書き換えられます（空にすると元の名前）。</p>
    <div id="list"></div>
  </details>

  <details open>
    <summary>キーについて（Tampermonkey 版）</summary>
    <div class="note scope">
      <b>01〜09</b>：<code>Ctrl+Shift+1</code>〜<code>9</code>、<b>10</b>：<code>Ctrl+Shift+0</code>（Mac は ⌘）。<br>
      Ovice の画面を見ている時だけ効きます。他のアプリや別のタブを見ている時は効きません（その時は ⚡ の小窓を使います）。キーの組み合わせは変えられません。
    </div>
    <button class="link" id="shortcuts">使い方を開く</button>
  </details>

  `;
function oqrRunSidepanel(document, window, location, localStorage, chrome, setInterval) {
// Side panel: compact "key -> reaction" table, plus collapsible sections for
// changing assignments. Assignments live in chrome.storage.sync, shared with
// the column injected into Ovice's settings dialog.

// Global shortcuts are only allowed for Ctrl+Shift+digit (Command on Mac).
const GLOBAL_OK = /^(Ctrl|Command|⌘)\+Shift\+\d$|^⇧⌘\d$/;

async function loadState() {
  const { reactions = [] } = await chrome.storage.local.get("reactions");
  const slots = await oqrGetSlots(reactions);
  const shortcut = {};
  for (const c of await chrome.commands.getAll()) {
    const m = /^react-(\d+)$/.exec(c.name);
    if (m) shortcut[Number(m[1])] = c.shortcut || "";
  }
  return { reactions, slots, shortcut };
}

// Slot whose icon picker is open (null = none). Kept across re-renders.
let openSlot = null;

function renderTable({ reactions, slots, shortcut }) {
  const byKey = new Map(reactions.map((r) => [r.key, r]));
  document.getElementById("empty").hidden = reactions.length > 0;
  const tbody = document.getElementById("slots");
  tbody.innerHTML = "";
  for (let n = 1; n <= OQR_SLOT_COUNT; n++) {
    const tr = document.createElement("tr");
    if (openSlot === n) tr.className = "open";

    const no = document.createElement("td");
    no.className = "no";
    no.textContent = String(n).padStart(2, "0");

    const key = document.createElement("td");
    const s = shortcut[n];
    key.className = "key" + (s ? (GLOBAL_OK.test(s) ? "" : " local") : " none");
    key.textContent = s || "未設定";
    if (s && !GLOBAL_OK.test(s)) key.title = "Chromeを見ているときだけ効くキーです";

    const what = document.createElement("td");
    what.className = "what";
    what.title = "押すとリアクションを変更";
    const r = slots[n - 1] && byKey.get(slots[n - 1]);
    if (r) {
      const img = document.createElement("img");
      img.src = r.icon || r.src;
      what.append(img, oqrLabel(r.key, r.src));
    } else {
      what.innerHTML = `<span class="empty">－</span>`;
    }
    const edit = document.createElement("span");
    edit.className = "edit";
    edit.textContent = openSlot === n ? "▴" : "▾";
    what.appendChild(edit);
    what.addEventListener("click", () => {
      openSlot = openSlot === n ? null : n;
      renderTable({ reactions, slots, shortcut });
    });

    tr.append(no, key, what);
    tbody.appendChild(tr);

    if (openSlot === n) tbody.appendChild(pickerRow(n, reactions, slots));
  }
}

function pickerRow(n, reactions, slots) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.className = "picker";
  td.colSpan = 3;
  const current = slots[n - 1];

  const choose = async (key) => {
    const s = await oqrGetSlots(reactions);
    if (key) await oqrAssign(key, n, reactions);
    else if (s[n - 1]) await oqrAssign(s[n - 1], 0, reactions);
    openSlot = null;
    renderAll(); // also covers "no change", which fires no storage event
  };

  for (const r of reactions) {
    const b = document.createElement("button");
    if (r.key === current) b.className = "on";
    b.title = oqrLabel(r.key, r.src);
    const img = document.createElement("img");
    img.src = r.icon || r.src;
    b.appendChild(img);
    b.addEventListener("click", () => choose(r.key));
    td.appendChild(b);
  }
  const clear = document.createElement("button");
  clear.className = "clear";
  clear.textContent = "外す";
  clear.addEventListener("click", () => choose(null));
  td.appendChild(clear);

  tr.appendChild(td);
  return tr;
}

function renderList({ reactions, slots, shortcut }) {
  const optionText = (n) => `${n}：${shortcut[n] || "未設定"}`;
  const root = document.getElementById("list");
  root.innerHTML = "";
  for (const r of reactions) {
    const n = oqrSlotOf(r.key, slots);
    const row = document.createElement("div");
    row.className = "row" + (n ? " on" : "");

    const img = document.createElement("img");
    img.src = r.icon || r.src;
    // The name is editable: type over it, Enter or click away to save,
    // empty to go back to the built-in name.
    const name = document.createElement("input");
    name.className = "name";
    name.value = oqrLabel(r.key, r.src);
    name.placeholder = oqrDefaultLabel(r.key, r.src);
    name.maxLength = 20;
    name.title = "押すと名前を変えられます（空にすると元の名前）";
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
    name.addEventListener("change", () => oqrSetName(r.key, r.src, name.value));

    const sel = document.createElement("select");
    sel.innerHTML = `<option value="0">－</option>` +
      Array.from({ length: OQR_SLOT_COUNT }, (_, i) => `<option value="${i + 1}">${optionText(i + 1)}</option>`).join("");
    sel.value = String(n);
    sel.addEventListener("change", () => oqrAssign(r.key, Number(sel.value), reactions));

    row.append(img, name, sel);
    root.appendChild(row);
  }
}

// ---------- "押して送る": reaction buttons that work from any tab ----------
// The panel stays open while the user switches tabs, so these reach Ovice even
// when it is buried under other tabs. background.js picks the Ovice tab.

const SEND_MESSAGES = {
  "no-tab": "Oviceのタブが見つかりません。ChromeでOviceを開いてください",
  "no-script": "Oviceのタブを再読み込み（F5）してください",
  "no-bar": "リアクション列が見つかりません。Oviceの画面下の😊を一度開いてください",
  "not-found": "このリアクションが今のOviceにありません。Oviceのタブを再読み込みしてください",
  "busy": "Oviceが連続送信を止めています。少し待ってから押してください",
};
const REPEAT_DELAY_MS = 350; // same feel as the ⚡ window
const REPEAT_MS = 200;

// Kept as references: the 📌 window moves these nodes into another document.
const sendBox = document.getElementById("sendBox");
const sendRoot = document.getElementById("send");
const sendStatus = document.getElementById("sendStatus");
let firing = { t: null, i: null, btn: null };

function stopFiring() {
  clearTimeout(firing.t);
  clearInterval(firing.i);
  if (firing.btn) firing.btn.classList.remove("firing");
  firing = { t: null, i: null, btn: null };
}

async function sendKey(key, label) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "send-reaction", key });
  } catch (e) {
    res = null;
  }
  const result = (res && res.result) || "no-script";
  sendStatus.classList.toggle("ng", result !== "ok");
  sendStatus.textContent = result === "ok" ? `送りました：${label}` : SEND_MESSAGES[result] || SEND_MESSAGES["no-script"];
  if (result !== "ok" && result !== "busy") stopFiring();
}

function renderSend({ reactions, slots }) {
  sendBox.hidden = reactions.length === 0;
  const root = sendRoot;
  const doc = root.ownerDocument;
  stopFiring();
  root.innerHTML = "";
  for (const r of reactions) {
    const label = oqrLabel(r.key, r.src);
    const n = oqrSlotOf(r.key, slots);
    const b = doc.createElement("button");
    b.title = n ? `${label}（キー${n}番）` : label;
    const img = doc.createElement("img");
    img.src = r.icon || r.src;
    b.appendChild(img);
    if (n) {
      const k = doc.createElement("span");
      k.className = "k";
      k.textContent = n;
      b.appendChild(k);
    }
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      stopFiring();
      firing.btn = b;
      b.classList.add("firing");
      sendKey(r.key, label);
      firing.t = setTimeout(() => {
        firing.i = setInterval(() => sendKey(r.key, label), REPEAT_MS);
      }, REPEAT_DELAY_MS);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, stopFiring);
    root.appendChild(b);
  }
}
window.addEventListener("blur", stopFiring);
document.addEventListener("pointerup", stopFiring); // release outside the button

async function renderAll() {
  await oqrLoadNames();
  const state = await loadState();
  renderSend(state);
  renderTable(state);
  renderList(state);
}

// Names column (リアクション 01 ...) is folded by default; remember the choice.
const toggle = document.getElementById("toggleNames");
function applyNames(on) {
  document.body.classList.toggle("names", on);
  toggle.textContent = on ? "名前 ▾" : "名前 ▸";
}
let namesOn = false;
try { namesOn = localStorage.getItem("oqrNames") === "1"; } catch (e) {}
applyNames(namesOn);
toggle.addEventListener("click", () => {
  namesOn = !namesOn;
  applyNames(namesOn);
  try { localStorage.setItem("oqrNames", namesOn ? "1" : "0"); } catch (e) {}
});

// View choice, kept in chrome.storage.local "oqrView":
//   "detail" | "simple" (side panel) | "window" (別窓: the toolbar icon opens
//   the narrow popup window directly; background.js handles that).
const simpleBtn = document.getElementById("toggleSimple");
function applySimple(on) {
  document.body.classList.toggle("simple", on);
  simpleBtn.textContent = on ? "詳しく" : "シンプル";
  simpleBtn.title = on ? "対応表と割り当ても表示する" : "送るボタンだけの細い別窓で開く";
}
const params = new URLSearchParams(location.search);
const IN_WINDOW = params.has("win"); // opened as the 別窓, not as the side panel
let simpleOn = IN_WINDOW;
applySimple(simpleOn);
if (!IN_WINDOW) {
  chrome.storage.local.get("oqrView").then(({ oqrView }) => {
    // Older versions kept the choice in localStorage.
    let legacy = false;
    try { legacy = localStorage.getItem("oqrSimple") === "1"; } catch (e) {}
    simpleOn = oqrView ? oqrView !== "detail" : legacy;
    applySimple(simpleOn);
  });
}
async function popOut() {
  let res = null;
  try {
    const me = await chrome.windows.getCurrent();
    res = await chrome.runtime.sendMessage({ type: "open-window", windowId: me.id });
  } catch (e) {
    res = null;
  }
  if (!res || !res.ok) {
    // Keep the panel open so the user is not left with nothing on screen.
    sendStatus.classList.add("ng");
    sendStatus.textContent = "別窓を開けませんでした。もう一度押すか、Chromeを再起動してください";
    return;
  }
  window.close(); // closes the side panel
}
// シンプル goes straight to the 別窓 (the panel cannot get narrow enough to be
// worth staying in). "simple" inside the panel only remains for older saves.
simpleBtn.addEventListener("click", () => {
  if (simpleOn) {
    simpleOn = false;
    applySimple(false);
    chrome.storage.local.set({ oqrView: "detail" });
  } else {
    popOut();
  }
});
document.getElementById("popOut").addEventListener("click", popOut);

if (IN_WINDOW) {
  document.body.classList.add("win");
  document.title = "リアクション";
  document.getElementById("backToPanel").addEventListener("click", () => {
    chrome.storage.local.set({ oqrView: "detail" });
    // Called straight from the click so Chrome accepts it as a user action.
    chrome.sidePanel.open({ windowId: Number(params.get("from")) })
      .catch(() => chrome.windows.getLastFocused({ windowTypes: ["normal"] })
        .then((w) => chrome.sidePanel.open({ windowId: w.id })))
      .catch(() => {})
      .finally(() => window.close());
  });

  // Chrome widens the window past the width we ask for (to about 160px), which
  // can push it off the right edge. Pull it back inside the screen it is on.
  const keepOnScreen = async () => {
    const s = window.screen;
    if (!s.availWidth || !window.outerWidth || window.outerWidth > s.availWidth || window.outerHeight > s.availHeight) return;
    const maxLeft = s.availLeft + s.availWidth - window.outerWidth;
    const maxTop = s.availTop + s.availHeight - window.outerHeight;
    const left = Math.max(s.availLeft, Math.min(window.screenX, maxLeft));
    const top = Math.max(s.availTop, Math.min(window.screenY, maxTop));
    if (left === window.screenX && top === window.screenY) return;
    const w = await chrome.windows.getCurrent();
    chrome.windows.update(w.id, { left, top }).catch(() => {});
  };
  keepOnScreen();
  setTimeout(keepOnScreen, 500); // again after Chrome has settled the size

  // Move the window by dragging the grip (chrome.windows.update; one update in
  // flight at a time, and a final one on release so it lands where dropped).
  const grip = document.getElementById("grip");
  let drag = null;
  const moveTo = (x, y) => {
    drag.busy = true;
    chrome.windows.update(drag.id, { left: Math.round(x - drag.dx), top: Math.round(y - drag.dy) })
      .catch(() => {})
      .finally(() => { if (drag) drag.busy = false; });
  };
  grip.addEventListener("pointerdown", async (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("moving");
    const w = await chrome.windows.getCurrent();
    drag = { id: w.id, dx: e.screenX - w.left, dy: e.screenY - w.top, busy: false, x: e.screenX, y: e.screenY };
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.x = e.screenX;
    drag.y = e.screenY;
    if (!drag.busy) moveTo(drag.x, drag.y);
  });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) {
    grip.addEventListener(ev, () => {
      grip.classList.remove("moving");
      if (!drag) return;
      moveTo(drag.x, drag.y);
      drag = null;
    });
  }

  // 📌: Chrome gives extensions no "always on top" for normal windows, but a
  // Document Picture-in-Picture window stays above every app (like the ⚡
  // window). Move the send buttons into one and minimize this window; they
  // come back when the pinned window is closed.
  if ("documentPictureInPicture" in window) {
    document.body.classList.add("canpin");
    document.getElementById("pinTop").addEventListener("click", async () => {
      let pip;
      try {
        pip = await documentPictureInPicture.requestWindow({ width: Math.max(window.innerWidth, 80), height: window.innerHeight });
      } catch (e) {
        sendStatus.classList.add("ng");
        sendStatus.textContent = "手前に固定できませんでした：" + e.message;
        return;
      }
      for (const s of document.querySelectorAll("style")) pip.document.head.appendChild(s.cloneNode(true));
      pip.document.body.className = "simple win pinned";
      const home = sendBox.nextSibling;
      pip.document.body.appendChild(sendBox);
      pip.document.addEventListener("pointerup", stopFiring);
      pip.addEventListener("blur", stopFiring);
      const me = await chrome.windows.getCurrent();
      chrome.windows.update(me.id, { state: "minimized" }).catch(() => {});
      pip.addEventListener("pagehide", () => {
        stopFiring();
        document.body.insertBefore(sendBox, home);
        renderAll(); // rebuild the buttons in this document
        chrome.windows.update(me.id, { state: "normal", focused: true }).catch(() => {});
      });
      renderAll(); // rebuild the buttons in the pinned document
    });
  }
}

document.getElementById("shortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// The panel stays open: follow changes made elsewhere.
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" && (changes.slots || changes.names)) || (area === "local" && changes.reactions)) renderAll();
});
// Shortcut edits in chrome://extensions fire no event; refresh the table only
// (leaving the list alone so an open dropdown is not interrupted).
setInterval(async () => renderTable(await loadState()), 3000);

renderAll();

}
// ---------- panel.js ----------
// Tampermonkey 版の「パネル」: 拡張のサイドパネル(sidepanel.html / sidepanel.js)を、Ovice のページの中に浮かぶ窓で動かす。
// - 中身は sidepanel.js をそのまま使う(build_userscript.py が oqrRunSidepanel() に包んで貼る)。
//   document / window / location / localStorage だけ、このパネル用の代役を渡す
// - 開閉ボタン(⌨)・ドラッグで移動・位置と開閉を保存(GM の oqrPanelPos / oqrPanelOpen)
// - Tampermonkey のメニューから「パネルを開く/閉じる」「使い方を開く」
// - ショートカット: Ctrl+Shift+1〜9・0 を、Ovice の画面を見ている間だけページ内で拾う
(function oqrPanelHost() {
  const root = document.documentElement;
  if (root.dataset.oqrRunning !== "userscript") {
    // 拡張版が先に動いている。こちらは休む(メニューで理由だけ分かるようにする)
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("拡張版が動いているため休んでいます", () =>
        alert("Chrome 拡張版の Ovice Quick Reactions が先に動いているので、Tampermonkey 版は休んでいます。\n片方だけにする時は、拡張版を chrome://extensions でオフにしてください。"));
      GM_registerMenuCommand("使い方を開く", () => GM_openInTab(OQR_US_HOME, { active: true }));
    }
    return;
  }

  const PANEL_W = 330;
  const FRAME_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483646; left: 0; top: 0; }
    :host([hidden]) { display: none; }
    .frame { display: flex; flex-direction: column; width: ${PANEL_W}px; max-height: calc(100vh - 16px);
             background: #fff; border: 1px solid #b9c6cf; border-radius: 8px; overflow: hidden;
             box-shadow: 0 6px 24px rgba(0,0,0,.22); font: 12px "Meiryo", sans-serif; color: #222; }
    .frame:has(.oqr-body.simple) { width: auto; min-width: 64px; }
    /* 細い表示では題名で幅が決まらないように(入りきらない分は … になる) */
    .frame:has(.oqr-body.simple) .bar .t { width: 0; }
    .bar { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 3px 0 6px; flex-shrink: 0;
           background: #e3eef2; color: #355; cursor: move; user-select: none; touch-action: none; }
    .bar.moving { background: #0a7c9e; color: #fff; }
    .bar .t { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: bold; }
    .bar button { flex-shrink: 0; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent;
                  color: inherit; font: bold 13px/18px sans-serif; cursor: pointer; }
    .bar button:hover { background: rgba(0,0,0,.12); }
    .scroll { overflow: auto; min-height: 0; }
    /* パネルでは窓そのものを動かす「⠿ 移動」は上の帯が兼ねる */
    .oqr-body #grip { display: none !important; }
  `;

  // ---------- 浮かぶ窓 ----------
  const host = document.createElement("div");
  host.id = "oqr-us-panel";
  const shadow = host.attachShadow({ mode: "open" });
  // 元の CSS(body 向け)も入れておく: 📌 で小窓に写す時に使われる。影の中では body が無いので何にも当たらない
  shadow.innerHTML = `<style>${OQR_PANEL_CSS_RAW}</style><style>${OQR_PANEL_CSS}</style><style>${FRAME_CSS}</style>
    <div class="frame"><div class="bar" title="ここをつかんで動かす"><span class="t">⠿ Ovice リアクション</span>
    <button class="close" title="閉じる(⌨ ボタンか Tampermonkey のメニューで また開けます)">×</button></div>
    <div class="scroll"><div class="oqr-body"></div></div></div>`;
  const frame = shadow.querySelector(".frame");
  const bar = shadow.querySelector(".bar");
  const body = shadow.querySelector(".oqr-body");

  function clampPos(p) {
    const w = frame.offsetWidth || PANEL_W;
    const h = Math.min(frame.offsetHeight || 200, innerHeight);
    return {
      left: Math.round(Math.max(0, Math.min(p.left, innerWidth - Math.min(w, innerWidth)))),
      top: Math.round(Math.max(0, Math.min(p.top, innerHeight - Math.min(h, 40)))),
    };
  }
  // want = 利用者が置いた場所(保存する値)。画面が狭い時は見せる位置だけ内側へ寄せ、want は変えない
  let want = GM_getValue("oqrPanelPos") || null;
  let pos = { left: 0, top: 0 };
  function placeAt(p, save) {
    if (p) want = { left: Math.round(p.left), top: Math.round(p.top) };
    const base = want || { left: innerWidth - PANEL_W - 70, top: 70 }; // 初めは右上(⚡ の左)
    pos = clampPos(base);
    host.style.left = pos.left + "px";
    host.style.top = pos.top + "px";
    if (save && want) GM_setValue("oqrPanelPos", want);
  }
  addEventListener("resize", () => placeAt(null, false));

  // 上の帯をつかんで動かす
  let drag = null;
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("moving");
    drag = { dx: e.clientX - pos.left, dy: e.clientY - pos.top };
  });
  bar.addEventListener("pointermove", (e) => {
    if (drag) placeAt({ left: e.clientX - drag.dx, top: e.clientY - drag.dy }, false);
  });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) {
    bar.addEventListener(ev, () => {
      bar.classList.remove("moving");
      if (!drag) return;
      drag = null;
      placeAt(pos, true);
    });
  }
  shadow.querySelector(".close").addEventListener("click", () => setOpen(false));

  // shim.js の chrome.windows.* がこの窓を指すようにする
  oqrPanelHooks.bounds = () => ({ left: pos.left, top: pos.top, width: frame.offsetWidth, height: frame.offsetHeight });
  oqrPanelHooks.move = (left, top) => placeAt({ left: left ?? pos.left, top: top ?? pos.top }, true);
  oqrPanelHooks.setHidden = (hide) => { host.hidden = hide; };

  // ---------- sidepanel.js を動かす ----------
  // sidepanel.js は「閉じる → 開き直す」で表示を切り替える(シンプル→別窓、戻す)。
  // ここでは window.close() で中身を作り直す。前の回の監視・タイマーは片付ける。
  let run = null;
  function teardown() {
    if (!run) return;
    for (const id of run.intervals) clearInterval(id);
    for (const fn of run.storage) chrome.storage.onChanged.removeListener(fn);
    for (const [t, f, o] of run.win) removeEventListener(t, f, o);
    for (const [t, f, o] of run.doc) document.removeEventListener(t, f, o);
    run = null;
  }
  function mount() {
    teardown();
    const view = GM_getValue("oqrView");
    body.className = "oqr-body";
    body.innerHTML = OQR_PANEL_HTML;
    const r = (run = { intervals: [], storage: [], win: [], doc: [] });
    const fakeDoc = {
      getElementById: (id) => shadow.getElementById(id),
      createElement: (t) => document.createElement(t),
      querySelectorAll: (s) => shadow.querySelectorAll(s),
      get body() { return body; },
      get title() { return ""; },
      set title(v) {},
      addEventListener: (t, f, o) => { document.addEventListener(t, f, o); r.doc.push([t, f, o]); },
    };
    const fakeWin = {
      addEventListener: (t, f, o) => { addEventListener(t, f, o); r.win.push([t, f, o]); },
      close: () => setTimeout(() => { if (run === r) mount(); }, 0),
      screen: { availWidth: 0, availHeight: 0, availLeft: 0, availTop: 0 }, // 画面の端へ戻す処理は使わない
      get innerWidth() { return frame.offsetWidth; },
      get innerHeight() { return body.scrollHeight + 8; },
      outerWidth: 0, outerHeight: 0, screenX: 0, screenY: 0,
    };
    // 📌(常に手前の小窓)は sidepanel.js が「"documentPictureInPicture" in window」で出し分ける
    if ("documentPictureInPicture" in globalThis) {
      Object.defineProperty(fakeWin, "documentPictureInPicture", { get: () => globalThis.documentPictureInPicture });
    }
    const fakeStorage = {
      getItem: (k) => { const v = GM_getValue("ls_" + k); return v == null ? null : String(v); },
      setItem: (k, v) => GM_setValue("ls_" + k, String(v)),
    };
    const runChrome = Object.assign({}, chrome, {
      storage: Object.assign({}, chrome.storage, {
        onChanged: { addListener: (fn) => { chrome.storage.onChanged.addListener(fn); r.storage.push(fn); } },
      }),
    });
    const trackedInterval = (f, ms) => { const id = setInterval(f, ms); r.intervals.push(id); return id; };
    const loc = { search: view === "window" ? "?win=1&from=1" : "" };
    try {
      oqrRunSidepanel(fakeDoc, fakeWin, loc, fakeStorage, runChrome, trackedInterval);
    } catch (e) {
      console.error("[ovice-quick-reactions] panel", e);
    }
    requestAnimationFrame(() => placeAt(null, false));
  }

  function setOpen(open) {
    GM_setValue("oqrPanelOpen", open);
    if (open) {
      if (!host.isConnected) document.body.appendChild(host);
      host.hidden = false;
      mount();
    } else {
      teardown();
      host.hidden = true;
    }
    launcher.style.opacity = open ? "1" : "0.85";
  }
  const isOpen = () => !host.hidden && !!run;

  // ---------- 開閉ボタン(⚡ の下) ----------
  const launcher = document.createElement("button");
  launcher.id = "oqr-panel-launcher";
  launcher.textContent = "⌨";
  launcher.title = "キーとリアクションのパネルを開く・閉じる(Tampermonkey 版)";
  Object.assign(launcher.style, {
    position: "fixed", right: "12px", top: "calc(45% + 48px)", zIndex: 2147483647,
    width: "40px", height: "40px", borderRadius: "50%", border: "0",
    background: "#0a7c9e", color: "#fff", fontSize: "20px", lineHeight: "40px", padding: "0", cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,.3)", opacity: "0.85",
  });
  launcher.addEventListener("click", () => setOpen(!isOpen()));

  // Ovice が画面を描き直してボタンが消えた時に付け直す(content.js の ⚡ と同じ考え方)
  function attach() {
    if (!launcher.isConnected) document.body.appendChild(launcher);
    if (!host.isConnected) document.body.appendChild(host);
  }
  host.hidden = true;
  attach();
  setInterval(attach, 3000);
  placeAt(null, false);
  // 初めて入れた時は開いておく(どこにあるか分かるように)
  if (GM_getValue("oqrPanelOpen", true)) setOpen(true);

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("⌨ パネルを開く/閉じる", () => setOpen(!isOpen()));
    GM_registerMenuCommand("📖 使い方を開く", () => GM_openInTab(OQR_US_HOME, { active: true }));
  }

  // ---------- ショートカットキー ----------
  // 拡張の chrome.commands は「グローバル」(他のアプリを見ていても効く)にできたが、
  // ページの中では Ovice の画面を見ている時しか拾えない。
  addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
    const m = /^Digit(\d)$/.exec(e.code || "");
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const slot = Number(m[1]) === 0 ? 10 : Number(m[1]);
    oqrDeliver({ type: "react-slot", slot });
  }, true);
})();

})();
