
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const LGD = "https://india-lgd-index-api.vercel.app";

app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

async function getJSON(url) {
  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json();

  if (!response.ok || data.success === false) {
    throw new Error(data.error?.message || `Source error ${response.status}`);
  }

  return data;
}

app.get("/api/health", async (req, res) => {
  try {
    const data = await getJSON(`${LGD}/v1/states`);
    res.json({
      ok: true,
      locationSource: "LGD community mirror",
      states: data.data.length,
      sourceDate: data.meta.source_date,
      langSearchConfigured: Boolean(process.env.LANGSEARCH_API_KEY)
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get("/api/locations/states", async (req, res) => {
  try {
    res.json(await getJSON(`${LGD}/v1/states`));
  } catch (e) {
    res.status(502).json({ success: false, error: { message: e.message } });
  }
});

app.get("/api/locations/districts", async (req, res) => {
  try {
    if (!req.query.state) return res.status(400).json({ error: "State code required" });
    res.json(await getJSON(`${LGD}/v1/districts?state=${encodeURIComponent(req.query.state)}`));
  } catch (e) {
    res.status(502).json({ success: false, error: { message: e.message } });
  }
});

app.get("/api/locations/tehsils", async (req, res) => {
  try {
    if (!req.query.district) return res.status(400).json({ error: "District code required" });
    res.json(await getJSON(`${LGD}/v1/subdistricts?district=${encodeURIComponent(req.query.district)}`));
  } catch (e) {
    res.status(502).json({ success: false, error: { message: e.message } });
  }
});

app.get("/api/locations/blocks", async (req, res) => {
  try {
    if (!req.query.district) return res.status(400).json({ error: "District code required" });
    res.json(await getJSON(`${LGD}/v1/blocks?district=${encodeURIComponent(req.query.district)}`));
  } catch (e) {
    res.status(502).json({ success: false, error: { message: e.message } });
  }
});

app.get("/api/locations/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Search name required" });
    res.json(await getJSON(`${LGD}/v1/search?q=${encodeURIComponent(q)}`));
  } catch (e) {
    res.status(502).json({ success: false, error: { message: e.message } });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const key = process.env.LANGSEARCH_API_KEY;
    if (!key) return res.status(503).json({ error: "LANGSEARCH_API_KEY सेट नहीं है।" });

    const { state, district, tehsil, block, village, keyword } = req.body || {};

    if (!village || !String(village).trim()) {
      return res.status(400).json({ error: "गाँव का नाम भरें।" });
    }

    const query = [
      `"${village}"`,
      district,
      state,
      tehsil,
      block,
      keyword || "सरकारी योजनाएं लाभार्थी सूची आवेदन पात्रता",
      "official government website"
    ].filter(Boolean).join(" ");

    const response = await fetch("https://api.langsearch.com/v1/web-search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        count: 10,
        contents: { text: true }
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await response.json();

    if (!response.ok || String(data.code) !== "200") {
      throw new Error(data.message || `LangSearch error ${response.status}`);
    }

    const pages = data.data?.webPages?.value || [];

    res.json({
      ok: true,
      query,
      results: pages.map(p => ({
        title: p.name || "जानकारी",
        url: p.url || "",
        text: p.text || p.snippet || "",
        date: p.datePublished || ""
      }))
    });
  } catch (e) {
    res.status(502).json({ error: e.message || "खोज नहीं हो सकी।" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`App running on ${PORT}`));
