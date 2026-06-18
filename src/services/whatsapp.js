/**
 * Serviço WhatsApp (whatsapp-web.js).
 *
 * Princípios:
 * - Uma única instância do Client por processo.
 * - Destrói o Client antigo COM logout antes de criar novo (evita sessão zumbi).
 * - Auto-reconexão com backoff exponencial limitado.
 * - Envio com timeout e verificação de número registrado.
 * - Logs estruturados em todas as transições de estado.
 */

import pkg from "whatsapp-web.js";
import qrcode from "qrcode";
import { config } from "../config.js";
import { log } from "../logger.js";

// whatsapp-web.js >=1.25: Client é named export, LocalAuth está em default.
const Client = pkg.Client || pkg.default?.Client;
const LocalAuth = pkg.LocalAuth || pkg.default?.LocalAuth;

const STATES = Object.freeze({
  STARTING: "starting",
  AWAITING_QR: "awaiting_qr",
  CONNECTED: "connected",
  OFFLINE: "offline",
  AUTH_FAILURE: "auth_failure",
  RECONNECTING: "reconnecting",
  ERROR: "error",
});

const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--mute-audio",
];

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout após ${ms}ms`)), ms)
    ),
  ]);

export class WhatsAppService {
  constructor(io, storage) {
    this.io = io;
    this.storage = storage;
    this.status = { state: STATES.STARTING, qr: null, message: "Inicializando..." };
    this.client = null;
    this.initializing = null;
    this.reconnectAttempts = 0;
    this.lastSendAt = null;
    this.lastError = null;
    this.profileName = null;
    this.profileNumber = null;
    this.profilePic = null;
    this.connectedAt = null;
    this.disconnectedAt = null;
  }

  // ---------- API pública ----------

  isReady() {
    return this.status.state === STATES.CONNECTED && this.client !== null;
  }

  getStatus() {
    return {
      ...this.status,
      profileName: this.profileName,
      profileNumber: this.profileNumber,
      profilePic: this.profilePic,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      lastSendAt: this.lastSendAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  async sendMessage(number, message) {
    if (!this.client) return this._fail("NOT_INITIALIZED", "Cliente não inicializado.");
    if (!this.isReady()) return this._fail("NOT_READY", "WhatsApp não está conectado.");

    const cleanNumber = String(number || "").replace(/\D+/g, "");
    if (cleanNumber.length < 10) {
      return this._fail("BAD_NUMBER", `Número inválido (${cleanNumber.length} dígitos).`, cleanNumber);
    }
    if (!message || !message.trim()) {
      return this._fail("EMPTY_MESSAGE", "Mensagem vazia.");
    }

    const chatId = `${cleanNumber}@c.us`;

    try {
      // Verifica se o número está registrado no WhatsApp (evita "success fantasma").
      const registered = await withTimeout(
        this.client.getNumberId(cleanNumber),
        5000,
        "getNumberId"
      );
      if (registered === null) {
        return this._fail("NOT_REGISTERED", "Número não registrado no WhatsApp.", cleanNumber);
      }

      const sent = await withTimeout(
        this.client.sendMessage(chatId, message),
        config.sendTimeoutMs,
        "sendMessage"
      );

      this.lastSendAt = new Date().toISOString();
      const messageId = sent?.id?._serialized || sent?.id || null;
      log.info("Mensagem enviada", { to: chatId, messageId });
      this.storage?.addMessage({ to: cleanNumber, status: "sent", source: "api", id: messageId });
      this.storage?.addLog("message_sent", `Mensagem enviada para ${cleanNumber}`, { to: cleanNumber, messageId });
      this.io?.emit("admin:message", { to: cleanNumber, status: "sent", timestamp: new Date().toISOString() });
      return {
        success: true,
        message: "Mensagem enviada com sucesso.",
        to: chatId,
        messageId,
      };
    } catch (err) {
      this.storage?.addLog("message_error", `Erro ao enviar para ${cleanNumber}: ${err.message}`, { to: cleanNumber, error: err.message });
      return this._fail("SEND_ERROR", err.message || String(err), cleanNumber);
    }
  }

  async reconnect() {
    log.info("Reconexão manual solicitada");
    this.reconnectAttempts = 0;
    this._setStatus(STATES.RECONNECTING, "Reconectando...");
    this.initializing = null;
    return this.initialize();
  }

  async disconnect() {
    log.info("Desconexão manual solicitada");
    await this._destroyClientSafely();
    this._setStatus(STATES.OFFLINE, "WhatsApp desconectado manualmente.");
    this.io?.emit("disconnected", { reason: "manual" });
  }

  destroy() {
    log.info("Destroy solicitado (SIGTERM)");
    this._destroyClientSafely().catch(() => {});
  }

  // ---------- Internos ----------

  initialize() {
    if (this.initializing) {
      log.warn("initialize() já em andamento, ignorando nova chamada");
      return this.initializing;
    }

    this.initializing = (async () => {
      try {
        await this._destroyClientSafely();
        const client = this._createClient();
        this._attachHandlers(client);
        this.client = client;
        this._setStatus(STATES.STARTING, "Inicializando cliente WhatsApp...");
        await client.initialize();
        log.info("Cliente WhatsApp inicializado");
      } catch (err) {
        this._setStatus(STATES.ERROR, `Erro na inicialização: ${err.message}`);
        log.error("Falha na inicialização", { error: err.message });
        this._scheduleAutoReconnect("init_error");
      } finally {
        this.initializing = null;
      }
    })();

    return this.initializing;
  }

  _createClient() {
    return new Client({
      authStrategy: new LocalAuth({ clientId: config.clientId }),
      puppeteer: { headless: true, args: PUPPETEER_ARGS },
    });
  }

  _attachHandlers(client) {
    client.on("qr", async (qr) => {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        this._setStatus(STATES.AWAITING_QR, "QR Code gerado. Escaneie com seu WhatsApp.", qrDataUrl);
        this.io?.emit("qr", { qrDataUrl });
        log.info("QR Code gerado");
      } catch (err) {
        this._setStatus(STATES.AWAITING_QR, "Erro ao gerar QR Code.");
        log.error("Falha ao gerar QR Code", { error: err.message });
      }
    });

    client.on("ready", async () => {
      this.reconnectAttempts = 0;
      this.connectedAt = new Date().toISOString();
      this.disconnectedAt = null;
      this._setStatus(STATES.CONNECTED, "WhatsApp conectado e pronto.", null);
      this.io?.emit("connected");
      log.info("WhatsApp conectado e pronto");
      this.storage?.addLog("connected", "WhatsApp conectado e pronto");

      try {
        const info = client.info;
        if (info) {
          this.profileName = info.pushname || info.name || null;
          this.profileNumber = info.wid?.user || info.me?.user || null;
          try {
            const picUrl = await client.getProfilePicUrl(info.wid._serialized);
            this.profilePic = picUrl || null;
          } catch {}
          this.storage?.saveSession({
            profileName: this.profileName,
            profileNumber: this.profileNumber,
            connectedAt: this.connectedAt,
          });
        }
      } catch {}
    });

    client.on("disconnected", (reason) => {
      this.disconnectedAt = new Date().toISOString();
      this._setStatus(STATES.OFFLINE, `WhatsApp desconectado: ${reason}`);
      this.io?.emit("disconnected", { reason });
      log.warn("WhatsApp desconectado", { reason });
      this.storage?.addLog("disconnected", `WhatsApp desconectado: ${reason}`, { reason });
      if (reason !== "LOGOUT") {
        this._scheduleAutoReconnect("disconnected");
      }
    });

    client.on("auth_failure", (msg) => {
      this._setStatus(STATES.AUTH_FAILURE, `Falha de autenticação: ${msg}`);
      log.error("Falha de autenticação", { message: msg });
      this.storage?.addLog("auth_failure", `Falha de autenticação: ${msg}`, { message: msg });
      this._scheduleAutoReconnect("auth_failure", 5000);
    });

    client.on("message_ack", (msg, ack) => {
      const statusMap = { 1: "sent", 2: "received", 3: "read" };
      const status = statusMap[ack] || "sent";
      const phone = msg.from?.replace("@c.us", "") || "";
      if (phone) {
        this.storage?.updateMessageStatus(phone, status);
        this.io?.emit("admin:message", { to: phone, status, timestamp: new Date().toISOString() });
      }
    });

    client.on("message_create", (msg) => {
      if (msg.fromMe && msg.to) {
        const phone = msg.to.replace("@c.us", "");
        this.storage?.addMessage({ to: phone, status: "sent", source: "app", id: msg.id?._serialized });
        this.io?.emit("admin:message", { to: phone, status: "sent", timestamp: new Date().toISOString() });
      }
    });
  }

  async _destroyClientSafely() {
    if (!this.client) return;
    const old = this.client;
    this.client = null;
    try {
      if (typeof old.logout === "function") {
        await withTimeout(old.logout(), 3000, "logout").catch(() => {});
      }
    } catch {}
    try {
      await withTimeout(old.destroy(), 5000, "destroy").catch(() => {});
    } catch {}
  }

  _scheduleAutoReconnect(reason, baseDelayMs) {
    if (this.reconnectAttempts >= config.maxReconnectAttempts) {
      log.error("Limite de reconexão atingido", { reason, attempts: this.reconnectAttempts });
      return;
    }
    this.reconnectAttempts += 1;
    const base = baseDelayMs ?? config.reconnectBaseDelayMs;
    const delay = base * Math.min(this.reconnectAttempts, 3);
    log.info("Reconexão automática agendada", {
      reason,
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    setTimeout(() => {
      this.initialize().catch((err) =>
        log.error("Falha na reconexão automática", { error: err.message })
      );
    }, delay);
  }

  _setStatus(state, message, qr = undefined) {
    const prevState = this.status.state;
    this.status = {
      state,
      qr: qr === undefined ? this.status.qr : qr,
      message,
    };
    if (prevState !== state) {
      this.storage?.addLog("state_change", `Estado: ${prevState} -> ${state}`, { from: prevState, to: state, message });
      this.io?.emit("admin:status", this.getStatus());
    }
  }

  _fail(code, error, phone = null) {
    const entry = { at: new Date().toISOString(), code, error, phone };
    this.lastError = entry;
    log.warn("Falha no envio", entry);
    return { success: false, code, error, phone };
  }
}
