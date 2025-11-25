const { URL } = require("url");

const PUBLIC_PATH_PATTERNS = [/^\/login(?:\/|$)/, /^\/api\/login(?:\/|$)/];
const PUBLIC_FILE_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".png",
  ".svg",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
  ".map",
  ".json",
  ".woff",
  ".woff2",
]);

function hasPublicExtension(pathname) {
  const lastDotIndex = pathname.lastIndexOf(".");
  if (lastDotIndex === -1) return false;
  const extension = pathname.slice(lastDotIndex).toLowerCase();
  return PUBLIC_FILE_EXTENSIONS.has(extension);
}

function isPublicPath(pathname) {
  return (
    PUBLIC_PATH_PATTERNS.some((pattern) => pattern.test(pathname)) ||
    hasPublicExtension(pathname)
  );
}

/**
 * Express middleware factory
 * options.password: 明文密码（优先），否则从 process.env.PASSWORD 读取
 */
function localAuthMiddleware(options = {}) {
  const password =
    typeof options.password === "string"
      ? options.password
      : process.env.PASSWORD;
  const expectedAuth =
    typeof password === "string"
      ? Buffer.from(password).toString("base64")
      : null;

  return function (req, res, next) {
    if (typeof password !== "string") {
      // 未设置密码时，本地不做认证（与 CF 中间件保持一致）
      return next();
    }

    const pathname = req.path || new URL(req.url, "http://localhost").pathname;
    if (isPublicPath(pathname)) return next();

    const cookieHeader = req.headers.cookie || "";
    const cookies = {};
    cookieHeader.split(";").forEach((part) => {
      const idx = part.indexOf("=");
      if (idx === -1) return;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) cookies[k] = v;
    });

    if (cookies.auth && expectedAuth && cookies.auth === expectedAuth) {
      return next();
    }

    // 未认证 -> 重定向到 /login（相同行为）
    return res.redirect(302, "/login");
  };
}

module.exports = localAuthMiddleware;
