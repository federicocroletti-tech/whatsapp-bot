const fs = require("node:fs/promises");
const path = require("node:path");
const { pool } = require("./database");

async function migrate() {
  const migrationDirectory = path.join(__dirname, "..", "migrations");
  const migrations = (await fs.readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();

  for (const name of migrations) {
    const migration = await fs.readFile(
      path.join(migrationDirectory, name),
      "utf8",
    );
    await pool.query(migration);
    console.log(`Migrazione applicata: ${name}`);
  }
}

migrate()
  .catch((error) => {
    console.error("Migrazione non riuscita:", error.code || "unknown");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
