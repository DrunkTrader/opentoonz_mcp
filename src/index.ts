import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();

serveStdio(() => createServer(config), {
  onerror: (error) => {
    process.stderr.write(`[opentoonz-mcp] ${error.stack ?? error.message}\n`);
  },
});
