import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export class Storage {
  constructor() {
    this.messagesPath = path.join(DATA_DIR, "messages.json");
    this.logsPath = path.join(DATA_DIR, "logs.json");
    this.sessionPath = path.join(DATA_DIR, "session.json");
    this.contactsPath = path.join(DATA_DIR, "contacts.json");
    ensureDir();
  }

  // ---------- Messages ----------

  addMessage(entry) {
    const messages = readJSON(this.messagesPath) || [];
    messages.push({
      id: entry.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      to: entry.to,
      status: entry.status || "sent",
      timestamp: entry.timestamp || new Date().toISOString(),
      source: entry.source || "api",
    });
    writeJSON(this.messagesPath, messages);
    this._updateContact(entry.to, entry.status || "sent");
    return messages[messages.length - 1];
  }

  updateMessageStatus(to, status) {
    const messages = readJSON(this.messagesPath) || [];
    const updated = [];
    for (const msg of messages) {
      if (msg.to === to && msg.status !== "failed") {
        msg.status = status;
        updated.push(msg);
      }
    }
    if (updated.length) writeJSON(this.messagesPath, messages);
  }

  getMessages(limit = 100) {
    const messages = readJSON(this.messagesPath) || [];
    return messages.slice(-limit).reverse();
  }

  getMessagesByPhone(phone) {
    const messages = readJSON(this.messagesPath) || [];
    return messages.filter((m) => m.to === phone).reverse();
  }

  // ---------- Contacts ----------

  _updateContact(phone, status) {
    const contacts = readJSON(this.contactsPath) || {};
    const existing = contacts[phone] || { phone, count: 0, lastStatus: "", lastSendAt: null };
    existing.count += 1;
    existing.lastStatus = status;
    existing.lastSendAt = new Date().toISOString();
    contacts[phone] = existing;
    writeJSON(this.contactsPath, contacts);
  }

  getContacts() {
    const contacts = readJSON(this.contactsPath) || {};
    return Object.values(contacts).sort((a, b) => {
      if (!a.lastSendAt) return 1;
      if (!b.lastSendAt) return -1;
      return new Date(b.lastSendAt) - new Date(a.lastSendAt);
    });
  }

  // ---------- Session ----------

  saveSession(data) {
    writeJSON(this.sessionPath, {
      ...data,
      updatedAt: new Date().toISOString(),
    });
  }

  getSession() {
    return readJSON(this.sessionPath) || null;
  }

  clearSession() {
    try { fs.unlinkSync(this.sessionPath); } catch {}
  }

  // ---------- Logs ----------

  addLog(event, description, data = {}) {
    const logs = readJSON(this.logsPath) || [];
    logs.push({
      event,
      description,
      data,
      timestamp: new Date().toISOString(),
    });
    writeJSON(this.logsPath, logs);
  }

  getLogs(limit = 200) {
    const logs = readJSON(this.logsPath) || [];
    return logs.slice(-limit).reverse();
  }
}
