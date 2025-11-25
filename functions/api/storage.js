const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const FAVORITE_KEYS = new Set([
  "favoriteSongs",
  "currentFavoriteIndex",
  "favoritePlayMode",
  "favoritePlaybackTime",
]);

const TABLES = {
  playback: "playback_store",
  favorites: "favorites_store",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function hasD1(env) {
  return Boolean(env.DB && typeof env.DB.prepare === "function");
}

function getTableForKey(key) {
  if (FAVORITE_KEYS.has(key)) {
    return TABLES.favorites;
  }
  return TABLES.playback;
}

async function ensureTables(env) {
  if (!hasD1(env)) {
    return;
  }
  const createStatements = [
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS playback_store (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS favorites_store (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    ),
  ];
  await env.DB.batch(createStatements);
}

async function handleGet(request, env) {
  const url = new URL(request.url);
  if (!hasD1(env)) {
    return jsonResponse({ d1Available: false, data: {} });
  }

  const statusOnly = url.searchParams.get("status");
  if (statusOnly) {
    return jsonResponse({ d1Available: true });
  }

  const keysParam = url.searchParams.get("keys") || "";
  const keys = keysParam
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  await ensureTables(env);

  const data = {};
  let rows = [];
  if (keys.length > 0) {
    const groupedKeys = keys.reduce(
      (acc, key) => {
        const table = getTableForKey(key);
        acc[table].push(key);
        return acc;
      },
      { [TABLES.playback]: [], [TABLES.favorites]: [] }
    );

    const results = [];
    for (const [table, tableKeys] of Object.entries(groupedKeys)) {
      if (tableKeys.length === 0) continue;
      const placeholders = tableKeys.map(() => "?").join(",");
      const statement = env.DB.prepare(
        `SELECT key, value FROM ${table} WHERE key IN (${placeholders})`
      ).bind(...tableKeys);
      const result = await statement.all();
      const rowsResult = result.results || [];
      results.push(...rowsResult);
    }
    rows = results;
    keys.forEach((key) => {
      data[key] = null;
    });
  } else {
    const playbackResult = await env.DB.prepare(
      "SELECT key, value FROM playback_store"
    ).all();
    const favoriteResult = await env.DB.prepare(
      "SELECT key, value FROM favorites_store"
    ).all();
    rows = [
      ...(playbackResult.results || []),
      ...(favoriteResult.results || []),
    ];
  }

  rows.forEach((row) => {
    if (!row || typeof row.key !== "string") return;
    data[row.key] = row.value;
  });

  return jsonResponse({ d1Available: true, data });
}

async function handlePost(request, env) {
  if (!hasD1(env)) {
    return jsonResponse({ d1Available: false, data: {} });
  }

  const body = await request.json().catch(() => ({}));
  const payload = body.data && typeof body.data === "object" ? body.data : null;

  if (!payload || Array.isArray(payload)) {
    return jsonResponse({ error: "Invalid payload" }, 400);
  }

  const entries = Object.entries(payload).filter(([key]) => Boolean(key));
  if (entries.length === 0) {
    return jsonResponse({ d1Available: true, updated: 0 });
  }

  await ensureTables(env);

  const groupedStatements = {
    [TABLES.playback]: [],
    [TABLES.favorites]: [],
  };

  entries.forEach(([key, value]) => {
    const storedValue = value == null ? "" : String(value);
    const table = getTableForKey(key);
    groupedStatements[table].push(
      env.DB.prepare(
        `INSERT INTO ${table} (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(key, storedValue)
    );
  });

  const batches = [];
  Object.values(groupedStatements).forEach((statements) => {
    if (statements.length > 0) {
      batches.push(env.DB.batch(statements));
    }
  });

  await Promise.all(batches);
  return jsonResponse({ d1Available: true, updated: entries.length });
}

async function handleDelete(request, env) {
  if (!hasD1(env)) {
    return jsonResponse({ d1Available: false });
  }

  const body = await request.json().catch(() => ({}));
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key) => typeof key === "string" && Boolean(key))
    : [];

  if (keys.length === 0) {
    return jsonResponse({ d1Available: true, deleted: 0 });
  }

  await ensureTables(env);

  const groupedStatements = {
    [TABLES.playback]: [],
    [TABLES.favorites]: [],
  };

  keys.forEach((key) => {
    const table = getTableForKey(key);
    groupedStatements[table].push(
      env.DB.prepare(`DELETE FROM ${table} WHERE key = ?1`).bind(key)
    );
  });

  const batches = [];
  Object.values(groupedStatements).forEach((statements) => {
    if (statements.length > 0) {
      batches.push(env.DB.batch(statements));
    }
  });

  await Promise.all(batches);
  return jsonResponse({ d1Available: true, deleted: keys.length });
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = (request.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }

  if (method === "GET") {
    return handleGet(request, env);
  }

  if (method === "POST") {
    return handlePost(request, env);
  }

  if (method === "DELETE") {
    return handleDelete(request, env);
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}