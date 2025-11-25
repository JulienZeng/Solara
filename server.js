const express = require("express");
const path = require("path");
const fs = require("fs");
const { pipeline } = require("stream");
const { Readable } = require("stream");

const app = express();
const PORT = process.env.PORT || 8787;

// 尝试加载本地 middleware（你仓库里有 functions/_middleware.local.js）
let localAuth = null;
const localAuthPath = path.join(__dirname, "functions", "_middleware.local.js");
if (fs.existsSync(localAuthPath)) {
  localAuth = require(localAuthPath);
  if (
    typeof localAuth !== "function" &&
    localAuth &&
    typeof localAuth.default === "function"
  ) {
    localAuth = localAuth.default;
  }
}

// 如果有本地认证中间件，则先使用（与 CF middleware 行为一致）
if (localAuth) {
  app.use((req, res, next) =>
    localAuth(
      { request: req, env: { PASSWORD: process.env.PASSWORD } },
      { next }
    ).then
      ? localAuth(
          { request: req, env: { PASSWORD: process.env.PASSWORD } },
          { next }
        ).catch(next)
      : next()
  );
}

// 静态资源
app.use(express.static(path.join(__dirname)));

// Helper: 将 Fetch Response body 转成 Node 的 readable 并 pipe 到 express res
async function pipeFetchBodyToExpress(fetchResponse, res) {
  // headers already set by caller
  const body = fetchResponse.body;
  if (!body) {
    res.end();
    return;
  }

  // If body is a WHATWG ReadableStream (Node 18+ fetch), convert to Node stream
  if (typeof body.getReader === "function") {
    const nodeStream = Readable.fromWeb(body);
    pipeline(nodeStream, res, (err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error("stream pipeline error:", err);
      }
    });
  } else if (typeof body.pipe === "function") {
    // Already a Node stream
    pipeline(body, res, (err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error("stream pipeline error:", err);
      }
    });
  } else {
    // Fallback: read as arrayBuffer/text
    try {
      const text = await fetchResponse.text();
      res.send(text);
    } catch (e) {
      res.end();
    }
  }
}

/*
  functions 的本地挂载策略：
  - 如果存在 functions/<name>.js（已编译），则自动 require 并尝试调用其导出的 onRequest(context)
  - 否则提示未实现，建议使用 wrangler pages dev 或预编译 functions。
*/
function mountFunctionRoute(urlPath, functionRelPath) {
  const absJs = path.join(__dirname, "functions", functionRelPath + ".js");
  const absTs = path.join(__dirname, "functions", functionRelPath + ".ts");
  if (fs.existsSync(absJs)) {
    const mod = require(absJs);
    const handler = mod.onRequest || mod.default || mod;
    if (typeof handler === "function") {
      app.all(urlPath, async (req, res) => {
        try {
          // 构造 minimal context similar to Cloudflare
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
          const text = await cfRes.text();
          res.status(cfRes.status || 200);
          if (cfRes.headers && typeof cfRes.headers.forEach === "function") {
            cfRes.headers.forEach((v, k) => res.setHeader(k, v));
          }
          res.send(text);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(e);
          res.status(500).send("function error");
        }
      });
      return;
    }
  }

  // TS 存在但未编译 - 提示
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

  // 不存在
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
  // eslint-disable-next-line no-console
  console.log(`Solara local server running: http://localhost:${PORT}`);
  if (!process.env.PASSWORD) {
    // eslint-disable-next-line no-console
    console.log(
      "注意：未设置 PASSWORD 环境变量，认证将被跳过（与 CF middleware 行为一致）"
    );
  }
});
