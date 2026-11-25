// ══════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════
const SB_URL = "https://fkddaibgfclnpjedeisw.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrZGRhaWJnZmNsbnBqZWRlaXN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NTA4NTEsImV4cCI6MjA5MzQyNjg1MX0.obf-xuFCd6NTXkMtsXniEt2-RsvKkgIrtkwqo7WJgpw";
const OFFLINE_MIN = 15;
const REFRESH_MS  = 10000;
const LBL_FAIL    = "Lâmpada Apagada";

// MQTT via WebSocket (broker público EMQX — porta 8084 = WSS)
const MQTT_BROKER    = "wss://broker.emqx.io:8084/mqtt";
const MQTT_CLIENT_ID = "WebDashboard_" + Math.random().toString(16).slice(2, 8);

// Mapeamento: device_name (Supabase) → slug MQTT (torres/torre_<SLUG>/cmd)
// O slug precisa ser igual ao TOPIC_BASE gravado no firmware de cada torre.
// Acentos são ignorados na comparação dos nomes.
const DEVICE_SLUG_MAP = {
  "AEROPORTO DE GUARULHOS":        "AGU",
  "TORRE AEROPORTO DE GUARULHOS":  "AGU",
  "REPETIDORA BRAS":               "BRAS",
  "REPETIDORA CECAP":              "CECAP",
  "REPETIDORA ESTUDANTES":         "ESTUDANTES",
  "REPETIDORA GUAIANAZES":         "GUAIANAZES",
  "REPETIDORA JARAGUA":            "JARAGUA",
  "REPETIDORA PARANAPIACABA":      "PARANAPIACABA",
  "ELEVADO LINHA 13 - 1":          "ELEVADO_LINHA13",
  "ELEVADO LINHA 13 - 2":          "ELEVADO_LINHA13",
  "ELEVADO LINHA13":               "ELEVADO_LINHA13",
  "REPETIDORA BUTUJURU":           "BUTUJURU",
};

// ══════════════════════════════════════════════════════════
// ESTADO
// ══════════════════════════════════════════════════════════
let allDevices      = [];
let selectedOtaSlug = null;
let selectedOtaName = null;
let mqttClient      = null;
let mqttConnected   = false;
let lastSig         = "";
let lastNames       = "";
let fetching        = false;

// ══════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const HDR = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// Escapa texto vindo do banco/MQTT antes de entrar em innerHTML
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();

function parseDate(v) {
  if (!v) return null;
  let d = new Date(v);
  if (!isNaN(d)) return d;
  d = new Date(v.replace(" ", "T").split("+")[0] + "Z");
  return isNaN(d) ? null : d;
}
function getStatus(t) {
  const d = parseDate(t.last_seen);
  const diff = d ? Math.floor((Date.now() - d.getTime()) / 60000) : 9999;
  if (diff > OFFLINE_MIN) return "offline";
  return t.is_ok ? "ok" : "fail";
}
function fmtTime(v) {
  const d = parseDate(v);
  if (!d) return "---";
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtSecs(s) {
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "min";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "min";
  return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h";
}
function timeSince(v) {
  const d = parseDate(v);
  return d ? fmtSecs(Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))) + " atrás" : "---";
}
function duration(from, to) {
  const a = parseDate(from), b = to ? parseDate(to) : new Date();
  if (!a || !b) return "---";
  return fmtSecs(Math.max(0, Math.floor((b - a) / 1000)));
}
function getSlug(deviceName) {
  if (!deviceName) return null;
  const n = norm(deviceName);
  for (const [key, slug] of Object.entries(DEVICE_SLUG_MAP)) {
    if (norm(key) === n) return slug;
  }
  return n.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function slugMatches(deviceSlug, mqttSlug) {
  if (!deviceSlug || !mqttSlug) return true;
  const n = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const a = n(deviceSlug), b = n(mqttSlug);
  return a === b || a.includes(b) || b.includes(a);
}
const unitNum = name => name.match(/(\d+)\s*$/)?.[1] || "";
function getBaseName(name) {
  const m = name.match(/^(.+?)\s*-\s*\d+\s*$/);
  return m ? m[1].trim() : null;
}
const statusLabel = st => st === "ok" ? "✅ OK" : st === "fail" ? "🔴 " + LBL_FAIL : "⚫ OFFLINE";

// ══════════════════════════════════════════════════════════
// SIDEBAR / NAVEGAÇÃO
// ══════════════════════════════════════════════════════════
function toggleSidebar() {
  $("sidebar").classList.toggle("open");
  $("sidebar-overlay").classList.toggle("open");
}
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-overlay").classList.remove("open");
}
function showPage(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.querySelectorAll(".bnav-item").forEach(n => n.classList.remove("active"));
  $("page-" + id).classList.add("active");
  $("nav-" + id).classList.add("active");
  $("bnav-" + id).classList.add("active");
  const titles  = { monitor: "Monitoramento", historico: "Histórico", ota: "Atualização OTA" };
  const kickers = { monitor: "Trivia Trens", historico: "Eventos da rede", ota: "Firmware remoto" };
  $("page-title").textContent = titles[id];
  const kicker = $("page-kicker");
  if (kicker) kicker.textContent = kickers[id];
  if (id === "historico") fetchHistory();
  if (id === "ota") { renderOtaDevices(); if (!mqttClient) mqttConnect(); }
  closeSidebar();
}

// ══════════════════════════════════════════════════════════
// SUPABASE — DISPOSITIVOS
// ══════════════════════════════════════════════════════════
async function fetchData() {
  if (fetching) return;
  fetching = true;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/device_status?select=*&order=device_name`, { headers: HDR });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allDevices = await res.json();
    renderCards(allDevices);
    populateDeviceFilter();
    if ($("page-ota").classList.contains("active")) renderOtaDevices();
    setConn(true);
  } catch (e) {
    setConn(false, e.message);
  } finally {
    fetching = false;
  }
}
function setConn(ok, msg) {
  $("conn-dot").className = "conn-dot " + (ok ? "ok" : "err");
  $("conn-text").textContent = ok
    ? "Conectado · " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : "Erro: " + msg;
}
function towerImg(st) {
  const src = st === "ok" ? "images/torre.png" : "images/torre-red.png";
  const cls = st === "ok" ? "tower-icon is-ok" : st === "offline" ? "tower-icon is-off" : "tower-icon";
  const alt = st === "ok" ? "OK" : st === "fail" ? LBL_FAIL : "Offline";
  return `<img class="${cls}" src="${src}" alt="${esc(alt)}">`;
}

function renderCards(data) {
  const grid = $("grid");
  const cnt = { ok: 0, fail: 0, offline: 0 };
  if (!data || !data.length) {
    grid.innerHTML = '<div class="empty">Nenhuma torre encontrada.</div>';
    lastSig = "";
    updateBadges(0, cnt);
    return;
  }
  data.forEach(t => cnt[getStatus(t)]++);
  updateBadges(data.length, cnt);

  // Só reconstrói os cards se algum nome/status mudou; senão atualiza só os tempos
  const sig = data.map(t => t.device_name + ":" + getStatus(t)).join("|");
  if (sig === lastSig) { refreshTimes(); return; }
  lastSig = sig;

  const groups = {}, singles = [];
  data.forEach(t => {
    const base = getBaseName(t.device_name);
    if (base) (groups[base] = groups[base] || []).push(t);
    else singles.push(t);
  });
  grid.innerHTML = "";
  const byNames = names => () => {
    const members = allDevices.filter(d => names.includes(d.device_name));
    if (members.length) openModal(members, members.length > 1 ? getBaseName(names[0]) + " (Par)" : names[0]);
  };

  Object.entries(groups).forEach(([base, members]) => {
    members.sort((a, b) => parseInt(unitNum(a.device_name) || 0) - parseInt(unitNum(b.device_name) || 0));
    const sts = members.map(getStatus);
    const hasFail = sts.includes("fail"), hasOffline = sts.includes("offline");
    const cls  = hasFail ? "fail" : hasOffline ? "offline" : "ok";
    const chip = hasFail ? LBL_FAIL : hasOffline ? "Offline" : "Operacional";
    const dual = members.map((m, i) =>
      `<div class="tower-dual-unit" title="${esc(m.device_name)}">${towerImg(sts[i])}<span class="dc-num">${esc(unitNum(m.device_name) || "?")}</span></div>`).join("");
    const foot = members.map(m =>
      `<span class="ts" data-name="${esc(m.device_name)}" title="${esc(m.device_name)}">${timeSince(m.last_seen)}</span>`).join("");
    const item = document.createElement("div");
    item.className = `tower-item ${cls}`;
    item.onclick = byNames(members.map(m => m.device_name));
    item.innerHTML = `<div class="tower-dual">${dual}</div>
      <div class="tower-name" title="${esc(base)}">${esc(base)}</div>
      <div class="status-chip">${chip}</div>
      <div class="tower-dual-meta">${foot}</div>`;
    grid.appendChild(item);
  });

  singles.forEach(t => {
    const st = getStatus(t);
    const chip = st === "ok" ? "Operacional" : st === "fail" ? LBL_FAIL : "Offline";
    const item = document.createElement("div");
    item.className = `tower-item ${st}`;
    item.onclick = byNames([t.device_name]);
    item.innerHTML = `<div class="tower-visual">${towerImg(st)}</div>
      <div class="tower-name" title="${esc(t.device_name)}">${esc(t.device_name)}</div>
      <div class="status-chip">${chip}</div>
      <div class="tower-meta ts" data-name="${esc(t.device_name)}">${timeSince(t.last_seen)}</div>`;
    grid.appendChild(item);
  });
}
function refreshTimes() {
  document.querySelectorAll(".ts").forEach(el => {
    const t = allDevices.find(d => d.device_name === el.dataset.name);
    if (t) el.textContent = timeSince(t.last_seen);
  });
}
function updateBadges(total, c) {
  $("cnt-total").textContent = total;
  $("cnt-ok").textContent    = c.ok;
  $("cnt-fail").textContent  = c.fail;
  $("cnt-off").textContent   = c.offline;
  $("badge-ok").textContent   = c.ok + " OK";
  $("badge-fail").textContent = c.fail + " " + LBL_FAIL;
  $("badge-off").textContent  = c.offline + " Offline";
}

// ══════════════════════════════════════════════════════════
// MODAL
// ══════════════════════════════════════════════════════════
function openModal(members, title) {
  const multi = members.length > 1;
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = members.map((t, i) => {
    const st = getStatus(t);
    const last = i === members.length - 1;
    const wrapStyle = multi && !last ? ' style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)"' : "";
    return `<div${wrapStyle}>
      ${multi ? `<div style="font-weight:700;font-size:0.85rem;margin-bottom:6px;color:var(--accent)">Unidade ${esc(unitNum(t.device_name) || "?")}</div>` : ""}
      <div class="modal-row"><span class="modal-key">Status</span><span class="modal-val">${statusLabel(st)}</span></div>
      <div class="modal-row"><span class="modal-key">Sensor</span><span class="modal-val">${t.is_ok ? "✅ OK" : "❌ " + LBL_FAIL}</span></div>
      <div class="modal-row"><span class="modal-key">Último contato</span><span class="modal-val">${fmtTime(t.last_seen)}</span></div>
      <div class="modal-row"><span class="modal-key">Tempo atrás</span><span class="modal-val">${timeSince(t.last_seen)}</span></div>
      ${multi ? "" : `<div class="modal-row"><span class="modal-key">Registrado em</span><span class="modal-val">${fmtTime(t.created_at)}</span></div>`}
    </div>`;
  }).join("");
  $("modal-overlay").classList.add("open");
}
function closeModal(e) {
  if (!e || e.target === $("modal-overlay")) $("modal-overlay").classList.remove("open");
}
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

// ══════════════════════════════════════════════════════════
// HISTÓRICO
// ══════════════════════════════════════════════════════════
async function fetchHistory() {
  const tbody = $("hist-body");
  tbody.innerHTML = '<tr><td colspan="4" class="hist-empty"><span class="loader"></span> Carregando...</td></tr>';
  const device = $("filt-device").value;
  const status = $("filt-status").value;
  const date   = $("filt-date").value;
  let url = `${SB_URL}/rest/v1/status_history?select=*&order=created_at.desc&limit=200`;
  if (device) url += `&device_name=eq.${encodeURIComponent(device)}`;
  if (status !== "") url += `&is_ok=eq.${encodeURIComponent(status)}`;
  // limites do dia no fuso de Brasília
  if (date) url += `&created_at=gte.${date}T00:00:00-03:00&created_at=lte.${date}T23:59:59-03:00`;
  try {
    const res = await fetch(url, { headers: HDR });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderHistory(await res.json(), status !== "", date !== "");
    populateDeviceFilter();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="hist-empty" style="color:var(--fail)">Erro: ${esc(e.message)}</td></tr>`;
  }
}
function renderHistory(rows, statusFiltered, dateFiltered) {
  const tbody = $("hist-body");
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="hist-empty">Nenhum registro encontrado.</td></tr>';
    return;
  }
  // Linhas vêm da mais nova para a mais antiga. A duração de um evento vai até o
  // próximo evento da MESMA torre (o mais novo visto antes na lista).
  const newer = {};
  tbody.innerHTML = rows.map(r => {
    const end = newer[r.device_name];
    newer[r.device_name] = r.created_at;
    let dur = "---";
    if (!statusFiltered) {
      if (end) dur = duration(r.created_at, end);
      else if (!dateFiltered) dur = duration(r.created_at, null);
    }
    const pill = r.is_ok
      ? '<span class="pill ok">✅ OK</span>'
      : `<span class="pill fail">🔴 ${LBL_FAIL}</span>`;
    return `<tr><td style="font-weight:600">${esc(r.device_name)}</td><td>${pill}</td><td>${fmtTime(r.created_at)}</td><td style="color:var(--muted)">${dur}</td></tr>`;
  }).join("");
}
function populateDeviceFilter() {
  const names = [...new Set(allDevices.map(d => d.device_name))].sort();
  const key = names.join("|");
  if (key === lastNames) return;
  lastNames = key;
  const sel = $("filt-device"), current = sel.value;
  sel.innerHTML = '<option value="">Todas as torres</option>' +
    names.map(n => `<option value="${esc(n)}" ${n === current ? "selected" : ""}>${esc(n)}</option>`).join("");
}
function clearFilters() {
  $("filt-device").value = "";
  $("filt-status").value = "";
  $("filt-date").value = "";
  fetchHistory();
}

// ══════════════════════════════════════════════════════════
// MQTT WebSocket
// ══════════════════════════════════════════════════════════
function setMqttStatus(state) {
  $("mqtt-dot").className = "mqtt-status-dot " + state;
  $("mqtt-status-text").className = "mqtt-status-text " + state;
  const labels = {
    connected:    "✅ MQTT conectado — broker.emqx.io",
    connecting:   "⏳ Conectando ao broker MQTT...",
    error:        "❌ Erro na conexão MQTT",
    disconnected: "⚫ Desconectado do broker MQTT",
  };
  $("mqtt-status-text").textContent = labels[state] || state;
}

function mqttConnect() {
  if (typeof mqtt === "undefined") {
    setMqttStatus("error");
    otaLog("❌ Biblioteca MQTT não carregou (CDN bloqueado ou sem internet).", "err");
    return;
  }
  if (mqttClient) {
    try { mqttClient.end(true); } catch (e) {}
    mqttClient = null;
    mqttConnected = false;
  }
  setMqttStatus("connecting");
  otaLog("Conectando ao broker MQTT via WebSocket...", "info");

  const client = mqtt.connect(MQTT_BROKER, {
    clientId: MQTT_CLIENT_ID, clean: true, connectTimeout: 10000, reconnectPeriod: 5000,
  });
  mqttClient = client;
  const current = () => client === mqttClient;   // ignora eventos de clientes antigos

  client.on("connect", () => {
    if (!current()) return;
    mqttConnected = true;
    setMqttStatus("connected");
    otaLog("✅ Conectado ao broker MQTT!", "ok");
    client.subscribe("torres/+/ota", { qos: 0 }, err => {
      if (!err) otaLog("📡 Subscrito em torres/+/ota", "info");
      else otaLog("Erro ao subscrever: " + err.message, "err");
    });
    client.subscribe("torres/+/online", { qos: 0 });
    updateOtaButtons();
  });
  client.on("message", (topic, message) => { if (current()) handleMqttMessage(topic, message.toString()); });
  client.on("error", err => {
    if (!current()) return;
    mqttConnected = false;
    setMqttStatus("error");
    otaLog("❌ Erro MQTT: " + err.message, "err");
    updateOtaButtons();
  });
  client.on("close", () => {
    if (!current()) return;
    mqttConnected = false;
    setMqttStatus("disconnected");
    otaLog("⚫ Conexão MQTT encerrada", "warn");
    updateOtaButtons();
  });
  client.on("reconnect", () => {
    if (!current()) return;
    setMqttStatus("connecting");
    otaLog("↻ Tentando reconectar...", "warn");
  });
}

// Mensagens vêm de um broker público: tudo é tratado como texto não confiável
function handleMqttMessage(topic, payload) {
  const topicSlug = (topic.split("/")[1] || "").replace("torre_", "");

  if (topic.endsWith("/online")) {
    otaLog(`📶 [${topicSlug}] ${payload.slice(0, 40)}`, payload === "online" ? "ok" : "warn");
    return;
  }
  if (!topic.endsWith("/ota")) return;

  let data;
  try {
    data = JSON.parse(payload);
    if (!data || typeof data !== "object") throw new Error("não é objeto");
  } catch (e) {
    otaLog(`[raw] ${topic}: ${payload.slice(0, 200)}`, "info");
    return;
  }

  const slug   = String(data.slug || topicSlug).slice(0, 40);
  const status = String(data.status || "");
  const msg    = String(data.message || "").slice(0, 200);
  let progress = Number(data.progress);
  progress = Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.round(progress))) : undefined;

  if (selectedOtaSlug && !slugMatches(selectedOtaSlug, slug)) return;

  const style = {
    success:  ["ok", "✅"], error: ["err", "❌"], progress: ["progress", "📦"],
    started:  ["warn", "🚀"], restart: ["warn", "🔄"], status: ["ok", "📊"],
  }[status] || ["info", "ℹ️"];
  const [cls, icon] = style;

  if (status === "status" && data.corrente !== undefined) {
    otaLog(`${icon} [${slug}] ${msg}`, cls);
    otaLog(`   ⚡ ${data.corrente}A | 💡 ${data.lampada} | 📶 ${data.wifi} dBm | 🌐 ${data.ip} | ⏱ ${data.uptime}s`, "ok");
  } else if (status === "restart") {
    otaLog(`${icon} [${slug}] ${msg}`, cls);
    otaLog("   ⏳ Dispositivo reiniciando — aguarde ~15s e peça status novamente", "warn");
  } else {
    otaLog(`${icon} [${slug}] ${msg}${progress !== undefined ? " — " + progress + "%" : ""}`, cls);
  }

  if (progress !== undefined) updateProgressBar(progress);
  if (status === "success") { updateProgressBar(100); setTimeout(hideProgressBar, 3000); }
  if (status === "error") hideProgressBar();
}

// ══════════════════════════════════════════════════════════
// OTA — DISPOSITIVOS
// ══════════════════════════════════════════════════════════
function renderOtaDevices() {
  const list = $("ota-device-list");
  if (!allDevices.length) {
    list.innerHTML = '<div class="empty" style="padding:16px;font-size:0.8rem">Nenhum dispositivo.<br>Vá em Monitoramento primeiro.</div>';
    return;
  }
  list.innerHTML = allDevices.map(d => {
    const online = getStatus(d) !== "offline";
    const selected = selectedOtaName === d.device_name;
    return `<div class="device-row ${selected ? "selected" : ""}" data-name="${esc(d.device_name)}">
      <div class="device-row-left">
        <span class="dname">${esc(d.device_name)}</span>
        <span class="dslug">torres/torre_${esc(getSlug(d.device_name))}/cmd</span>
      </div>
      <span class="dstatus ${online ? "online" : "offline"}">${online ? "● Online" : "○ Offline"}</span>
    </div>`;
  }).join("");
}
$("ota-device-list").addEventListener("click", e => {
  const row = e.target.closest(".device-row");
  if (!row) return;
  const d = allDevices.find(x => x.device_name === row.dataset.name);
  if (d) selectOtaDevice(d);
});

function selectOtaDevice(d) {
  selectedOtaName = d.device_name;
  selectedOtaSlug = getSlug(d.device_name);
  renderOtaDevices();
  otaLog(`🎯 Dispositivo selecionado: ${selectedOtaName}`, "ok");
  otaLog(`📌 Tópico CMD: torres/torre_${selectedOtaSlug}/cmd`, "info");
  if (getStatus(d) === "offline") otaLog("⚠️ Dispositivo offline — OTA pode falhar", "warn");
  updateOtaButtons();
}
function updateOtaButtons() {
  const ready = mqttConnected && selectedOtaSlug;
  $("btn-send-ota").disabled = !ready;
  $("btn-restart").disabled  = !ready;
  $("btn-status").disabled   = !ready;
}

// ══════════════════════════════════════════════════════════
// OTA — COMANDOS
// ══════════════════════════════════════════════════════════
function publishCmd(slug, cmd) {
  if (!mqttClient || !mqttConnected) {
    otaLog("❌ MQTT não conectado. Reconecte primeiro.", "err");
    return false;
  }
  mqttClient.publish(`torres/torre_${slug}/cmd`, cmd, { qos: 1, retain: false }, err => {
    if (err) otaLog(`❌ Falha ao publicar: ${err.message}`, "err");
  });
  return true;
}
function needDevice() {
  if (selectedOtaSlug) return true;
  otaLog("❌ Selecione um dispositivo primeiro.", "err");
  return false;
}

function sendOTA() {
  if (!needDevice()) return;
  const url = $("ota-url").value.trim();
  if (!/^https:\/\/\S+$/i.test(url)) {
    otaLog("❌ URL inválida. Use https://... (sem espaços).", "err");
    return;
  }
  if (!confirm(`Enviar firmware para ${selectedOtaName}?\n\n${url}`)) return;
  otaLog(`🚀 Enviando OTA para ${selectedOtaName}...`, "warn");
  otaLog(`📦 URL: ${url}`, "info");
  if (publishCmd(selectedOtaSlug, `update ${url}`)) {
    otaLog(`✅ Comando publicado em torres/torre_${selectedOtaSlug}/cmd`, "ok");
    otaLog("⏳ Aguardando resposta do ESP32...", "info");
    showProgressBar();
  }
}
function sendRestart() {
  if (!needDevice()) return;
  if (!confirm(`Reiniciar ${selectedOtaName}?`)) return;
  otaLog(`🔄 Enviando restart para ${selectedOtaName}...`, "warn");
  if (publishCmd(selectedOtaSlug, "restart")) {
    otaLog(`✅ Comando publicado em torres/torre_${selectedOtaSlug}/cmd`, "ok");
    otaLog("⏳ Aguardando confirmação do ESP32...", "info");
  }
}
function sendStatus() {
  if (!needDevice()) return;
  otaLog(`📊 Solicitando status de ${selectedOtaName}...`, "info");
  if (publishCmd(selectedOtaSlug, "status")) {
    otaLog(`✅ Comando publicado em torres/torre_${selectedOtaSlug}/cmd`, "ok");
    otaLog(`⏳ Aguardando resposta em torres/torre_${selectedOtaSlug}/ota ...`, "info");
  }
}

// ══════════════════════════════════════════════════════════
// LOG E BARRA DE PROGRESSO
// ══════════════════════════════════════════════════════════
function otaLog(msg, cls = "") {
  const log = $("ota-log");
  const line = document.createElement("div");
  line.className = "log-line" + (cls ? " log-" + cls : "");
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString("pt-BR");
  line.append(time, document.createTextNode(msg));   // texto puro: nada vira HTML
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 200) log.removeChild(log.firstChild);
}
function clearLog() {
  $("ota-log").innerHTML = "";
  otaLog("Log limpo.", "info");
}
function showProgressBar() {
  $("ota-progress-wrap").classList.add("visible");
  updateProgressBar(0);
}
function hideProgressBar() {
  $("ota-progress-wrap").classList.remove("visible");
}
function updateProgressBar(pct) {
  $("ota-progress-bar").style.width = pct + "%";
  $("ota-progress-label").textContent = pct + "%";
}

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════
fetchData();
setInterval(() => { if (!document.hidden) fetchData(); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) fetchData(); });
