import { defineConfig, Plugin } from "vite";
import fs from "fs";
import path from "path";

function configSavePlugin(): Plugin {
  const tracesDir = path.resolve(__dirname, "../traces");
  return {
    name: "config-save",
    configureServer(server) {
      const configPath = path.join(tracesDir, "config.json");

      server.middlewares.use("/save-config", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          fs.writeFileSync(configPath, body, "utf-8");
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
        try { fs.unlinkSync(configPath); } catch {}
        res.statusCode = 200;
        res.end();
      });

      server.middlewares.use("/config.json", (_req, res) => {
        try {
          const data = fs.readFileSync(configPath, "utf-8");
          res.setHeader("Content-Type", "application/json");
          res.end(data);
        } catch {
          res.statusCode = 404;
          res.end();
        }
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
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
      },
    },
  },
  plugins: [configSavePlugin()],
});
