// ── CONFIG ──
const SB_URL = "https://fkddaibgfclnpjedeisw.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrZGRhaWJnZmNsbnBqZWRlaXN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NTA4NTEsImV4cCI6MjA5MzQyNjg1MX0.obf-xuFCd6NTXkMtsXniEt2-RsvKkgIrtkwqo7WJgpw";
const OFFLINE_MIN = 15;
const REFRESH_MS = 10000;
const MQTT_URL = "wss://broker.emqx.io:8084/mqtt";
// device_name (Supabase) -> sufixo do tópico MQTT (torres/torre_<SLUG>/cmd). Acrescente as demais torres.
const SLUGS = { "TORRE AEROPORTO DE GUARULHOS": "AGU" };
const LBL_FAIL = "Lâmpada Apagada";

let allDevices = [], selectedDevice = null, mqttClient = null, mqttOn = false;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const HDR = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// ── NAV ──
function toggleSidebar() { $("sidebar").classList.toggle("open"); $("sidebar-overlay").classList.toggle("open"); }
function closeSidebar() { $("sidebar").classList.remove("open"); $("sidebar-overlay").classList.remove("open"); }
function showPage(id) {
  document.querySelectorAll(".page,.nav-item,.bnav-item").forEach(e => e.classList.remove("active"));
  [`page-${id}`, `nav-${id}`, `bnav-${id}`].forEach(i => $(i).classList.add("active"));
  $("page-title").textContent = { monitor: "Monitoramento", historico: "Histórico", ota: "Atualização OTA" }[id];
  if (id === "historico") fetchHistory();
  if (id === "ota") { renderOtaDevices(); if (!mqttClient) mqttConnect(); }
  closeSidebar();
}

// ── UTILS ──
function parseDate(v) {
  if (!v) return null;
  let d = new Date(v);
  if (!isNaN(d)) return d;
  d = new Date(v.replace(" ", "T").split("+")[0] + "Z");
  return isNaN(d) ? null : d;
}
function getStatus(t) {
  const d = parseDate(t.last_seen);
  const min = d ? (Date.now() - d.getTime()) / 60000 : Infinity;
  return min > OFFLINE_MIN ? "offline" : t.is_ok ? "ok" : "fail";
}
const fmtTime = v => { const d = parseDate(v); return d ? d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "---"; };
function fmtSecs(s) {
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "min";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "min";
}
function timeSince(v) { const d = parseDate(v); return d ? fmtSecs(Math.floor((Date.now() - d) / 1000)) + " atrás" : "---"; }
function duration(from, to) {
  const a = parseDate(from), b = to ? parseDate(to) : new Date();
  return a && b ? fmtSecs(Math.floor((b - a) / 1000)) : "---";
}
const statusText = st => st === "ok" ? "✅ OK" : st === "fail" ? `🔴 ${LBL_FAIL}` : "⚫ OFFLINE";
const circleText = st => st === "ok" ? "OK" : st === "fail" ? "Lâmpada<br>Apagada" : "OFF";

// ── MONITOR ──
async function fetchData() {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/device_status?select=*&order=device_name`, { headers: HDR });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allDevices = await res.json();
    renderCards(allDevices);
    setConn(true);
    if ($("page-ota").classList.contains("active")) renderOtaDevices();
  } catch (e) { setConn(false, e.message); }
}
function setConn(ok, msg) {
  $("conn-dot").className = "conn-dot " + (ok ? "ok" : "err");
  $("conn-text").textContent = ok ? "Atualizado " + new Date().toLocaleTimeString("pt-BR") : "Erro: " + msg;
}
const baseName = n => { const m = n.match(/^(.+?)\s*-\s*\d+\s*$/); return m ? m[1].trim() : null; };
const unitNum = n => parseInt(n.match(/(\d+)\s*$/)?.[1] || 0);

function renderCards(data) {
  const grid = $("grid"), cnt = { ok: 0, fail: 0, offline: 0 };
  if (!data || !data.length) { grid.innerHTML = '<div class="empty">Nenhuma torre encontrada.</div>'; updateBadges(0, cnt); return; }
  const groups = {}, singles = [];
  data.forEach(t => { const b = baseName(t.device_name); b ? (groups[b] = groups[b] || []).push(t) : singles.push(t); });
  grid.innerHTML = "";

  Object.entries(groups).forEach(([base, members]) => {
    members.sort((a, b) => unitNum(a.device_name) - unitNum(b.device_name));
    const sts = members.map(getStatus);
    sts.forEach(s => cnt[s]++);
    const cls = sts.includes("fail") ? "fail" : sts.includes("offline") ? "offline" : "ok";
    const card = document.createElement("div");
    card.className = `card ${cls}`;
    card.onclick = () => openModal(members, `${base} (Par)`);
    card.innerHTML = `<div class="card-name" title="${esc(base)}">${esc(base)}</div>
      <div class="dual-circles">${members.map((m, i) => `<div class="dual-circle ${sts[i]}" title="${esc(m.device_name)}"><span class="dc-num">${unitNum(m.device_name) || "?"}</span><span>${circleText(sts[i])}</span></div>`).join("")}</div>
      <div class="card-footer">${members.map(m => `<span>🕐 ${timeSince(m.last_seen)}</span>`).join("")}</div>`;
    grid.appendChild(card);
  });

  singles.forEach(t => {
    const st = getStatus(t); cnt[st]++;
    const card = document.createElement("div");
    card.className = `card ${st}`;
    card.onclick = () => openModal([t], t.device_name);
    card.innerHTML = `<div class="card-name" title="${esc(t.device_name)}">${esc(t.device_name)}</div>
      <div class="circle ${st}">${st === "offline" ? "OFFLINE" : circleText(st)}</div>
      <div class="card-footer">🕐 ${timeSince(t.last_seen)}</div>`;
    grid.appendChild(card);
  });
  updateBadges(data.length, cnt);
}
function updateBadges(total, c) {
  $("cnt-total").textContent = total; $("cnt-ok").textContent = c.ok;
  $("cnt-fail").textContent = c.fail; $("cnt-off").textContent = c.offline;
  $("badge-ok").textContent = `${c.ok} OK`;
  $("badge-fail").textContent = `${c.fail} ${LBL_FAIL}`;
  $("badge-off").textContent = `${c.offline} Offline`;
}

// ── MODAL ──
function openModal(members, title) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = members.map(t => `<div class="unit">
    ${members.length > 1 ? `<div class="unit-title">Unidade ${unitNum(t.device_name) || "?"}</div>` : ""}
    <div class="modal-row"><span class="modal-key">Status</span><span class="modal-val">${statusText(getStatus(t))}</span></div>
    <div class="modal-row"><span class="modal-key">Sensor</span><span class="modal-val">${t.is_ok ? "✅ OK" : "❌ " + LBL_FAIL}</span></div>
    <div class="modal-row"><span class="modal-key">Último contato</span><span class="modal-val">${fmtTime(t.last_seen)}</span></div>
    <div class="modal-row"><span class="modal-key">Tempo atrás</span><span class="modal-val">${timeSince(t.last_seen)}</span></div>
    ${members.length === 1 ? `<div class="modal-row"><span class="modal-key">Registrado em</span><span class="modal-val">${fmtTime(t.created_at)}</span></div>` : ""}
  </div>`).join("");
  $("modal-overlay").classList.add("open");
}
function closeModal(e) { if (!e || e.target === $("modal-overlay")) $("modal-overlay").classList.remove("open"); }
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

// ── HISTÓRICO ──
async function fetchHistory() {
  const tbody = $("hist-body");
  tbody.innerHTML = '<tr><td colspan="4" class="hist-empty"><span class="loader"></span> Carregando...</td></tr>';
  const dev = $("filt-device").value, st = $("filt-status").value, date = $("filt-date").value;
  let url = `${SB_URL}/rest/v1/status_history?select=*&order=created_at.desc&limit=200`;
  if (dev) url += `&device_name=eq.${encodeURIComponent(dev)}`;
  if (st !== "") url += `&is_ok=eq.${st}`;
  if (date) url += `&created_at=gte.${date}T00:00:00-03:00&created_at=lte.${date}T23:59:59-03:00`;
  try {
    const res = await fetch(url, { headers: HDR });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderHistory(await res.json());
    populateDeviceFilter();
  } catch (e) { tbody.innerHTML = `<tr><td colspan="4" class="hist-empty" style="color:var(--fail)">Erro: ${esc(e.message)}</td></tr>`; }
}
function renderHistory(rows) {
  const tbody = $("hist-body");
  if (!rows || !rows.length) { tbody.innerHTML = '<tr><td colspan="4" class="hist-empty">Nenhum registro encontrado.</td></tr>'; return; }
  tbody.innerHTML = rows.map((r, i) => `<tr>
    <td style="font-weight:600">${esc(r.device_name)}</td>
    <td><span class="pill ${r.is_ok ? "ok" : "fail"}">${r.is_ok ? "✅ OK" : "🔴 " + LBL_FAIL}</span></td>
    <td>${fmtTime(r.created_at)}</td>
    <td style="color:var(--muted)">${duration(r.created_at, rows[i - 1]?.created_at)}</td></tr>`).join("");
}
function populateDeviceFilter() {
  const sel = $("filt-device"), cur = sel.value;
  sel.innerHTML = '<option value="">Todas as torres</option>' + [...new Set(allDevices.map(d => d.device_name))].sort()
    .map(n => `<option value="${esc(n)}" ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
}
function clearFilters() { ["filt-device", "filt-status", "filt-date"].forEach(i => $(i).value = ""); fetchHistory(); }

// ── OTA / MQTT ──
function otaLog(msg, cls = "info") {
  const l = document.createElement("div");
  l.className = `log-line log-${cls}`;
  l.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString("pt-BR")}</span>${esc(msg)}`;
  $("ota-log").appendChild(l); $("ota-log").scrollTop = $("ota-log").scrollHeight;
}
function clearLog() { $("ota-log").innerHTML = ""; }
function setMqtt(on, txt) {
  mqttOn = on;
  $("mqtt-dot").className = "mqtt-dot " + (on ? "ok" : "err");
  $("mqtt-text").textContent = txt;
  checkReady();
}
function mqttConnect() {
  if (typeof mqtt === "undefined") { setMqtt(false, "Biblioteca MQTT não carregou"); return; }
  if (mqttClient) mqttClient.end(true);
  setMqtt(false, "Conectando ao broker MQTT...");
  mqttClient = mqtt.connect(MQTT_URL, { clientId: "painel_" + Math.random().toString(16).slice(2, 8), reconnectPeriod: 5000, connectTimeout: 10000 });
  mqttClient.on("connect", () => { setMqtt(true, "Conectado ao broker MQTT"); mqttClient.subscribe("torres/+/ota"); otaLog("MQTT conectado.", "ok"); });
  mqttClient.on("close", () => setMqtt(false, "Desconectado do broker MQTT"));
  mqttClient.on("error", e => otaLog("Erro MQTT: " + e.message, "err"));
  mqttClient.on("message", (topic, payload) => {
    const txt = payload.toString();
    otaLog(`[${topic.split("/")[1]}] ${txt}`, /erro|fail|falha/i.test(txt) ? "err" : "info");
    const m = txt.match(/(\d{1,3})\s*%/);
    if (m) { $("ota-progress").hidden = false; $("ota-bar").style.width = Math.min(100, m[1]) + "%"; $("ota-pct").textContent = Math.min(100, m[1]) + "%"; }
  });
}
function renderOtaDevices() {
  const list = $("ota-device-list");
  if (!allDevices.length) { list.innerHTML = '<div class="empty">Nenhum dispositivo carregado.<br>Vá em Monitoramento primeiro.</div>'; return; }
  list.innerHTML = allDevices.map(d => {
    const on = getStatus(d) !== "offline";
    return `<div class="device-row ${selectedDevice === d.device_name ? "selected" : ""}" data-name="${esc(d.device_name)}">
      <span class="dname">${esc(d.device_name)}</span><span class="dstatus ${on ? "online" : "offline"}">${on ? "● Online" : "○ Offline"}</span></div>`;
  }).join("");
}
$("ota-device-list").addEventListener("click", e => {
  const row = e.target.closest(".device-row"); if (!row) return;
  selectedDevice = row.dataset.name; renderOtaDevices();
  otaLog(`Dispositivo selecionado: ${selectedDevice}`, "ok");
  if (!SLUGS[selectedDevice]) otaLog("Sem tópico MQTT cadastrado para esta torre (veja SLUGS em app.js).", "err");
  checkReady();
});
$("ota-url").addEventListener("input", checkReady);
function checkReady() {
  const ok = mqttOn && selectedDevice && SLUGS[selectedDevice];
  $("btn-send-ota").disabled = !(ok && /^https:\/\/.+/i.test($("ota-url").value.trim()));
  $("btn-restart").disabled = $("btn-status").disabled = !ok;
}
function publishCmd(cmd) {
  mqttClient.publish(`torres/torre_${SLUGS[selectedDevice]}/cmd`, cmd);
  otaLog(`→ ${selectedDevice}: ${cmd}`, "ok");
}
function sendCmd(cmd) {
  if (cmd === "restart" && !confirm(`Reiniciar ${selectedDevice}?`)) return;
  publishCmd(cmd);
}
function sendOTA() {
  const url = $("ota-url").value.trim();
  if (!confirm(`Enviar firmware para ${selectedDevice}?\n${url}`)) return;
  $("ota-progress").hidden = false; $("ota-bar").style.width = "0"; $("ota-pct").textContent = "0%";
  publishCmd(`update ${url}`);
}

// ── INIT ──
fetchData();
setInterval(fetchData, REFRESH_MS);
