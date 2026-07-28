import { defineConfig, Plugin } from "vite";
import fs from "fs";
import path from "path";

function configSavePlugin(): Plugin {
  const tracesDir = path.resolve(__dirname, "../traces");
  return {
    name: "config-save",
    configureServer(server) {
      server.middlewares.use("/save-config", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url || "", "http://localhost");
        const trace = url.searchParams.get("trace");
        if (!trace || trace.includes("..")) {
          res.statusCode = 400;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          const filePath = path.join(tracesDir, trace + ".config.json");
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, body, "utf-8");
          res.statusCode = 200;
          res.end();
        });
      });

      server.middlewares.use("/delete-config", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url || "", "http://localhost");
        const trace = url.searchParams.get("trace");
        if (!trace || trace.includes("..")) {
          res.statusCode = 400;
          res.end();
          return;
        }
        const filePath = path.join(tracesDir, trace + ".config.json");
        try { fs.unlinkSync(filePath); } catch {}
        res.statusCode = 200;
        res.end();
      });

      server.middlewares.use("/save-last-trace", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          fs.writeFileSync(path.join(tracesDir, ".last-trace"), body.trim(), "utf-8");
          res.statusCode = 200;
          res.end();
        });
      });

      server.middlewares.use("/get-last-trace", (_req, res) => {
        const filePath = path.join(tracesDir, ".last-trace");
        try {
          const val = fs.readFileSync(filePath, "utf-8").trim();
          res.setHeader("Content-Type", "text/plain");
          res.end(val);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 8765,
  },
  build: {
    outDir: "dist",
  },
  plugins: [configSavePlugin()],
});
