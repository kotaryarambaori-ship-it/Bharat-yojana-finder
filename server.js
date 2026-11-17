
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const LGD = "https://india-lgd-index-api.vercel.app";

app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

async function getJSON(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json();

  if (!response.ok || data.success === false) {
    throw new Error(data.error?.message || `Source error ${response.status}`);
  }

  return data;
}

// प्रमुख सरकारी योजनाओं की संदर्भ सूची
const SCHEMES = [
  {
    name: "प्रधानमंत्री आवास योजना ग्रामीण",
    category: "आवास",
    url: "https://pmayg.nic.in/",
    level: "रिपोर्ट ग्राम पंचायत/ब्लॉक स्तर पर हो सकती है। गाँव-स्तर की पुष्टि जरूरी है।"
  },
  {
    name: "वृद्धावस्था पेंशन",
    category: "पेंशन",
    url: "https://nsap.nic.in/",
    level: "राज्य और योजना के अनुसार उपलब्ध रिकॉर्ड की सीमा अलग हो सकती है।"
  },
  {
    name: "विधवा पेंशन",
    category: "पेंशन",
    url: "https://nsap.nic.in/",
    level: "लाभार्थी की गाँव-वार संख्या आधिकारिक स्रोत से सत्यापित करनी होगी।"
  },
  {
    name: "दिव्यांग पेंशन",
    category: "पेंशन",
    url: "https://nsap.nic.in/",
    level: "लाभार्थी की गाँव-वार संख्या आधिकारिक स्रोत से सत्यापित करनी होगी।"
  },
  {
    name: "मनरेगा",
    category: "रोजगार",
    url: "https://nrega.nic.in/",
    level: "MIS में ग्राम पंचायत और गाँव के रिकॉर्ड उपलब्ध हो सकते हैं।"
  },
  {
    name: "प्रधानमंत्री किसान सम्मान निधि",
    category: "किसान",
    url: "https://pmkisan.gov.in/",
    level: "सार्वजनिक गाँव-वार लाभार्थी सूची हर जगह उपलब्ध नहीं होती।"
  },
  {
    name: "राष्ट्रीय ग्रामीण आजीविका मिशन",
    category: "स्वयं सहायता समूह",
    url: "https://nrlm.gov.in/",
    level: "MIS में गाँव/ग्राम पंचायत तक कुछ रिकॉर्ड मिल सकते हैं।"
  },
  {
    name: "स्वच्छ भारत मिशन ग्रामीण",
    category: "स्वच्छता",
    url: "https://sbm.gov.in/",
    level: "रिपोर्ट की उपलब्धता और स्तर योजना के अनुसार अलग हो सकता है।"
  },
  {
    name: "जल जीवन मिशन",
    category: "पेयजल",
    url: "https://ejalshakti.gov.in/jjmreport/JJMIndia.aspx",
    level: "गाँव की पेयजल योजना और प्रगति रिपोर्ट देखें।"
  },
  {
    name: "प्रधानमंत्री ग्राम सड़क योजना",
    category: "सड़क",
    url: "https://pmgsy.nic.in/",
    level: "सड़क/बसावट संबंधी जानकारी; लाभार्थी संख्या लागू नहीं।"
  },
  {
    name: "प्रधानमंत्री उज्ज्वला योजना",
    category: "गैस",
    url: "https://www.pmuy.gov.in/",
    level: "गाँव-वार लाभार्थी संख्या सार्वजनिक रूप से हमेशा उपलब्ध नहीं।"
  },
  {
    name: "प्रधानमंत्री कृषि सिंचाई योजना",
    category: "कृषि",
    url: "https://pmksy.gov.in/",
    level: "घटक के अनुसार रिपोर्ट की उपलब्धता अलग होती है।"
  }
];

// सर्वर की स्थिति
app.get("/api/health", async (req, res) => {
  try {
    const data = await getJSON(`${LGD}/v1/states`);
    res.json({
      ok: true,
      locationSource: "LGD community mirror",
      states: data.data?.length || 0,
      sourceDate: data.meta?.source_date || null,
      langSearchConfigured: Boolean(process.env.LANGSEARCH_API_KEY)
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

// योजनाओं की सूची
app.get("/api/schemes", (req, res) => {
  res.json({
    ok: true,
    schemes: SCHEMES,
    message: "यह योजनाओं की संदर्भ सूची है, चयनित गाँव की प्रमाणित लाभार्थी सूची नहीं।"
  });
});

// राज्य
app.get("/api/locations/states", async (req, res) => {
  try {
    res.json(await getJSON(`${LGD}/v1/states`));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// जिले
app.get("/api/locations/districts", async (req, res) => {
  try {
    if (!req.query.state) {
      return res.status(400).json({ error: "State code required" });
    }
    res.json(await getJSON(
      `${LGD}/v1/districts?state=${encodeURIComponent(req.query.state)}`
    ));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// तहसील / उप-जिला
app.get("/api/locations/tehsils", async (req, res) => {
  try {
    if (!req.query.district) {
      return res.status(400).json({ error: "District code required" });
    }
    res.json(await getJSON(
      `${LGD}/v1/subdistricts?district=${encodeURIComponent(req.query.district)}`
    ));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ब्लॉक
app.get("/api/locations/blocks", async (req, res) => {
  try {
    if (!req.query.district) {
      return res.status(400).json({ error: "District code required" });
    }
    res.json(await getJSON(
      `${LGD}/v1/blocks?district=${encodeURIComponent(req.query.district)}`
    ));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// LGD स्थान खोज
app.get("/api/locations/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Search name required" });

    res.json(await getJSON(
      `${LGD}/v1/search?q=${encodeURIComponent(q)}`
    ));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// इंटरनेट पर योजनाओं की जानकारी खोज
app.post("/api/search", async (req, res) => {
  try {
    const key = process.env.LANGSEARCH_API_KEY;

    if (!key) {
      return res.status(503).json({
        error: "Render Environment में LANGSEARCH_API_KEY सेट करें।"
      });
    }

    const {
      state, district, tehsil, block, village, keyword
    } = req.body || {};

    if (!village || !String(village).trim()) {
      return res.status(400).json({ error: "गाँव का नाम भरें।" });
    }

    const query = [
      `"${String(village).trim()}"`,
      district,
      state,
      tehsil,
      block,
      keyword || "सरकारी योजना लाभार्थी सूची आवास पेंशन मनरेगा",
      "site:gov.in OR site:nic.in"
    ].filter(Boolean).join(" ");

    const response = await fetch(
      "https://api.langsearch.com/v1/web-search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          count: 10,
          contents: { text: true }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    const data = await response.json();

    if (!response.ok || String(data.code) !== "200") {
      throw new Error(data.message || `LangSearch error ${response.status}`);
    }

    const pages = data.data?.webPages?.value || [];

    res.json({
      ok: true,
      query,
      results: pages.map(p => ({
        title: p.name || "सरकारी जानकारी",
        url: p.url || "",
        text: p.text || p.snippet || "",
        date: p.datePublished || ""
      }))
    });
  } catch (e) {
    res.status(502).json({
      error: e.message || "खोज नहीं हो सकी।"
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Bharat Yojana Finder running on ${PORT}`);
});
