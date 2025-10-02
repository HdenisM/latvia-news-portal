const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const parser = new Parser({ timeout: 15000 });
app.use(cors());

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// --- Источники
const FEEDS = [
  { id: "rus-lsm", title: "Rus.LSM", url: "https://rus.lsm.lv/rss", lang: "ru" },
  { id: "delfi-latvia", title: "Delfi Latvia", url: "https://rus.delfi.lv/rss/?channel=latvia", lang: "ru" },
  { id: "meduza", title: "Meduza", url: "https://meduza.io/rss/all", lang: "ru" },
  { id: "bbc-world", title: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", lang: "en" },
  { id: "euronews-world", title: "Euronews", url: "https://www.euronews.com/rss?level=2&format=atom", lang: "en" },
  { id: "reuters-world", title: "Reuters World", url: "https://www.reutersagency.com/feed/?best-topics=world", lang: "en" },
  { id: "politico-europe", title: "Politico Europe", url: "https://www.politico.eu/rss-feed/", lang: "en" }
];

// Чёрный список
const BLACKLIST_SOURCES = ["rbc.ru", "foxnews.com", "ria.ru"];

// Ключевые слова
const KEYWORDS = {
  latvia: ["латви", "riga", "рига", "рīga", "ри́га"],
  eu: ["евро", "евросоюз", "eu", "european union", "brussels", "nato", "schengen"],
  russia: ["росси", "russia", "москва", "moscow"],
  usa: ["сша", "америк", "usa", "united states", "washington", "washington dc"],
  world: ["мир", "world", "global"]
};
const TOPICS = {
  politics: ["политик", "government", "parliament", "prime minister", "president", "правительств"],
  culture: ["культ", "фестив", "концерт", "театр", "музей", "culture", "festival"]
};

let cache = { items: [], lastFetched: null };
let aiCache = {};

function textLower(s) { return (s || "").toString().toLowerCase(); }
function localSummary(text) { if (!text) return ""; return text.replace(/<[^>]+>/g, "").split(" ").slice(0,25).join(" ") + "..."; }
function pickImage(it){
  if(it.image) return it.image;
  if(it.enclosure?.url) return it.enclosure.url;
  if(it["media:content"]?.url) return it["media:content"].url;
  const m=(it.content||it.contentSnippet||"").match(/<img[^>]+src="([^"]+)"/i); if(m) return m[1]; return null;
}

function scoreItem(item){
  const text = (item.title + " " + item.summary + " " + (item.content || "")).toLowerCase();
  let score=0;
  for(const k of KEYWORDS.latvia) if(text.includes(k)) score+=10;
  for(const k of KEYWORDS.eu) if(text.includes(k)) score+=6;
  for(const k of KEYWORDS.russia) if(text.includes(k)) score+=4;
  for(const k of KEYWORDS.usa) if(text.includes(k)) score+=3;
  for(const k of KEYWORDS.world) if(text.includes(k)) score+=1;
  for(const k of TOPICS.politics) if(text.includes(k)) score+=5;
  for(const k of TOPICS.culture) if(text.includes(k)) score+=3;
  if(item.source?.toLowerCase().includes("meduza") && score<6) score-=6;
  for(const b of BLACKLIST_SOURCES) if((item.link||"").includes(b)) score-=20;
  return score;
}

function normalizeItems(feed, items){
  return (items||[]).map(it=>{
    const id = `${feed.id}::${(it.guid||it.id||it.link||it.title||"").toString().slice(0,200)}`;
    const summary = localSummary(it.contentSnippet||it.content||"");
    const image = pickImage(it);
    return {
      id,
      source: feed.title,
      title: it.title||"(без заголовка)",
      rawContent: it.content||it.contentSnippet||"",
      summary,
      link: it.link||null,
      pubDate: it.pubDate?new Date(it.pubDate).toISOString():null,
      image
    };
  });
}

async function fetchFeeds(){
  try{
    const seen = new Set(cache.items.map(i=>i.id));
    for(const feed of FEEDS){
      try{
        const parsed = await parser.parseURL(feed.url);
        const normalized = normalizeItems(feed, parsed.items||[]);
        for(const it of normalized){
          if(!seen.has(it.id)){
            const sc=scoreItem(it);
            const include = sc>0 || feed.id.includes("rus-lsm") || feed.id.includes("delfi");
            if(include){ it.score=sc; cache.items.unshift(it); seen.add(it.id);}
          }
        }
      }catch(e){ console.warn("Feed error:",feed.url,e.message||e);}
    }
    cache.items.sort((a,b)=>{
      const sa=a.score||0,sb=b.score||0;
      if(sb!==sa) return sb-sa;
      return (new Date(b.pubDate).getTime()||0)-(new Date(a.pubDate).getTime()||0);
    });
    cache.items=cache.items.slice(0,800);
    cache.lastFetched=new Date().toISOString();
  }catch(e){ console.error("FetchFeeds error",e);}
}

setInterval(fetchFeeds, 2*60*1000);
fetchFeeds();

async function aiSummarizeAndMaybeTranslate(id,title,rawContent,langHint){
  if(!OPENAI_KEY) return {title,summary:localSummary(rawContent),language:langHint||"ru"};
  if(aiCache[id]) return aiCache[id];
  try{
    const system="Ты делаешь краткое резюме и перевод новостей на русский, JSON: {title,summary,language}";
    const user=`Заголовок: ${title}\nТекст: ${rawContent}`;
    const body={model:OPENAI_MODEL,messages:[{role:"system",content:system},{role:"user",content:user}],max_tokens:300,temperature:0.2};
    const resp = await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${OPENAI_KEY}`},body:JSON.stringify(body)});
    const j=await resp.json();
    const txt=j?.choices?.[0]?.message?.content||"";
    let parsed=null;
    try{parsed=JSON.parse(txt);}catch(e){parsed={title,title,summary:localSummary(rawContent),language:langHint||"ru"};}
    const out={title:(parsed.title||title).toString(),summary:(parsed.summary||localSummary(rawContent)).toString(),language:parsed.language||langHint||"ru"};
    aiCache[id]=out;
    return out;
  }catch(e){console.warn("AI error",e.message||e); return {title,summary:localSummary(rawContent),language:langHint||"ru"};}
}

app.get("/api/items",async(req,res)=>{
  const region=(req.query.region||"all").toLowerCase();
  const topic=(req.query.topic||"all").toLowerCase();
  const limit=Math.min(parseInt(req.query.limit||"80",10),400);
  const items=[];
  for(const it of cache.items){
    const text=(it.title+" "+it.summary+" "+(it.rawContent||"")).toLowerCase();
    let regionMatch=false;
    if(region==="all") regionMatch=true;
    else if(region==="latvia") for(const k of KEYWORDS.latvia) if(text.includes(k)) regionMatch=true;
    else if(region==="eu") for(const k of KEYWORDS.eu) if(text.includes(k)) regionMatch=true;
    else if(region==="russia") for(const k of KEYWORDS.russia) if(text.includes(k)) regionMatch=true;
    else if(region==="usa") for(const k of KEYWORDS.usa) if(text.includes(k)) regionMatch=true;
    else if(region==="world") regionMatch=true;
    if(!regionMatch) continue;
    let topicMatch=false;
    if(topic==="all") topicMatch=true;
    else if(topic==="politics") for(const k of TOPICS.politics) if(text.includes(k)) topicMatch=true;
    else if(topic==="culture") for(const k of TOPICS.culture) if(text.includes(k)) topicMatch=true;
    if(!topicMatch) continue;
    items.push(it);
    if(items.length>=limit) break;
  }

  const out=[];
  for(const it of items){
    const enriched = await aiSummarizeAndMaybeTranslate(it.id,it.title,it.rawContent||it.summary,it.lang||"unknown");
    out.push({
      id:it.id,source:it.source,title:enriched.title,summary:enriched.summary,link:it.link,pubDate:it.pubDate,image:it.image
    });
  }
  res.json({items:out,total:out.length,lastFetched:cache.lastFetched});
});

app.get("/",(req,res)=>{
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
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.filter{padding:6px 12px;border-radius:8px;background:#eee;cursor:pointer}
.filter.active{background:var(--accent);color:#fff}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:var(--card);border-radius:12px;overflow:hidden;
box-shadow:0 6px 18px rgba(10,10,10,0.06);cursor:pointer;
display:flex;flex-direction:column;transition:transform 0.2s ease, box-shadow 0.2s ease;}
.card:hover{transform:scale(1.02);box-shadow:0 8px 20px rgba(10,10,10,0.12);}
.card img{width:100%;height:160px;object-fit:cover}
.card .content{padding:8px;flex-grow:1}
.card .title{font-weight:600;font-size:16px;margin-bottom:4px}
.card .summary{font-size:14px;color:var(--muted)}
.card .footer{font-size:12px;color:var(--muted);padding:4px 8px;text-align:right}
.empty{padding:20px;color:var(--muted);text-align:center}
</style>
</head>
<body>
<header><h1>Мешечкины Новости</h1></header>
<div class="container">
<div class="filters">
  <div class="filter active" data-region="all" data-topic="all">Все</div>
  <div class="filter" data-region="latvia" data-topic="all">Латвия</div>
  <div class="filter" data-region="eu" data-topic="all">Евросоюз</div>
  <div class="filter" data-region="usa" data-topic="all">Америка</div>
  <div class="filter" data-region="russia" data-topic="all">Россия</div>
  <div class="filter" data-region="world" data-topic="all">Мир</div>
</div>
<div class="filters">
  <div class="filter active" data-topic="all">Все темы</div>
  <div class="filter" data-topic="politics">Политика</div>
  <div class="filter" data-topic="culture">Культура</div>
</div>
<div class="empty" style="display:none">Загрузка...</div>
<div class="cards"></div>
</div>
<script>
let activeRegion="all",activeTopic="all";
const filters=document.querySelectorAll(".filter");
filters.forEach(f=>f.addEventListener("click",e=>{
  const r=f.dataset.region,t=f.dataset.topic;
  if(r) activeRegion=r;
  if(t) activeTopic=t;
  filters.forEach(x=>x.classList.remove("active"));
  filters.forEach(x=>{if(x.dataset.region===activeRegion||x.dataset.topic===activeTopic)x.classList.add("active")});
  loadItems();
}));
async function loadItems(){
  const cards=document.querySelector(".cards");
  const empty=document.querySelector(".empty");
  cards.innerHTML=""; empty.style.display="block"; empty.innerText="Загрузка...";
  try{
    const resp=await fetch("/api/items?region="+activeRegion+"&topic="+activeTopic+"&limit=80");
    const j=await resp.json();
    if(!j.items || !j.items.length){ empty.style.display="block"; empty.innerText="Не найдено по выбранному фильтру, показываются все новости."; return;}
    empty.style.display="none";
    for(const it of j.items){
      const c=document.createElement("div"); c.className="card";
      if(it.link)c.addEventListener("click",()=>window.open(it.link,"_blank"));
      let imgHTML=it.image?'<img src="'+it.image+'"/>':'';
      c.innerHTML=imgHTML+'<div class="content"><div class="title">'+it.title+'</div><div class="summary">'+it.summary+'</div></div><div class="footer">'+it.source+'</div>';
      cards.appendChild(c);
    }
  }catch(e){ empty.style.display="block"; empty.innerText="Ошибка загрузки новостей.";}
}
loadItems();
</script>
</body>
</html>
`);
});

app.listen(PORT,()=>console.log(`Мешечкины Новости запущены на порту ${PORT}`));
