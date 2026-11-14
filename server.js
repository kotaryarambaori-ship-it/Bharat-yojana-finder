
const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ||
       process.env.DATABASE_URL.includes("127.0.0.1")
    ? false
    : { rejectUnauthorized: false }
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_schemes (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      source_url TEXT,
      state TEXT,
      category TEXT,
      published_date DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE saved_schemes
    ADD COLUMN IF NOT EXISTS district TEXT,
    ADD COLUMN IF NOT EXISTS tehsil TEXT,
    ADD COLUMN IF NOT EXISTS village TEXT
  `);

  console.log("Database initialized");
}

function clean(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function makeSearchQuery({ q, state, district, tehsil, village, category }) {
  const parts = [];

  if (q) parts.push(q);
  else parts.push("government schemes benefits application");

  if (village) parts.push("village " + village);
  if (tehsil) parts.push("tehsil " + tehsil);
  if (district) parts.push("district " + district);
  if (state) parts.push("state " + state);

  if (category && category !== "all") {
    parts.push(category);
  }

  parts.push("India government scheme official information");

  return parts.join(" ");
}

function getFreshness(range) {
  const map = {
    today: "oneDay",
    week: "oneWeek",
    month: "oneMonth",
    year: "oneYear",
    all: "noLimit"
  };
  return map[range] || "noLimit";
}

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS total FROM saved_schemes"
    );

    res.json({
      ok: true,
      database: "connected",
      savedSchemes: result.rows[0].total,
      onlineSearchConfigured: Boolean(process.env.LANGSEARCH_API_KEY)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: "error",
      message: error.message
    });
  }
});

// Live internet search
app.get("/api/search", async (req, res) => {
  try {
    if (!process.env.LANGSEARCH_API_KEY) {
      return res.status(503).json({
        error: "LANGSEARCH_API_KEY is missing"
      });
    }

    const filters = {
      q: clean(req.query.q, 250),
      state: clean(req.query.state, 100),
      district: clean(req.query.district, 100),
      tehsil: clean(req.query.tehsil, 100),
      village: clean(req.query.village, 100),
      category: clean(req.query.category, 100),
      dateRange: clean(req.query.dateRange, 20)
    };

    if (
      !filters.q &&
      !filters.state &&
      !filters.district &&
      !filters.tehsil &&
      !filters.village
    ) {
      return res.status(400).json({
        error: "Search ke liye koi keyword ya location bharein"
      });
    }

    const searchQuery = makeSearchQuery(filters);

    const response = await fetch(
      "https://api.langsearch.com/v1/web-search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LANGSEARCH_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: searchQuery,
          count: 10,
          freshness: getFreshness(filters.dateRange),
          contents: {
            text: { max_characters: 2500 }
          }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      console.error("LangSearch HTTP error:", response.status, detail);

      return res.status(502).json({
        error: "Online search service error",
        status: response.status
      });
    }

    const payload = await response.json();

    if (
      payload.code !== undefined &&
      String(payload.code) !== "200"
    ) {
      console.error("LangSearch API error:", payload.message);
      return res.status(502).json({
        error: payload.message || "Search API failed"
      });
    }

    const pages = payload.data?.webPages?.value || [];

    const results = pages
      .filter(item => item.url && validUrl(item.url))
      .map(item => ({
        title: item.name || "सरकारी योजना",
        url: item.url,
        description: item.text || item.snippet || "अधिक जानकारी के लिए स्रोत खोलें।",
        date: item.datePublished || "",
        source: (() => {
          try {
            return new URL(item.url).hostname;
          } catch {
            return "";
          }
        })()
      }));

    res.json({
      ok: true,
      query: searchQuery,
      location: {
        state: filters.state,
        district: filters.district,
        tehsil: filters.tehsil,
        village: filters.village
      },
      count: results.length,
      results
    });

  } catch (error) {
    console.error("Search error:", error);

    res.status(500).json({
      error: error.name === "TimeoutError"
        ? "Search timeout. Dobara koshish karein."
        : "Search nahi ho payi. Server logs check karein."
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
  } catch (error) {
    res.status(500).json({ error: "Saved schemes load nahi hui" });
  }
});

// Admin: save scheme
app.post("/api/admin/schemes", async (req, res) => {
  try {
    const adminKey = process.env.ADMIN_KEY;

    if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
      return res.status(401).json({ error: "Invalid Admin Key" });
    }

    const title = clean(req.body.title, 300);
    const description = clean(req.body.description, 5000);
    const sourceUrl = clean(req.body.source_url, 1000);

    if (!title) {
      return res.status(400).json({ error: "Scheme title zaroori hai" });
    }

    if (sourceUrl && !validUrl(sourceUrl)) {
      return res.status(400).json({ error: "Source URL sahi nahi hai" });
    }

    const result = await pool.query(
      `INSERT INTO saved_schemes
       (title, description, source_url, state, category,
        published_date, district, tehsil, village)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        title,
        description,
        sourceUrl,
        clean(req.body.state, 100),
        clean(req.body.category, 100),
        req.body.published_date || null,
        clean(req.body.district, 100),
        clean(req.body.tehsil, 100),
        clean(req.body.village, 100)
      ]
    );

    res.json({ ok: true, saved: result.rows[0] });

  } catch (error) {
    console.error("Save error:", error);
    res.status(500).json({ error: "Scheme save nahi hui" });
  }
});

// Admin: delete saved scheme
app.delete("/api/admin/schemes/:id", async (req, res) => {
  try {
    const adminKey = process.env.ADMIN_KEY;

    if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
      return res.status(401).json({ error: "Invalid Admin Key" });
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    const result = await pool.query(
      "DELETE FROM saved_schemes WHERE id=$1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Record nahi mila" });
    }

    res.json({ ok: true, deleted: id });

  } catch (error) {
    res.status(500).json({ error: "Delete nahi hua" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Bharat Yojana Finder running on port", PORT);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
