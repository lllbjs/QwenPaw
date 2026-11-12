/**
 * Model Accordion — QwenPaw frontend plugin.
 *
 * Port of dsh-model-accordion's core ideas to the QwenPaw console:
 * single-open provider accordion, pinned favorites, expand/collapse/sort
 * toolbar, model-count badges and persistent state.
 *
 * DOM-decoration only: every click that selects a model is forwarded to the
 * host ModelSelector's own buttons, so OAuth checks, free-switch warnings
 * and activation logic stay with the host. No build step; plain ES module.
 */

const VERSION = "0.2.3";
const NS = "qwenpaw-model-accordion";
const LS = {
  favorites: `${NS}:favorites`,
  sort: `${NS}:sort`,
  single: `${NS}:single-open`,
  open: `${NS}:open`,
};

// CSS modules emit `index__<local>___<hash>`; substring selectors survive
// hashing and host rebuilds. `modelItem` does not match `hiddenModelItem`
// (capital M) and `providerHeader` does not match `providerHeading`.
const SEL = {
  list: 'div[class*="listContainer"][role="region"]',
  group: 'div[class*="providerGroup"]',
  header: 'button[class*="providerHeader"]',
  headerName: 'span[class*="providerHeaderName"]',
  collapseIcon: 'span[class*="collapseIcon"]',
  row: 'div[class*="modelItem"]',
  selectBtn: 'button[class*="modelSelectButton"]',
  modelName: 'span[class*="modelName"]',
  search: 'input[class*="searchInput"]',
  searchWrap: 'div[class*="searchWrapper"]',
  freeToggle: 'button[class*="manageButton"][aria-pressed]',
  viewMore: 'button[class*="viewMore"]',
  spin: 'div[class*="spinWrapper"]',
  empty: 'div[class*="emptyTip"]',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full / blocked — decoration keeps working in-memory
  }
}

// ── i18n ────────────────────────────────────────────────────────────────────

const STRINGS = {
  zh: {
    favorites: "收藏",
    clearFavorites: "清空收藏",
    clearConfirm: "确定清空所有收藏模型？",
    expandAll: "全部展开",
    collapseAll: "全部收起",
    sort: "供应商排序",
    sortDefault: "默认顺序",
    sortName: "名称 A→Z",
    sortSize: "模型数量 ↓",
    star: "收藏该模型",
    unstar: "取消收藏",
    missing: "已下线",
    missingHint: "模型已不存在，可点星标移除",
    selectFailed: "当前列表里找不到该模型",
    gateway: "本地网关",
    gatewayTip:
      "扫描本机 127.0.0.1 上的 OpenAI 兼容网关（WorkBuddy / Trae 等），一键导入成 QwenPaw provider。",
    gatewayRescan: "重新扫描",
    gatewayImport: "导入",
    gatewayImporting: "导入中…",
    gatewayImported: "已导入，发现 {n} 个模型",
    gatewayExists: "已导入，重新拉取模型",
    gatewayFail: "导入失败：{msg}",
    gatewayNeedsKey: "该网关需要一个 key（在 DaddySuite 里获取）才能导入并拉取模型。",
    gatewayKeyPlaceholder: "网关 API Key",
    gatewayStatusOpen: "可用",
    gatewayStatusKey: "需密钥",
    gatewayStatusDown: "未发现",
    gatewayNone: "没有发现本地网关（确认 DaddySuite / Ollama 是否在运行）。",
    gatewayPortHint: "额外端口（可选，逗号分隔）",
    gatewayClose: "关闭",
  },
  en: {
    favorites: "Favorites",
    clearFavorites: "Clear favorites",
    clearConfirm: "Remove all favorite models?",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    sort: "Provider sort",
    sortDefault: "Default order",
    sortName: "Name A→Z",
    sortSize: "Model count ↓",
    star: "Favorite this model",
    unstar: "Unfavorite",
    missing: "Unavailable",
    missingHint: "Model no longer exists; remove it via the star",
    selectFailed: "Model not found in the current list",
    gateway: "Local gateways",
    gatewayTip:
      "Scan this machine's 127.0.0.1 OpenAI-compatible gateways (WorkBuddy / Trae, …) and import one as a QwenPaw provider.",
    gatewayRescan: "Rescan",
    gatewayImport: "Import",
    gatewayImporting: "Importing…",
    gatewayImported: "Imported — {n} models found",
    gatewayExists: "Already imported — re-pulling models",
    gatewayFail: "Import failed: {msg}",
    gatewayNeedsKey: "This gateway needs a key (get it from DaddySuite) before it can be imported and its models listed.",
    gatewayKeyPlaceholder: "Gateway API key",
    gatewayStatusOpen: "Open",
    gatewayStatusKey: "Needs key",
    gatewayStatusDown: "Not found",
    gatewayNone: "No local gateway found (is DaddySuite / Ollama running?).",
    gatewayPortHint: "Extra ports (optional, comma-separated)",
    gatewayClose: "Close",
  },
};
function lang() {
  const raw =
    localStorage.getItem("language") ||
    document.documentElement.lang ||
    navigator.language ||
    "en";
  return raw.toLowerCase().startsWith("zh") ? "zh" : "en";
}
const t = (key) => (STRINGS[lang()] || STRINGS.en)[key] || STRINGS.en[key] || key;

// ── Host API + data cache ───────────────────────────────────────────────────
// Only id/name/model metadata is kept — provider credentials from /api/models
// are never read into the cache or persisted.

const host = () => (window.QwenPaw && window.QwenPaw.host) || {};
function apiUrl(path) {
  const fn = host().getApiUrl;
  if (typeof fn === "function") return fn(path);
  return `/api${path.startsWith("/") ? "" : "/"}${path}`;
}
function selectedAgentId() {
  try {
    const raw =
      sessionStorage.getItem("qwenpaw-agent-storage") ??
      localStorage.getItem("qwenpaw-agent-storage");
    const id = raw ? JSON.parse(raw)?.state?.selectedAgent : null;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}
function authHeaders() {
  const headers = {};
  const token = host().getApiToken?.();
  if (token) headers.Authorization = `Bearer ${token}`;
  const agentId = selectedAgentId();
  if (agentId) headers["X-Agent-Id"] = agentId;
  return headers;
}

const cache = {
  providers: new Map(), // id -> { name, models: [{ id, name, is_free }] }
  active: null, // { providerId, modelId }
  version: 0, // bumped on every successful fetch; invalidates signatures
  fetchedAt: 0,
};

async function fetchData(force = false) {
  if (!force && Date.now() - cache.fetchedAt < 5000) return;
  cache.fetchedAt = Date.now();
  try {
    const agentId = selectedAgentId();
    const activeQuery = agentId
      ? `/models/active?scope=effective&agent_id=${encodeURIComponent(agentId)}`
      : "/models/active";
    const [providersRes, activeRes] = await Promise.all([
      fetch(apiUrl("/models"), { headers: authHeaders() }),
      fetch(apiUrl(activeQuery), { headers: authHeaders() }).catch(() => null),
    ]);
    if (!providersRes.ok) return;
    const providers = await providersRes.json();
    const next = new Map();
    if (Array.isArray(providers)) {
      for (const p of providers) {
        if (!p || typeof p.id !== "string") continue;
        // The host selector merges models + extra_models (local/custom models).
        const raw = [
          ...(Array.isArray(p.models) ? p.models : []),
          ...(Array.isArray(p.extra_models) ? p.extra_models : []),
        ];
        const byId = new Map();
        for (const m of raw) {
          if (m && typeof m.id === "string" && !byId.has(m.id)) {
            byId.set(m.id, { id: m.id, name: m.name || m.id, is_free: !!m.is_free });
          }
        }
        next.set(p.id, { name: p.name || p.id, models: [...byId.values()] });
      }
    }
    cache.providers = next;
    if (activeRes && activeRes.ok) {
      const active = await activeRes.json();
      const llm = active?.active_llm;
      cache.active =
        llm && llm.provider_id && llm.model
          ? { providerId: llm.provider_id, modelId: llm.model }
          : null;
    }
    cache.version += 1;
    scheduleScan();
  } catch {
    // backend unreachable — keep the previous cache
  }
}

function providerByKey(key) {
  if (cache.providers.has(key)) return { id: key, ...cache.providers.get(key) };
  for (const [id, p] of cache.providers) {
    if (p.name === key) return { id, ...p };
  }
  return null;
}

// ── Persistent preferences ──────────────────────────────────────────────────

const SORT_MODES = ["default", "name", "size"];
const prefs = {
  get favorites() {
    const list = readJSON(LS.favorites, []);
    return Array.isArray(list)
      ? list.filter((f) => f && typeof f.p === "string" && typeof f.n === "string")
      : [];
  },
  set favorites(list) {
    writeJSON(LS.favorites, list);
  },
  get sort() {
    const mode = readJSON(LS.sort, "default");
    return SORT_MODES.includes(mode) ? mode : "default";
  },
  set sort(mode) {
    writeJSON(LS.sort, mode);
  },
  get singleOpen() {
    return readJSON(LS.single, true) !== false;
  },
  get open() {
    const list = readJSON(LS.open, null);
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : null;
  },
  set open(list) {
    writeJSON(LS.open, list);
  },
};

const favKey = (f) => `${f.p}/${f.m || f.n}`;

function resolveModelId(p, name, index) {
  const provider = providerByKey(p);
  const sameName = provider ? provider.models.filter((m) => m.name === name) : [];
  // Duplicate names: key by name + row index instead of guessing an id.
  return sameName.length === 1 ? sameName[0].id : null;
}

function isFavorited(p, modelId, name) {
  const keys = new Set(prefs.favorites.map(favKey));
  return (modelId && keys.has(`${p}/${modelId}`)) || keys.has(`${p}/${name}`);
}

function toggleFavorite(p, name, index) {
  const modelId = resolveModelId(p, name, index);
  const key = `${p}/${modelId || name}`;
  const list = prefs.favorites;
  const at = list.findIndex((f) => favKey(f) === key);
  if (at >= 0) list.splice(at, 1);
  else list.push({ p, m: modelId, n: name, i: index });
  prefs.favorites = list;
}

// ── Injected stylesheet ─────────────────────────────────────────────────────

const STYLE = `
.qma-tool {
  border: none; background: transparent; cursor: pointer;
  color: var(--app-text-tertiary, #999); font-size: 13px; line-height: 1;
  padding: 3px 5px; border-radius: 4px; flex-shrink: 0; white-space: nowrap;
}
.qma-tool:hover { color: var(--app-text, #333); background: rgba(127,127,127,.12); }
.qma-count {
  font-size: 11px; font-weight: 400;
  color: var(--app-text-quaternary, #aaa);
  flex-shrink: 0; white-space: nowrap; margin-left: auto;
}
.qma-star {
  border: none; background: transparent; cursor: pointer;
  font-size: 13px; line-height: 1; padding: 2px 4px; border-radius: 4px;
  color: var(--app-text-quaternary, #bbb); flex-shrink: 0;
}
.qma-star:hover { color: #f5a623; background: rgba(127,127,127,.12); }
.qma-star[data-on="1"] { color: #f5a623; }
.qma-favs { border-bottom: 1px solid var(--app-border, rgba(127,127,127,.2)); }
.qma-favs-head {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 500;
  color: var(--app-text-secondary, #666);
  padding: 2px 0; user-select: none;
}
.qma-favs-head .qma-tool { margin-left: auto; font-size: 11px; }
.qma-fav-row {
  display: flex; align-items: center; gap: 8px;
  font-size: 14px; border-radius: 6px; cursor: pointer;
  padding: 1px 0; outline: none;
}
.qma-fav-row:hover, .qma-fav-row:focus-visible { background: rgba(127,127,127,.1); }
.qma-fav-row img, .qma-fav-row svg { flex-shrink: 0; }
.qma-fav-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1; min-width: 0;
}
.qma-fav-provider {
  font-size: 11px; color: var(--app-text-quaternary, #aaa);
  flex-shrink: 0; max-width: 96px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.qma-fav-row[data-missing="1"] { opacity: .45; }
.qma-missing-tag {
  font-size: 10px; border: 1px solid var(--app-border, rgba(127,127,127,.35));
  border-radius: 99px; padding: 0 5px; flex-shrink: 0;
  color: var(--app-text-tertiary, #999);
}
.qma-gw-mask {
  position: fixed; inset: 0; z-index: 2147483000;
  background: rgba(0,0,0,.35);
  display: flex; align-items: center; justify-content: center;
}
.qma-gw {
  width: min(540px, 92vw); max-height: 82vh; overflow: auto;
  background: var(--app-bg, #fff); color: var(--app-text, #222);
  border: 1px solid var(--app-border, rgba(127,127,127,.3));
  border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.25);
  font-size: 13px;
}
.qma-gw-head {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px; font-weight: 600;
  border-bottom: 1px solid var(--app-border, rgba(127,127,127,.2));
}
.qma-gw-head .qma-tool { margin-left: auto; font-size: 16px; }
.qma-gw-body { padding: 6px 14px 14px; }
.qma-gw-tip {
  font-size: 11px; color: var(--app-text-tertiary, #999);
  line-height: 1.5; margin: 6px 0 10px;
}
.qma-gw-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--app-border, rgba(127,127,127,.18));
}
.qma-gw-row:last-child { border-bottom: none; }
.qma-gw-label { font-weight: 600; flex-shrink: 0; }
.qma-gw-url {
  font-size: 11px; color: var(--app-text-tertiary, #999);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.qma-gw-chip {
  font-size: 11px; padding: 1px 7px; border-radius: 99px; flex-shrink: 0;
  border: 1px solid var(--app-border, rgba(127,127,127,.35));
  color: var(--app-text-secondary, #666);
}
.qma-gw-chip[data-s="open"] { color: #1a9c46; border-color: rgba(26,156,70,.4); }
.qma-gw-chip[data-s="needs_key"] { color: #c98a1a; border-color: rgba(201,138,26,.4); }
.qma-gw-chip[data-s="down"] { color: #b0483f; border-color: rgba(176,72,63,.4); }
.qma-gw-key {
  font-size: 12px; padding: 3px 6px; border-radius: 5px; width: 150px; flex-shrink: 0;
  border: 1px solid var(--app-border, rgba(127,127,127,.4));
  background: var(--app-bg, #fff); color: var(--app-text, #222);
}
.qma-gw-btn {
  border: 1px solid var(--app-border, rgba(127,127,127,.4));
  background: transparent; color: var(--app-text, #333);
  font-size: 12px; padding: 3px 10px; border-radius: 6px; cursor: pointer; flex-shrink: 0;
}
.qma-gw-btn:hover { background: rgba(127,127,127,.12); }
.qma-gw-btn:disabled { opacity: .5; cursor: default; }
.qma-gw-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
.qma-toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 2147483001; max-width: 80vw;
  background: rgba(0,0,0,.82); color: #fff;
  font-size: 12px; padding: 8px 14px; border-radius: 8px;
}
.qma-launcher {
  display: inline-flex; align-items: center; gap: 3px;
  border: 1px solid var(--app-border, rgba(127,127,127,.35));
  background: transparent; cursor: pointer;
  color: var(--app-text-secondary, #666);
  font-size: 12px; line-height: 1; padding: 3px 7px; border-radius: 99px;
  flex-shrink: 0; white-space: nowrap;
}
.qma-launcher:hover { color: var(--app-text, #333); background: rgba(127,127,127,.12); }
`;

function ensureStyle() {
  if ($( "style[data-qma-style]" )) return;
  const style = document.createElement("style");
  style.setAttribute("data-qma-style", "");
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

let synthetic = false; // guards our own click delegation during .click()
let restoring = false; // guards accordion while restoring persisted state

function synthClick(el) {
  synthetic = true;
  try {
    el.click();
  } finally {
    synthetic = false;
  }
}

function providerKeyOf(header) {
  const icon = header.querySelector("[data-provider-id]");
  const id = icon && icon.getAttribute("data-provider-id");
  if (id) return id;
  const name = $(SEL.headerName, header);
  return name ? name.textContent.trim() : "";
}

function providerNameOf(header) {
  const name = $(SEL.headerName, header);
  return name ? name.textContent.trim() : providerKeyOf(header);
}

function groupOf(header) {
  return header.closest(SEL.group);
}

function findGroup(panel, key) {
  return $$(SEL.header, panel)
    .map((h) => ({ h, g: groupOf(h) }))
    .find(({ h, g }) => g && providerKeyOf(h) === key)?.g;
}

function searchInput(panel) {
  return $(SEL.search, panel);
}
function searchQuery(panel) {
  const input = searchInput(panel);
  return input ? input.value.trim() : "";
}
function freeTabActive(panel) {
  const toggle = $(SEL.freeToggle, panel);
  return toggle ? toggle.getAttribute("aria-pressed") === "true" : false;
}

function modelRows(group) {
  return $$(SEL.row, group).filter((row) => $(SEL.selectBtn, row));
}
function rowName(row) {
  const el = $(SEL.modelName, row);
  return el ? el.textContent.trim() : "";
}

// ── Toolbar ─────────────────────────────────────────────────────────────────

function sortButtonLabel() {
  const mode = prefs.sort;
  if (mode === "name") return "↺ A→Z";
  if (mode === "size") return "↺ ↓N";
  return "↺";
}
function sortButtonTitle() {
  const mode = prefs.sort;
  const current =
    mode === "name" ? t("sortName") : mode === "size" ? t("sortSize") : t("sortDefault");
  return `${t("sort")}: ${current}`;
}

function ensureToolbar(panel) {
  const wrap = $(SEL.searchWrap, panel);
  if (!wrap || wrap.querySelector("[data-qma-toolbar]")) return;
  const bar = document.createElement("span");
  bar.setAttribute("data-qma-toolbar", "");
  bar.style.display = "inline-flex";
  bar.style.alignItems = "center";
  bar.style.gap = "2px";
  bar.style.flexShrink = "0";

  const mk = (tool, label, title) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qma-tool";
    btn.setAttribute("data-qma-tool", tool);
    btn.setAttribute("aria-label", title);
    btn.title = title;
    btn.textContent = label;
    return btn;
  };
  const sortBtn = mk("sort", sortButtonLabel(), sortButtonTitle());
  bar.append(
    mk("expand", "⊞", t("expandAll")),
    mk("collapse", "⊟", t("collapseAll")),
    sortBtn,
    mk("gateway", "🌐", t("gateway")),
  );
  // Keep host controls (free toggle / manage) at the far right.
  const gift = $(SEL.freeToggle, wrap);
  if (gift) wrap.insertBefore(bar, gift);
  else wrap.appendChild(bar);
}

function updateToolbar(panel) {
  const btn = $('[data-qma-tool="sort"]', panel);
  if (btn) {
    btn.textContent = sortButtonLabel();
    btn.title = sortButtonTitle();
    btn.setAttribute("aria-label", sortButtonTitle());
  }
}

// ── Local gateway panel (discover + import) ─────────────────────────────────
// The browser cannot probe other loopback ports (cross-origin, opaque 401), so
// discovery goes through this plugin's own backend route
// (/api/model-accordion/gateways). Import uses QwenPaw's regular, same-origin
// provider endpoints — no upstream token handling, no protocol work.

let gwPanel = null;
let gwToastEl = null;
let gwToastTimer = null;

const gwEscHandler = (event) => {
  if (event.key === "Escape") closeGatewayPanel();
};

function gwToast(message) {
  if (!gwToastEl) {
    gwToastEl = document.createElement("div");
    gwToastEl.className = "qma-toast";
    gwToastEl.setAttribute("data-qma-gw", "");
    document.body.appendChild(gwToastEl);
  }
  gwToastEl.textContent = message;
  gwToastEl.style.display = "block";
  clearTimeout(gwToastTimer);
  gwToastTimer = setTimeout(() => {
    if (gwToastEl) gwToastEl.style.display = "none";
  }, 3600);
}

function gwErrorText(res) {
  const data = res && res.data;
  if (data && typeof data === "object") {
    return data.detail || data.raw || String(res.status || "error");
  }
  return String((res && res.status) || "network error");
}

async function gwFetch(path, init = {}) {
  const headers = { ...authHeaders(), ...(init.headers || {}) };
  if (init.body) headers["Content-Type"] = "application/json";
  const res = await fetch(apiUrl(path), { ...init, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

function gwStatusLabel(status, count) {
  if (status === "open") return `${t("gatewayStatusOpen")} · ${count}`;
  if (status === "needs_key") return t("gatewayStatusKey");
  return t("gatewayStatusDown");
}

async function gwImport(gw, input, btn) {
  const pid = `gw-${gw.label}`;
  const key = input ? input.value.trim() : "";
  const reset = () => {
    btn.textContent = t("gatewayImport");
    btn.disabled = false;
  };
  btn.disabled = true;
  btn.textContent = t("gatewayImporting");
  try {
    // Reuse the exact id when it already exists — a second POST would fork a
    // `-new` row — so probe the provider list first.
    const list = await gwFetch("/models");
    const ids = new Set(((list.data) || []).map((p) => p && p.id));
    if (!ids.has(pid)) {
      const created = await gwFetch("/models/custom-providers", {
        method: "POST",
        body: JSON.stringify({
          id: pid,
          name: `${gw.label} (local)`,
          default_base_url: gw.baseUrl,
          api_key: key,
          models: [],
        }),
      });
      if (!created.ok) {
        gwToast(t("gatewayFail").replace("{msg}", gwErrorText(created)));
        reset();
        return;
      }
    } else if (key) {
      // Existing row: apply the freshly typed key + base_url before discovering
      // (the create route can leave a stored key empty, which 401s the gateway).
      await gwFetch(`/models/${encodeURIComponent(pid)}/config`, {
        method: "PUT",
        body: JSON.stringify({ api_key: key, base_url: gw.baseUrl }),
      });
    }
    const disc = await gwFetch(
      `/models/${encodeURIComponent(pid)}/discover?save=true`,
      { method: "POST" },
    );
    const count = (disc.data && disc.data.discovered_count) || 0;
    if (count > 0) {
      await gwFetch(`/models/${encodeURIComponent(pid)}/pool/selection`, {
        method: "PUT",
        body: JSON.stringify({ selected: true }),
      });
    }
    let msg = (ids.has(pid) ? t("gatewayExists") : t("gatewayImported")).replace(
      "{n}",
      count,
    );
    if (count === 0) msg += " · " + t("gatewayNeedsKey");
    gwToast(msg);
    void fetchData(true);
    scheduleScan();
  } catch (err) {
    gwToast(t("gatewayFail").replace("{msg}", (err && err.message) || String(err)));
  }
  reset();
}

function gwRow(gw) {
  const row = document.createElement("div");
  row.className = "qma-gw-row";

  const label = document.createElement("span");
  label.className = "qma-gw-label";
  label.textContent = gw.label;

  const url = document.createElement("span");
  url.className = "qma-gw-url";
  url.textContent = gw.baseUrl;
  url.title = gw.baseUrl;

  const chip = document.createElement("span");
  chip.className = "qma-gw-chip";
  chip.setAttribute("data-s", gw.status);
  chip.textContent = gwStatusLabel(gw.status, gw.modelCount);

  row.append(label, url, chip);

  if (gw.status !== "down") {
    let input = null;
    if (gw.status === "needs_key") {
      input = document.createElement("input");
      input.className = "qma-gw-key";
      input.type = "password";
      input.placeholder = t("gatewayKeyPlaceholder");
      row.append(input);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qma-gw-btn";
    btn.textContent = t("gatewayImport");
    btn.addEventListener("click", () => gwImport(gw, input, btn));
    row.append(btn);
  }
  return row;
}

async function gwLoad() {
  const body = gwPanel && gwPanel.querySelector("[data-qma-gw-body]");
  if (!body) return;
  body.textContent = "";

  const tip = document.createElement("div");
  tip.className = "qma-gw-tip";
  tip.textContent = t("gatewayTip");
  body.append(tip);

  const list = document.createElement("div");
  list.setAttribute("data-qma-gw-list", "");
  list.textContent = "…";
  body.append(list);

  const portsInput = gwPanel.querySelector("[data-qma-gw-ports]");
  const extra = portsInput ? portsInput.value.trim() : "";
  let res;
  try {
    res = await gwFetch(
      `/model-accordion/gateways${extra ? `?ports=${encodeURIComponent(extra)}` : ""}`,
    );
  } catch (err) {
    list.textContent = t("gatewayFail").replace(
      "{msg}",
      (err && err.message) || String(err),
    );
    return;
  }
  if (!res.ok) {
    list.textContent = t("gatewayFail").replace("{msg}", gwErrorText(res));
    return;
  }
  const gws = (res.data && res.data.gateways) || [];
  list.textContent = "";
  if (!gws.length) {
    list.textContent = t("gatewayNone");
    return;
  }
  for (const gw of gws) list.append(gwRow(gw));
}

function closeGatewayPanel() {
  if (gwPanel) {
    gwPanel.remove();
    gwPanel = null;
  }
  document.removeEventListener("keydown", gwEscHandler);
}

function openGatewayPanel() {
  if (gwPanel) return; // one panel at a time

  const mask = document.createElement("div");
  mask.className = "qma-gw-mask";
  mask.setAttribute("data-qma-gw", "");

  const panel = document.createElement("div");
  panel.className = "qma-gw";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", t("gateway"));

  const head = document.createElement("div");
  head.className = "qma-gw-head";
  const title = document.createElement("span");
  title.textContent = `🌐 ${t("gateway")}`;
  const ports = document.createElement("input");
  ports.className = "qma-gw-key";
  ports.setAttribute("data-qma-gw-ports", "");
  ports.placeholder = t("gatewayPortHint");
  const rescan = document.createElement("button");
  rescan.type = "button";
  rescan.className = "qma-gw-btn";
  rescan.textContent = t("gatewayRescan");
  rescan.addEventListener("click", () => gwLoad());
  const close = document.createElement("button");
  close.type = "button";
  close.className = "qma-tool";
  close.textContent = "×";
  close.title = t("gatewayClose");
  close.setAttribute("aria-label", t("gatewayClose"));
  close.addEventListener("click", closeGatewayPanel);
  head.append(title, ports, rescan, close);

  const body = document.createElement("div");
  body.className = "qma-gw-body";
  body.setAttribute("data-qma-gw-body", "");

  panel.append(head, body);
  mask.append(panel);
  mask.addEventListener("click", (event) => {
    if (event.target === mask) closeGatewayPanel();
  });

  gwPanel = mask;
  document.body.appendChild(mask);
  document.addEventListener("keydown", gwEscHandler);
  void gwLoad();
}

// The 🌐 inside the model menu only exists while that menu is open, so mirror
// it as a persistent pill beside the composer's model trigger. The trigger's
// class differs across layouts, so the first match wins; no match leaves the
// in-menu button as the only entry (graceful, never an error).
const COMPOSER_ANCHORS = [
  'div[class*="ModelSelector"] button[class*="trigger"]',
  'button[class*="thinking-module__trigger"]',
  'button[aria-label="选择模型"]',
];

function findComposerAnchor() {
  for (const sel of COMPOSER_ANCHORS) {
    const el = $(sel);
    if (el) return el;
  }
  return null;
}

// ── Sort (CSS order — never moves React-managed nodes) ──────────────────────

const styledLists = new Set();

function setStyle(el, prop, value) {
  if (el.style[prop] !== value) el.style[prop] = value;
}

function applySort(panel) {
  const list = $(SEL.list, panel);
  if (!list) return;
  const mode = prefs.sort;
  const groups = $$(SEL.group, list).filter((g) => g.parentElement === list);
  if (mode === "default") {
    if (styledLists.has(list)) {
      setStyle(list, "display", "");
      setStyle(list, "flexDirection", "");
      for (const child of list.children) {
        setStyle(child, "order", "");
        setStyle(child, "flexShrink", "");
      }
      styledLists.delete(list);
    }
    return;
  }
  const countOf = (g) => {
    const header = $(SEL.header, g);
    const p = header && providerByKey(providerKeyOf(header));
    return p ? p.models.length : modelRows(g).length;
  };
  const nameOf = (g) => {
    const header = $(SEL.header, g);
    return header ? providerNameOf(header) : "";
  };
  const sorted = [...groups].sort((a, b) =>
    mode === "name"
      ? nameOf(a).localeCompare(nameOf(b))
      : countOf(b) - countOf(a) || nameOf(a).localeCompare(nameOf(b)),
  );
  const orderOf = new Map(sorted.map((g, i) => [g, i + 1]));
  setStyle(list, "display", "flex");
  setStyle(list, "flexDirection", "column");
  for (const child of list.children) {
    setStyle(child, "flexShrink", "0");
    if (child.hasAttribute("data-qma-favorites")) setStyle(child, "order", "-1");
    else if (orderOf.has(child)) setStyle(child, "order", String(orderOf.get(child)));
    else setStyle(child, "order", "999");
  }
  styledLists.add(list);
}

// ── Badges + stars ──────────────────────────────────────────────────────────

function decorateGroups(panel) {
  for (const group of $$(SEL.group, panel)) {
    const header = $(SEL.header, group);
    if (!header) continue;
    const key = providerKeyOf(header);
    const provider = providerByKey(key);
    const collapsed = header.getAttribute("aria-expanded") === "false";

    let badge = header.querySelector("[data-qma-count]");
    const count = provider ? provider.models.length : null;
    const activeHere =
      collapsed && cache.active && cache.active.providerId === key;
    let text = "";
    if (activeHere) {
      const m = provider?.models.find((x) => x.id === cache.active.modelId);
      text += `● ${m ? m.name : cache.active.modelId} `;
    }
    if (count !== null) text += `· ${count}`;
    if (text) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "qma-count";
        badge.setAttribute("data-qma-count", "");
        const icon = $(SEL.collapseIcon, header);
        if (icon) header.insertBefore(badge, icon);
        else header.appendChild(badge);
      }
      if (badge.textContent !== text) badge.textContent = text;
    } else if (badge) badge.remove();

    const rows = modelRows(group);
    const nameSeen = new Map();
    for (const row of rows) {
      const name = rowName(row);
      const index = nameSeen.get(name) || 0;
      nameSeen.set(name, index + 1);
      const on = isFavorited(key, resolveModelId(key, name, index), name);
      let star = row.querySelector("[data-qma-star]");
      if (!star) {
        star = document.createElement("button");
        star.type = "button";
        star.className = "qma-star";
        star.setAttribute("data-qma-star", "");
        star.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleFavorite(providerKeyOf(header), rowName(row), +star.dataset.i || 0);
          scheduleScan();
        });
        row.appendChild(star);
      }
      star.dataset.i = String(index);
      star.dataset.on = on ? "1" : "";
      const glyph = on ? "★" : "☆";
      if (star.textContent !== glyph) star.textContent = glyph;
      star.title = on ? t("unstar") : t("star");
      star.setAttribute("aria-label", star.title);
      star.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
}

// ── Favorites section ───────────────────────────────────────────────────────

function favoriteMissing(f) {
  const provider = providerByKey(f.p);
  if (!provider || !cache.providers.size) return false;
  if (f.m) return !provider.models.some((m) => m.id === f.m);
  return !provider.models.some((m) => m.name === f.n);
}

function renderFavorites(panel) {
  const list = $(SEL.list, panel);
  if (!list) return;
  const favs = prefs.favorites;
  let section = list.querySelector(":scope > [data-qma-favorites]");
  if (!favs.length) {
    if (section) section.remove();
    return;
  }
  if (!section) {
    section = document.createElement("div");
    section.className = "qma-favs";
    section.setAttribute("data-qma-favorites", "");
    list.prepend(section);
  }
  const query = searchQuery(panel).toLowerCase();
  const sig = JSON.stringify([favs, query, lang(), cache.version]);
  if (section.dataset.sig === sig) return;
  section.dataset.sig = sig;
  section.textContent = "";

  const head = document.createElement("div");
  head.className = "qma-favs-head";
  const title = document.createElement("span");
  title.textContent = `★ ${t("favorites")} · ${favs.length}`;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "qma-tool";
  clear.setAttribute("data-qma-clear", "");
  clear.textContent = t("clearFavorites");
  clear.title = t("clearFavorites");
  head.append(title, clear);
  section.appendChild(head);

  let shown = 0;
  for (const f of favs) {
    const provider = providerByKey(f.p);
    const providerName = provider ? provider.name : f.p;
    if (
      query &&
      !f.n.toLowerCase().includes(query) &&
      !providerName.toLowerCase().includes(query) &&
      !f.p.toLowerCase().includes(query)
    ) {
      continue;
    }
    shown += 1;
    const row = document.createElement("div");
    row.className = "qma-fav-row";
    row.setAttribute("data-qma-fav-row", favKey(f));
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    const missing = favoriteMissing(f);
    if (missing) {
      row.setAttribute("data-missing", "1");
      row.title = t("missingHint");
    } else {
      row.title = f.m ? `${providerName} / ${f.m}` : `${providerName} / ${f.n}`;
    }

    const group = findGroup(panel, f.p);
    const icon = group && $(SEL.header, group)?.querySelector("[data-provider-id]");
    if (icon) {
      const clone = icon.cloneNode(true);
      clone.removeAttribute("id");
      row.appendChild(clone);
    }
    const name = document.createElement("span");
    name.className = "qma-fav-name";
    name.textContent = f.n;
    const pname = document.createElement("span");
    pname.className = "qma-fav-provider";
    pname.textContent = providerName;
    row.append(name, pname);
    if (missing) {
      const tag = document.createElement("span");
      tag.className = "qma-missing-tag";
      tag.textContent = t("missing");
      row.appendChild(tag);
    }
    const star = document.createElement("button");
    star.type = "button";
    star.className = "qma-star";
    star.setAttribute("data-qma-fav-star", favKey(f));
    star.setAttribute("data-on", "1");
    star.textContent = "★";
    star.title = t("unstar");
    star.setAttribute("aria-label", t("unstar"));
    row.appendChild(star);
    section.appendChild(row);
  }
  section.style.display = shown ? "" : "none";
}

async function selectFavorite(panel, key) {
  const f = prefs.favorites.find((x) => favKey(x) === key);
  if (!f) return;
  let group = findGroup(panel, f.p);
  if (!group && freeTabActive(panel)) {
    const toggle = $(SEL.freeToggle, panel);
    if (toggle) {
      toggle.click();
      await delay(150);
      group = findGroup(panel, f.p);
    }
  }
  if (!group) {
    const row = $(`[data-qma-fav-row="${CSS.escape(key)}"]`, panel);
    if (row) {
      row.setAttribute("data-missing", "1");
      row.title = t("selectFailed");
    }
    return;
  }
  const header = $(SEL.header, group);
  if (header && header.getAttribute("aria-expanded") === "false") {
    header.click();
    await delay(80);
  }
  const rows = modelRows(group).filter((r) => rowName(r) === f.n);
  const row = rows[f.i || 0] || rows[0];
  const btn = row && $(SEL.selectBtn, row);
  if (btn) {
    btn.click(); // host owns selection, OAuth and confirm flows
    return;
  }
  const favRowEl = $(`[data-qma-fav-row="${CSS.escape(key)}"]`, panel);
  if (favRowEl) {
    favRowEl.setAttribute("data-missing", "1");
    favRowEl.title = t("selectFailed");
  }
}

// ── Accordion + state memory ────────────────────────────────────────────────

function saveOpenState(panel) {
  const open = $$(SEL.header, panel)
    .filter((h) => h.getAttribute("aria-expanded") === "true")
    .map(providerKeyOf)
    .filter(Boolean);
  prefs.open = open;
}

function handleHeaderClick(panel, header, event) {
  if (event.ctrlKey || event.metaKey || !prefs.singleOpen) {
    setTimeout(() => panel.isConnected && saveOpenState(panel), 0);
    return;
  }
  if (searchQuery(panel)) return; // host force-expands while searching
  setTimeout(() => {
    if (!panel.isConnected || restoring) return;
    if (header.getAttribute("aria-expanded") === "true") {
      const prevFocus = document.activeElement;
      for (const other of $$(SEL.header, panel)) {
        if (other !== header && other.getAttribute("aria-expanded") === "true") {
          synthClick(other);
        }
      }
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) {
        prevFocus.focus({ preventScroll: true });
      }
    }
    saveOpenState(panel);
  }, 0);
}

function restoreOpenState(panel) {
  setTimeout(() => {
    if (!panel.isConnected || searchQuery(panel)) return;
    const saved = prefs.open;
    const headers = $$(SEL.header, panel);
    if (!headers.length) {
      panelVisibility.delete(panel); // retry on next scan once rows exist
      return;
    }
    if (saved === null) return; // never user-modified: keep host default
    const wanted = new Set(saved);
    restoring = true;
    try {
      for (const h of headers) {
        const expanded = h.getAttribute("aria-expanded") === "true";
        const key = providerKeyOf(h);
        if (wanted.has(key) !== expanded) synthClick(h);
      }
    } finally {
      restoring = false;
    }
  }, 300);
}

// ── Panel decoration + events ───────────────────────────────────────────────

const boundPanels = new Map(); // panel -> { click, keydown } for dispose()
const panelVisibility = new WeakMap();
const warnedLists = new WeakSet();

function decoratePanel(list) {
  const panel = list.parentElement;
  if (!panel) return;
  ensureToolbar(panel);
  updateToolbar(panel);
  decorateGroups(panel);
  renderFavorites(panel);
  applySort(panel);

  const visible = list.getClientRects().length > 0;
  if (visible && !panelVisibility.get(panel)) restoreOpenState(panel);
  panelVisibility.set(panel, visible);

  if (
    !warnedLists.has(list) &&
    list.children.length > 0 &&
    !$$(SEL.group, list).length &&
    !$(SEL.spin, list) &&
    !$(SEL.empty, list) &&
    cache.version > 0
  ) {
    warnedLists.add(list);
    console.warn(
      `[${NS}] a model list is present but no provider sections were found; the menu markup may have changed`,
    );
  }
}

function bindPanel(panel) {
  if (boundPanels.has(panel)) return;

  const onClick = (event) => {
    if (synthetic) return;
    const target = event.target;

    const clear = target.closest?.("[data-qma-clear]");
    if (clear && panel.contains(clear)) {
      event.preventDefault();
      event.stopPropagation();
      if (window.confirm(t("clearConfirm"))) {
        prefs.favorites = [];
        scheduleScan();
      }
      return;
    }

    const favStar = target.closest?.("[data-qma-fav-star]");
    if (favStar && panel.contains(favStar)) {
      event.preventDefault();
      event.stopPropagation();
      const key = favStar.getAttribute("data-qma-fav-star");
      prefs.favorites = prefs.favorites.filter((f) => favKey(f) !== key);
      scheduleScan();
      return;
    }

    const favRow = target.closest?.("[data-qma-fav-row]");
    if (favRow && panel.contains(favRow)) {
      event.preventDefault();
      event.stopPropagation();
      void selectFavorite(panel, favRow.getAttribute("data-qma-fav-row"));
      return;
    }

    const tool = target.closest?.("[data-qma-tool]");
    if (tool && panel.contains(tool)) {
      event.preventDefault();
      event.stopPropagation();
      const action = tool.getAttribute("data-qma-tool");
      if (action === "gateway") {
        openGatewayPanel();
      } else if (action === "sort") {
        const next =
          SORT_MODES[(SORT_MODES.indexOf(prefs.sort) + 1) % SORT_MODES.length];
        prefs.sort = next;
        updateToolbar(panel);
        applySort(panel);
      } else {
        const expand = action === "expand";
        const prevFocus = document.activeElement;
        for (const h of $$(SEL.header, panel)) {
          if ((h.getAttribute("aria-expanded") === "true") !== expand) {
            synthClick(h);
          }
        }
        if (prevFocus && prevFocus.isConnected && prevFocus.focus) {
          prevFocus.focus({ preventScroll: true });
        }
        // While searching the host force-expands everything — persisting
        // that would poison the remembered open state. Defer until React
        // commits the toggles triggered by the synthetic clicks above.
        if (!searchQuery(panel)) {
          setTimeout(() => panel.isConnected && saveOpenState(panel), 0);
        }
      }
      return;
    }

    const header = target.closest?.(SEL.header);
    if (header && panel.contains(header)) handleHeaderClick(panel, header, event);
  };

  const onKeydown = (event) => {
    const favRow = event.target.closest?.("[data-qma-fav-row]");
    if (favRow && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      void selectFavorite(panel, favRow.getAttribute("data-qma-fav-row"));
      return;
    }
    const headers = $$(SEL.header, panel).filter(
      (h) => h.getClientRects().length > 0,
    );
    if (!headers.length) return;
    const header = event.target.closest?.(SEL.header);
    const inSearch = event.target === searchInput(panel);
    if (event.key === "ArrowDown" && (header || inSearch)) {
      event.preventDefault();
      const i = header ? headers.indexOf(header) : -1;
      headers[(i + 1) % headers.length].focus();
    } else if (event.key === "ArrowUp" && header) {
      event.preventDefault();
      const i = headers.indexOf(header);
      headers[(i - 1 + headers.length) % headers.length].focus();
    } else if (event.key === "ArrowRight" && header) {
      if (header.getAttribute("aria-expanded") === "false") {
        event.preventDefault();
        header.click();
      }
    } else if (event.key === "ArrowLeft" && header) {
      if (header.getAttribute("aria-expanded") === "true") {
        event.preventDefault();
        header.click();
      }
    }
  };

  panel.addEventListener("click", onClick);
  panel.addEventListener("keydown", onKeydown);
  boundPanels.set(panel, { click: onClick, keydown: onKeydown });
}

// ── Scan loop ───────────────────────────────────────────────────────────────

let scanScheduled = false;
function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  // setTimeout, not rAF: rAF is paused in hidden/backgrounded tabs, which
  // would leave the menu undecorated until the tab regains focus.
  setTimeout(() => {
    scanScheduled = false;
    scan();
  }, 0);
}

function scan() {
  ensureStyle();
  for (const list of $$(SEL.list)) {
    const panel = list.parentElement;
    if (!panel) continue;
    bindPanel(panel);
    decoratePanel(list);
  }
  ensureComposerLauncher();
}

function ensureComposerLauncher() {
  const anchor = findComposerAnchor();
  const existing = $('[data-qma-launcher]');
  if (!anchor) {
    if (existing) existing.remove();
    return;
  }
  // Keep it only while it still sits immediately after the *current* anchor.
  // When React re-renders the composer it swaps the trigger node, which can
  // leave the button orphaned (invisible) — detect that and re-place it.
  if (existing && existing.previousElementSibling === anchor) return;
  if (existing) existing.remove();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "qma-launcher";
  btn.setAttribute("data-qma-launcher", "");
  btn.setAttribute("aria-label", t("gateway"));
  btn.title = t("gateway");
  btn.textContent = `🌐 ${t("gateway")}`;
  btn.addEventListener("click", () => openGatewayPanel());
  anchor.after(btn);
}

const observer = new MutationObserver((mutations) => {
  if (
    mutations.every((m) =>
      m.target instanceof Element && m.target.closest("[data-qma-favorites],[data-qma-toolbar],[data-qma-gw]"),
    )
  ) {
    return; // our own injections — do not feedback-loop
  }
  scheduleScan();
});

// ── Diagnostics + lifecycle ─────────────────────────────────────────────────

function dispose() {
  observer.disconnect();
  closeGatewayPanel();
  clearTimeout(gwToastTimer);
  if (gwToastEl) {
    gwToastEl.remove();
    gwToastEl = null;
  }
  for (const [panel, handlers] of boundPanels) {
    panel.removeEventListener("click", handlers.click);
    panel.removeEventListener("keydown", handlers.keydown);
  }
  boundPanels.clear();
  for (const el of $$(
    "[data-qma-star],[data-qma-count],[data-qma-toolbar],[data-qma-favorites],[data-qma-launcher]",
  )) {
    el.remove();
  }
  for (const list of styledLists) {
    list.style.display = "";
    list.style.flexDirection = "";
    for (const child of list.children) {
      child.style.order = "";
      child.style.flexShrink = "";
    }
  }
  styledLists.clear();
  $("style[data-qma-style]")?.remove();
  if (window.__qwenpawModelAccordion === api) delete window.__qwenpawModelAccordion;
}

const api = {
  version: VERSION,
  rescan: scan,
  refresh: () => fetchData(true),
  state: () =>
    $$(SEL.list).map((list) => ({
      query: searchQuery(list.parentElement),
      groups: $$(SEL.group, list).map((g) => {
        const h = $(SEL.header, g);
        return {
          provider: h ? providerKeyOf(h) : "",
          name: h ? providerNameOf(h) : "",
          collapsed: h ? h.getAttribute("aria-expanded") === "false" : null,
          models: modelRows(g).length,
        };
      }),
    })),
  favorites: () => prefs.favorites,
  sort: () => prefs.sort,
  singleOpen: () => prefs.singleOpen,
  openGateways: () => openGatewayPanel(),
  dispose,
};

if (window.__qwenpawModelAccordion?.dispose) {
  try {
    window.__qwenpawModelAccordion.dispose();
  } catch {
    // previous instance already broken — proceed with a fresh one
  }
}
window.__qwenpawModelAccordion = api;

observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class", "style", "aria-expanded"],
});
scan();
void fetchData();