// ══════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════
const SB_URL    = "https://fkddaibgfclnpjedeisw.supabase.co";
const SB_KEY    = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrZGRhaWJnZmNsbnBqZWRlaXN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NTA4NTEsImV4cCI6MjA5MzQyNjg1MX0.obf-xuFCd6NTXkMtsXniEt2-RsvKkgIrtkwqo7WJgpw";
const OFFLINE_MIN = 15;

// MQTT via WebSocket (broker público EMQX — porta 8084 = WSS)
const MQTT_BROKER   = "wss://broker.emqx.io:8084/mqtt";
const MQTT_CLIENT_ID = "WebDashboard_" + Math.random().toString(16).slice(2, 8);

// Mapeamento: device_name (Supabase) → slug MQTT
// Adicione aqui todas as suas torres
const DEVICE_SLUG_MAP = {
  "REPETIDORA BRÁS":          "BRAS",
  "REPETIDORA BRAS":          "BRAS",
  "REPETIDORA CECAP":         "CECAP",
  "REPETIDORA ESTUDANTES":    "ESTUDANTES",
  "REPETIDORA GUAIANAZES":    "GUAIANAZES",
  "REPETIDORA JARAGUÁ":       "JARAGUÁ",
  "REPETIDORA JARAGUA":       "JARAGUÁ",
  "REPETIDORA PARANAPIACABA": "PARANAPIACABA",
  "ELEVADO LINHA 13 - 1":     "ELEVADO_LINHA13",
  "ELEVADO LINHA 13 - 2":     "ELEVADO_LINHA13",
  "ELEVADO LINHA13":          "ELEVADO_LINHA13",
  "REPETIDORA BUTUJURU":      "BUTUJURU",
};

// ══════════════════════════════════════════════════════════
// ESTADO
// ══════════════════════════════════════════════════════════
let allDevices       = [];
let selectedOtaSlug  = null;
let selectedOtaName  = null;
let mqttClient       = null;
let mqttConnected    = false;

// ══════════════════════════════════════════════════════════
// SIDEBAR
// ══════════════════════════════════════════════════════════
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════
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
  if (diff > OFFLINE_MIN) return 'offline';
  return t.is_ok ? 'ok' : 'fail';
}
function fmtTime(v) {
  const d = parseDate(v);
  if (!d) return '---';
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function timeSince(v) {
  const d = parseDate(v);
  if (!d) return '---';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return s + 's atrás';
  if (s < 3600) return Math.floor(s/60) + 'min atrás';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'min atrás';
}
function duration(from, to) {
  const a = parseDate(from), b = to ? parseDate(to) : new Date();
  if (!a || !b) return '---';
  const s = Math.floor((b - a) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'min';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'min';
}
function getSlug(deviceName) {
  if (!deviceName) return null;
  const upper = deviceName.toUpperCase().trim();
  for (const [key, slug] of Object.entries(DEVICE_SLUG_MAP)) {
    if (upper === key.toUpperCase()) return slug;
  }
  // fallback: remove espaços e acentos
  return upper.replace(/\s+/g, '_').replace(/[ÁÀÃÂÄ]/g,'A').replace(/[ÉÈÊË]/g,'E').replace(/[ÍÌÎÏ]/g,'I').replace(/[ÓÒÕÔÖ]/g,'O').replace(/[ÚÙÛÜ]/g,'U').replace(/Ç/g,'C');
}

function slugMatches(deviceSlug, mqttSlug) {
  if (!deviceSlug || !mqttSlug) return true;
  const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const a = norm(deviceSlug);
  const b = norm(mqttSlug);
  return a === b || a.includes(b) || b.includes(a);
}

// ══════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.bnav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  document.getElementById('nav-' + id).classList.add('active');
  document.getElementById('bnav-' + id).classList.add('active');
  const titles = { monitor: 'Monitoramento', historico: 'Histórico', ota: 'Atualização OTA' };
  const kickers = { monitor: 'Trivia Trens', historico: 'Eventos da rede', ota: 'Firmware remoto' };
  document.getElementById('page-title').textContent = titles[id];
  const kicker = document.getElementById('page-kicker');
  if (kicker) kicker.textContent = kickers[id];
  if (id === 'historico') fetchHistory();
  if (id === 'ota') { renderOtaDevices(); if (!mqttConnected) mqttConnect(); }
  closeSidebar();
}

// ══════════════════════════════════════════════════════════
// SUPABASE — FETCH DEVICES
// ══════════════════════════════════════════════════════════
async function fetchData() {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/device_status?select=*&order=device_name`, {
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allDevices = await res.json();
    renderCards(allDevices);
    setConn(true);
  } catch(e) {
    setConn(false, e.message);
  }
}
function setConn(ok, msg) {
  const dot = document.getElementById('conn-dot');
  const txt = document.getElementById('conn-text');
  dot.className = 'conn-dot ' + (ok ? 'ok' : 'err');
  txt.textContent = ok ? 'Conectado' : ('Erro: ' + msg);
}
function getBaseName(name) {
  const m = name.match(/^(.+?)\s*-\s*\d+\s*$/);
  return m ? m[1].trim() : null;
}
function towerImg(st) {
  const src = st === 'ok' ? 'images/torre.png' : 'images/torre-red.png';
  const cls = st === 'ok' ? 'tower-icon is-ok' : 'tower-icon';
  const alt = st === 'ok' ? 'OK' : st === 'fail' ? 'FALHA' : 'OFFLINE';
  return `<img class="${cls}" src="${src}" alt="${alt}">`;
}
function renderCards(data) {
  const grid = document.getElementById('grid');
  let ok=0, fail=0, off=0;
  if (!data || !data.length) {
    grid.innerHTML = '<div class="empty">Nenhuma torre encontrada.</div>';
    updateBadges(0,0,0,0); return;
  }
  const groups = {}, singles = [];
  data.forEach(t => {
    const base = getBaseName(t.device_name);
    if (base) { if (!groups[base]) groups[base] = []; groups[base].push(t); }
    else singles.push(t);
  });
  grid.innerHTML = '';
  Object.entries(groups).forEach(([base, members]) => {
    members.sort((a,b) => {
      const na = parseInt(a.device_name.match(/(\d+)\s*$/)?.[1]||0);
      const nb = parseInt(b.device_name.match(/(\d+)\s*$/)?.[1]||0);
      return na - nb;
    });
    const statuses = members.map(m => getStatus(m));
    const hasFail = statuses.includes('fail'), hasOffline = statuses.includes('offline');
    const cardClass = hasFail ? 'fail' : hasOffline ? 'offline' : 'ok';
    statuses.forEach(s => { if(s==='ok') ok++; else if(s==='fail') fail++; else off++; });
    const item = document.createElement('div');
    item.className = `tower-item ${cardClass}`;
    item.onclick = () => openModalGroup(members);
    const dualHtml = members.map(m => {
      const st = getStatus(m);
      const num = m.device_name.match(/(\d+)\s*$/)?.[1] || '?';
      return `<div class="tower-dual-unit" title="${m.device_name}">${towerImg(st)}<span class="dc-num">${num}</span></div>`;
    }).join('');
    const footerHtml = members.map(m => `<span title="${m.device_name}">${timeSince(m.last_seen)}</span>`).join('');
    const chip = hasFail ? 'Falha' : hasOffline ? 'Offline' : 'Operacional';
    item.innerHTML = `<div class="tower-dual">${dualHtml}</div><div class="tower-name" title="${base}">${base}</div><div class="status-chip">${chip}</div><div class="tower-dual-meta">${footerHtml}</div>`;
    grid.appendChild(item);
  });
  singles.forEach(t => {
    const st = getStatus(t);
    if(st==='ok') ok++; else if(st==='fail') fail++; else off++;
    const chip = st === 'ok' ? 'Operacional' : st === 'fail' ? 'Falha' : 'Offline';
    const item = document.createElement('div');
    item.className = `tower-item ${st}`;
    item.onclick = () => openModal(t);
    item.innerHTML = `<div class="tower-visual">${towerImg(st)}</div><div class="tower-name" title="${t.device_name}">${t.device_name}</div><div class="status-chip">${chip}</div><div class="tower-meta">${timeSince(t.last_seen)}</div>`;
    grid.appendChild(item);
  });
  updateBadges(data.length, ok, fail, off);
}
function updateBadges(total, ok, fail, off) {
  document.getElementById('cnt-total').textContent = total;
  document.getElementById('cnt-ok').textContent = ok;
  document.getElementById('cnt-fail').textContent = fail;
  document.getElementById('cnt-off').textContent = off;
  document.getElementById('badge-ok').textContent = ok + ' OK';
  document.getElementById('badge-fail').textContent = fail + ' Falha';
  document.getElementById('badge-off').textContent = off + ' Offline';
}

// ══════════════════════════════════════════════════════════
// MODAL
// ══════════════════════════════════════════════════════════
function openModal(t) {
  const st = getStatus(t);
  const label = st==='ok'?'✅ OK':st==='fail'?'🔴 FALHA':'⚫ OFFLINE';
  document.getElementById('modal-title').textContent = t.device_name;
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-row"><span class="modal-key">Status</span><span class="modal-val">${label}</span></div>
    <div class="modal-row"><span class="modal-key">Sensor</span><span class="modal-val">${t.is_ok?'✅ OK':'❌ FALHA'}</span></div>
    <div class="modal-row"><span class="modal-key">Último contato</span><span class="modal-val">${fmtTime(t.last_seen)}</span></div>
    <div class="modal-row"><span class="modal-key">Tempo atrás</span><span class="modal-val">${timeSince(t.last_seen)}</span></div>
    <div class="modal-row"><span class="modal-key">Registrado em</span><span class="modal-val">${fmtTime(t.created_at)}</span></div>`;
  document.getElementById('modal-overlay').classList.add('open');
}
function openModalGroup(members) {
  const base = getBaseName(members[0].device_name) || members[0].device_name;
  document.getElementById('modal-title').textContent = base + ' (Par)';
  document.getElementById('modal-body').innerHTML = members.map(t => {
    const st = getStatus(t);
    const label = st==='ok'?'✅ OK':st==='fail'?'🔴 FALHA':'⚫ OFFLINE';
    const num = t.device_name.match(/(\d+)\s*$/)?.[1] || '?';
    return `<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)">
      <div style="font-weight:700;font-size:0.85rem;margin-bottom:6px;color:var(--accent)">Unidade ${num}</div>
      <div class="modal-row"><span class="modal-key">Status</span><span class="modal-val">${label}</span></div>
      <div class="modal-row"><span class="modal-key">Sensor</span><span class="modal-val">${t.is_ok?'✅ OK':'❌ FALHA'}</span></div>
      <div class="modal-row"><span class="modal-key">Último contato</span><span class="modal-val">${fmtTime(t.last_seen)}</span></div>
      <div class="modal-row" style="border-bottom:none"><span class="modal-key">Tempo atrás</span><span class="modal-val">${timeSince(t.last_seen)}</span></div>
    </div>`;
  }).join('');
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal(e) {
  if (e.target === document.getElementById('modal-overlay'))
    document.getElementById('modal-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
// HISTÓRICO
// ══════════════════════════════════════════════════════════
async function fetchHistory() {
  const tbody = document.getElementById('hist-body');
  tbody.innerHTML = '<tr><td colspan="4" class="hist-empty"><span class="loader"></span> Carregando...</td></tr>';
  const device = document.getElementById('filt-device').value;
  const status = document.getElementById('filt-status').value;
  const date   = document.getElementById('filt-date').value;
  let url = `${SB_URL}/rest/v1/status_history?select=*&order=created_at.desc&limit=200`;
  if (device) url += `&device_name=eq.${encodeURIComponent(device)}`;
  if (status !== '') url += `&is_ok=eq.${status}`;
  if (date) url += `&created_at=gte.${date}T00:00:00&created_at=lte.${date}T23:59:59`;
  try {
    const res = await fetch(url, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    renderHistory(rows);
    populateDeviceFilter();
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="4" class="hist-empty" style="color:var(--fail)">Erro: ${e.message}</td></tr>`;
  }
}
function renderHistory(rows) {
  const tbody = document.getElementById('hist-body');
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="hist-empty">Nenhum registro encontrado.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const next = rows[i-1];
    const dur = next ? duration(r.created_at, next.created_at) : duration(r.created_at, null);
    const pill = r.is_ok ? '<span class="pill ok">✅ OK</span>' : '<span class="pill fail">🔴 FALHA</span>';
    return `<tr><td style="font-weight:600">${r.device_name}</td><td>${pill}</td><td>${fmtTime(r.created_at)}</td><td style="color:var(--muted)">${dur}</td></tr>`;
  }).join('');
}
function populateDeviceFilter() {
  const sel = document.getElementById('filt-device');
  const current = sel.value;
  const names = [...new Set(allDevices.map(d => d.device_name))].sort();
  sel.innerHTML = '<option value="">Todas as torres</option>' +
    names.map(n => `<option value="${n}" ${n===current?'selected':''}>${n}</option>`).join('');
}
function clearFilters() {
  document.getElementById('filt-device').value = '';
  document.getElementById('filt-status').value = '';
  document.getElementById('filt-date').value = '';
  fetchHistory();
}

// ══════════════════════════════════════════════════════════
// MQTT WebSocket
// ══════════════════════════════════════════════════════════
function setMqttStatus(state) {
  const dot  = document.getElementById('mqtt-dot');
  const text = document.getElementById('mqtt-status-text');
  dot.className  = 'mqtt-status-dot ' + state;
  text.className = 'mqtt-status-text ' + state;
  const labels = {
    connected:    '✅ MQTT conectado — broker.emqx.io',
    connecting:   '⏳ Conectando ao broker MQTT...',
    error:        '❌ Erro na conexão MQTT',
    disconnected: '⚫ Desconectado do broker MQTT'
  };
  text.textContent = labels[state] || state;
}

function mqttConnect() {
  if (mqttClient) {
    try { mqttClient.end(true); } catch(e) {}
    mqttClient = null;
  }
  setMqttStatus('connecting');
  otaLog('Conectando ao broker MQTT via WebSocket...', 'info');

  mqttClient = mqtt.connect(MQTT_BROKER, {
    clientId: MQTT_CLIENT_ID,
    clean: true,
    connectTimeout: 10000,
    reconnectPeriod: 5000,
  });

  mqttClient.on('connect', () => {
    mqttConnected = true;
    setMqttStatus('connected');
    otaLog('✅ Conectado ao broker MQTT!', 'ok');
    // Subscreve em todos os tópicos OTA de todas as torres
    mqttClient.subscribe('torres/+/ota', { qos: 0 }, (err) => {
      if (!err) otaLog('📡 Subscrito em torres/+/ota', 'info');
      else otaLog('Erro ao subscrever: ' + err.message, 'err');
    });
    mqttClient.subscribe('torres/+/online', { qos: 0 });
    updateOtaButtons();
  });

  mqttClient.on('message', (topic, message) => {
    const payload = message.toString();
    handleMqttMessage(topic, payload);
  });

  mqttClient.on('error', (err) => {
    mqttConnected = false;
    setMqttStatus('error');
    otaLog('❌ Erro MQTT: ' + err.message, 'err');
    updateOtaButtons();
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    setMqttStatus('disconnected');
    otaLog('⚫ Conexão MQTT encerrada', 'warn');
    updateOtaButtons();
  });

  mqttClient.on('reconnect', () => {
    setMqttStatus('connecting');
    otaLog('↻ Tentando reconectar...', 'warn');
  });
}

function handleMqttMessage(topic, payload) {
  // Tópico online
  if (topic.endsWith('/online')) {
    const slug = topic.split('/')[1].replace('torre_', '');
    otaLog(`📶 [${slug}] ${payload}`, payload === 'online' ? 'ok' : 'warn');
    return;
  }

  // Tópico OTA
  if (topic.endsWith('/ota')) {
    try {
      const data = JSON.parse(payload);
      const slug = data.slug || topic.split('/')[1].replace('torre_', '');
      const status = data.status || '';
      const msg    = data.message || '';
      const progress = data.progress;

      if (!selectedOtaSlug || slugMatches(selectedOtaSlug, slug)) {
        const cls = status === 'success' ? 'ok'
                  : status === 'error'   ? 'err'
                  : status === 'progress'? 'progress'
                  : status === 'started' ? 'warn'
                  : status === 'restart' ? 'warn'
                  : status === 'status'  ? 'ok'
                  : 'info';

        const icon = status === 'success' ? '✅'
                   : status === 'error'   ? '❌'
                   : status === 'progress'? '📦'
                   : status === 'started' ? '🚀'
                   : status === 'restart' ? '🔄'
                   : status === 'status'  ? '📊'
                   : 'ℹ️';

        if (status === 'status' && data.corrente !== undefined) {
          otaLog(`${icon} [${slug}] ${msg}`, cls);
          otaLog(`   ⚡ ${data.corrente}A | 💡 ${data.lampada} | 📶 ${data.wifi} dBm | 🌐 ${data.ip} | ⏱ ${data.uptime}s`, 'ok');
        } else if (status === 'restart') {
          otaLog(`${icon} [${slug}] ${msg}`, cls);
          otaLog(`   ⏳ Dispositivo reiniciando — aguarde ~15s e peça status novamente`, 'warn');
        } else {
          otaLog(`${icon} [${slug}] ${msg}${progress !== undefined ? ' — ' + progress + '%' : ''}`, cls);
        }

        if (progress !== undefined) {
          updateProgressBar(progress);
        }
        if (status === 'success') {
          updateProgressBar(100);
          setTimeout(() => hideProgressBar(), 3000);
        }
        if (status === 'error') {
          hideProgressBar();
        }
      }
    } catch(e) {
      otaLog(`[raw] ${topic}: ${payload}`, 'info');
    }
  }
}

// ══════════════════════════════════════════════════════════
// OTA — DISPOSITIVOS
// ══════════════════════════════════════════════════════════
function renderOtaDevices() {
  const list = document.getElementById('ota-device-list');
  if (!allDevices.length) {
    list.innerHTML = '<div class="empty" style="padding:16px;font-size:0.8rem">Nenhum dispositivo.<br>Vá em Monitoramento primeiro.</div>';
    return;
  }
  list.innerHTML = allDevices.map(d => {
    const st = getStatus(d);
    const online = st !== 'offline';
    const slug = getSlug(d.device_name);
    const isSelected = selectedOtaSlug === slug;
    return `<div class="device-row ${isSelected ? 'selected' : ''}" onclick="selectOtaDevice('${d.device_name}', '${slug}', ${online})">
      <div class="device-row-left">
        <span class="dname">${d.device_name}</span>
        <span class="dslug">torres/torre_${slug}/cmd</span>
      </div>
      <span class="dstatus ${online ? 'online' : 'offline'}">${online ? '● Online' : '○ Offline'}</span>
    </div>`;
  }).join('');
}

function selectOtaDevice(name, slug, online) {
  selectedOtaSlug = slug;
  selectedOtaName = name;
  renderOtaDevices();
  otaLog(`🎯 Dispositivo selecionado: ${name}`, 'ok');
  otaLog(`📌 Tópico CMD: torres/torre_${slug}/cmd`, 'info');
  if (!online) otaLog('⚠️ Dispositivo offline — OTA pode falhar', 'warn');
  updateOtaButtons();
}

function updateOtaButtons() {
  const ready = mqttConnected && selectedOtaSlug;
  document.getElementById('btn-send-ota').disabled  = !ready;
  document.getElementById('btn-restart').disabled   = !ready;
  document.getElementById('btn-status').disabled    = !ready;
}

// ══════════════════════════════════════════════════════════
// OTA — ENVIO DE COMANDOS
// ══════════════════════════════════════════════════════════
function publishCmd(slug, cmd) {
  if (!mqttClient || !mqttConnected) {
    otaLog('❌ MQTT não conectado. Reconecte primeiro.', 'err');
    return false;
  }
  const topic = `torres/torre_${slug}/cmd`;
  mqttClient.publish(topic, cmd, { qos: 1, retain: false }, (err) => {
    if (err) otaLog(`❌ Falha ao publicar: ${err.message}`, 'err');
  });
  return true;
}

function sendOTA() {
  if (!selectedOtaSlug) { otaLog('❌ Selecione um dispositivo primeiro.', 'err'); return; }
  const url = document.getElementById('ota-url').value.trim();
  if (!url || !url.startsWith('http')) {
    otaLog('❌ URL inválida. Use https://...', 'err');
    return;
  }
  const cmd = `update ${url}`;
  otaLog(`🚀 Enviando OTA para ${selectedOtaName}...`, 'warn');
  otaLog(`📦 URL: ${url}`, 'info');
  if (publishCmd(selectedOtaSlug, cmd)) {
    otaLog(`✅ Comando publicado em torres/torre_${selectedOtaSlug}/cmd`, 'ok');
    otaLog('⏳ Aguardando resposta do ESP32...', 'info');
    showProgressBar();
  }
}

function sendRestart() {
  if (!selectedOtaSlug) { otaLog('❌ Selecione um dispositivo primeiro.', 'err'); return; }
  otaLog(`🔄 Enviando restart para ${selectedOtaName}...`, 'warn');
  if (publishCmd(selectedOtaSlug, 'restart')) {
    otaLog(`✅ Comando publicado em torres/torre_${selectedOtaSlug}/cmd`, 'ok');
    otaLog('⏳ Aguardando confirmação do ESP32...', 'info');
  }
}

function sendStatus() {
  if (!selectedOtaSlug) { otaLog('❌ Selecione um dispositivo primeiro.', 'err'); return; }
  otaLog(`📊 Solicitando status de ${selectedOtaName}...`, 'info');
  if (publishCmd(selectedOtaSlug, 'status')) {
    otaLog(`✅ Comando publicado em torres/torre_${selectedOtaSlug}/cmd`, 'ok');
    otaLog('⏳ Aguardando telemetria em torres/torre_' + selectedOtaSlug + '/ota ...', 'info');
  }
}

// ══════════════════════════════════════════════════════════
// LOG
// ══════════════════════════════════════════════════════════
function otaLog(msg, cls = '') {
  const log = document.getElementById('ota-log');
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' log-' + cls : '');
  const time = new Date().toLocaleTimeString('pt-BR');
  line.innerHTML = `<span class="log-time">${time}</span>${msg}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  // Limita a 200 linhas
  while (log.children.length > 200) log.removeChild(log.firstChild);
}
function clearLog() {
  document.getElementById('ota-log').innerHTML = '';
  otaLog('Log limpo.', 'info');
}

// ══════════════════════════════════════════════════════════
// PROGRESS BAR
// ══════════════════════════════════════════════════════════
function showProgressBar() {
  const wrap = document.getElementById('ota-progress-wrap');
  wrap.classList.add('visible');
  updateProgressBar(0);
}
function hideProgressBar() {
  document.getElementById('ota-progress-wrap').classList.remove('visible');
}
function updateProgressBar(pct) {
  document.getElementById('ota-progress-bar').style.width = pct + '%';
  document.getElementById('ota-progress-label').textContent = pct + '%';
}

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════
fetchData();
setInterval(fetchData, 10000);
// Conecta MQTT ao abrir a página OTA
// (também conecta automaticamente se já estiver na aba OTA)
