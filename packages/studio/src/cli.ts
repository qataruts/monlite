import { createStudioServer } from "./server.js";

const args = process.argv.slice(2);
let dbPath: string | undefined;
let port = 0; // 0 = random free port
let host = "127.0.0.1";
let readonly = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--port" || a === "-p") port = Number(args[++i]);
  else if (a === "--host") host = args[++i];
  else if (a === "--readonly") readonly = true;
  else if (a === "--help" || a === "-h") {
    printHelp();
    process.exit(0);
  } else if (!a.startsWith("-")) dbPath = a;
}

function printHelp(): void {
  console.log(`monlite studio — a local web inspector for monlite databases

Usage:
  monlite-studio <db-path> [options]

Options:
  -p, --port <n>   Port to listen on (default: a random free port)
      --host <h>   Host to bind (default: 127.0.0.1 — localhost only)
      --readonly   Open the database read-only (disables delete)
  -h, --help       Show this help`);
}

if (!dbPath) {
  printHelp();
  process.exit(1);
}

const server = createStudioServer(dbPath, { readonly });
server.listen(port, host, () => {
  const addr = server.address();
  const p = typeof addr === "object" && addr ? addr.port : port;
  console.log(`\n🌙 monlite studio → http://${host}:${p}`);
  console.log(`   database: ${dbPath}${readonly ? " (read-only)" : ""}`);
  console.log(`   press Ctrl+C to stop\n`);
});
