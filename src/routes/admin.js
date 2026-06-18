import { Router } from "express";

export function createAdminRouter(whatsapp) {
  const router = Router();
  const storage = whatsapp.storage;

  // ---- API ----

  router.get("/api/admin/status", (_req, res) => {
    const status = whatsapp.getStatus();
    const elapsed = status.connectedAt
      ? Math.floor((Date.now() - new Date(status.connectedAt).getTime()) / 1000)
      : 0;
    res.json({ ...status, uptime: elapsed });
  });

  router.get("/api/admin/messages", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const messages = storage?.getMessages(limit) || [];
    res.json({ success: true, messages });
  });

  router.get("/api/admin/messages/:phone", (req, res) => {
    const phone = req.params.phone;
    const messages = storage?.getMessagesByPhone(phone) || [];
    res.json({ success: true, messages });
  });

  router.get("/api/admin/contacts", (_req, res) => {
    const contacts = storage?.getContacts() || [];
    res.json({ success: true, contacts });
  });

  router.get("/api/admin/logs", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const logs = storage?.getLogs(limit) || [];
    res.json({ success: true, logs });
  });

  // ---- Admin HTML ----

  router.get("/admin", (_req, res) => {
    res.type("html").send(ADMIN_HTML);
  });

  return router;
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Painel WhatsApp | Vale Saúde</title>
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.layout{display:grid;grid-template-columns:280px 1fr;min-height:100vh}
.sidebar{background:#1e293b;padding:1.25rem;border-right:1px solid #334155;overflow-y:auto}
.sidebar h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin:1.25rem 0 .5rem}
.sidebar h2:first-child{margin-top:0}
.sidebar .stat{display:flex;justify-content:space-between;padding:.4rem 0;font-size:.825rem;border-bottom:1px solid #334155}
.sidebar .stat:last-child{border:none}
.sidebar .stat-label{color:#94a3b8}
.sidebar .stat-value{font-weight:600}
.main{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.topbar{display:flex;align-items:center;gap:.75rem;padding:.75rem 1.25rem;background:#1e293b;border-bottom:1px solid #334155}
.topbar h1{font-size:1rem;font-weight:700}
.status-dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0}
.status-dot--connected{background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.5)}
.status-dot--awaiting_qr,.status-dot--reconnecting{background:#eab308;box-shadow:0 0 8px rgba(234,179,8,.5)}
.status-dot--offline,.status-dot--auth_failure,.status-dot--error{background:#ef4444;box-shadow:0 0 8px rgba(239,68,68,.5)}
.status-dot--starting{background:#64748b}
.content{flex:1;overflow-y:auto;padding:1.25rem;display:grid;grid-template-columns:1fr 1fr;gap:1rem;align-content:start}
.card{background:#1e293b;border-radius:.75rem;padding:1rem;border:1px solid #334155}
.card h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:.75rem}
.card-full{grid-column:1/-1}
.profile-row{display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem}
.profile-pic{width:48px;height:48px;border-radius:50%;object-fit:cover;background:#334155}
.profile-info strong{font-size:.95rem}
.profile-info small{display:block;color:#94a3b8;font-size:.8rem;margin-top:2px}
.actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.75rem}
.btn{padding:.45rem 1rem;border-radius:.5rem;border:none;font-size:.8rem;font-weight:600;cursor:pointer;transition:opacity .15s}
.btn:hover{opacity:.85}
.btn-primary{background:#2563eb;color:#fff}
.btn-danger{background:#dc2626;color:#fff}
.btn-warning{background:#d97706;color:#fff}
.btn-outline{background:transparent;border:1px solid #475569;color:#cbd5e1}
.btn-sm{padding:.3rem .65rem;font-size:.75rem}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th{text-align:left;padding:.5rem .4rem;color:#64748b;font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #334155}
td{padding:.45rem .4rem;border-bottom:1px solid #1e293b;font-size:.8rem}
.tag{padding:.15rem .5rem;border-radius:999px;font-size:.7rem;font-weight:600}
.tag-success{background:#052e16;color:#4ade80}
.tag-warning{background:#451a03;color:#fbbf24}
.tag-error{background:#450a0a;color:#f87171}
.tag-info{background:#1e3a5f;color:#60a5fa}
.empty{color:#64748b;font-size:.8rem;padding:1rem 0;text-align:center}
.contact-item{display:flex;justify-content:space-between;align-items:center;padding:.4rem 0;border-bottom:1px solid #334155;font-size:.8rem}
.contact-item:last-child{border:none}
.contact-phone{font-weight:600;font-family:monospace}
.contact-meta{text-align:right;color:#94a3b8;font-size:.7rem}
.log-item{padding:.35rem 0;border-bottom:1px solid #1e293b;font-size:.75rem;display:flex;gap:.5rem}
.log-item:last-child{border:none}
.log-time{color:#64748b;flex-shrink:0;font-family:monospace;font-size:.7rem}
.log-event{font-weight:600;flex-shrink:0;min-width:120px}
.log-desc{color:#94a3b8}
.tabs{display:flex;gap:0;margin-bottom:1rem;border-bottom:1px solid #334155}
.tab{padding:.5rem 1rem;font-size:.8rem;font-weight:600;cursor:pointer;color:#64748b;border-bottom:2px solid transparent;transition:all .15s}
.tab:hover{color:#e2e8f0}
.tab.active{color:#60a5fa;border-bottom-color:#60a5fa}
.tab-content{display:none}
.tab-content.active{display:block}
.uptime{font-family:monospace;font-size:.8rem}
@media(max-width:768px){.layout{grid-template-columns:1fr}.sidebar{display:none}.content{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar" id="sidebar">
    <h2>Conexão</h2>
    <div class="stat"><span class="stat-label">Status</span><span class="stat-value" id="sStatus">---</span></div>
    <div class="stat"><span class="stat-label">Número</span><span class="stat-value" id="sNumber">---</span></div>
    <div class="stat"><span class="stat-label">Conta</span><span class="stat-value" id="sAccount">---</span></div>
    <div class="stat"><span class="stat-label">Conectado há</span><span class="stat-value uptime" id="sUptime">---</span></div>
    <div class="stat"><span class="stat-label">Último envio</span><span class="stat-value" id="sLastSend">---</span></div>
    <div class="stat"><span class="stat-label">Mensagens</span><span class="stat-value" id="sMsgCount">0</span></div>
    <div class="stat"><span class="stat-label">Contatos</span><span class="stat-value" id="sContactCount">0</span></div>

    <h2>Ações</h2>
    <div style="display:flex;flex-direction:column;gap:.4rem;margin-top:.25rem">
      <button class="btn btn-primary btn-sm" onclick="window.open('/','whatsapp-qr')">Abrir QR Code</button>
      <button class="btn btn-warning btn-sm" onclick="action('reconnect')">Reconectar</button>
      <button class="btn btn-danger btn-sm" onclick="if(confirm('Desconectar WhatsApp?'))action('disconnect')">Desconectar</button>
    </div>
  </aside>

  <div class="main">
    <div class="topbar">
      <span class="status-dot status-dot--starting" id="topStatusDot"></span>
      <h1 id="topStatusText">Inicializando...</h1>
    </div>

    <div class="content">
      <div class="card">
        <h3>WhatsApp</h3>
        <div class="profile-row">
          <img class="profile-pic" id="profilePic" src="" alt="Foto do perfil" style="display:none">
          <div id="profilePlaceholder" class="profile-pic" style="display:flex;align-items:center;justify-content:center;color:#64748b;font-size:1.25rem">?</div>
          <div class="profile-info">
            <strong id="profileName">---</strong>
            <small id="profileNumber">---</small>
          </div>
        </div>
        <div class="actions">
          <span class="tag tag-info" id="statusTag">Inicializando</span>
        </div>
        <div class="actions">
          <button class="btn btn-primary btn-sm" onclick="window.open('/','whatsapp-qr')">Exibir QR Code</button>
          <button class="btn btn-warning btn-sm" onclick="action('reconnect')">Reconectar</button>
          <button class="btn btn-danger btn-sm" onclick="if(confirm('Desconectar WhatsApp?'))action('disconnect')">Desconectar</button>
          <button class="btn btn-outline btn-sm" onclick="fetchStatus()">Atualizar</button>
        </div>
      </div>

      <div class="card">
        <h3>Sessão</h3>
        <div class="stat"><span class="stat-label">Conectado desde</span><span class="stat-value" id="connectedSince">---</span></div>
        <div class="stat"><span class="stat-label">Tempo online</span><span class="stat-value uptime" id="uptimeDisplay">---</span></div>
        <div class="stat"><span class="stat-label">Reconexões</span><span class="stat-value" id="reconnectCount">0</span></div>
        <div class="stat"><span class="stat-label">Último erro</span><span class="stat-value" id="lastErrorDisplay">---</span></div>
      </div>

      <div class="card card-full">
        <div class="tabs" id="tabs">
          <div class="tab active" data-tab="messages">Mensagens</div>
          <div class="tab" data-tab="contacts">Contatos</div>
          <div class="tab" data-tab="logs">Logs</div>
        </div>

        <div class="tab-content active" id="tabMessages">
          <table>
            <thead><tr><th>Data/Hora</th><th>Número</th><th>Status</th><th>Origem</th></tr></thead>
            <tbody id="messagesBody"><tr><td colspan="4" class="empty">Carregando...</td></tr></tbody>
          </table>
        </div>

        <div class="tab-content" id="tabContacts">
          <div id="contactsBody"></div>
        </div>

        <div class="tab-content" id="tabLogs">
          <div id="logsBody"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
const socket = io({ transports: ["websocket", "polling"], reconnection: true });

function statusClass(state) {
  const map = { connected: "success", awaiting_qr: "warning", reconnecting: "warning", starting: "info", offline: "error", auth_failure: "error", error: "error" };
  return map[state] || "info";
}

function renderStatus(status) {
  const dot = document.getElementById("topStatusDot");
  const text = document.getElementById("topStatusText");
  const tag = document.getElementById("statusTag");
  dot.className = "status-dot status-dot--" + (status.state || "starting");
  text.textContent = status.message || status.state || "---";
  tag.className = "tag tag-" + statusClass(status.state);
  tag.textContent = status.message || status.state || "---";

  document.getElementById("sStatus").textContent = status.state || "---";
  document.getElementById("sNumber").textContent = status.profileNumber || "---";
  document.getElementById("sAccount").textContent = status.profileName || "---";
  document.getElementById("sLastSend").textContent = status.lastSendAt ? new Date(status.lastSendAt).toLocaleString("pt-BR") : "---";
  document.getElementById("reconnectCount").textContent = status.reconnectAttempts || 0;
  document.getElementById("lastErrorDisplay").textContent = status.lastError?.error || "---";

  const profileName = document.getElementById("profileName");
  const profileNumber = document.getElementById("profileNumber");
  const profilePic = document.getElementById("profilePic");
  const placeholder = document.getElementById("profilePlaceholder");
  profileName.textContent = status.profileName || "---";
  profileNumber.textContent = status.profileNumber ? "+55 " + status.profileNumber : "---";
  if (status.profilePic) {
    profilePic.src = status.profilePic;
    profilePic.style.display = "";
    placeholder.style.display = "none";
  } else {
    profilePic.style.display = "none";
    placeholder.style.display = "flex";
  }

  document.getElementById("connectedSince").textContent = status.connectedAt ? new Date(status.connectedAt).toLocaleString("pt-BR") : "---";
}

function renderUptime() {
  const status = window._lastStatus;
  if (!status || !status.connectedAt) {
    document.getElementById("sUptime").textContent = "---";
    document.getElementById("uptimeDisplay").textContent = "---";
    return;
  }
  const elapsed = Math.floor((Date.now() - new Date(status.connectedAt).getTime()) / 1000);
  const d = Math.floor(elapsed / 86400);
  const h = Math.floor((elapsed % 86400) / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  parts.push(s + "s");
  const str = parts.join(" ");
  document.getElementById("sUptime").textContent = str;
  document.getElementById("uptimeDisplay").textContent = str;
}

function renderMessages(messages) {
  const tbody = document.getElementById("messagesBody");
  if (!messages || !messages.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Nenhuma mensagem enviada.</td></tr>';
    return;
  }
  tbody.innerHTML = messages.map(m => {
    const statusClass = m.status === "sent" || m.status === "received" || m.status === "delivered" ? "success" : m.status === "failed" ? "error" : "warning";
    const statusLabel = { sent: "Enviada", received: "Recebida", delivered: "Entregue", read: "Lida", failed: "Falhou" };
    return '<tr><td>' + new Date(m.timestamp).toLocaleString("pt-BR") + '</td><td>+55 ' + m.to + '</td><td><span class="tag tag-' + statusClass + '">' + (statusLabel[m.status] || m.status) + '</span></td><td>' + (m.source || "api") + '</td></tr>';
  }).join("");
  document.getElementById("sMsgCount").textContent = messages.length;
}

function renderContacts(contacts) {
  const el = document.getElementById("contactsBody");
  if (!contacts || !contacts.length) {
    el.innerHTML = '<div class="empty">Nenhum contato.</div>';
    return;
  }
  el.innerHTML = contacts.map(c => {
    const statusClass = c.lastStatus === "sent" || c.lastStatus === "received" || c.lastStatus === "delivered" ? "success" : c.lastStatus === "failed" ? "error" : "warning";
    const statusLabel = { sent: "Enviada", received: "Recebida", delivered: "Entregue", read: "Lida", failed: "Falhou" };
    return '<div class="contact-item"><div><div class="contact-phone">+55 ' + (c.phone || "---") + '</div><div style="color:#64748b;font-size:.7rem">' + (c.lastSendAt ? new Date(c.lastSendAt).toLocaleString("pt-BR") : "---") + '</div></div><div class="contact-meta"><span class="tag tag-' + statusClass + '">' + (statusLabel[c.lastStatus] || c.lastStatus) + '</span><div style="margin-top:4px">' + (c.count || 0) + ' msg</div></div></div>';
  }).join("");
  document.getElementById("sContactCount").textContent = contacts.length;
}

function renderLogs(logs) {
  const el = document.getElementById("logsBody");
  if (!logs || !logs.length) {
    el.innerHTML = '<div class="empty">Nenhum log registrado.</div>';
    return;
  }
  el.innerHTML = logs.map(l => '<div class="log-item"><span class="log-time">' + new Date(l.timestamp).toLocaleString("pt-BR") + '</span><span class="log-event">' + (l.event || "") + '</span><span class="log-desc">' + (l.description || "") + '</span></div>').join("");
}

async function fetchStatus() {
  try {
    const r = await fetch("/api/admin/status");
    const data = await r.json();
    window._lastStatus = data;
    renderStatus(data);
  } catch {}
}

async function fetchMessages() {
  try {
    const r = await fetch("/api/admin/messages");
    const data = await r.json();
    if (data.success) renderMessages(data.messages);
  } catch {}
}

async function fetchContacts() {
  try {
    const r = await fetch("/api/admin/contacts");
    const data = await r.json();
    if (data.success) renderContacts(data.contacts);
  } catch {}
}

async function fetchLogs() {
  try {
    const r = await fetch("/api/admin/logs");
    const data = await r.json();
    if (data.success) renderLogs(data.logs);
  } catch {}
}

async function action(type) {
  try {
    const r = await fetch("/api/whatsapp/" + type);
    await r.json();
    setTimeout(fetchStatus, 1000);
  } catch {}
}

// Tabs
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab" + tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)).classList.add("active");
  });
});

// Socket.io events
socket.on("admin:status", (data) => {
  window._lastStatus = data;
  renderStatus(data);
});

socket.on("admin:message", () => {
  fetchMessages();
  fetchContacts();
});

socket.on("connect", fetchStatus);
socket.on("connected", fetchStatus);
socket.on("disconnected", fetchStatus);
socket.on("qr", fetchStatus);

// Initial load
fetchStatus();
fetchMessages();
fetchContacts();
fetchLogs();
setInterval(fetchStatus, 3000);
setInterval(renderUptime, 1000);
setInterval(fetchMessages, 5000);
setInterval(fetchContacts, 10000);
setInterval(fetchLogs, 15000);
</script>
</body>
</html>`;
