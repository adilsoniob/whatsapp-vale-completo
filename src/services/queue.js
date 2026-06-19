import initSqlJs from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { log } from "../logger.js";

const DB_PATH = "./data/queue.db";

let db = null;
let SQL = null;

async function getDb() {
  if (db) return db;
  if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
  SQL = await initSqlJs();
  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run("PRAGMA journal_mode=WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      completed_at TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_queue_status ON message_queue(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_queue_priority ON message_queue(priority, created_at)");
  _save();
  return db;
}

function _save() {
  if (!db) return;
  const data = db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

function nowISO() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export async function enqueue(phone, message, metadata = {}) {
  const d = await getDb();
  const ts = nowISO();
  const result = d.exec(
    "INSERT INTO message_queue (phone, message, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    [phone, message, JSON.stringify(metadata), ts, ts]
  );
  _save();
  const id = result[0]?.values[0][0];
  log.info("[queue] Enfileirado", { id, phone: phone.slice(-8) });
  return id;
}

export async function dequeue(limit = 1) {
  const d = await getDb();
  const rows = d.exec(
    `SELECT id, phone, message, metadata, retry_count, max_retries, created_at
     FROM message_queue
     WHERE status = 'pending'
     ORDER BY priority DESC, created_at ASC
     LIMIT ?`,
    [limit]
  );
  if (!rows.length || !rows[0].values.length) return [];
  const items = rows[0].values.map((row) => ({
    id: row[0],
    phone: row[1],
    message: row[2],
    metadata: tryParse(row[3], {}),
    retry_count: row[4],
    max_retries: row[5],
    created_at: row[6],
  }));
  const ids = items.map((r) => r.id);
  const ts = nowISO();
  d.run(`UPDATE message_queue SET status = 'processing', updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`, [ts, ...ids]);
  _save();
  return items;
}

export async function complete(id) {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [ts, ts, id]);
  _save();
  log.info("[queue] Completado", { id });
  return true;
}

export async function fail(id, error) {
  const d = await getDb();
  const ts = nowISO();
  const row = d.exec("SELECT retry_count, max_retries FROM message_queue WHERE id = ?", [id]);
  if (!row.length || !row[0].values.length) return false;
  const retryCount = row[0].values[0][0] + 1;
  const maxRetries = row[0].values[0][1];
  if (retryCount >= maxRetries) {
    d.run("UPDATE message_queue SET status = 'deadletter', retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?", [retryCount, String(error).slice(0, 500), ts, id]);
    log.warn("[queue] Dead letter", { id, error: String(error).slice(0, 200), retries: retryCount });
  } else {
    d.run("UPDATE message_queue SET status = 'pending', retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?", [retryCount, String(error).slice(0, 500), ts, id]);
    log.warn("[queue] Falhou (retry pendente)", { id, error: String(error).slice(0, 200), retry: retryCount, max: maxRetries });
  }
  _save();
  return true;
}

export async function revertToPending(id) {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'pending', last_error = NULL, updated_at = ? WHERE id = ? AND status = 'processing'", [ts, id]);
  _save();
  return true;
}

export async function retry(id) {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'pending', retry_count = 0, last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed','deadletter')", [ts, id]);
  _save();
  log.info("[queue] Reenfileirado manualmente", { id });
  return true;
}

export async function retryAll() {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'pending', retry_count = 0, last_error = NULL, updated_at = ? WHERE status IN ('failed','deadletter')", [ts]);
  _save();
  const changes = d.getRowsModified();
  if (changes > 0) log.info("[queue] Todos reenfileirados", { count: changes });
  return changes;
}

export async function stats() {
  const d = await getDb();
  const rows = d.exec("SELECT status, COUNT(*) as count FROM message_queue GROUP BY status");
  const result = { pending: 0, processing: 0, completed: 0, failed: 0, deadletter: 0, total: 0 };
  if (rows.length) {
    for (const row of rows[0].values) {
      result[row[0]] = row[1];
    }
  }
  result.total = result.pending + result.processing + result.completed + result.failed + result.deadletter;
  return result;
}

export async function list(status, limit = 50, offset = 0) {
  const d = await getDb();
  if (status && status !== "all") {
    const rows = d.exec("SELECT * FROM message_queue WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [status, limit, offset]);
    return _rowsToObjects(rows, ["id", "phone", "message", "status", "priority", "retry_count", "max_retries", "last_error", "metadata", "created_at", "updated_at", "completed_at"]);
  }
  const rows = d.exec("SELECT * FROM message_queue ORDER BY created_at DESC LIMIT ? OFFSET ?", [limit, offset]);
  return _rowsToObjects(rows, ["id", "phone", "message", "status", "priority", "retry_count", "max_retries", "last_error", "metadata", "created_at", "updated_at", "completed_at"]);
}

export async function pendingCount() {
  const d = await getDb();
  const rows = d.exec("SELECT COUNT(*) as count FROM message_queue WHERE status = 'pending'");
  return rows.length && rows[0].values.length ? rows[0].values[0][0] : 0;
}

export async function deadletter(id, error) {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'deadletter', last_error = ?, updated_at = ? WHERE id = ?", [String(error).slice(0, 500), ts, id]);
  _save();
  log.warn("[queue] Dead letter direto (sem retry)", { id, error: String(error).slice(0, 200) });
  return true;
}

export async function clearCompleted() {
  const d = await getDb();
  d.run("DELETE FROM message_queue WHERE status = 'completed'");
  _save();
  const changes = d.getRowsModified();
  if (changes > 0) log.info("[queue] Limpos completados", { deleted: changes });
  return changes;
}

export async function clearAll(status) {
  const d = await getDb();
  if (status) {
    d.run("DELETE FROM message_queue WHERE status = ?", [status]);
  } else {
    d.run("DELETE FROM message_queue");
  }
  _save();
  return d.getRowsModified();
}

export function closeDb() {
  if (db) {
    _save();
    db.close();
    db = null;
    log.info("[queue] Banco fechado");
  }
}

function _rowsToObjects(rows, columns) {
  if (!rows.length || !rows[0].values.length) return [];
  return rows[0].values.map((row) => {
    const obj = {};
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
    return obj;
  });
}

function tryParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}
