
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
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const localDB =
  DATABASE_URL.includes("localhost") ||
  DATABASE_URL.includes("127.0.0.1");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: localDB ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000
});

pool.on("error", err => console.error("DB error:", err.message));

function clean(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliases(value, type) {
  const n = normalize(value);
  const result = [n];

  if (type === "village" && /panduwa|pandua|पंडुवा|पंडुआ/.test(n)) {
    result.push("panduwa", "pandua", "पंडुवा", "पंडुआ");
  }

  if (type === "district" &&
      /prayagraj|allahabad|प्रयागराज|इलाहाबाद/.test(n)) {
    result.push("prayagraj", "allahabad", "प्रयागराज", "इलाहाबाद");
  }

  if (type === "state" &&
      /uttar pradesh|uttarpradesh|उत्तर प्रदेश|^up$/.test(n)) {
    result.push("uttar pradesh", "uttarpradesh", "उत्तर प्रदेश");
  }

  if (type === "tehsil" && /bara|बारा/.test(n)) {
    result.push("bara", "बारा");
  }

  return [...new Set(result.filter(Boolean))];
}

function containsLocation(text, value, type) {
  const haystack = ` ${normalize(text)} `;

  return aliases(value, type).some(alias => {
    return haystack.includes(` ${normalize(alias)} `);
  });
}

function resultText(item) {
  return [
    item.name,
    item.title,
    item.text,
    item.snippet,
    item.description,
    item.url
  ].filter(Boolean).join(" ");
}

function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function exactVillageMatch(item, f) {
  const text = resultText(item);

  return (
    containsLocation(text, f.state, "state") &&
    containsLocation(text, f.district, "district") &&
    containsLocation(text, f.tehsil, "tehsil") &&
    containsLocation(text, f.village, "village")
  );
}

function getFreshness(value) {
  const map = {
    today: "oneDay",
    week: "oneWeek",
    month: "oneMonth",
    year: "oneYear",
    all: "noLimit"
  };

  return map[value] || "noLimit";
}

function makeExactQuery(f) {
  return [
    f.keyword,
    f.category,
    f.village,
    f.tehsil,
    f.district,
    f.state,
    "India government scheme official information"
  ].filter(Boolean).join(" ");
}

function makeRegionalQuery(f, includeTehsil = true) {
  return [
    f.keyword,
    f.category,
    includeTehsil ? f.tehsil : "",
    f.district,
    f.state,
    "India government scheme official information"
  ].filter(Boolean).join(" ");
}

async function langSearch(query, freshness) {
  if (!LANGSEARCH_API_KEY) {
    throw new Error("LANGSEARCH_API_KEY Render में सेट नहीं है।");
  }

  const response = await fetch(
    "https://api.langsearch.com/v1/web-search",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LANGSEARCH_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        count: 30,
        freshness,
        contents: {
          text: {
            max_characters: 2500
          }
        }
      }),
      signal: AbortSignal.timeout(30000)
    }
  );

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("LangSearch का जवाब सही JSON में नहीं आया।");
  }

  if (!response.ok) {
    console.error("LangSearch HTTP error:", response.status, raw.slice(0, 500));
    throw new Error(
      data.message || data.error || `Search HTTP error ${response.status}`
    );
  }

  if (data.code && String(data.code) !== "200") {
    console.error("LangSearch API error:", data);
    throw new Error(data.message || "LangSearch API ने खोज स्वीकार नहीं की।");
  }

  const results = data?.data?.webPages?.value || [];

  return Array.isArray(results) ? results : [];
}

function prepareResult(item, level, filters) {
  const text = resultText(item);

  return {
    title: clean(item.name || item.title || "योजना की जानकारी", 500),
    description: clean(
      item.text || item.snippet || item.description || "स्रोत वेबसाइट पर जानकारी देखें।",
      3000
    ),
    url: item.url,
    date: item.datePublished || item.date || null,
    level,
    villageConfirmed: level === "village",
    locationMatch: {
      state: containsLocation(text, filters.state, "state"),
      district: containsLocation(text, filters.district, "district"),
      tehsil: containsLocation(text, filters.tehsil, "tehsil"),
      village: containsLocation(text, filters.village, "village")
    }
  };
}

function uniqueResults(results) {
  const seen = new Set();

  return results.filter(item => {
    const key = String(item.url || "").toLowerCase();

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
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
      message: "ADMIN_KEY सेट नहीं है।"
    });
  }

  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({
      ok: false,
      message: "Admin Key गलत है।"
    });
  }

  next();
}

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    const count = await pool.query(
      "SELECT COUNT(*)::int AS total FROM saved_schemes"
    );

    res.json({
      ok: true,
      database: "connected",
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

// Main online search
app.post("/api/search", async (req, res) => {
  try {
    const f = {
      state: clean(req.body.state, 100),
      district: clean(req.body.district, 100),
      tehsil: clean(req.body.tehsil, 100),
      village: clean(req.body.village, 100),
      keyword: clean(req.body.keyword, 200),
      category: clean(req.body.category, 100),
      dateRange: clean(req.body.dateRange, 20) || "all"
    };

    const required = ["state", "district", "tehsil", "village"];

    if (required.some(key => !f[key])) {
      return res.status(400).json({
        ok: false,
        message: "राज्य, जिला, तहसील और गाँव चारों भरें।"
      });
    }

    if (!f.keyword && !f.category) {
      return res.status(400).json({
        ok: false,
        message: "योजना का नाम या श्रेणी भरें।"
      });
    }

    const freshness = getFreshness(f.dateRange);

    const exactQuery = makeExactQuery(f);
    const regionalQuery = makeRegionalQuery(f, true);

    console.log("Village search:", exactQuery);

    // First search: exact village
    const exactRaw = await langSearch(exactQuery, freshness);

    const exactResults = uniqueResults(
      exactRaw
        .filter(item => item && validUrl(item.url))
        .filter(item => exactVillageMatch(item, f))
        .map(item => prepareResult(item, "village", f))
    );

    let regionalResults = [];
    let broadResults = [];

    // Second search: tehsil and district
    if (exactResults.length === 0) {
      console.log("Trying tehsil and district search");

      const regionalRaw = await langSearch(regionalQuery, freshness);

      regionalResults = uniqueResults(
        regionalRaw
          .filter(item => item && validUrl(item.url))
          .map(item => prepareResult(item, "regional", f))
      );
    }

    // Third search: district and state, only if still no results
    if (exactResults.length === 0 && regionalResults.length === 0) {
      console.log("Trying district and state search");

      const broadQuery = makeRegionalQuery(f, false);
      const broadRaw = await langSearch(broadQuery, freshness);

      broadResults = uniqueResults(
        broadRaw
          .filter(item => item && validUrl(item.url))
          .map(item => prepareResult(item, "general", f))
      );
    }

    const regional = regionalResults.length
      ? regionalResults
      : broadResults;

    console.log("Search counts:", {
      exactReceived: exactRaw.length,
      exactMatched: exactResults.length,
      regionalMatched: regionalResults.length,
      generalMatched: broadResults.length
    });

    res.json({
      ok: true,
      location: f,
      exactResults,
      regionalResults: regional,
      message: exactResults.length
        ? "गाँव के चारों स्थानों का मिलान करने वाले परिणाम मिले।"
        : regionalResults.length
          ? "गाँव की पुष्टि नहीं हुई। तहसील और जिले की खोज के परिणाम नीचे हैं।"
          : broadResults.length
            ? "गाँव की पुष्टि नहीं हुई। जिले और राज्य की सामान्य योजनाएँ नीचे हैं।"
            : "इन खोज शब्दों पर LangSearch से कोई परिणाम नहीं मिला।"
    });

  } catch (err) {
    console.error("Search error:", err);

    res.status(500).json({
      ok: false,
      message: err.message || "खोज करते समय समस्या हुई।"
    });
  }
});

// Saved schemes
app.get("/api/saved", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM saved_schemes ORDER BY created_at DESC LIMIT 100"
    );

    res.json({ ok: true, results: result.rows });
  } catch (err) {
    console.error("Saved error:", err);
    res.status(500).json({
      ok: false,
      message: "सेव किए गए रिकॉर्ड नहीं मिल सके।"
    });
  }
});

// Save scheme
app.post("/api/admin/schemes", requireAdmin, async (req, res) => {
  try {
    const title = clean(req.body.title, 500);
    const description = clean(req.body.description, 5000);
    const sourceUrl = clean(req.body.source_url, 2000);
    const state = clean(req.body.state, 100);
    const category = clean(req.body.category, 100);
    const publishedDate = clean(req.body.published_date, 50);

    if (!title || !validUrl(sourceUrl)) {
      return res.status(400).json({
        ok: false,
        message: "योजना का नाम और सही स्रोत लिंक जरूरी है।"
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
    console.error("Save error:", err);
    res.status(500).json({
      ok: false,
      message: "जानकारी सेव नहीं हो सकी।"
    });
  }
});

// Delete scheme
app.delete("/api/admin/schemes/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        ok: false,
        message: "गलत रिकॉर्ड ID।"
      });
    }

    const result = await pool.query(
      "DELETE FROM saved_schemes WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        ok: false,
        message: "रिकॉर्ड नहीं मिला।"
      });
    }

    res.json({
      ok: true,
      message: "रिकॉर्ड डिलीट हो गया।"
    });

  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({
      ok: false,
      message: "रिकॉर्ड डिलीट नहीं हुआ।"
    });
  }
});

// Frontend
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Bharat Yojana Finder running on port", PORT);
    });
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
