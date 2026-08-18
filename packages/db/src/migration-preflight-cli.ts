import { loadDatabaseConfig } from "./config.js";
import { runMigrationPreflight } from "./migration-preflight.js";

const result = await runMigrationPreflight(loadDatabaseConfig());
console.log(JSON.stringify(result, null, 2));
