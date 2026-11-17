
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// गाँवों की सूची — प्रशासनिक कोड सत्यापन के बाद भरें
const PANCHAYAT = {
  name: "पंडुवा-भिलोर ग्राम पंचायत",
  villages: [
    {
      id: "panduwa",
      name: "पंडुवा (Panduwa)",
      lgdCode: null,
      pinCode: "212107"
    },
    {
      id: "bhilore",
      name: "भिलोर (Bhilore)",
      lgdCode: null,
      pinCode: "212107"
    }
  ]
};

const SCHEMES = [
  { name: "प्रधानमंत्री आवास योजना ग्रामीण", category: "आवास", url: "https://pmayg.nic.in/" },
  { name: "वृद्धावस्था पेंशन", category: "पेंशन", url: "https://nsap.nic.in/" },
  { name: "विधवा पेंशन", category: "पेंशन", url: "https://nsap.nic.in/" },
  { name: "दिव्यांग पेंशन", category: "पेंशन", url: "https://nsap.nic.in/" },
  { name: "मनरेगा", category: "रोजगार", url: "https://nrega.nic.in/" },
  { name: "प्रधानमंत्री किसान सम्मान निधि", category: "किसान", url: "https://pmkisan.gov.in/" },
  { name: "राष्ट्रीय ग्रामीण आजीविका मिशन", category: "स्वयं सहायता समूह", url: "https://nrlm.gov.in/" },
  { name: "स्वच्छ भारत मिशन ग्रामीण", category: "स्वच्छता", url: "https://sbm.gov.in/" },
  { name: "जल जीवन मिशन", category: "पेयजल", url: "https://ejalshakti.gov.in/jjmreport/JJMIndia.aspx" },
  { name: "प्रधानमंत्री ग्राम सड़क योजना", category: "सड़क", url: "https://pmgsy.nic.in/" },
  { name: "प्रधानमंत्री उज्ज्वला योजना", category: "गैस", url: "https://www.pmuy.gov.in/" },
  { name: "प्रधानमंत्री कृषि सिंचाई योजना", category: "कृषि", url: "https://pmksy.gov.in/" }
];

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "Bharat Yojana Finder",
    langSearchConfigured: Boolean(process.env.LANGSEARCH_API_KEY),
    villageCount: PANCHAYAT.villages.length,
    officialBeneficiaryDataConnected: false
  });
});

app.get("/api/panchayat", (req, res) => {
  res.json({
    ok: true,
    panchayat: PANCHAYAT.name,
    villages: PANCHAYAT.villages
  });
});

app.get("/api/schemes", (req, res) => {
  res.json({
    ok: true,
    schemes: SCHEMES,
    note: "यह योजनाओं की संदर्भ सूची है, लाभार्थियों की प्रमाणित गणना नहीं।"
  });
});

// किसी गाँव की रिपोर्ट — अभी सरकारी MIS कनेक्शन उपलब्ध नहीं
app.get("/api/village-report/:villageId", (req, res) => {
  const village = PANCHAYAT.villages.find(
    v => v.id === req.params.villageId
  );

  if (!village) {
    return res.status(404).json({
      ok: false,
      error: "गाँव नहीं मिला।"
    });
  }

  res.json({
    ok: true,
    village: village.name,
    lgdCode: village.lgdCode,
    dataLevel: "village",
    verified: false,
    beneficiaryCounts: null,
    message: "इस गाँव के प्रमाणित सरकारी लाभार्थी आँकड़े का कनेक्शन अभी उपलब्ध नहीं है। कोई संख्या अनुमान से नहीं दिखाई जाएगी।"
  });
});

// पंचायत की संयुक्त रिपोर्ट — इसे गाँव की रिपोर्ट न समझें
app.get("/api/panchayat-report", (req, res) => {
  res.json({
    ok: true,
    panchayat: PANCHAYAT.name,
    villages: PANCHAYAT.villages.map(v => v.name),
    dataLevel: "gram_panchayat",
    verified: false,
    beneficiaryCounts: null,
    message: "संयुक्त ग्राम पंचायत के प्रमाणित आँकड़े का सरकारी कनेक्शन अभी उपलब्ध नहीं है।"
  });
});

// LangSearch केवल वेब संदर्भ खोजेगा, लाभार्थी संख्या प्रमाणित नहीं करेगा।
app.post("/api/search", async (req, res) => {
  try {
    const key = process.env.LANGSEARCH_API_KEY;
    if (!key) {
      return res.status(503).json({
        ok: false,
        error: "Render Environment में LANGSEARCH_API_KEY सेट करें।"
      });
    }

    const village = PANCHAYAT.villages.find(
      v => v.id === req.body.villageId
    );

    if (!village) {
      return res.status(400).json({
        ok: false,
        error: "पहले पंडुवा या भिलोर गाँव चुनें।"
      });
    }

    const keyword = String(req.body.keyword || "सरकारी योजनाएँ").trim();

    const query = [
      `"${village.name}"`,
      "Bara Prayagraj Uttar Pradesh",
      keyword,
      "site:gov.in OR site:nic.in"
    ].join(" ");

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
      village: village.name,
      dataLevel: "unverified_web_results",
      verified: false,
      beneficiaryCounts: null,
      message: "ये इंटरनेट खोज के संदर्भ हैं। इनसे गाँव के लाभार्थियों की संख्या प्रमाणित नहीं होती।",
      results: pages.map(p => ({
        title: p.name || "सरकारी जानकारी",
        url: p.url || "",
        text: p.text || p.snippet || "",
        date: p.datePublished || "",
        verifiedVillageData: false,
        dataLevel: "unknown"
      }))
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message || "खोज नहीं हो सकी।"
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Bharat Yojana Finder running on " + PORT);
});
