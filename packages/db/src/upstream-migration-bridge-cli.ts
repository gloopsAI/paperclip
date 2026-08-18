import { resolveMigrationConnection } from "./migration-runtime.js";
import { runUpstreamMigrationBridge } from "./upstream-migration-bridge.js";

const command = process.argv[2];
if (command !== "verify" && command !== "record" && command !== "rollback-classification") {
  throw new Error("usage: upstream-migration-bridge verify|record|rollback-classification");
}

const connection = await resolveMigrationConnection();
try {
  const receipt = await runUpstreamMigrationBridge(connection.connectionString, command);
  process.stdout.write(`${JSON.stringify({ source: connection.source, ...receipt })}\n`);
} finally {
  await connection.stop();
}
