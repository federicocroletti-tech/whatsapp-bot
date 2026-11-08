const app = require("./app");
const config = require("./config");
const { pool } = require("./database");
const { startOutboxWorker } = require("./outbox.worker");

async function startServer() {
  await pool.query("SELECT 1");
  const server = app.listen(config.port, () => {
    console.log("Server avviato su porta", config.port);
  });
  startOutboxWorker().catch((error) => {
    console.error("Avvio coda WhatsApp non riuscito:", error.code || "unknown");
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      pool.end().catch((error) => {
        console.error("Chiusura PostgreSQL non riuscita:", error.code || "unknown");
      });
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

startServer().catch((error) => {
  console.error("Avvio server non riuscito:", error.code || "unknown");
  process.exitCode = 1;
});
