
const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const LANGSEARCH_API_KEY = process.env.LANGSEARCH_API_KEY;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const isLocalDatabase =
  DATABASE_URL.includes("localhost") ||
  DATABASE_URL.includes("127.0.0.1");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000
});

pool.on("error", (err) => {
  console.error("Database pool error:", err.message);
});

function clean(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[़्]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliasesFor(value, type) {
  const n = normalize(value);
  const aliases = [n];

  if (type === "village" && /panduwa|pandua|पंडुवा|पंडुआ/.test(n)) {
    aliases.push("panduwa", "pandua", "पंडुवा", "पंडुआ");
  }

  if (type === "district" && /prayagraj|प्रयागराज|allahabad|इलाहाबाद/.test(n)) {
    aliases.push("prayagraj", "allahabad", "प्रयागराज", "इलाहाबाद");
  }

  if (type === "state" && /uttar pradesh|uttarpradesh|उत्तर प्रदेश|up/.test(n)) {
    aliases.push("uttar pradesh", "uttarpradesh", "उत्तर प्रदेश");
  }

  return [...new Set(aliases.filter(Boolean))];
}

function containsPhrase(text, phrase) {
  const haystack = ` ${normalize(text)} `;
  const needle = ` ${normalize(phrase)} `;
  return needle.trim().length > 0 && haystack.includes(needle);
}

function hasLocation(text, value, type) {
  const aliases = aliasesFor(value, type);
  return aliases.some((alias) => containsPhrase(text, alias));
}

function getResultText(item) {
  return [
    item.name,
    item.title,
    item.text,
    item.snippet,
    item.description,
    item.url
  ].filter(Boolean).join(" ");
}

function validHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function freshnessValue(range) {
  const values = {
    today: "oneDay",
    week: "oneWeek",
    month: "oneMonth",
    year: "oneYear",
    all: "noLimit"
  };
  return values[range] || "noLimit";
}

function makeSearchQuery(filters, exact) {
  const parts = [];

  if (exact) {
    parts.push(`"${filters.village}"`);
    parts.push(`"${filters.tehsil}"`);
    parts.push(`"${filters.district}"`);
    parts.push(`"${filters.state}"`);
  } else {
    parts.push(`"${filters.district}"`);
    parts.push(`"${filters.state}"`);
    if (filters.tehsil) parts.push(`"${filters.tehsil}"`);
  }

  if (filters.keyword) parts.push(filters.keyword);
  if (filters.category) parts.push(filters.category);

  parts.push("government scheme official information India");
  parts.push("site:gov.in OR site:nic.in");

  return parts.join(" ");
}

function matchesExactLocation(item, filters) {
  const text = getResultText(item);

  return (
    hasLocation(text, filters.state, "state") &&
    hasLocation(text, filters.district, "district") &&
    hasLocation(text, filters.tehsil, "tehsil") &&
    hasLocation(text, filters.village, "village")
  );
}

function matchesRegionalLocation(item, filters) {
  const text = getResultText(item);

  return (
    hasLocation(text, filters.state, "state") &&
    hasLocation(text, filters.district, "district")
  );
}

function mapSearchResult(item, level) {
  return {
    title: clean(item.name || item.title || "योजना की जानकारी", 500),
    description: clean(item.text || item.snippet || item.description || "स्रोत वेबसाइट पर जानकारी देखें।", 3000),
    url: item.url,
    date: item.datePublished || item.date || null,
    level,
    villageConfirmed: level === "village"
  };
}

async function searchLangSearch(query, freshness) {
  if (!LANGSEARCH_API_KEY) {
    const error = new Error("LANGSEARCH_API_KEY सेट नहीं है।");
    error.status = 503;
    throw error;
  }

  const response = await fetch("https://api.langsearch.com/v1/web-search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LANGSEARCH_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      count: 50,
      freshness,
      contents: {
        text: {
          max_characters: 4000
        }
      }
    }),
    signal: AbortSignal.timeout(30000)
  });

  const raw = await response.text();
  let payload = {};

  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("LangSearch ने पढ़ने योग्य JSON जवाब नहीं दिया।");
  }

  if (!response.ok) {
    console.error("LangSearch error:", response.status, raw.slice(0, 1000));
    const error = new Error(
      payload.message || payload.error || `Online search failed (${response.status})`
    );
    error.status = 502;
    throw error;
  }

  const list =
    payload?.data?.webPages?.value ||
    payload?.data?.web_pages?.value ||
    payload?.webPages?.value ||
    [];

  return Array.isArray(list) ? list : [];
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_schemes (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      source_url TEXT NOT NULL,
      state TEXT,
      category TEXT,
      published_date TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("Database initialized");
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({
      ok: false,
      message: "ADMIN_KEY Render Environment Variables में सेट नहीं है।"
    });
  }

  const supplied = req.headers["x-admin-key"];

  if (!supplied || supplied !== ADMIN_KEY) {
    return res.status(401).json({
      ok: false,
      message: "Admin key गलत है।"
    });
  }

  next();
}

app.get("/api/health", async (req, res) => {
  try {
    const db = await pool.query("SELECT 1");
    const count = await pool.query("SELECT COUNT(*)::int AS total FROM saved_schemes");

    res.json({
      ok: true,
      database: db.rowCount ? "connected" : "unknown",
      savedSchemes: count.rows[0].total,
      onlineSearchConfigured: Boolean(LANGSEARCH_API_KEY)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      database: "error",
      message: err.message
    });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const filters = {
      state: clean(req.body.state, 100),
      district: clean(req.body.district, 100),
      tehsil: clean(req.body.tehsil, 100),
      village: clean(req.body.village, 100),
      keyword: clean(req.body.keyword, 200),
      category: clean(req.body.category, 100),
      dateRange: clean(req.body.dateRange, 20) || "all"
    };

    const missing = ["state", "district", "tehsil", "village"]
      .filter((key) => !filters[key]);

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        message: "राज्य, जिला, तहसील और गाँव चारों भरना जरूरी है।"
      });
    }

    if (!filters.keyword && !filters.category) {
      return res.status(400).json({
        ok: false,
        message: "योजना का नाम या श्रेणी भरें।"
      });
    }

    const freshness = freshnessValue(filters.dateRange);
    const exactQuery = makeSearchQuery(filters, true);
    const regionalQuery = makeSearchQuery(filters, false);

    console.log("Exact search:", exactQuery);

    const exactRaw = await searchLangSearch(exactQuery, freshness);
    const exactResults = exactRaw
      .filter((item) => item && validHttpUrl(item.url))
      .filter((item) => matchesExactLocation(item, filters))
      .map((item) => mapSearchResult(item, "village"));

    let regionalResults = [];

    if (exactResults.length === 0) {
      console.log("No exact village match. Trying district-level search.");

      const regionalRaw = await searchLangSearch(regionalQuery, freshness);

      regionalResults = regionalRaw
        .filter((item) => item && validHttpUrl(item.url))
        .filter((item) => matchesRegionalLocation(item, filters))
        .filter((item) => !matchesExactLocation(item, filters))
        .map((item) => mapSearchResult(item, "regional"));
    }

    console.log({
      receivedExact: exactRaw.length,
      matchedExact: exactResults.length,
      matchedRegional: regionalResults.length
    });

    res.json({
      ok: true,
      location: filters,
      exactResults,
      regionalResults,
      message: exactResults.length
        ? "चारों स्थानों का मिलान करने वाले परिणाम मिले।"
        : regionalResults.length
          ? "गाँव का पक्का मिलान नहीं मिला। नीचे जिला/राज्य के परिणाम अलग दिखाए गए हैं।"
          : "इस स्थान के लिए मिलान वाला परिणाम नहीं मिला।"
    });
  } catch (err) {
    console.error("Search error:", err);
    res.status(err.status || 500).json({
      ok: false,
      message: err.message || "खोज करते समय समस्या हुई।"
    });
  }
});

app.get("/api/saved", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM saved_schemes ORDER BY created_at DESC LIMIT 100"
    );
    res.json({ ok: true, results: result.rows });
  } catch (err) {
    console.error("Saved list error:", err);
    res.status(500).json({ ok: false, message: "सेव किए गए रिकॉर्ड नहीं मिल सके।" });
  }
});

app.post("/api/admin/schemes", requireAdmin, async (req, res) => {
  try {
    const title = clean(req.body.title, 500);
    const description = clean(req.body.description, 5000);
    const sourceUrl = clean(req.body.source_url, 2000);
    const state = clean(req.body.state, 100);
    const category = clean(req.body.category, 100);
    const publishedDate = clean(req.body.published_date, 50);

    if (!title || !sourceUrl || !validHttpUrl(sourceUrl)) {
      return res.status(400).json({
        ok: false,
        message: "योजना का नाम और सही http/https स्रोत लिंक जरूरी है।"
      });
    }

    const result = await pool.query(
      `INSERT INTO saved_schemes
       (title, description, source_url, state, category, published_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, description, sourceUrl, state, category, publishedDate]
    );

    res.json({ ok: true, record: result.rows[0] });
  } catch (err) {
    console.error("Save scheme error:", err);
    res.status(500).json({ ok: false, message: "जानकारी सेव नहीं हो सकी।" });
  }
});

app.delete("/api/admin/schemes/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ ok: false, message: "गलत रिकॉर्ड ID।" });
    }

    const result = await pool.query(
      "DELETE FROM saved_schemes WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, message: "रिकॉर्ड नहीं मिला।" });
    }

    res.json({ ok: true, message: "रिकॉर्ड डिलीट हो गया।" });
  } catch (err) {
    console.error("Delete scheme error:", err);
    res.status(500).json({ ok: false, message: "रिकॉर्ड डिलीट नहीं हुआ।" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bharat Yojana Finder running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
