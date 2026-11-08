const express = require("express");
const cors = require("cors");
const { createWebhookHandlers } = require("./webhook.controller");
const config = require("./config");
const { pool } = require("./database");
const { createMotoIntakeService } = require("./moto-intake.service");
const { askAI, askLocalKnowledge } = require("./ai.service");
const { createOperatorAuth } = require("./operator-auth");
const { createOperatorHandlers } = require("./operator.controller");

const app = express();
const operatorAuth = createOperatorAuth({
  config,
  pool,
  isProduction: process.env.NODE_ENV === "production",
});
const operatorHandlers = createOperatorHandlers({ pool });
const { processIncomingMessage } = createMotoIntakeService({
  pool,
  config,
  askLocalKnowledge,
});
const { verify, handleMessage } = createWebhookHandlers({ config, processIncomingMessage });

app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || config.webOrigins.includes(origin));
    },
    credentials: true,
  }),
);
app.use(
  express.json({
    limit: "256kb",
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  }),
);

app.get("/", (req, res) => {
  res.send("WhatsApp Bot API attiva");
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({ status: "ok" });
  } catch {
    console.error("Controllo PostgreSQL non riuscito.");
    return res.status(503).json({ status: "unavailable" });
  }
});

app.get("/webhook", verify);
app.post("/webhook", handleMessage);

app.post("/operator/login", operatorAuth.requireOrigin, operatorAuth.login);
app.get(
  "/operator/session",
  operatorAuth.requireOrigin,
  operatorAuth.requireSession,
  operatorAuth.session,
);
app.post("/operator/logout", operatorAuth.requireOrigin, operatorAuth.logout);
app.get(
  "/operator/requests",
  operatorAuth.requireOrigin,
  operatorAuth.requireSession,
  operatorHandlers.listRequests,
);
app.patch(
  "/operator/requests/:id/status",
  operatorAuth.requireOrigin,
  operatorAuth.requireSession,
  operatorHandlers.updateRequestStatus,
);

app.post("/chat", async (req, res) => {
  try {
    const message = req.body.message;

    if (typeof message !== "string" || !message.trim() || message.length > 2000) {
      return res.status(400).json({
        error: "Il campo message deve contenere da 1 a 2000 caratteri",
      });
    }

    const reply = await askAI(message.trim());

    return res.json({
      reply,
    });
  } catch (err) {
    console.error("Errore endpoint /chat:", err.code || "unknown");

    return res.status(500).json({
      error: "Errore server",
    });
  }
});

module.exports = app;
