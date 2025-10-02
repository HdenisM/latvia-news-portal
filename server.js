const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");

const app = express();
const parser = new Parser({ timeout: 10000 });
app.use(cors());

const PORT = process.env.PORT || 3000;

// --- Источники новостей ---
const FEEDS = [
  { id: "rus-lsm", title: "Rus.LSM", url: "https://rus.lsm.lv/rss" },
  { id: "delfi-ru", title: "Delfi (rus)", url: "https://rus.delfi.lv/rss" },
  { id: "meduza", title: "Meduza", url: "https://meduza.io/rss/all" },
  { id: "press-lv", title: "Press.lv", url: "https://press.lv/feed" },
  { id: "bb-lv", title: "BB.lv", url: "https://bb.lv/feed" }
];

let cache = { items: [], lastFetched: null };

function normalizeItems(feed, items) {
  return items.map((it) => ({
    id: `${feed.id}::${it.guid || it.link || it.title}`,
    source: feed.title,
    title: it.title || "(без заголовка)",
    link: it.link || null,
    pubDate: it.pubDate ? new Date(it.pubDate).toISOString() : null
  }));
}

async function fetchFeeds() {
  const seen = new Set(cache.items.map((i) => i.id));
  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const normalized = normalizeItems(feed, parsed.items || []);
      for (const it of normalized) {
        if (!seen.has(it.id)) {
          cache.items.unshift(it);
          seen.add(it.id);
        }
      }
    } catch (e) {
      console.error("Ошибка загрузки", feed.url, e.message);
    }
  }
  cache.items = cache.items.slice(0, 500);
  cache.lastFetched = new Date().toISOString();
}

setInterval(fetchFeeds, 180000); // каждые 3 минуты
fetchFeeds();

// --- API ---
app.get("/api/items", (req, res) => {
  res.json({
    items: cache.items,
    total: cache.items.length,
    lastFetched: cache.lastFetched
  });
});

// --- Простой фронт ---
app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<title>Новости Латвии (рус.)</title>
<style>
body { font-family: sans-serif; margin:0; padding:0; background:#f7f7f7 }
header { background:#222; color:#fff; padding:10px 16px; }
main { max-width:900px; margin:0 auto; padding:16px; }
.item { background:#fff; padding:12px; margin:8px 0; border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,0.1) }
.meta { font-size:12px; color:#555; margin-bottom:4px }
a { color:#0645ad; text-decoration:none }
a:hover { text-decoration:underline }
</style>
</head>
<body>
<header><h2>Новости Латвии (рус.)</h2></header>
<main id="list">Загрузка...</main>
<script>
async function load(){
  const res = await fetch('/api/items');
  const data = await res.json();
  const list = document.getElementById('list');
  list.innerHTML = '';
  for(const it of data.items){
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = '<div class="meta">'+it.source+' · '+(it.pubDate?new Date(it.pubDate).toLocaleString():'')+'</div>'+
                   '<div><a href="'+it.link+'" target="_blank">'+it.title+'</a></div>';
    list.appendChild(el);
  }
}
load();
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
