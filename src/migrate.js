const fs = require("node:fs/promises");
const path = require("node:path");
const { pool } = require("./database");

async function migrate() {
  const migration = await fs.readFile(
    path.join(__dirname, "..", "migrations", "001_moto_intake.sql"),
    "utf8",
  );
  await pool.query(migration);
  console.log("Migrazione Moto Smart applicata.");
}

migrate()
  .catch((error) => {
    console.error("Migrazione non riuscita:", error.code || "unknown");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
