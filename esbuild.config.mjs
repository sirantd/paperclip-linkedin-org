import { build } from "esbuild";

const common = { bundle: true, format: "esm", platform: "node", target: "node18", logLevel: "info" };

await build({ ...common, entryPoints: ["src/manifest.ts"], outfile: "dist/manifest.js" });
await build({ ...common, entryPoints: ["src/worker.ts"], outfile: "dist/worker.js" });
