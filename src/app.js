import express from "express";
import cors from "cors";

import { authMiddleware } from "./middleware/auth.js";
import { healthRouter } from "./routes/health.js";
import { statusRouter } from "./routes/status.js";
import { sendMessageRouter } from "./routes/send-message.js";
import { reconnectRouter } from "./routes/reconnect.js";
import { disconnectRouter } from "./routes/disconnect.js";
import { qrPageRouter } from "./routes/qr-page.js";
import { createAdminRouter } from "./routes/admin.js";

export function createApp(whatsapp) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Locals ficam acessíveis em todas as rotas via req.app.locals
  app.locals.whatsapp = whatsapp;

  // Painel admin + API de monitoramento (público, acessível via /admin)
  app.use("/", createAdminRouter(whatsapp));

  // Rotas públicas (sem auth) — úteis para monitoramento
  app.use("/", qrPageRouter);
  app.use("/health", healthRouter);
  app.use("/api/whatsapp/status", statusRouter);

  // Rotas autenticadas (Bearer token)
  app.use("/api/send-message", authMiddleware, sendMessageRouter);
  app.use("/api/whatsapp/reconnect", authMiddleware, reconnectRouter);
  app.use("/api/whatsapp/disconnect", authMiddleware, disconnectRouter);

  // 404 + error handler globais
  app.use((_req, res) => res.status(404).json({ success: false, error: "Rota não encontrada." }));
  app.use((err, _req, res, _next) => {
    console.error("[express-error]", err);
    res.status(500).json({ success: false, error: "Erro interno do servidor." });
  });

  return app;
}
