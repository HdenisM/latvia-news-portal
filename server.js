/**
  Мешечкины Новости — aggregator
  - Умный скоринг для тем/регионов
  - AI summary/translate через OpenAI (опционально)
  - Фронтенд: фильтры, карточки, картинка, клик по карточке -> переход
  - Как включить AI: задать OPENAI_API_KEY в переменных окружения (Render)
*/

const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const parser = new Parser({ timeout: 15000 });
app.use(cors());

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // можно заменить

// --- Источники (расширенный список). Некоторые — английские мировые ленты.
const FEEDS = [
  { id: "rus-lsm", title: "Rus.LSM", url: "https://rus.lsm.lv/rss", lang: "ru" },
  { id: "delfi-ru", title: "Delfi (rus)", url: "https://rus.delfi.lv/rss", lang: "ru" },
  { id: "meduza", title: "Meduza", url: "https://meduza.io/rss/all", lang: "ru" },
  { id: "press-lv", title: "Press.lv", url: "https://press.lv/feed", lang: "ru" },
  { id: "bb-lv", title: "BB.lv", url: "https://bb.lv/feed", lang: "ru" },
  // мировые (англ)
  { id: "bbc-world", title: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", lang: "en" },
  { id: "aljazeera", title: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", lang: "en" },
  { id: "nytimes-world", title: "NYTimes World", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", lang: "en" },
  { id: "ap-news", title: "AP News (World)", url: "https://apnews.com/hub/world?outputType=xml", lang: "en" }
];

// Чёрный список источников (избегаем)
const BLACKLIST_SOURCES = ["rbc.ru", "foxnews.com", "ria.ru"];

// Ключевые слова для регионов/тем (простая логика)
const KEYWORDS = {
  latvia: ["латви", "riga", "рига", "рīga", "ри́га"], // riga in various
  eu: ["евро", "евросоюз", "eu", "european union", "brussels"],
  russia: ["росси", "russia", "москва", "moscow"],
  usa: ["сша", "америк", "usa", "united states", "washington"],
  world: ["мир", "world", "global"]
};
const TOPICS = {
  politics: ["политик", "government", "parliament", "съезд", "депутат", "prime minister", "president", "правительств"],
  culture: ["культ", "фестив", "концерт", "театр", "музей", "culture", "festival"]
};

// В памяти: кэш элементов и AI-резюме
let cache = { items: [], lastFetched: null };
let aiCache = {}; // id -> { title, summary, language }

function textLower(s) { return (s || "").toString().toLowerCase(); }

// Примитивный скоринг для релевантности Латвии/ЕС/РФ/США/Мира
function scoreItem(item) {
  const text = (item.title + " " + item.summary + " " + (item.content || "")).toLowerCase();
  let score = 0;
  // region boosts
  for (const k of KEYWORDS.latvia) if (text.includes(k)) score += 10;
  for (const k of KEYWORDS.eu) if (text.includes(k)) score += 6;
  for (const k of KEYWORDS.russia) if (text.includes(k)) score += 4;
  for (const k of KEYWORDS.usa) if (text.includes(k)) score += 3;
  for (const k of KEYWORDS.world) if (text.includes(k)) score += 1;
  // topic boosts
  for (const k of TOPICS.politics) if (text.includes(k)) score += 5;
  for (const k of TOPICS.culture) if (text.includes(k)) score += 3;
  // penalize general Meduza if not about Latvia/ES/Russia
  if (item.source && item.source.toLowerCase().includes("meduza")) {
    if (score < 6) score -= 6; // понижаем не-латвийские медузные тексты
  }
  // penalize blacklisted domains
  for (const b of BLACKLIST_SOURCES) if ((item.link||"").includes(b)) score -= 20;
  return score;
}

// Примитивный summary (локальный)
function localSummary(text) {
  if (!text) return "";
  // берем первые 25 слов, убираем теги
  const stripped = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const words = stripped.split(" ");
  return words.slice(0, 25).join(" ") + (words.length > 25 ? "..." : "");
}

// Попытка достать картинку из item
function pickImage(it) {
  if (!it) return null;
  if (it.image) return it.image;
  if (it.enclosure && it.enclosure.url) return it.enclosure.url;
  if (it["media:content"] && it["media:content"].url) return it["media:content"].url;
  // некоторые RSS помещают картинку в content (img tag)
  const content = it.content || it.contentSnippet || "";
  const m = content.match(/<img[^>]+src="([^"]+)"/i);
  if (m) return m[1];
  return null;
}

// нормализация элементов
function normalizeItems(feed, items) {
  return (items || []).map(it => {
    const idRaw = it.guid || it.id || it.link || it.title;
    const id = `${feed.id}::${(idRaw || "").toString().slice(0,200)}`;
    const summary = localSummary(it.contentSnippet || it.content || "");
    const image = pickImage(it);
    return {
      id,
      source: feed.title,
      title: it.title || "(без заголовка)",
      rawContent: it.content || it.contentSnippet || "",
      summary,
      link: it.link || null,
      pubDate: it.pubDate ? new Date(it.pubDate).toISOString() : null,
      image
    };
  });
}

// Fetch feeds and smart select items
async function fetchFeeds() {
  try {
    const seen = new Set(cache.items.map(i => i.id));
    for (const feed of FEEDS) {
      try {
        const parsed = await parser.parseURL(feed.url);
        const normalized = normalizeItems(feed, parsed.items || []);
        for (const it of normalized) {
          if (!seen.has(it.id)) {
            // compute score
            const sc = scoreItem(it);
            // include if score positive OR source is local latvian (give benefit)
            const include = sc > 0 || feed.id.includes("rus-lsm") || feed.id.includes("delfi");
            if (include) {
              it.score = sc;
              cache.items.unshift(it);
              seen.add(it.id);
            }
          }
        }
      } catch (e) {
        console.warn("Feed error:", feed.url, e.message || e);
      }
    }
    // сортируем по score + date
    cache.items.sort((a,b) => {
      const sa = (a.score || 0);
      const sb = (b.score || 0);
      if (sb !== sa) return sb - sa;
      const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return db - da;
    });
    cache.items = cache.items.slice(0, 800);
    cache.lastFetched = new Date().toISOString();
  } catch (e) {
    console.error("FetchFeeds all error", e);
  }
}

// AI: translate+summarize using OpenAI if key present
async function aiSummarizeAndMaybeTranslate(id, title, rawContent, langHint) {
  if (!OPENAI_KEY) {
    // no AI key -> return local fallback
    return {
      title: title,
      summary: localSummary(rawContent),
      lang: langHint || "ru"
    };
  }
  if (aiCache[id]) return aiCache[id];
  try {
    // prepare prompt
    const system = "Ты помогаешь сжато перефразировать и переводить новостные заголовки и тексты. " +
      "Выдавай JSON с полями: title, summary (не более 2-3 предложений), language (код). " +
      "Если текст на другом языке — переведи заголовок и summary на русский.";
    const user = `Заголовок: ${title}\n\nТекст: ${rawContent}\n\nИнструкция: дай короткий русский заголовок (одна строка), затем 1-2 предложения краткого саммари, максимально по сути. Ответ — только JSON.`;
    const body = {
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_tokens: 300,
      temperature: 0.2
    };

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(body)
    });
    const j = await resp.json();
    const txt = j?.choices?.[0]?.message?.content || "";
    // Попытка распарсить JSON, иначе взять fallback
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch (e) {
      // если не JSON — попробуем выделить строки
      parsed = { title: title, summary: localSummary(rawContent), language: langHint || "ru" };
    }
    const out = {
      title: (parsed.title || title).toString(),
      summary: (parsed.summary || localSummary(rawContent)).toString(),
      language: parsed.language || langHint || "ru"
    };
    aiCache[id] = out;
    return out;
  } catch (e) {
    console.warn("AI error", e.message || e);
    return { title, summary: localSummary(rawContent), language: langHint || "ru" };
  }
}

// initial fetch
setInterval(fetchFeeds, 2 * 60 * 1000); // 2 минуты
fetchFeeds();

// API: get items, optional filtering params
app.get("/api/items", async (req, res) => {
  const region = (req.query.region || "all").toLowerCase(); // latvia, eu, russia, usa, world, all
  const topic = (req.query.topic || "all").toLowerCase(); // politics, culture, all
  const limit = Math.min(parseInt(req.query.limit || "80", 10), 400);

  // filter by region/topic via keywords
  const items = [];
  for (const it of cache.items) {
    // match region
    const text = (it.title + " " + it.summary + " " + (it.rawContent || "")).toLowerCase();
    let regionMatch = false;
    if (region === "all") regionMatch = true;
    else if (region === "latvia") for (const k of KEYWORDS.latvia) if (text.includes(k)) regionMatch = true;
    else if (region === "eu") for (const k of KEYWORDS.eu) if (text.includes(k)) regionMatch = true;
    else if (region === "russia") for (const k of KEYWORDS.russia) if (text.includes(k)) regionMatch = true;
    else if (region === "usa") for (const k of KEYWORDS.usa) if (text.includes(k)) regionMatch = true;
    else if (region === "world") regionMatch = true;

    if (!regionMatch) continue;

    // match topic
    let topicMatch = false;
    if (topic === "all") topicMatch = true;
    else if (topic === "politics") for (const k of TOPICS.politics) if (text.includes(k)) topicMatch = true;
    else if (topic === "culture") for (const k of TOPICS.culture) if (text.includes(k)) topicMatch = true;

    if (!topicMatch) continue;

    items.push(it);
    if (items.length >= limit) break;
  }

  // For items, attach AI summary/translation if available or fallback
  const out = [];
  for (const it of items) {
    // if ai enabled, enrich (but do not await all parallel — do sequential small batching)
    let enriched = { title: it.title, summary: it.summary, language: "ru" };
    if (OPENAI_KEY) {
      // affordable: call AI only if not in cache
      enriched = await aiSummarizeAndMaybeTranslate(it.id, it.title, it.rawContent || it.summary, it.lang || "unknown");
    }
    out.push({
      id: it.id,
      source: it.source,
      title: enriched.title,
      summary: enriched.summary,
      link: it.link,
      pubDate: it.pubDate,
      image: it.image
    });
  }

  res.json({ items: out, total: out.length, lastFetched: cache.lastFetched });
});

// Frontend (single page)
app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<title>Мешечкины Новости</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
:root{--bg:#f5f6f7;--card:#fff;--muted:#666;--accent:#0b66ff}
body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial;}
header{background:#111;color:#fff;padding:18px 12px;text-align:center}
header h1{margin:0;font-size:20px}
.container{max-width:1100px;margin:18px auto;padding:0 12px}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:14px}
.left{display:flex;gap:8px;flex-wrap:wrap}
.filter-btn{background:#eee;border:0;padding:8px 10px;border-radius:8px;cursor:pointer}
.filter-btn.active{background:#111;color:#fff}
.topic-select{padding:8px;border-radius:8px;border:1px solid #ddd}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{background:var(--card);border-radius:12px;overflow:hidden;box-shadow:0 6px 18px rgba(10,10,10,0.06);cursor:pointer;display:flex;flex-direction:column}
.card img{width:100%;height:160px;object-fit:cover}
.card .c{padding:12px;display:flex;flex-direction:column;gap:8px}
.meta{font-size:12px;color:var(--muted)}
.title{font-size:15px;margin:0;color:#111}
.summary{font-size:13px;color:#333}
.footer{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}
.topics {display:flex;gap:8px}
.small{font-size:12px;color:#999}
.badge{background:#eef6ff;color:#036;padding:4px 8px;border-radius:999px;font-size:12px}
.empty{padding:24px;text-align:center;color:#666}
</style>
</head>
<body>
<header>
  <h1>Мешечкины Новости — Латвия, Рига, ЕС, Россия, Мир</h1>
</header>
<div class="container">
  <div class="controls">
    <div class="left">
      <button class="filter-btn active" data-region="all">Все</button>
      <button class="filter-btn" data-region="latvia">Латвия</button>
      <button class="filter-btn" data-region="eu">ЕвроСоюз</button>
      <button class="filter-btn" data-region="usa">Америка</button>
      <button class="filter-btn" data-region="russia">Россия</button>
      <button class="filter-btn" data-region="world">Мир</button>
      <select id="topic" class="topic-select">
        <option value="all">Все темы</option>
        <option value="politics">Политика</option>
        <option value="culture">Культура</option>
      </select>
    </div>
    <div class="right small">
      <span id="last">загрузка…</span>
    </div>
  </div>

  <div id="grid" class="grid"></div>
  <div id="empty" class="empty" style="display:none">Нет новостей по фильтру.</div>
</div>

<script>
let region = 'all';
let topic = 'all';
const grid = document.getElementById('grid');
const last = document.getElementById('last');
const empty = document.getElementById('empty');

async function load() {
  grid.innerHTML = '<div class="empty">Загрузка...</div>';
  const res = await fetch('/api/items?region=' + region + '&topic=' + topic + '&limit=120');
  const j = await res.json();
  last.innerText = 'Последнее обновление: ' + (j.lastFetched ? new Date(j.lastFetched).toLocaleString() : '-');
  render(j.items || []);
}

function render(items) {
  grid.innerHTML = '';
  if (!items || items.length === 0) {
    empty.style.display = 'block';
    return;
  } else empty.style.display = 'none';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'card';
    el.onclick = () => { if (it.link) window.open(it.link, '_blank'); };
    el.innerHTML = (it.image ? '<img src="' + it.image + '" alt="">' : '') +
      '<div class="c">' +
      '<div class="meta"><span class="badge">' + it.source + '</span> · ' + (it.pubDate ? new Date(it.pubDate).toLocaleString() : '') + '</div>' +
      '<div class="title">' + escapeHtml(it.title) + '</div>' +
      '<div class="summary">' + escapeHtml(it.summary) + '</div>' +
      '<div class="footer"><div class="small">ID: ' + (it.id ? it.id.slice(0,6) : '') + '</div><div class="small">Подробнее: нажми карточку</div></div>'+
      '</div>';
    grid.appendChild(el);
  }
}

function escapeHtml(s){ if(!s) return ''; return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// filter btns
document.querySelectorAll('.filter-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    region = b.getAttribute('data-region') || 'all';
    load();
  });
});
document.getElementById('topic').addEventListener('change', (e) => { topic = e.target.value; load(); });

// initial
load();

// auto-refresh every 90s in background (not disruptive)
setInterval(load, 90*1000);
</script>
</body>
</html>`);
});

// start
app.listen(PORT, () => console.log("Мешечкины Новости запущены на порту " + PORT));
