import express from "express";
import path from "path";
import fs from "fs";
import { pipeline, Readable } from "stream";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8787;

// 尝试加载本地 middleware（你仓库里有 functions/_middleware.local.js）
let localAuth = null;
const localAuthPath = path.join(__dirname, "functions", "_middleware.local.js");
if (fs.existsSync(localAuthPath)) {
  const mod = await import(pathToFileURL(localAuthPath).href);
  localAuth = mod.default ?? mod;
  if (
    localAuth &&
    typeof localAuth !== "function" &&
    typeof localAuth.default === "function"
  ) {
    localAuth = localAuth.default;
  }
}

// 如果有本地认证中间件，则先使用（兼容多种导出形式）
// - 如果导出是 express middleware (req,res,next) -> 直接 app.use(mw)
// - 如果导出是 factory -> 调用得到 mw 并 app.use(mw)
// - 其他情况，包装为 async handler，按 Cloudflare 风格调用
if (localAuth) {
  if (typeof localAuth === "function" && localAuth.length === 3) {
    // express middleware
    app.use(localAuth);
  } else {
    // try factory style
    try {
      const maybeMw =
        typeof localAuth === "function"
          ? localAuth({ env: { PASSWORD: process.env.PASSWORD } })
          : null;
      if (typeof maybeMw === "function") {
        app.use(maybeMw);
      } else {
        // fallback: wrap CF-style middleware function
        app.use((req, res, next) => {
          try {
            const result =
              typeof localAuth === "function"
                ? localAuth(
                    { request: req, env: { PASSWORD: process.env.PASSWORD } },
                    { next }
                  )
                : null;
            if (result && typeof result.then === "function") {
              result.catch(next);
            } else {
              next();
            }
          } catch (err) {
            next(err);
          }
        });
      }
    } catch (err) {
      // if factory threw, fallback to wrapper
      app.use((req, res, next) => {
        try {
          const result = localAuth(
            { request: req, env: { PASSWORD: process.env.PASSWORD } },
            { next }
          );
          if (result && typeof result.then === "function") {
            result.catch(next);
          } else {
            next();
          }
        } catch (e) {
          next(e);
        }
      });
    }
  }
}

// 静态资源
app.use(express.static(path.join(__dirname)));

// Helper: 将 Fetch Response body 转成 Node 的 readable 并 pipe 到 express res
async function pipeFetchBodyToExpress(fetchResponse, res) {
  const body = fetchResponse.body;
  if (!body) {
    res.end();
    return;
  }

  if (typeof body.getReader === "function") {
    const nodeStream = Readable.fromWeb(body);
    pipeline(nodeStream, res, (err) => {
      if (err) console.error("stream pipeline error:", err);
    });
  } else if (typeof body.pipe === "function") {
    pipeline(body, res, (err) => {
      if (err) console.error("stream pipeline error:", err);
    });
  } else {
    try {
      const text = await fetchResponse.text();
      res.send(text);
    } catch (e) {
      res.end();
    }
  }
}

/*
  functions 的本地挂载策略（按原结构动态导入 JS 实现）：
  - 如果存在 functions/<name>.js（已编译），动态 import 并调用其导出的 onRequest(context)
  - 否则若存在 .ts 提示未编译
  - 否则 404
*/
function mountFunctionRoute(urlPath, functionRelPath) {
  const absJs = path.join(__dirname, "functions", functionRelPath + ".js");
  const absTs = path.join(__dirname, "functions", functionRelPath + ".ts");

  if (fs.existsSync(absJs)) {
    app.all(urlPath, async (req, res) => {
      try {
        const mod = await import(pathToFileURL(absJs).href);
        const handler = mod.onRequest ?? mod.default ?? mod;
        if (typeof handler !== "function") {
          res.status(500).send("Invalid function module");
          return;
        }

        const ctx = {
          request: new Request(
            new URL(req.originalUrl, `http://localhost:${PORT}`).toString(),
            {
              method: req.method,
              headers: req.headers,
            }
          ),
          env: { PASSWORD: process.env.PASSWORD },
          next: () => new Response(null, { status: 404 }),
        };

        const cfRes = await handler(ctx);
        if (!(cfRes && typeof cfRes.text === "function")) {
          res.status(500).send("Invalid function response");
          return;
        }

        // 复制状态与头
        res.status(cfRes.status || 200);
        if (cfRes.headers && typeof cfRes.headers.forEach === "function") {
          cfRes.headers.forEach((v, k) => res.setHeader(k, v));
        }

        // 如果是流则用 pipe helper
        const contentType =
          cfRes.headers && typeof cfRes.headers.get === "function"
            ? cfRes.headers.get("content-type")
            : null;
        if (
          cfRes.body &&
          (typeof cfRes.body.getReader === "function" ||
            typeof cfRes.body.pipe === "function")
        ) {
          await pipeFetchBodyToExpress(cfRes, res);
        } else {
          const text = await cfRes.text();
          res.send(text);
        }
      } catch (e) {
        console.error(e);
        res.status(500).send("function error");
      }
    });
    return;
  }

  if (fs.existsSync(absTs)) {
    app.all(urlPath, (req, res) => {
      res
        .status(501)
        .send(
          `${functionRelPath}.ts exists but not compiled to JS. Run a build or use 'npx wrangler pages dev .' to test functions locally.`
        );
    });
    return;
  }

  app.all(urlPath, (req, res) => {
    res.status(404).send("Not found");
  });
}

// 尝试挂载已知的 functions 路由
mountFunctionRoute("/proxy", "proxy");
mountFunctionRoute("/palette", "palette");
mountFunctionRoute("/api/login", path.join("api", "login"));
mountFunctionRoute("/api/storage", path.join("api", "storage"));

// SPA fallback (按需启用)
// app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`Solara local server running: http://localhost:${PORT}`);
  if (!process.env.PASSWORD) {
    console.log(
      "注意：未设置 PASSWORD 环境变量，认证将被跳过（与 CF middleware 行为一致）"
    );
  }
});
