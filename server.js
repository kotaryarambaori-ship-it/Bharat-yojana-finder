
const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "15mb" }));

const {
  DATABASE_URL,
  ADMIN_KEY,
  LANGSEARCH_API_KEY
} = process.env;

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

pool.on("error", err => {
  console.error("Database error:", err.message);
});

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function officialSource(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.endsWith(".gov.in") ||
      host.endsWith(".nic.in") ||
      host.endsWith(".gov") ||
      host === "india.gov.in"
    );
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({
      ok: false,
      message: "ADMIN_KEY Render में सेट नहीं है।"
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

/* Database */
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS villages (
      id BIGSERIAL PRIMARY KEY,
      lgd_code TEXT UNIQUE NOT NULL,
      village_name TEXT NOT NULL,
      gram_panchayat TEXT DEFAULT '',
      block_name TEXT DEFAULT '',
      subdistrict_name TEXT DEFAULT '',
      district_name TEXT NOT NULL,
      state_name TEXT NOT NULL,
      state_code TEXT DEFAULT '',
      district_code TEXT DEFAULT '',
      block_code TEXT DEFAULT '',
      subdistrict_code TEXT DEFAULT '',
      source TEXT DEFAULT 'LGD CSV',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS villages_location_idx
    ON villages (state_name, district_name, village_name)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS villages_name_idx
    ON villages (LOWER(village_name))
  `);

  console.log("Database initialized");
}

/* Health */
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    const [schemes, villages] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total FROM saved_schemes"),
      pool.query("SELECT COUNT(*)::int AS total FROM villages")
    ]);

    res.json({
      ok: true,
      database: "connected",
      savedSchemes: schemes.rows[0].total,
      savedVillages: villages.rows[0].total,
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

/* CSV parser: commas and quoted fields supported */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"' && quoted && text[i + 1] === '"') {
      field += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);

  return rows;
}

function headerIndex(headers, patterns) {
  return headers.findIndex(h =>
    patterns.some(p => h.includes(p))
  );
}

/* Admin: import official LGD village CSV */
app.post(
  "/api/admin/villages/import",
  requireAdmin,
  async (req, res) => {
    const csv = String(req.body.csv || "");

    if (!csv || csv.length > 14 * 1024 * 1024) {
      return res.status(400).json({
        ok: false,
        message: "CSV खाली है या 14 MB से बड़ी है।"
      });
    }

    const rows = parseCSV(csv.replace(/^\uFEFF/, ""));

    if (rows.length < 2) {
      return res.status(400).json({
        ok: false,
        message: "CSV में हेडर और गाँवों का डेटा होना चाहिए।"
      });
    }

    const headers = rows[0].map(normalize);

    const col = {
      village: headerIndex(headers, ["villagename", "village name"]),
      lgd: headerIndex(headers, ["villagecode", "villagelgdcode", "lgdcode"]),
      state: headerIndex(headers, ["statename"]),
      district: headerIndex(headers, ["districtname"]),
      block: headerIndex(headers, ["blockname", "developmentblock"]),
      subdistrict: headerIndex(headers, ["subdistrictname", "tehsilname"]),
      gp: headerIndex(headers, ["grampanchayatname", "villagepanchayatname"]),
      stateCode: headerIndex(headers, ["statecode"]),
      districtCode: headerIndex(headers, ["districtcode"]),
      blockCode: headerIndex(headers, ["blockcode"]),
      subdistrictCode: headerIndex(headers, ["subdistrictcode"])
    };

    const missing = [];
    if (col.village < 0) missing.push("Village Name");
    if (col.lgd < 0) missing.push("Village Code / LGD Code");
    if (col.state < 0) missing.push("State Name");
    if (col.district < 0) missing.push("District Name");

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        message:
          "CSV के कॉलम पहचाने नहीं गए: " + missing.join(", ") +
          ". LGD Village CSV डाउनलोड करें।"
      });
    }

    const get = (row, index) =>
      index >= 0 ? clean(row[index], 200) : "";

    let imported = 0;
    let skipped = 0;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const row of rows.slice(1)) {
        const village = get(row, col.village);
        const lgd = get(row, col.lgd);
        const state = get(row, col.state);
        const district = get(row, col.district);

        if (!village || !lgd || !state || !district) {
          skipped++;
          continue;
        }

        await client.query(
          `INSERT INTO villages
           (lgd_code, village_name, gram_panchayat,
            block_name, subdistrict_name, district_name,
            state_name, state_code, district_code,
            block_code, subdistrict_code, source, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'LGD CSV',NOW())
           ON CONFLICT (lgd_code) DO UPDATE SET
             village_name = EXCLUDED.village_name,
             gram_panchayat = EXCLUDED.gram_panchayat,
             block_name = EXCLUDED.block_name,
             subdistrict_name = EXCLUDED.subdistrict_name,
             district_name = EXCLUDED.district_name,
             state_name = EXCLUDED.state_name,
             state_code = EXCLUDED.state_code,
             district_code = EXCLUDED.district_code,
             block_code = EXCLUDED.block_code,
             subdistrict_code = EXCLUDED.subdistrict_code,
             source = 'LGD CSV',
             updated_at = NOW()`,
          [
            lgd,
            village,
            get(row, col.gp),
            get(row, col.block),
            get(row, col.subdistrict),
            district,
            state,
            get(row, col.stateCode),
            get(row, col.districtCode),
            get(row, col.blockCode),
            get(row, col.subdistrictCode)
          ]
        );

        imported++;
      }

      await client.query("COMMIT");

      res.json({
        ok: true,
        imported,
        skipped,
        message: `${imported} गाँवों के रिकॉर्ड सेव हुए।`
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Village import error:", err.message);
      res.status(500).json({
        ok: false,
        message: "गाँवों का डेटा सेव नहीं हुआ।"
      });
    } finally {
      client.release();
    }
  }
);

/* Village directory search */
app.get("/api/villages", async (req, res) => {
  try {
    const q = clean(req.query.q, 100);
    const state = clean(req.query.state, 100);
    const district = clean(req.query.district, 100);

    if (!q && !state && !district) {
      return res.status(400).json({
        ok: false,
        message: "गाँव, जिला या राज्य का नाम दें।"
      });
    }

    const result = await pool.query(
      `SELECT lgd_code, village_name, gram_panchayat,
              block_name, subdistrict_name,
              district_name, state_name,
              state_code, district_code
       FROM villages
       WHERE ($1 = '' OR village_name ILIKE '%' || $1 || '%'
              OR gram_panchayat ILIKE '%' || $1 || '%')
         AND ($2 = '' OR state_name ILIKE '%' || $2 || '%')
         AND ($3 = '' OR district_name ILIKE '%' || $3 || '%')
       ORDER BY
         CASE WHEN LOWER(village_name) = LOWER($1) THEN 0 ELSE 1 END,
         village_name
       LIMIT 30`,
      [q, state, district]
    );

    res.json({
      ok: true,
      count: result.rowCount,
      results: result.rows,
      note: "गाँव के सरकारी रिकॉर्ड LGD CSV आयात होने के बाद ही मिलेंगे।"
    });
  } catch (err) {
    console.error("Village lookup error:", err.message);
    res.status(500).json({
      ok: false,
      message: "गाँवों का रिकॉर्ड नहीं मिल सका।"
    });
  }
});

/* LangSearch */
async function langSearch(query, freshness) {
  if (!LANGSEARCH_API_KEY) {
    throw new Error("LANGSEARCH_API_KEY सेट नहीं है।");
  }

  const response = await fetch(
    "https://api.langsearch.com/v1/web-search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LANGSEARCH_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        count: 20,
        freshness,
        contents: {
          text: { max_characters: 3000 }
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
    throw new Error("LangSearch से सही जवाब नहीं मिला।");
  }

  if (!response.ok || String(data.code) !== "200") {
    console.error("LangSearch response:", response.status, raw.slice(0, 400));
    throw new Error(
      data.message || `LangSearch HTTP ${response.status}`
    );
  }

  return Array.isArray(data?.data?.webPages?.value)
    ? data.data.webPages.value
    : [];
}

function freshness(value) {
  return ({
    today: "oneDay",
    week: "oneWeek",
    month: "oneMonth",
    year: "oneYear",
    all: "noLimit"
  })[value] || "noLimit";
}

function resultText(item) {
  return normalize([
    item.name,
    item.text,
    item.snippet,
    item.description,
    item.url
  ].filter(Boolean).join(" "));
}

function hasTerm(text, value) {
  const term = normalize(value);
  if (!term) return false;
  return (` ${text} `).includes(` ${term} `);
}

function classifyResult(item, f) {
  const text = resultText(item);

  const villageMatch = hasTerm(text, f.village);
  const blockMatch = hasTerm(text, f.block);
  const tehsilMatch = hasTerm(text, f.tehsil);
  const districtMatch = hasTerm(text, f.district);
  const stateMatch = hasTerm(text, f.state);

  if (villageMatch && districtMatch && stateMatch) return "village";
  if ((blockMatch || tehsilMatch) && districtMatch && stateMatch) return "block";
  if (districtMatch && stateMatch) return "district";
  if (stateMatch) return "state";
  return "other";
}

function prepareResult(item, f) {
  const url = item.url;

  return {
    title: clean(item.name || "सरकारी जानकारी", 500),
    description: clean(
      item.text || item.snippet || item.description || "मूल स्रोत खोलें।",
      2500
    ),
    url,
    date: item.datePublished || item.date || "",
    official: officialSource(url),
    level: classifyResult(item, f)
  };
}

function uniqueResults(items) {
  const seen = new Set();

  return items.filter(item => {
    const key = String(item.url || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* Multi-level scheme search */
app.post("/api/search", async (req, res) => {
  try {
    const f = {
      state: clean(req.body.state, 100),
      district: clean(req.body.district, 100),
      tehsil: clean(req.body.tehsil, 100),
      block: clean(req.body.block, 100),
      village: clean(req.body.village, 100),
      keyword: clean(req.body.keyword, 200),
      category: clean(req.body.category, 100),
      dateRange: clean(req.body.dateRange, 20) || "all"
    };

    if (!f.state || !f.district || !f.village) {
      return res.status(400).json({
        ok: false,
        message: "राज्य, जिला और गाँव भरना जरूरी है।"
      });
    }

    const topic = f.keyword || f.category || "सरकारी योजनाएँ";
    const where = [f.village, f.block, f.tehsil, f.district, f.state]
      .filter(Boolean);

    const queries = [
      `${topic} ${f.village} ${f.district} ${f.state} सरकारी योजना`,
      `${topic} ${f.block} ${f.district} ${f.state} सरकारी योजना`,
      `${topic} ${f.district} ${f.state} official government scheme`
    ];

    console.log("Multi-level search:", queries);

    const batches = await Promise.allSettled(
      queries.map(q => langSearch(q, freshness(f.dateRange)))
    );

    const successful = batches
      .filter(x => x.status === "fulfilled")
      .flatMap(x => x.value);

    const failed = batches.filter(x => x.status === "rejected");

    if (!successful.length && failed.length) {
      throw new Error(failed[0].reason.message || "वेब खोज विफल हुई।");
    }

    const all = uniqueResults(
      successful
        .filter(item => item && validUrl(item.url))
        .map(item => prepareResult(item, f))
    );

    // Government sources are placed first, but other sources remain visible.
    all.sort((a, b) => Number(b.official) - Number(a.official));

    const villageResults = all.filter(x => x.level === "village");
    const blockResults = all.filter(x => x.level === "block");
    const districtResults = all.filter(x => x.level === "district");
    const stateResults = all.filter(x => x.level === "state");
    const otherResults = all.filter(x => x.level === "other");

    // If a result mentions the village but not all other place names,
    // keep it visible as a village-name match, not as verified implementation.
    const villageNameResults = all.filter(x =>
      hasTerm(resultText(x), f.village)
    );

    const officialCount = all.filter(x => x.official).length;

    res.json({
      ok: true,
      location: f,
      totals: {
        allResults: all.length,
        villageNameMatches: villageNameResults.length,
        blockMatches: blockResults.length,
        districtMatches: districtResults.length,
        stateMatches: stateResults.length,
        officialSources: officialCount
      },
      villageResults: villageNameResults,
      blockResults,
      districtResults,
      stateResults,
      otherResults,
      message: all.length
        ? "खोज पूरी हुई। परिणामों को स्थान के स्तर के अनुसार अलग दिखाया गया है।"
        : "LangSearch से इस खोज के लिए कोई वेब परिणाम नहीं मिला।",
      warning: "वेब पेज में गाँव का नाम मिलना इस बात का प्रमाण नहीं है कि योजना उस गाँव में लागू है। लागू होने की पुष्टि संबंधित सरकारी रिकॉर्ड से करें।",
      searchErrors: failed.length
    });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({
      ok: false,
      message: err.message || "खोज में समस्या हुई।"
    });
  }
});

/* Beneficiary portals */
app.get("/api/beneficiary-portals", (req, res) => {
  res.json({
    ok: true,
    portals: [
      {
        title: "प्रधानमंत्री आवास योजना ग्रामीण",
        description: "ग्रामीण आवास योजना का आधिकारिक पोर्टल।",
        url: "https://pmayg.dord.gov.in/"
      },
      {
        title: "मनरेगा श्रमिक जानकारी",
        description: "उपलब्ध जॉब कार्ड और श्रमिक रिकॉर्ड देखें।",
        url: "https://mnregaweb4.nic.in/netnrega/workers/wrkinfo.aspx?lang=en"
      },
      {
        title: "मनरेगा आधिकारिक पोर्टल",
        description: "काम, मस्टर रोल और भुगतान संबंधी जानकारी।",
        url: "https://nrega.dord.gov.in/"
      },
      {
        title: "राष्ट्रीय सरकारी सेवा पोर्टल",
        description: "भारत सरकार की सेवाएँ और योजनाएँ।",
        url: "https://www.india.gov.in/"
      },
      {
        title: "LGD - गाँव और पंचायत निर्देशिका",
        description: "गाँव, पंचायत और प्रशासनिक इकाइयों की सरकारी निर्देशिका।",
        url: "https://lgdirectory.gov.in/"
      }
    ],
    note: "लाभार्थी की जानकारी तभी उपलब्ध होगी जब संबंधित सरकारी पोर्टल उसे सार्वजनिक करता हो।"
  });
});

/* Saved schemes */
app.get("/api/saved", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM saved_schemes ORDER BY created_at DESC LIMIT 100"
    );
    res.json({ ok: true, results: result.rows });
  } catch (err) {
    console.error("Saved schemes error:", err.message);
    res.status(500).json({
      ok: false,
      message: "सेव रिकॉर्ड नहीं मिल सके।"
    });
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

    if (!title || !validUrl(sourceUrl)) {
      return res.status(400).json({
        ok: false,
        message: "योजना का नाम और सही लिंक जरूरी है।"
      });
    }

    const result = await pool.query(
      `INSERT INTO saved_schemes
       (title, description, source_url, state, category, published_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [title, description, sourceUrl, state, category, publishedDate]
    );

    res.json({ ok: true, record: result.rows[0] });
  } catch (err) {
    console.error("Save error:", err.message);
    res.status(500).json({
      ok: false,
      message: "जानकारी सेव नहीं हो सकी।"
    });
  }
});

app.delete(
  "/api/admin/schemes/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({
          ok: false,
          message: "गलत रिकॉर्ड ID।"
        });
      }

      const result = await pool.query(
        "DELETE FROM saved_schemes WHERE id=$1 RETURNING id",
        [id]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          ok: false,
          message: "रिकॉर्ड नहीं मिला।"
        });
      }

      res.json({ ok: true, message: "रिकॉर्ड डिलीट हो गया।" });
    } catch (err) {
      console.error("Delete error:", err.message);
      res.status(500).json({
        ok: false,
        message: "रिकॉर्ड डिलीट नहीं हुआ।"
      });
    }
  }
);

/* Frontend */
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
