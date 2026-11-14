
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
  ssl:
    process.env.DATABASE_URL.includes("localhost") ||
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

// Text ko matching ke liye normalize karna
function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("hi")
    .replace(/[\s\-_.,।/\\]+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// Kuch common Hindi-English village spellings
function villageAliases(village) {
  const n = normalize(village);

  if (["पंडुवा", "पंडुआ", "पंडुवा"].includes(n)) {
    return ["पंडुवा", "पंडुआ", "Panduwa", "Pandua"];
  }

  return [village];
}

// Result ke title, description aur URL mein location match
function matchesLocation(item, location) {
  const text = normalize([
    item.name,
    item.text,
    item.snippet,
    item.url
  ].join(" "));

  if (location.village) {
    const aliases = villageAliases(location.village);
    const villageMatch = aliases.some(alias => {
      const name = normalize(alias);
      return name.length >= 2 && text.includes(name);
    });

    if (!villageMatch) return false;
  }

  if (location.district) {
    const district = normalize(location.district);
    if (district.length >= 3 && !text.includes(district)) {
      return false;
    }
  }

  if (location.tehsil) {
    const tehsil = normalize(location.tehsil);
    if (tehsil.length >= 3 && !text.includes(tehsil)) {
      return false;
    }
  }

  return true;
}

function makeSearchQuery(filters) {
  const parts = [
    "Indian government schemes official information"
  ];

  if (filters.q) parts.push(filters.q);
  if (filters.category && filters.category !== "all") {
    parts.push(filters.category);
  }

  if (filters.state) parts.push(`state "${filters.state}"`);
  if (filters.district) parts.push(`district "${filters.district}"`);
  if (filters.tehsil) parts.push(`tehsil "${filters.tehsil}"`);

  if (filters.village) {
    const aliases = villageAliases(filters.village);
    parts.push(`village "${aliases.join('" OR "')}"`);
    parts.push("exact village location");
  }

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

// Location-based live search
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
        error: "Search ke liye location ya keyword bharein"
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
          count: 20,
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
      console.error("LangSearch error:", response.status, detail);

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
      return res.status(502).json({
        error: payload.message || "Search API failed"
      });
    }

    const pages = payload.data?.webPages?.value || [];

    const validResults = pages.filter(item =>
      item.url && validUrl(item.url)
    );

    // Strict village/district/tehsil matching
    const matchedResults = validResults.filter(item =>
      matchesLocation(item, filters)
    );

    const results = matchedResults.map(item => ({
      title: item.name || "सरकारी योजना",
      url: item.url,
      description:
        item.text || item.snippet || "अधिक जानकारी के लिए स्रोत खोलें।",
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
      totalFound: validResults.length,
      matchedCount: results.length,
      count: results.length,
      strictLocationMatch: true,
      message: results.length
        ? "Location matching results"
        : "Is location ke naam se matching information nahi mili.",
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
    res.status(500).json({
      error: "Saved schemes load nahi hui"
    });
  }
});

// Admin save
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
      return res.status(400).json({
        error: "Scheme title zaroori hai"
      });
    }

    if (sourceUrl && !validUrl(sourceUrl)) {
      return res.status(400).json({
        error: "Source URL sahi nahi hai"
      });
    }

    const publishedDate = req.body.published_date || null;

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
        publishedDate,
        clean(req.body.district, 100),
        clean(req.body.tehsil, 100),
        clean(req.body.village, 100)
      ]
    );

    res.json({
      ok: true,
      saved: result.rows[0]
    });

  } catch (error) {
    console.error("Save error:", error);

    res.status(500).json({
      error: "Scheme save nahi hui"
    });
  }
});

// Admin delete
app.delete("/api/admin/schemes/:id", async (req, res) => {
  try {
    const adminKey = process.env.ADMIN_KEY;

    if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
      return res.status(401).json({
        error: "Invalid Admin Key"
      });
    }

    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        error: "Invalid ID"
      });
    }

    const result = await pool.query(
      "DELETE FROM saved_schemes WHERE id=$1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Record nahi mila"
      });
    }

    res.json({
      ok: true,
      deleted: id
    });

  } catch (error) {
    res.status(500).json({
      error: "Delete nahi hua"
    });
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
