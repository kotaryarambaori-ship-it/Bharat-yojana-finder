
const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

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
  console.log("Database connected");
}

app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*) FROM saved_schemes"
    );

    res.json({
      ok: true,
      database: "connected",
      savedSchemes: Number(result.rows[0].count),
      onlineSearchConfigured: Boolean(process.env.LANGSEARCH_API_KEY)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Database error"
    });
  }
});

// Live internet search
app.get("/api/search", async (req, res) => {
  try {
    const keyword = String(req.query.q || "").trim();
    const state = String(req.query.state || "").trim();
    const category = String(req.query.category || "").trim();

    if (!keyword) {
      return res.status(400).json({
        error: "Search keyword required"
      });
    }

    if (!process.env.LANGSEARCH_API_KEY) {
      return res.status(503).json({
        error: "Online search API key is not configured"
      });
    }

    const query = [
      keyword,
      state,
      category,
      "India government scheme official application eligibility"
    ].filter(Boolean).join(" ");

    const response = await fetch(
      "https://api.langsearch.com/v1/web-search",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.LANGSEARCH_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          count: 10
        }),
        signal: AbortSignal.timeout(25000)
      }
    );

    if (!response.ok) {
      const message = await response.text();
      console.error("Search API error:", response.status, message);
      return res.status(502).json({
        error: "Online search service failed"
      });
    }

    const data = await response.json();
    const items = data.data?.webPages?.value || [];

    res.json({
      ok: true,
      results: items.map(item => ({
        title: item.name || item.title || "Government information",
        url: item.url,
        description: item.snippet || item.description || "",
        publishedDate: item.datePublished || null,
        source: item.displayUrl || item.url
      })).filter(item => item.url)
    });

  } catch (error) {
    console.error("Search error:", error.message);
    res.status(500).json({
      error: "Search failed. Please try again."
    });
  }
});

// Saved schemes
app.get("/api/saved", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM saved_schemes ORDER BY created_at DESC"
    );
    res.json({ ok: true, results: result.rows });
  } catch (error) {
    res.status(500).json({ error: "Could not load saved schemes" });
  }
});

// Admin save
app.post("/api/admin/schemes", async (req, res) => {
  try {
    if (!process.env.ADMIN_KEY ||
        req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      title,
      description,
      source_url,
      state,
      category,
      published_date
    } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "Title required" });
    }

    const result = await pool.query(
      `INSERT INTO saved_schemes
       (title, description, source_url, state, category, published_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        title,
        description || "",
        source_url || "",
        state || "",
        category || "",
        published_date || null
      ]
    );

    res.json({ ok: true, scheme: result.rows[0] });

  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Could not save scheme" });
  }
});

// Admin delete
app.delete("/api/admin/schemes/:id", async (req, res) => {
  try {
    if (!process.env.ADMIN_KEY ||
        req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    await pool.query(
      "DELETE FROM saved_schemes WHERE id = $1",
      [req.params.id]
    );

    res.json({ ok: true });

  } catch (error) {
    res.status(500).json({ error: "Delete failed" });
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
  
