
const INDIA_TZ = "Asia/Kolkata";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://opezknjjjlavlrzemzgo.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const GEMINI_MODEL = "gemini-2.5-flash";

const json = (res, status, body) =>
  res.status(status).setHeader("Content-Type", "application/json").json(body);

const indiaDate = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
};

const isText = v => typeof v === "string" && v.trim().length > 0;

const isHttps = value => {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
};

async function sb(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${JSON.stringify(data).slice(0, 600)}`);
  }

  return { data, response };
}

async function checkSource(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const r = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "AcadcomPlacementReadiness/1.0"
      }
    });

    if ([403, 405, 501].includes(r.status)) {
      return {
        url,
        reachable: null,
        status: r.status,
        note: "Host blocks automated HEAD checks"
      };
    }

    return {
      url,
      reachable: r.status >= 200 && r.status < 400,
      status: r.status
    };
  } catch {
    return {
      url,
      reachable: null,
      status: null,
      note: "Link could not be checked automatically"
    };
  } finally {
    clearTimeout(timer);
  }
}

function validate(p) {
  const errors = [];

  if (!p || !p.gd_topic || !p.guesstimate || !Array.isArray(p.data_points)) {
    return {
      ok: false,
      errors: ["Required sections are missing."],
      urls: [],
      domains: []
    };
  }

  const gd = p.gd_topic;
  const g = p.guesstimate;

  for (const k of ["title", "context", "opening_statement", "conclusion"]) {
    if (!isText(gd[k])) errors.push(`GD field missing: ${k}`);
  }

  for (const k of [
    "arguments_for",
    "arguments_against",
    "solutions",
    "follow_up_questions"
  ]) {
    if (!Array.isArray(gd[k]) || gd[k].length < 2) {
      errors.push(`GD section ${k} needs at least two items`);
    }
  }

  for (const k of [
    "question",
    "approach",
    "final_estimate",
    "sanity_check",
    "interview_explanation"
  ]) {
    if (!isText(g[k])) errors.push(`Guesstimate field missing: ${k}`);
  }

  for (const k of ["assumptions", "calculation_steps"]) {
    if (!Array.isArray(g[k]) || g[k].length < 2) {
      errors.push(`Guesstimate section ${k} needs at least two items`);
    }
  }

  if (p.data_points.length !== 10) {
    errors.push("Exactly 10 data points are required");
  }

  const urls = [];
  const domains = new Set();

  p.data_points.forEach((d, i) => {
    for (const k of [
      "label",
      "figure",
      "unit",
      "year",
      "context",
      "placement_relevance",
      "source_title",
      "source_url"
    ]) {
      if (!isText(String(d?.[k] ?? ""))) {
        errors.push(`Data point ${i + 1} missing ${k}`);
      }
    }

    if (!isHttps(d?.source_url)) {
      errors.push(`Data point ${i + 1} source must be a valid HTTPS URL`);
    } else {
      urls.push(d.source_url);
      domains.add(new URL(d.source_url).hostname.replace(/^www\./, ""));
    }
  });

  if (domains.size < 5) {
    errors.push("At least five distinct source domains are required");
  }

  if (new Set(urls).size < 8) {
    errors.push("At least eight distinct source URLs are required");
  }

  return {
    ok: errors.length === 0,
    errors,
    urls,
    domains: [...domains]
  };
}

async function authorize(req) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (CRON_SECRET && bearer === CRON_SECRET) {
    return { ok: true, actor: "cron" };
  }

  if (!bearer || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 401, message: "Authorization required" };
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${bearer}`
    }
  });

  if (!r.ok) {
    return { ok: false, status: 401, message: "Valid sign-in required" };
  }

  const user = await r.json();

  const profile = await sb(
    `profiles?select=role&id=eq.${encodeURIComponent(user.id)}&limit=1`
  );

  if (profile.data?.[0]?.role !== "admin") {
    return { ok: false, status: 403, message: "Administrator access required" };
  }

  return { ok: true, actor: `admin:${user.id}` };
}

async function generate(actor) {
  if (!SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
    throw new Error(
      "Server secrets missing: configure SUPABASE_SERVICE_ROLE_KEY and GEMINI_API_KEY in Vercel Environment Variables."
    );
  }

  const date = indiaDate();

  const existing = await sb(
    `placement_daily_packs?select=id,status,content_date&content_date=eq.${date}&limit=1`
  );

  if (existing.data?.[0]?.status === "published") {
    return {
      ok: true,
      alreadyPublished: true,
      content_date: date,
      id: existing.data[0].id
    };
  }

  const [topicRes, recentRes] = await Promise.all([
    sb("placement_topic_bank?select=source_deck,topic_type,topic,company,details&order=created_at.desc&limit=300"),
    sb("placement_daily_packs?select=gd_topic,content_date&order=content_date.desc&limit=30")
  ]);

  const topics = (topicRes.data || []).map(t => ({
    source_deck: t.source_deck,
    type: t.topic_type,
    topic: t.topic,
    company: t.company,
    details: t.details
  }));

  const recent = (recentRes.data || [])
    .map(p => p.gd_topic?.title)
    .filter(Boolean);

  const prompt = `You are the daily Placement Readiness editor for MANAGE Hyderabad PGDM-ABM students in India. Date: ${date} (India). Use supplied past placement bank topics first; do not claim a question was previously asked unless explicitly in bank. If bank is empty/no fit, choose a useful specific agribusiness/MBA topic. Avoid recent GD topics: ${JSON.stringify(recent)}. Topic bank: ${JSON.stringify(topics)}. Return JSON only with gd_topic:{title,context,opening_statement,arguments_for:[...],arguments_against:[...],solutions:[...],conclusion,follow_up_questions:[...]}; guesstimate:{question,approach,assumptions:[...],calculation_steps:[...],final_estimate,sanity_check,interview_explanation}; data_points: exactly 10 objects with label,figure,unit,year,context,placement_relevance,source_title,source_url. Give balanced, practical GD arguments and 45-60 second opening. Guesstimate must show transparent assumptions, unit-labelled calculations and sanity check; label assumptions as estimates. Each data point must be a real agribusiness statistic with year, unit and direct trustworthy source URL (official Indian government, RBI, NABARD, APEDA, DAHD, MoAFW, MOSPI, FAO, World Bank, annual reports or credible research). Never invent statistics or URLs; prefer well-supported data. At least 5 distinct source domains and 8 distinct URLs.`;

  // Generate the placement pack using Google Gemini.
  const ai = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "Return only valid JSON. Do not fabricate citations or figures."
            }
          ]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!ai.ok) {
    throw new Error(
      `Gemini generation failed (${ai.status}): ${(await ai.text()).slice(0, 500)}`
    );
  }

  const aiJson = await ai.json();

  const generatedText =
    aiJson?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") || "";

  if (!generatedText) {
    const reason = aiJson?.promptFeedback?.blockReason;
    throw new Error(
      reason
        ? `Gemini blocked the request: ${reason}`
        : "Gemini returned an empty response. Check model availability and API quota."
    );
  }

  let pack;

  try {
    pack = JSON.parse(generatedText);
  } catch {
    throw new Error("Gemini returned invalid JSON. Please retry generation.");
  }

  const val = validate(pack);
  const links = await Promise.all(val.urls.map(checkSource));
  const dead = links.filter(x => x.reachable === false);
  const inconclusive = links.filter(x => x.reachable === null);

  if (dead.length) {
    val.errors.push(`${dead.length} source links returned error statuses`);
  }

  val.ok = val.errors.length === 0;

  const report = {
    passed: val.ok,
    errors: val.errors,
    checked_at: new Date().toISOString(),
    source_urls_count: val.urls.length,
    distinct_source_domains: val.domains.length,
    dead_links: dead,
    inconclusive_link_checks: inconclusive,
    note: "Automated checks validate required fields, source diversity, HTTPS URLs and link responses; they do not independently prove each statistic. Review source reports before relying on a high-impact figure."
  };

  const row = {
    content_date: date,
    gd_topic: pack.gd_topic,
    guesstimate: pack.guesstimate,
    data_points: pack.data_points,
    source_urls: val.urls.map(url => ({ url })),
    status: val.ok ? "published" : "failed",
    validation_report: report,
    generated_by: actor,
    published_at: val.ok ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };

  const saved = await sb(
    "placement_daily_packs?on_conflict=content_date",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(row)
    }
  );

  return {
    ok: val.ok,
    pack: saved.data?.[0] || null,
    validation: report
  };
}

module.exports = async (req, res) => {
  if (!["GET", "POST"].includes(req.method)) {
    return json(res, 405, { error: "GET or POST required" });
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return json(res, 503, {
      error: "Missing SUPABASE_SERVICE_ROLE_KEY in Vercel environment"
    });
  }

  try {
    const auth = await authorize(req);

    if (!auth.ok) {
      return json(res, auth.status, { error: auth.message });
    }

    const result = await generate(auth.actor);

    return json(res, result.ok ? 200 : 422, result);
  } catch (e) {
    console.error("Placement Readiness generation failed", e);

    return json(res, 500, {
      error: e.message || "Generation failed"
    });
  }
};
