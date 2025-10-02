const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");

const app = express();
const parser = new Parser({ timeout: 10000 });
app.use(cors());

const PORT = process.env.PORT || 3000;

const FEEDS = [
  { id: "rus-lsm", title: "Rus.LSM", url: "https://rus.lsm.lv/rss" },
  { id: "delfi-ru", title: "Delfi (rus)", url: "https://rus.delfi.lv/rss" },
  { id: "meduza", title: "Meduza", url: "https://meduza.io/rss/all" },
  { id: "press-lv", title: "Press.lv", url: "https://press.lv/feed" },
  { id: "bb-lv", title: "BB.lv", url: "https://bb.lv/feed" }
];

let cache = { items: [], lastFetched: null };

function makeSummary(text) {
  if (!text) return "";
  // примитивная "сжатая версия": первые 20 слов
  return text.split(" ").slice(0, 20).join(" ") + "...";
}

function normalizeItems(feed, items) {
  return items.map((it) => ({
    id: `${feed.id}::${it.guid || it.link || it.title}`,
    source: feed.title,
    title: it.title || "(без заголовка)",
    summary: makeSummary(it.contentSnippet || it.content || ""),
    link: it.link || null,
    pubDate: it.pubDate ? new Date(it.pubDate).toISOString() : null,
    image: it.enclosure?.url || it["media:content"]?.url || null
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

setInterval(fetchFeeds, 180000);
fetchFeeds();

app.get("/api/items", (req, res) => {
  res.json({
    items: cache.items,
    total: cache.items.length,
    lastFetched: cache.lastFetched
  });
});

// --- Фронт ---
app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<title>Новости Латвии (рус.)</title>
<style>
body { font-family: system-ui, sans-serif; margin:0; background:#f5f6f7; color:#222; }
header { background:#2a2a2a; color:#fff; padding:16px; text-align:center; }
h1 { margin:0; font-size:22px; }
main { max-width:1000px; margin:0 auto; padding:16px; }
.filters { margin-bottom:16px; text-align:center; }
button.filter { margin:0 6px; padding:6px 12px; border:none; border-radius:6px;
  background:#ddd; cursor:pointer; }
button.active { background:#444; color:#fff; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
.card { background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.1); display:flex; flex-direction:column; }
.card img { width:100%; height:160px; object-fit:cover; }
.card .content { padding:12px; flex:1; display:flex; flex-direction:column; }
.card .meta { font-size:12px; color:#666; margin-bottom:6px; }
.card h3 { margin:0 0 8px; font-size:16px; }
.card p { flex:1; margin:0 0 12px; font-size:14px; color:#444; }
.card a { align-self:flex-start; text-decoration:none; color:#0645ad; font-weight:bold; }
</style>
</head>
<body>
<header><h1>Новости Латвии (рус.)</h1></header>
<main>
<div class="filters">
  <button class="filter active" onclick="setFilter('all')">Все</button>
  <button class="filter" onclick="setFilter('latvia')">Латвия</button>
  <button class="filter" onclick="setFilter('riga')">Рига</button>
  <button class="filter" onclick="setFilter('politics')">Политика</button>
</div>
<div class="grid" id="grid">Загрузка...</div>
</main>
<script>
let currentFilter = 'all';

function setFilter(f) {
  currentFilter = f;
  for (const btn of document.querySelectorAll('.filter')) {
    btn.classList.remove('active');
    if (btn.textContent.toLowerCase().includes(f)) btn.classList.add('active');
    if (f==='all' && btn.textContent==='Все') btn.classList.add('active');
  }
  render(window.items);
}

async function load() {
  const res = await fetch('/api/items');
  const data = await res.json();
  window.items = data.items;
  render(data.items);
}
function matchesFilter(item){
  const t = (item.title + " " + item.summary).toLowerCase();
  if (currentFilter==='latvia') return t.includes('латви');
  if (currentFilter==='riga') return t.includes('рига');
  if (currentFilter==='politics') return t.includes('полит');
  return true;
}
function render(items){
  const grid = document.getElementById('grid');
  grid.innerHTML='';
  for(const it of items){
    if (!matchesFilter(it)) continue;
    const el = document.createElement('div');
    el.className='card';
    el.innerHTML = (it.image ? '<img src="'+it.image+'" alt="">' : '') +
    '<div class="content">'+
    '<div class="meta">'+it.source+' · '+(it.pubDate?new Date(it.pubDate).toLocaleDateString("ru-RU"):"")+'</div>'+
    '<h3>'+it.title+'</h3>'+
    (it.summary?'<p>'+it.summary+'</p>':'')+
    '<a href="'+it.link+'" target="_blank">Читать</a>'+
    '</div>';
    grid.appendChild(el);
  }
}
load();
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
