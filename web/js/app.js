/* SAFI TV+ Smart Box — TV remote navigation + HLS player */
"use strict";
/* Safe storage wrapper: never let blocked localStorage kill startup */
const store=(()=>{ try{ const ls=window.localStorage; ls.setItem("__safi_t","1"); ls.removeItem("__safi_t"); return ls; }catch(e){ const m={}; return {getItem:k=>(k in m?m[k]:null), setItem:(k,v)=>{m[k]=String(v)}, removeItem:k=>{delete m[k]}, clear:()=>{for(const k in m) delete m[k]}}; } })();

/* ---------- Defensive data loading: bad local data can never crash startup ---------- */
function readJSON(key, fallback){
  try{ const v=JSON.parse(store.getItem(key)||"null"); return v===null?fallback:v; }
  catch(e){ try{store.removeItem(key);}catch(_){ } return fallback; }
}
function cleanText(v,max){
  return typeof v==="string" ? v.replace(/[\u0000-\u001F\u007F]/g," ").replace(/\s+/g," ").trim().slice(0,max||160) : "";
}
function safeHttpUrl(v,httpsOnly){
  if(typeof v!=="string" || v.length>4096) return "";
  try{
    const u=new URL(v.trim());
    if(!/^https?:$/.test(u.protocol) || u.username || u.password) return "";
    if(httpsOnly && u.protocol!=="https:") return "";
    return u.toString();
  }catch(e){ return ""; }
}
function sanitizeStoredChannel(c,isRadio){
  if(!c || typeof c!=="object" || Array.isArray(c)) return null;
  const n=cleanText(c.n,120), u=safeHttpUrl(c.u,false);
  if(!n||!u) return null;
  const out={n,u};
  out.type=isRadio?"radio":(["hls","embed","mp4"].includes(c.type)?c.type:"hls");
  out.c=cleanText(c.c,60)||(isRadio?"Radio":"World TV");
  out.d=cleanText(c.d,180); out.co=cleanText(c.co,80); out.logo=safeHttpUrl(c.logo,false);
  if(isRadio){ out.g=cleanText(c.g,60)||"Radio"; out.f=cleanText(c.f,40); }
  if(c.src==="scan"||c.src==="world") out.src=c.src;
  if(Array.isArray(c.b)){
    const b=[...new Set(c.b.map(x=>safeHttpUrl(x,false)).filter(x=>x&&x!==u))].slice(0,3);
    if(b.length) out.b=b;
  }
  const e=safeHttpUrl(c.e,true); if(e) out.e=e;
  return out;
}
function sanitizeChannelList(list,isRadio,limit){
  if(!Array.isArray(list)) return [];
  const seen=new Set(), out=[];
  for(const raw of list){
    const c=sanitizeStoredChannel(raw,isRadio); if(!c) continue;
    const k=c.u.toLowerCase(); if(seen.has(k)) continue;
    seen.add(k); out.push(c);
    if(out.length>=(limit||1500)) break;
  }
  return out;
}
function sanitizeHistory(list){
  if(!Array.isArray(list)) return [];
  return list.filter(x=>x&&typeof x==="object"&&typeof x.kind==="string"&&typeof x.name==="string")
    .map(x=>({kind:cleanText(x.kind,20),name:cleanText(x.name,160),pos:Number.isFinite(+x.pos)?Math.max(0,+x.pos):0,at:Number.isFinite(+x.at)?+x.at:Date.now()}))
    .filter(x=>x.name).slice(0,24);
}
let __lastRecoverToast=0;
function reportRecoverableError(err){
  try{ console.warn("[SAFI recovered]",err); }catch(_){ }
  try{ if(window.__safiRemoveSplash) window.__safiRemoveSplash(); }catch(_){ }
  try{
    if(typeof toast==="function" && Date.now()-__lastRecoverToast>6000){
      __lastRecoverToast=Date.now();
      toast("⚠️ A small screen error was recovered — SAFI TV+ is still running",3500);
    }
  }catch(_){ }
}
window.addEventListener("error",e=>{ if(e && e.error && e.error.name!=="NotAllowedError") reportRecoverableError(e.error); });
window.addEventListener("unhandledrejection",e=>{ try{e.preventDefault();}catch(_){ } reportRecoverableError(e.reason||e); });

let myChannels = sanitizeChannelList(readJSON("safi_my_channels",[]),false,3000);
let scanChannels = sanitizeChannelList(readJSON("safi_scan_channels",[]),false,1500);
let scanRadio = sanitizeChannelList(readJSON("safi_scan_radio",[]),true,500);
function saveScanChannels(){ try{ store.setItem("safi_scan_channels",JSON.stringify(scanChannels.slice(0,1500))); }catch(e){ toast("⚠️ Auto-Scan storage is full — clear scanned channels in Auto-Scan",4000); } }
function saveScanRadio(){ try{ store.setItem("safi_scan_radio",JSON.stringify(scanRadio.slice(0,500))); }catch(e){} }
let favs = new Set((Array.isArray(readJSON("safi_favs",[]))?readJSON("safi_favs",[]):[]).filter(x=>typeof x==="string").slice(0,2000));
let currentList = [], currentIndex = -1, currentItem = null, hls = null, uiTimer = null, isEmbed = false;
let mediaRecorder = null, recChunks = [], recTimer = null, recStartedAt = 0, recTitle = "";
let lastObjectUrl = null, offlineCache = [];
let lowData = store.getItem("safi_lowdata")==="1";
let healthMap = (()=>{ const h=readJSON("safi_health",{}); return (h&&typeof h==="object"&&!Array.isArray(h))?h:{}; })();
let watchHistory = sanitizeHistory(readJSON("safi_history",[]));
let liveState = {cat:"All", q:"", sort:"smart", view:"grid", hideBad:false, limit:240, offset:0};
let boosterReady = false, doctorRunning = false;
let playSession = 0, attemptIdx = 0, attemptSources = [], attemptNet = 0, attemptMedia = 0, watchdog = null;
let playerBaseSub = "", playerTitle = "", lastPosSave = 0;
let digitBuffer = "", digitTimer = null, heroTimer = null, heroItems = [], heroIdx = 0;
let lastFocusByView = {};
let playerErrorOpen = false, lastErrorReason = "";
let radioState = {cat:"All", q:""};
let autoScanState = {scope:store.getItem("safi_scan_scope")||"kenya", limit:100, running:false, stop:false,
  tested:0,total:0,added:0,failed:0,skipped:0,current:"",results:[],lastMessage:""};
let autoScanMode = store.getItem("safi_autoscan_mode")||"auto"; // auto (default) | weekly | weeklyRadio | off
let playerMediaKind = "video";
let recAutoStopTimer = null, recKind = "Live TV recording";
let WORLD = [], worldLoaded = false, worldLoading = false, lastAllList = [];
let allState = {src:"safi", q:"", cat:"All", letter:"", limit:120, offset:0};
/* Audience collections: one tap blends the right categories for who's watching. */
const COLLECTIONS = {
  "👨‍👩‍👧 Family Time": ch=>["Kids","Education & Culture","Documentary","Gospel"].includes(ch.c),
  "🎉 With Friends": ch=>["Sports","Comedy","Music","Entertainment"].includes(ch.c),
  "🍿 Movie Night": ch=>["Movies","Classic TV"].includes(ch.c),
  "💃 Telenovela Nights": ch=>["Telenovelas","Soaps & Dramas"].includes(ch.c),
  "🧘 Solo & Relax": ch=>["Documentary","Lifestyle","Travel","Classic TV","Education & Culture"].includes(ch.c),
  "🇵🇭 Filipino Teleserye": ch=>ch.co==="Philippines"||/filam|pinoy|kapamilya|jeepney/i.test(ch.n)
};
const COLLECTION_NAMES = Object.keys(COLLECTIONS);
function isCollection(x){ return !!COLLECTIONS[x]; }
function collectionFilter(list,label){ const f=COLLECTIONS[label]; return f?list.filter(f):list; }
let bigText = store.getItem("safi_bigtext")==="1";
let noMotion = store.getItem("safi_nomotion")==="1";
function applyPrefs(){ document.body.classList.toggle("bigtext",bigText); document.body.classList.toggle("nomotion",noMotion); }
/* ---------- Language (Settings): English / Kiswahili / Francais ---------- */
let uiLang = store.getItem("safi_lang")||"en";
const LANG_NAMES = {en:"English", sw:"Kiswahili", fr:"Français"};
const I18N = {
 sw:{"Home":"Nyumbani","Live":"Moja kwa Moja","Radio":"Redio","Channels":"Vituo","Movies":"Filamu","Kids":"Watoto","Apps":"Programu",
 "Top picks for you":"Chaguo bora kwako","Your apps":"Programu zako","Who's watching?":"Nani anatizama?","Browse by Category":"Vinjari kwa Kundi",
 "Settings ⚙️":"Mipangilio ⚙️","Low-Data Mode":"Hali ya Data Kidogo","Channel Doctor":"Daktari wa Vituo","Large Text":"Maandishi Makubwa","Reduce Motion":"Punguza Mwendo",
 "All Channels A–Z":"Vituo Vyote A–Z","Storage & Offline":"Hifadhi na Nje ya Mtandao","Help & Guidance":"Usaidizi na Mwongozo","Language / Lugha":"Lugha",
 "Live TV Guide 📺":"Mwongozo wa TV 📺","Pick a channel":"Chagua kituo","All Channels ☰":"Vituo Vyote ☰","Radio 📻":"Redio 📻","Auto-Scan 🛰":"Auto-Scan 🛰",
 "Movies & Series":"Filamu na Mfululizo","Kids Zone 🧒":"Eneo la Watoto 🧒","Search 🔍":"Tafuta 🔍","My Favourites ★":"Vipendwa Vyangu ★","Offline / USB ⬇️":"Nje ya Mtandao / USB ⬇️",
 "Kenya":"Kenya","Africa":"Afrika","News":"Habari","Business":"Biashara","Sports":"Michezo","Series":"Mfululizo","Telenovelas":"Telenovela","Soaps & Dramas":"Sopu na Drama","Comedy":"Vichekesho","Anime & Toons":"Anime na Katuni","Music":"Muziki","Fashion":"Mitindo","Cooking & Food":"Mapishi na Chakula","Travel":"Usafiri","Lifestyle":"Maisha","Documentary":"Makala","Education & Culture":"Elimu na Utamaduni","Gospel":"Injili","Entertainment":"Burudani","Classic TV":"TV ya Zamani","World TV":"TV ya Dunia","All":"Vyote"},
 fr:{"Home":"Accueil","Live":"En direct","Radio":"Radio","Channels":"Chaînes","Movies":"Films","Kids":"Enfants","Apps":"Applis",
 "Top picks for you":"Sélection pour vous","Your apps":"Vos applis","Who's watching?":"Qui regarde ?","Browse by Category":"Parcourir par catégorie",
 "Settings ⚙️":"Réglages ⚙️","Low-Data Mode":"Mode éco données","Channel Doctor":"Docteur des chaînes","Large Text":"Grand texte","Reduce Motion":"Réduire les animations",
 "All Channels A–Z":"Toutes les chaînes A–Z","Storage & Offline":"Stockage et hors-ligne","Help & Guidance":"Aide et guide","Language / Lugha":"Langue",
 "Live TV Guide 📺":"Guide TV en direct 📺","Pick a channel":"Choisissez une chaîne","All Channels ☰":"Toutes les chaînes ☰","Radio 📻":"Radio 📻","Auto-Scan 🛰":"Auto-Scan 🛰",
 "Movies & Series":"Films et séries","Kids Zone 🧒":"Espace enfants 🧒","Search 🔍":"Rechercher 🔍","My Favourites ★":"Mes favoris ★","Offline / USB ⬇️":"Hors-ligne / USB ⬇️",
 "Kenya":"Kenya","Africa":"Afrique","News":"Infos","Business":"Économie","Sports":"Sport","Series":"Séries","Telenovelas":"Telenovelas","Soaps & Dramas":"Feuilletons et drames","Comedy":"Comédie","Anime & Toons":"Anime et dessins animés","Music":"Musique","Fashion":"Mode","Cooking & Food":"Cuisine","Travel":"Voyage","Lifestyle":"Art de vivre","Documentary":"Documentaire","Education & Culture":"Éducation et culture","Gospel":"Gospel","Entertainment":"Divertissement","Classic TV":"TV classique","World TV":"TV mondiale","All":"Tout"}
};
function applyLanguage(){
  document.documentElement.lang = uiLang==="sw"?"sw":uiLang==="fr"?"fr":"en";
  const dict=I18N[uiLang]; if(!dict) return;
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{
    acceptNode:n=>(n.parentElement&&!["SCRIPT","STYLE"].includes(n.parentElement.tagName))?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT});
  const nodes=[]; while(walker.nextNode()) nodes.push(walker.currentNode);
  for(const n of nodes){ const key=n.nodeValue.trim(); if(dict[key]) n.nodeValue=n.nodeValue.replace(key,dict[key]); }
  const ls=document.querySelector("#langState"); if(ls) ls.textContent=LANG_NAMES[uiLang]||"English";
}
function saveHealth(){ try{ store.setItem("safi_health", JSON.stringify(healthMap)); }catch(e){} }
function saveHistory(){ try{ store.setItem("safi_history", JSON.stringify(watchHistory.slice(0,24))); }catch(e){} }
function hueFor(str){ let h=0; for(let i=0;i<String(str).length;i++) h=(h*31+String(str).charCodeAt(i))%360; return h; }
function chGlobalNo(ch){
  if(ch && ch.src==="world"){ const i=WORLD.indexOf(ch); return i<0?"W":"W"+(i+1); }
  const i=allChannels().findIndex(c=>c.n===ch.n); return i<0?"":i+1;
}
function healthOf(name){ const h=healthMap[name]; if(!h) return ""; if(Date.now()-(h.t||0)>86400000) return ""; return h.s||""; }
function addHistory(kind,name,pos){
  const prev=watchHistory.find(x=>x.kind===kind&&x.name===name);
  watchHistory=[{kind,name,pos:pos!==undefined?pos:(prev?prev.pos:0),at:Date.now()},...watchHistory.filter(x=>!(x.kind===kind&&x.name===name))].slice(0,24);
  saveHistory();
}
function scoreChannel(ch){
  let s=0; const h=healthOf(ch.n);
  if(h==="ok")s+=6; else if(h==="boost")s+=4; else if(h==="embed")s+=2; else if(h==="fail")s-=8;
  if(ch.type==="embed")s+=2;
  if(ch.b)s+=Math.min(2,ch.b.length);
  if(/Not 24\/7/.test(ch.d||""))s-=3;
  if(favs.has(ch.n))s+=3;
  return s;
}
function smartSort(list){ return [...list].sort((a,b)=>scoreChannel(b)-scoreChannel(a)||a.n.localeCompare(b.n)); }
function isNativeApp(){ return location.hostname==="appassets.androidplatform.net"; }
function boosterLabel(){ if(isNativeApp()) return "⚡ Booster (APK)"; if(boosterReady) return "⚡ Booster"; return ""; }
/* NO-REDIRECT GUARD: this app must never leave itself. Block any stray external link. */
document.addEventListener("click", e=>{
  const a = e.target.closest && e.target.closest("a[href]");
  if(a){ e.preventDefault(); toast("🔒 External links are disabled — everything plays inside SAFI TV+"); }
}, true);
const $ = s => document.querySelector(s);
const allChannels = () => [...CHANNELS, ...scanChannels, ...myChannels];
const radioStations = () => [...(typeof RADIO_STATIONS!=="undefined"?RADIO_STATIONS:[]), ...scanRadio];
const everyChannel = () => [...allChannels(), ...WORLD];
function loadWorld(cb){
  if(worldLoaded){ if(cb) cb(true); return; }
  if(worldLoading){ setTimeout(()=>loadWorld(cb),400); return; }
  worldLoading=true;
  const s=document.createElement("script"); s.src="js/world-data.js";
  s.onload=()=>{
    worldLoading=false;
    try{
      WORLD=(window.WORLD_RAW||[]).map(r=>Array.isArray(r)?sanitizeStoredChannel({n:r[0],c:r[1],co:r[2],type:"hls",u:r[3],logo:r[4],d:r[5],b:r[6]?String(r[6]).split("|"):[],src:"world"},false):null).filter(Boolean);
      worldLoaded=true;
    }catch(e){ WORLD=[]; }
    if(cb) cb(worldLoaded);
  };
  s.onerror=()=>{ worldLoading=false; toast("🌍 World Directory could not load (js/world-data.js)"); if(cb) cb(false); };
  document.head.appendChild(s);
}
const esc = s => String(s??"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function toast(t,ms=2600){const el=$("#toast");el.textContent=t;el.classList.add("show");clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove("show"),ms);}
function saveFavs(){store.setItem("safi_favs",JSON.stringify([...favs]));}
function initials(n){return n.replace(/\(.*?\)/g,"").split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join("").toUpperCase();}

/* ---------- Clock (Africa/Nairobi) ---------- */
function tick(){
  const now=new Date();
  try{
    $("#clock").textContent=now.toLocaleTimeString("en-KE",{timeZone:"Africa/Nairobi",hour:"2-digit",minute:"2-digit"});
    $("#date").textContent=now.toLocaleDateString("en-KE",{timeZone:"Africa/Nairobi",weekday:"long",day:"numeric",month:"long",year:"numeric"});
  }catch(e){ $("#clock").textContent=now.toLocaleTimeString(); $("#date").textContent=now.toDateString(); }
}
setInterval(tick,1000);

/* ---------- Focus / Remote navigation ---------- */
function focusables(){return [...document.querySelectorAll(".focusable")].filter(el=>el.offsetParent!==null && !el.disabled && !el.closest(".hidden"));}
function updateFocusPreview(el){
  const box=$("#focusPreview"); if(!box||!el) return;
  const kind=el.dataset.kind, name=el.dataset.name; if(!name) return;
  if(kind==="channel"){
    const ch=everyChannel().find(c=>c.n===name); if(!ch) return;
    const h=healthOf(ch.n);
    box.innerHTML='<div class="pvLogo">'+esc(initials(ch.n))+'</div><div class="pvMain"><b>CH '+chGlobalNo(ch)+' • '+esc(ch.n)+'</b><span>'+esc(ch.c)+' • '+esc(ch.d||"")+(ch.b?' • '+(ch.b.length+1)+' sources (auto-switch)':'')+(h?' • Doctor: '+h:'')+'</span></div><div class="pvHint">OK ▶ Watch &nbsp;•&nbsp; F ★</div>';
  } else if(kind==="radio"){
    const st=radioStations().find(x=>x.n===name); if(!st) return;
    box.innerHTML='<div class="pvLogo">📻</div><div class="pvMain"><b>'+esc(st.n)+'</b><span>'+esc(st.f||"Online radio")+' • '+esc(st.g||"")+' • '+esc(st.co||"")+' — '+esc(st.d||"")+'</span></div><div class="pvHint">OK 📻 Listen &nbsp;•&nbsp; F ★</div>';
  } else if(kind==="movie"){
    const m=MOVIES.find(x=>x.t===name); if(!m) return;
    box.innerHTML='<div class="pvLogo">🎬</div><div class="pvMain"><b>'+esc(m.t)+'</b><span>'+m.y+' • '+esc(m.g)+' • ★ '+esc(m.r)+' — '+esc(m.d)+'</span></div><div class="pvHint">OK ▶ Play</div>';
  }
}
function setFocus(el){
  if(!el||el.disabled) return;
  if(currentView && (el.dataset.name||el.id)) lastFocusByView[currentView]=el.dataset.name||("#"+el.id);
  updateFocusPreview(el);
  document.querySelectorAll(".focused").forEach(x=>x.classList.remove("focused"));
  el.classList.add("focused");
  el.scrollIntoView({block:"nearest",inline:"nearest",behavior:"smooth"});
}
function move(dir){
  const cur=document.querySelector(".focused"); const els=focusables(); if(!els.length) return;
  if(!cur){setFocus(els[0]);return;}
  const r=cur.getBoundingClientRect(), cx=r.left+r.width/2, cy=r.top+r.height/2;
  let best=null,bestScore=Infinity;
  for(const el of els){
    if(el===cur) continue;
    const q=el.getBoundingClientRect(), x=q.left+q.width/2, y=q.top+q.height/2, dx=x-cx, dy=y-cy;
    if(dir==="left"&&dx>=-8) continue; if(dir==="right"&&dx<=8) continue;
    if(dir==="up"&&dy>=-8) continue; if(dir==="down"&&dy<=8) continue;
    const primary=(dir==="left"||dir==="right")?Math.abs(dx):Math.abs(dy);
    const secondary=(dir==="left"||dir==="right")?Math.abs(dy):Math.abs(dx);
    const score=primary+secondary*2.5;
    if(score<bestScore){bestScore=score;best=el;}
  }
  if(best) setFocus(best);
}
document.addEventListener("mouseover",e=>{const f=e.target.closest(".focusable"); if(f) setFocus(f);});
document.addEventListener("click",e=>{const f=e.target.closest(".focusable"); if(f){setFocus(f);}});

/* ---------- Rendering ---------- */
function healthBadge(ch){
  const h=healthOf(ch.n); const bits=[];
  bits.push('<span class="bdg b-live">● LIVE</span>');
  if(ch.co==="Kenya") bits.push('<span class="bdg b-ok">🇰🇪 Kenya</span>');
  if(ch.src==="world") bits.push('<span class="bdg b-mirror">🌍 World</span>');
  if(ch.src==="scan") bits.push('<span class="bdg b-boost">🛰 Auto-Scan</span>');
  if(ch.b&&ch.b.length) bits.push('<span class="bdg b-mirror">⇄ '+(ch.b.length+1)+' sources</span>');
  if(/Not 24\/7/.test(ch.d||"")) bits.push('<span class="bdg b-247">Not 24/7</span>');
  if(h==="ok") bits.push('<span class="bdg b-ok">✓ Working</span>');
  else if(h==="boost") bits.push('<span class="bdg b-boost">⚡ Booster</span>');
  else if(h==="fail") bits.push('<span class="bdg b-bad">✖ Offline (doctor)</span>');
  else if(h==="embed") bits.push('<span class="bdg b-boost">Embedded live</span>');
  return bits.join(" ");
}
function channelCard(ch,i){
  const fav=favs.has(ch.n)?'<span class="favstar">★</span>':"";
  const logo=ch.logo?`<img loading="lazy" decoding="async" src="${esc(ch.logo)}" alt="" onerror="this.outerHTML='<span class=&quot;initials&quot;>${esc(initials(ch.n))}</span>'">`:`<span class="initials">${esc(initials(ch.n))}</span>`;
  return `<button class="card focusable" style="--h:${hueFor(ch.n)}" data-kind="channel" data-name="${esc(ch.n)}">
    <div class="logo">${logo}</div>
    <span class="chno">CH ${chGlobalNo(ch)}</span>${fav}
    <h3>${esc(ch.n)}</h3>
    <div class="badges">${healthBadge(ch)}</div>
    <p>${esc(ch.c)} • ${esc(ch.d||"")}</p></button>`;
}
function channelRow(ch){
  const fav=favs.has(ch.n)?'<span class="favstar">★</span>':"";
  const logo=ch.logo?`<img loading="lazy" decoding="async" src="${esc(ch.logo)}" alt="" onerror="this.outerHTML='<span class=&quot;initials sm&quot;>${esc(initials(ch.n))}</span>'">`:`<span class="initials sm">${esc(initials(ch.n))}</span>`;
  return `<button class="grow focusable" style="--h:${hueFor(ch.n)}" data-kind="channel" data-name="${esc(ch.n)}">
    <span class="gno">${String(chGlobalNo(ch)).padStart(3,"0")}</span>
    <span class="glogo">${logo}</span>
    <span class="gmain"><b>${esc(ch.n)} ${fav}</b><small>${esc(ch.c)} • ${esc(ch.d||"")}</small></span>
    <span class="gbadges">${healthBadge(ch)}</span></button>`;
}
function radioBadge(st){
  const bits=['<span class="bdg b-live">● LIVE RADIO</span>'];
  if(st.co==="Kenya") bits.push('<span class="bdg b-ok">🇰🇪 Kenya</span>');
  else bits.push('<span class="bdg b-mirror">🌍 '+esc(st.co||"World")+'</span>');
  if(st.src==="scan") bits.push('<span class="bdg b-boost">🛰 Auto-Scan</span>');
  const h=healthOf(st.n);
  if(h==="ok") bits.push('<span class="bdg b-ok">✓ Working</span>');
  else if(h==="fail") bits.push('<span class="bdg b-bad">✖ Offline (last try)</span>');
  return bits.join(" ");
}
function radioCard(st){
  const fav=favs.has(st.n)?'<span class="favstar">★</span>':"";
  const logo=st.logo?`<img loading="lazy" decoding="async" src="${esc(st.logo)}" alt="" onerror="this.outerHTML='<span class=&quot;initials&quot;>📻</span>'">`:'<span class="initials">📻</span>';
  return `<button class="card radiocard focusable" style="--h:${hueFor(st.n)}" data-kind="radio" data-name="${esc(st.n)}">
    <div class="logo">${logo}</div>
    <span class="chno">${esc(st.f||"ONLINE RADIO")}</span>${fav}
    <h3>${esc(st.n)}</h3>
    <div class="badges">${radioBadge(st)}</div>
    <p>${esc(st.g||"Radio")} • ${esc(st.d||"")}</p></button>`;
}
function radioRow(st){
  return `<button class="grow focusable" style="--h:${hueFor(st.n)}" data-kind="radio" data-name="${esc(st.n)}">
    <span class="gno">📻</span><span class="gmain"><b>${esc(st.n)} ${favs.has(st.n)?"★":""}</b><small>${esc(st.f||"Online")} • ${esc(st.g||"")} • ${esc(st.co||"")} — ${esc(st.d||"")}</small></span>
    <span class="gbadges">${radioBadge(st)}</span></button>`;
}
function movieCard(m){
  const fav=favs.has(m.t)?'<span class="favstar">★</span>':"";
  return `<button class="poster focusable" data-kind="movie" data-name="${esc(m.t)}">
    <div class="poster-art" style="background:linear-gradient(170deg,hsla(${m.hue},75%,45%,.25),rgba(5,8,15,.88) 75%),linear-gradient(135deg,hsl(${m.hue},75%,42%),hsl(${(m.hue+50)%360},80%,28%))">
      <b>${esc(m.t)}</b><span>★ ${esc(m.r)} • ${m.y}</span></div>
    <h3>${esc(m.t)} ${fav}</h3><p>${esc(m.g)} • ${esc(m.dur)}</p></button>`;
}
function appCard(a){
  return `<button class="appcard focusable" data-kind="app" data-name="${esc(a.n)}">
    <div class="appicon" style="background:${esc(a.color)}">${esc(a.icon)}</div>
    <h3>${esc(a.n)}</h3><p>${esc(a.d)}</p></button>`;
}
function pickCard(ch){
  const logo=ch.logo?`<img class="plogo" loading="lazy" decoding="async" src="${esc(ch.logo)}" alt="" onerror="this.outerHTML='<span class=&quot;pinit&quot;>${esc(initials(ch.n))}</span>'">`:`<span class="pinit">${esc(initials(ch.n))}</span>`;
  return `<button class="pick focusable" data-kind="channel" data-name="${esc(ch.n)}">
    <div class="pick-art" style="background:linear-gradient(180deg,rgba(4,7,14,.05),rgba(4,7,14,.72) 82%),linear-gradient(135deg,hsl(${hueFor(ch.n)},78%,40%),hsl(${(hueFor(ch.n)+60)%360},70%,24%))">
      <span class="pchip">${esc(ch.c)}</span>${logo}</div>
    <h3>${esc(ch.n)}</h3><p>CH ${chGlobalNo(ch)} • ${esc(ch.d||"")}</p></button>`;
}
function roundApp(a){
  return `<button class="roundapp focusable" data-kind="app" data-name="${esc(a.n)}">
    <span class="ric" style="background:${esc(a.color)}">${esc(a.icon)}</span><span>${esc(a.n)}</span></button>`;
}
function rail(title,html,cat,count){
  if(!html) return "";
  const head = cat?`<h2><span>${title}</span><button class="viewall focusable" data-livecat="${esc(cat)}">${count||""} channels • View all ›</button></h2>`:`<h2><span>${title}</span></h2>`;
  return `<section class="row">${head}<div class="rail">${html}</div></section>`;
}

const VIEWS = {
  home(){
    const chs=allChannels();
    const byCat=c=>smartSort(chs.filter(x=>x.c===c));
    const KE=smartSort(chs.filter(x=>x.co==="Kenya"));
    const featuredCh = KE.find(c=>c.n==="Citizen TV")||KE[0];
    const featuredSports = byCat("Sports")[0];
    const featuredKids = chs.find(c=>c.n==="Akili Kids!")||byCat("Kids")[0];
    const featuredNews = byCat("News")[0];
    const featuredNovela = chs.find(c=>c.n==="Kapamilya Online Live")||byCat("Telenovelas")[0];
    const featuredMusic = chs.find(c=>c.n==="Trace Mziki")||byCat("Music")[0];
    const featuredTravel = chs.find(c=>c.n==="Tastemade Travel")||byCat("Travel")[0];
    const featuredNature = chs.find(c=>c.n==="Love Nature")||byCat("Documentary")[0];
    heroItems=[
      {kind:"channel", name:featuredCh?featuredCh.n:"", kicker:"🇰🇪 KENYA LIVE", title:featuredCh?featuredCh.n:CONFIG.appName, sub:featuredCh?("Watch "+featuredCh.n+" live inside SAFI TV+ — "+(featuredCh.d||"")):"", hue:0, bg:"assets/hero-kenya.jpg"},
      {kind:"channel", name:featuredNovela?featuredNovela.n:"", kicker:"💃 TELENOVELA NIGHTS", title:featuredNovela?featuredNovela.n:"Telenovelas", sub:featuredNovela?("Filipino, Latin & Turkish soaps — "+(featuredNovela.d||"")):"", hue:330, bg:"assets/hero-novela.jpg"},
      {kind:"movie", name:MOVIES[1]?MOVIES[1].t:"", kicker:"🎬 FREE MOVIE", title:MOVIES[1]?MOVIES[1].t:"Movies", sub:MOVIES[1]?(MOVIES[1].y+" • "+MOVIES[1].g+" — "+MOVIES[1].d):"", hue:MOVIES[1]?MOVIES[1].hue:210, bg:"assets/hero-movie.jpg"},
      {kind:"channel", name:featuredSports?featuredSports.n:"", kicker:"⚽ SPORTS LIVE", title:featuredSports?featuredSports.n:"Sports", sub:featuredSports?("Live sports inside the app — "+(featuredSports.d||"")):"", hue:150, bg:"assets/hero-sports.jpg"},
      {kind:"channel", name:featuredNews?featuredNews.n:"", kicker:"📰 WORLD NEWS", title:featuredNews?featuredNews.n:"News", sub:featuredNews?("Breaking news live — "+(featuredNews.d||"")):"", hue:215, bg:"assets/hero-news.jpg"},
      {kind:"channel", name:featuredKids?featuredKids.n:"", kicker:"🧒 KIDS", title:featuredKids?featuredKids.n:"Kids", sub:featuredKids?("Safe kids TV — "+(featuredKids.d||"")):"", hue:200, bg:"assets/hero-kids.jpg"},
      {kind:"channel", name:featuredMusic?featuredMusic.n:"", kicker:"🎵 MUSIC LIVE", title:featuredMusic?featuredMusic.n:"Music", sub:featuredMusic?("Music TV 24/7 — "+(featuredMusic.d||"")):"", hue:275, bg:"assets/hero-music.jpg"},
      {kind:"channel", name:featuredTravel?featuredTravel.n:"", kicker:"✈️ TRAVEL & NATURE", title:featuredTravel?featuredTravel.n:"Travel", sub:featuredTravel?("Escape in beautiful places — "+(featuredTravel.d||"")):"", hue:180, bg:"assets/hero-travel.jpg"},
      {kind:"channel", name:featuredNature?featuredNature.n:"", kicker:"🦁 ANIMALS AND NATURE", title:featuredNature?featuredNature.n:"Animals and Nature", sub:featuredNature?("Wildlife and nature in cinematic detail — "+(featuredNature.d||"")):"", hue:32, bg:"assets/hero-nature.jpg"}
    ].filter(x=>x.name);
    heroIdx=0;
    const catsOrdered=["Africa","News","Business","Sports","Movies","Series","Telenovelas","Soaps & Dramas","Comedy","Kids","Anime & Toons","Fashion","Cooking & Food","Travel","Lifestyle","Documentary","Education & Culture","Gospel","Entertainment","Classic TV","World TV"];
    const keTile=`<button class="catTile focusable" style="--h:120" data-livecat="🇰🇪 Kenya Local"><b>🇰🇪 Kenya Local</b><span>${KE.length} channels ›</span></button>`;
    const catTiles=keTile+[...new Set(chs.map(c=>c.c))].sort((a,b)=>a.localeCompare(b)).map(c=>{
      const n=chs.filter(x=>x.c===c).length;
      return `<button class="catTile focusable" style="--h:${hueFor(c)}" data-livecat="${esc(c)}"><b>${esc(c)}</b><span>${n} channels ›</span></button>`;
    }).join("");
    const picks=smartSort(chs).slice(0,12).map(pickCard).join("");
    const cont = watchHistory.map(h=>{
      if(h.kind==="channel"){ const ch=chs.find(c=>c.n===h.name); return ch?channelCard(ch):""; }
      if(h.kind==="radio"){ const st=radioStations().find(x=>x.n===h.name); return st?radioCard(st):""; }
      const m=MOVIES.find(x=>x.t===h.name); return m?movieCard(m):"";
    }).join("");
    return `<section class="dashboard-stage">
    <section id="hero">
      <div class="heroWall wallA on"></div><div class="heroWall wallB"></div><div class="heroShade"></div>
      <span class="badge" id="heroKicker">● LIVE TV + MOVIES</span>
      <h1 id="heroTitle">Karibu ${esc(CONFIG.appName)} Smart Box</h1>
      <p id="heroSub">${chs.length} channels, free movies, kids &amp; music — plays inside this app. Use <b>← ↑ → ↓</b> and <b>OK</b>, or type a channel number e.g. <b>1 2</b>.</p>
      <div class="hero-btns">
        <button class="btn red focusable" data-hero-play>▶ &nbsp;Watch Now</button>
        <button class="btn focusable" data-nav="allchannels">☰ &nbsp;All Channels (${chs.length}+)</button>
        <button class="btn ghost focusable" data-hero-prev>‹ Previous</button>
        <button class="btn ghost focusable" data-hero-next>Next ›</button>
        <button class="btn ghost focusable" data-nav="offline">⬇ Offline</button>
      </div>
      <div class="heroDots">${heroItems.map((_,i)=>`<i class="${i===0?"on":""}"></i>`).join("")}</div>
      <div class="hero-live-strip"><span class="liveTag">● LIVE</span><span>Featured now</span><span class="hero-strip-line"><i></i></span><span>24/7</span></div>
    </section>
    <aside class="media-modules" aria-label="Media shortcuts">
      <button class="media-module module-live focusable" data-nav="live">
        <span class="module-top"><span class="module-icon">▣</span><span class="module-kicker">LIVE GUIDE</span></span>
        <span class="module-copy"><b>Live TV's</b><small>${chs.length} Channels</small></span>
        <span class="module-arrow">›</span>
      </button>
      <button class="media-module module-movies focusable" data-nav="movies">
        <span class="module-top"><span class="module-icon">🎟</span><span class="module-kicker">WATCH</span></span>
        <span class="module-copy"><b>Movies</b><small>${MOVIES.length} Films + ${byCat("Movies").length} channels</small></span>
        <span class="module-arrow">›</span>
      </button>
      <button class="media-module module-radio focusable" data-nav="radio">
        <span class="module-top"><span class="module-icon">◉</span><span class="module-kicker">LISTEN</span></span>
        <span class="module-copy"><b>Radios</b><small>${radioStations().length} Stations</small></span>
        <span class="module-arrow">›</span>
      </button>
    </aside>
    </section>

      ${picks?`<section class="row"><h2><span>Top picks for you</span></h2><div class="rail">${picks}</div></section>`:""}
      <section class="row"><h2><span>Your apps</span><small>all inside SAFI TV+ 🔒</small></h2>
        <div class="roundapps">${APPS.slice(0,16).map(roundApp).join("")}</div></section>
      <section class="row"><h2><span>Who's watching?</span><small>one tap blends channels for the moment</small></h2>
        <div class="catTiles">${COLLECTION_NAMES.map(c=>`<button class="catTile focusable" style="--h:${hueFor(c)}" data-livecat="${esc(c)}"><b>${esc(c)}</b><span>${collectionFilter(chs,c).length} channels ›</span></button>`).join("")}</div></section>
      ${cont?rail("▶ Continue / Recently Watched",cont):""}
      <section class="row"><h2><span>Browse by Category</span><small>every category has 10+ channels — nothing is hidden</small></h2>
        <div class="catTiles">${catTiles}</div></section>
      ${rail("🇰🇪 Kenya — Start Here", KE.slice(0,18).map(channelCard).join(""), "🇰🇪 Kenya Local", KE.length)}
      ${rail("🎵 Music Channels", byCat("Music").slice(0,18).map(channelCard).join(""), "Music", byCat("Music").length)}
      <section class="row"><h2><span>📻 Radio — Kenya &amp; World</span><button class="viewall focusable" data-nav="radio">${radioStations().length} stations • Open Radio ›</button></h2><div class="rail">${radioStations().slice(0,14).map(radioCard).join("")}</div></section>
      ${rail("🎬 Free Movies", MOVIES.map(movieCard).join(""))}
      ${catsOrdered.map(c=>{ const list=byCat(c); return list.length?rail(c, list.slice(0,18).map(channelCard).join(""), c, list.length):""; }).join("")}`;
  },
  live(){
    const cats=["All","🇰🇪 Kenya Local",...COLLECTION_NAMES,...(scanChannels.length?["🛰 Auto-Scan"]:[]),...new Set(allChannels().map(c=>c.c))];
    const cnt=c=>c==="All"?allChannels().length:c==="🇰🇪 Kenya Local"?allChannels().filter(x=>x.co==="Kenya").length:c==="🛰 Auto-Scan"?scanChannels.length:isCollection(c)?collectionFilter(allChannels(),c).length:allChannels().filter(x=>x.c===c).length;
    return `<div class="pageHead"><div><h1>Live TV Guide 📺</h1><p><span id="liveCount">${allChannels().length}</span> channels • Type a number to jump e.g. <kbd>2</kbd><kbd>5</kbd> • <kbd>F</kbd> ★ favourite</p></div>
      <div class="pageHeadR">${boosterLabel()?'<span class="bdg b-boost big">'+boosterLabel()+" ON</span>":""}</div></div>
      <div id="focusPreview" class="previewBar"><div class="pvLogo">📺</div><div class="pvMain"><b>Pick a channel</b><span>Move with the remote — details appear here. OK = watch inside SAFI TV+.</span></div></div>
      <div class="toolrow">
        <input id="liveSearch" class="focusable toolSearch" placeholder="🔍 Filter channels… e.g. trace, news, kass" value="${esc(liveState.q)}" autocomplete="off">
        <button class="chip focusable" data-sortbtn>↕ Sort: ${liveState.sort==="smart"?"Best first":liveState.sort==="az"?"A–Z":"Category"}</button>
        <button class="chip focusable" data-viewbtn>${liveState.view==="grid"?"☰ List view":"▦ Grid view"}</button>
        <button class="chip focusable" data-hidebad>${liveState.hideBad?"✓ Hiding offline":"Show all"}</button>
        <button class="chip focusable doctor" data-doctor>🩺 Channel Doctor</button>
        <button class="chip focusable" data-nav="allchannels">☰ All Channels A–Z + World</button>
        <button class="chip focusable" data-nav="autoscan">🛰 Auto-Scan</button>
      </div>
      <div id="doctorBox"></div>
      <div class="chips">${cats.map(c=>`<button class="chip focusable ${liveState.cat===c?'active':''}" data-cat="${esc(c)}">${esc(c)} <small>${cnt(c)}</small></button>`).join("")}</div>
      <div id="liveGrid" class="grid"></div>`;
  },
  movies(){
    return `<h1 style="font-size:38px">Movies & Series</h1><p style="color:var(--muted);font-size:18px;margin-top:6px">Free open movies included. Add your own M3U playlist in Settings for more.</p>
      <div class="grid">${MOVIES.map(movieCard).join("")}</div>
      <h2 style="font-size:26px;margin:22px 0 6px">Movie TV Channels (24/7)</h2>
      <div class="grid">${allChannels().filter(c=>c.c==="Movies").map(channelCard).join("")}</div>`;
  },
  kids(){
    return `<h1 style="font-size:38px">Kids Zone 🧒</h1><p style="color:var(--muted);font-size:18px;margin-top:6px">Safe kids channels &amp; family films</p>
      <div class="grid">${allChannels().filter(c=>c.c==="Kids").map(channelCard).join("")}</div>
      <h2 style="font-size:26px;margin:22px 0 6px">Family Movies</h2>
      <div class="grid">${MOVIES.filter(m=>/animation|family|kids/i.test(m.g)).map(movieCard).join("")}</div>`;
  },
  apps(){
    return `<h1 style="font-size:38px">Apps — All Inside SAFI TV+ 🔒</h1><p style="color:var(--muted);font-size:18px;margin-top:6px">Every tile opens <b>inside this app</b>. Nothing sends you to YouTube, a browser, or another app.<br>Netflix / Showmax / YouTube app etc. were removed from here — those companies block playing inside other apps, so the only way was redirecting you out (not allowed). Use them separately from your TV home screen if installed.</p>
      <div class="grid">${APPS.map(appCard).join("")}</div>`;
  },
  favourites(){
    const fc=allChannels().filter(c=>favs.has(c.n)), fr=radioStations().filter(s=>favs.has(s.n)), fm=MOVIES.filter(m=>favs.has(m.t));
    if(!fc.length&&!fr.length&&!fm.length) return `<h1 style="font-size:38px">My Favourites ★</h1><div class="empty">No favourites yet.<br><br>Go to Live TV or Movies, move to an item and press <kbd>F</kbd> (or the ★ button in the player).</div>`;
    return `<h1 style="font-size:38px">My Favourites ★</h1>
      ${fc.length?`<h2 style="font-size:24px;margin:20px 0 6px">Channels</h2><div class="grid">${fc.map(channelCard).join("")}</div>`:""}
      ${fr.length?`<h2 style="font-size:24px;margin:20px 0 6px">Radio</h2><div class="grid">${fr.map(radioCard).join("")}</div>`:""}
      ${fm.length?`<h2 style="font-size:24px;margin:20px 0 6px">Movies</h2><div class="grid">${fm.map(movieCard).join("")}</div>`:""}`;
  },
  search(){
    const keys="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
    return `<h1 style="font-size:38px">Search 🔍</h1>
      <input id="searchInput" class="focusable" placeholder="Type a TV channel, radio station or movie name…" autocomplete="off">
      <div class="kb">${keys.map(k=>`<button class="focusable" data-key="${k}">${k}</button>`).join("")}
        <button class="focusable" data-key=" ">SPACE</button><button class="focusable wide" data-key="⌫">⌫ DELETE</button>
        <button class="focusable wide" data-key="✕">✕ CLEAR</button></div>
      <div class="toolrow"><button class="chip focusable" data-loadworld>🌍 Also search World Directory (7,400+)</button></div><div class="grid" id="searchResults"></div>`;
  },
  offline(){
    const on = navigator.onLine;
    return `<h1 style="font-size:38px">Offline / USB ⬇️</h1>
    <div class="panel"><h3>${on?"🟢 You are ONLINE":"🔴 You are OFFLINE"}</h3>
      <p>${on?"Download / record now while you have internet, then watch with <b>zero data</b> later (travel, shamba, data imeisha).":"No internet right now. <b>Live streams need internet</b> (or an aerial — see below), but everything on this page works <b>completely offline</b>."}</p></div>

    <div class="panel"><h3>💾 Play video or audio from USB flash disk / this device (100% offline)</h3>
      <p>Copy movies, MP3/AAC radio shows, podcasts or music onto a flash disk, plug it in, then pick the file here. It plays inside SAFI TV+ — no internet, no data.</p>
      <div class="inputrow"><label class="btn red focusable" style="display:inline-block">📁 Choose video/audio file <input type="file" id="localFile" accept="video/*,audio/*,.mp4,.mkv,.webm,.m4v,.mp3,.aac,.m4a,.ogg,.opus,.wav,.flac" hidden></label></div></div>

    <div class="panel"><h3>📥 Saved inside this app — watch with NO internet</h3>
      <p id="storageInfo">Your TV/radio recordings and downloaded media. Saved on this TV/device only.</p>
      <div id="offlineList"><div class="empty">Loading your saved videos…</div></div></div>

    <div class="panel"><h3>🎬 Download a movie now, watch offline later</h3>
      <p>Downloads use internet <b>once</b> (some films are 50–900 MB — use Wi-Fi / unlimited if possible). Then find them in the list above, even with data off.<br>Select a movie to download it:</p>
      <div class="grid">${MOVIES.filter(m=>m.type==="mp4").map(m=>`<button class="card focusable" data-save-movie="${esc(m.t)}"><div class="logo"><span class="initials">⬇</span></div><h3>${esc(m.t)}</h3><p>${m.y} • ${esc(m.g)}<br>⬇ <b>SAVE FOR OFFLINE</b></p></button>`).join("")}</div></div>

    <div class="panel"><h3>📻 Record Radio → listen offline later</h3>
      <p>Open <b>Radio</b>, start a station, then press <b>⏺ Record</b> in the player. Radio recording stops automatically after <b>30 minutes</b> (or press Stop sooner), is saved above, and replays with no internet. At 128 kbps, expect roughly <b>1 MB per minute</b>. Some devices/streams block recording; USB audio always works.</p></div>

    <div class="panel"><h3>⏺ Record Live TV → watch it offline later</h3>
      <p>While watching any normal channel, press <b>⏺ Record</b> in the player. Press <b>⏹ Stop</b> when done — it is saved above and replays with no internet.<br>
      • Uses internet + storage <i>while recording</i> (roughly 5–20 MB per minute). • A few streams/TVs block recording — if so, use Downloads or USB. • Embedded stations (Citizen/NTV/KTN/TV47) cannot be recorded.</p></div>

    <div class="panel"><h3>📡 TRUE offline Live TV: free-to-air Aerial (DVB-T2) — the only way with NO internet at all</h3>
      <p>Live TV must come from <i>somewhere</i>: internet <b>or</b> a broadcast signal. Software alone cannot receive a broadcast — a <b>tuner + aerial</b> does that, free, no data and no subscription for local channels:</p><ul>
      <li><b>Most digital Smart TVs in Kenya already have a DVB-T2 tuner.</b> Plug in an aerial (indoor/outdoor).</li>
      <li>Press <b>Source/Input</b> on the TV remote → choose <b>DTV / Antenna / Live TV</b> (this uses the TV own tuner screen, not this app).</li>
      <li><b>Settings → Channels → Auto Scan / Auto Tuning</b>. You should get KBC, Citizen, NTV, KTN, K24, TV47 and others depending on signal in your area.</li>
      <li>If a TV box has <b>no</b> tuner (many Android streaming boxes), it cannot get aerial channels without a USB DVB-T2 tuner stick. Internet streaming in SAFI TV+ is its live source.</li></ul>
      <p>Tip: Use <b>both</b> — aerial for free local live TV with zero data, SAFI TV+ for extra world channels + your offline recordings/downloads.</p></div>`;
  },
  radio(){
    const cats=["All","🇰🇪 Kenya","Music","News & Talk","Gospel","Education","World","★ Favourites"];
    const cnt=c=>c==="All"?radioStations().length:c==="🇰🇪 Kenya"?radioStations().filter(s=>s.co==="Kenya").length:c==="World"?radioStations().filter(s=>s.co!=="Kenya").length:c==="★ Favourites"?radioStations().filter(s=>favs.has(s.n)).length:radioStations().filter(s=>s.g===c).length;
    return `<div class="pageHead"><div><h1>Radio 📻</h1><p><span id="radioCount">${radioStations().length}</span> stations — listen live inside SAFI TV+, or record/download for offline.</p></div>
      <div class="pageHeadR">${navigator.onLine?'<span class="bdg b-ok big">🟢 Online radio ready</span>':'<span class="bdg b-bad big">🔴 Offline — use saved radio below</span>'}</div></div>
      <div class="qtiles" style="max-width:none">
        <button class="qtile focusable" data-nav="offline"><span class="qi">💾</span><b>Offline Radio Library</b><span>Recordings, downloads & USB audio — zero data</span></button>
        <label class="qtile focusable" style="display:block"><span class="qi">📁</span><b>Play USB / Saved Audio File</b><span>MP3, AAC, M4A, OGG, WAV — 100% offline</span><input type="file" id="localFile" accept="audio/*,video/*,.mp3,.aac,.m4a,.ogg,.opus,.wav,.flac,.mp4,.mkv,.webm" hidden></label>
        <button class="qtile focusable" data-nav="autoscan"><span class="qi">🛰</span><b>Auto-Scan Stations</b><span>Find & add more TV and radio stations</span></button>
        <div class="qtile"><span class="qi">⏺</span><b>Save live radio offline</b><span>Open a station → Record. Radio records up to 30 minutes, then stops by itself.</span></div>
      </div>
      <div id="focusPreview" class="previewBar"><div class="pvLogo">📻</div><div class="pvMain"><b>Pick a station</b><span>OK = listen inside SAFI TV+. In the player, Record saves a copy for offline.</span></div></div>
      <div class="toolrow"><input id="radioSearch" class="focusable toolSearch" placeholder="🔍 Search radio… e.g. Citizen, Kiss, Gospel, BBC" value="${esc(radioState.q)}" autocomplete="off"></div>
      <div class="chips">${cats.map(c=>`<button class="chip focusable ${radioState.cat===c?'active':''}" data-radiocat="${esc(c)}">${esc(c)} <small>${cnt(c)}</small></button>`).join("")}</div>
      <div id="radioGrid" class="grid"></div>
      <div class="panel"><h3>📶 Online + offline radio — how it works</h3>
        <p><b>Online:</b> the stations above stream over the internet (audio uses far less data than TV — roughly 25–60 MB/hour).<br>
        <b>Offline:</b> while listening, press <b>⏺ Record</b>; the saved copy appears in <b>Offline / USB</b> and plays with zero data. MP3/AAC files on a flash disk also play offline above.<br>
        <b>Honest limit:</b> a live FM broadcast cannot be created by software when there is no internet — that needs an FM/DVB tuner in the device. Most Android TV boxes do not expose one to apps, so SAFI TV+ never pretends to receive FM; recordings/downloads/USB are the true offline radio here.</p></div>`;
  },
  autoscan(){
    const lastBg=Number(store.getItem("safi_autoscan_last")||0);
    const modeTxt=autoScanMode==="auto"?"AUTO — Daily Kenya TV + Radio, weekly Africa":autoScanMode==="weekly"?"Weekly — Kenya TV":autoScanMode==="weeklyRadio"?"Weekly — Kenya TV + Radio":"OFF";
    const scopes=[["kenya","🇰🇪 Kenya TV"],["africa","🌍 Africa TV"],["world","🌐 World TV"],["radio-ke","📻 Kenya Radio"],["radio-world","📻 World Radio"]];
    return `<div class="pageHead"><div><h1>Auto-Scan 🛰</h1><p>Scans trusted public sources, <b>tests each stream</b>, and automatically adds only new channels/stations that actually play. Nothing opens outside SAFI TV+.</p></div></div>
    <div class="qtiles" style="max-width:none">
      <div class="qtile"><span class="qi">📺</span><b>${allChannels().length} TV channels</b><span>${scanChannels.length} added by Auto-Scan</span></div>
      <div class="qtile"><span class="qi">📻</span><b>${radioStations().length} radio stations</b><span>${scanRadio.length} added by Auto-Scan</span></div>
      <button class="qtile focusable" id="btnAutoMode"><span class="qi">🔄</span><b>Automatic channel updates</b><span class="qstate" id="autoModeState">${modeTxt}</span><span>${lastBg?"Last background scan: "+new Date(lastBg).toLocaleString("en-KE"):"Tap to enable hands-free updates"}</span></button>
      <button class="qtile focusable" data-viewscanned><span class="qi">☰</span><b>View scanned TV</b><span>Open the Auto-Scan category in Live TV</span></button>
    </div>
    <div class="panel scanpanel"><h3>🔎 Scan for new channels now</h3>
      <p>Sources: <b>iptv-org Kenya</b> (live internet list), the app's bundled <b>World Directory</b>, and <b>Radio Browser</b> for radio. A channel is added only after SAFI receives a valid playlist + media (TV) or live audio (radio). Blocked/dead streams are skipped. Scanning uses data — Wi-Fi is best.</p>
      <div class="chips">${scopes.map(([k,label])=>`<button class="chip focusable ${autoScanState.scope===k?'active':''}" data-scanscope="${k}">${label}</button>`).join("")}</div>
      <div class="inputrow">
        <button class="btn red focusable" id="btnStartScan">🛰 Scan & Add New Channels</button>
        <button class="btn ghost focusable" id="btnStopScan">⏹ Stop</button>
        <button class="btn focusable" id="btnScanLimit">Test up to: <span id="scanLimitState">${autoScanState.limit}</span></button>
        <button class="btn ghost focusable" id="btnClearScan">🗑 Clear scanned additions</button>
      </div>
      <div id="scanBox"></div>
    </div>
    <h2 style="font-size:26px;margin:22px 0 6px">Recently added by Auto-Scan</h2>
    <div id="scanResults" class="guideList"></div>
    <div class="panel"><h3>📡 Auto-Scan is not aerial tuning</h3>
      <p>This scans <b>internet</b> channel sources. It cannot tune DVB-T2/FM frequencies because a web app cannot control the TV tuner. For true aerial channels: TV <b>Source → DTV/Antenna → Auto Scan</b> (see Offline page). SAFI TV+ will never redirect you to another app to do it.</p></div>`;
  },
  allchannels(){
    const safiN=allChannels().length, keN=allChannels().filter(c=>c.co==="Kenya").length;
    const catsFor = allState.src==="world"
      ? ["All",...new Set(WORLD.map(c=>c.c))].slice(0,24)
      : ["All","🇰🇪 Kenya Local",...COLLECTION_NAMES,...new Set(allChannels().map(c=>c.c))];
    const letters="ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("");
    return `<div class="pageHead"><div><h1>All Channels ☰</h1><p>Every channel in one list — SAFI curated, all Kenyan stations, and the World Directory. OK = watch inside the app.</p></div></div>
      <div class="srcTabs">
        <button class="srcTab focusable ${allState.src==="safi"?"active":""}" data-src="safi">⭐ SAFI Channels <small>${safiN}</small></button>
        <button class="srcTab focusable ${allState.src==="kenya"?"active":""}" data-src="kenya">🇰🇪 Kenya — All Local <small>${keN} watch + ${KENYA_DIRECTORY.length} listed</small></button>
        <button class="srcTab focusable ${allState.src==="world"?"active":""}" data-src="world">🌍 World Directory <small>${worldLoaded?WORLD.length:"7,400+"}</small></button>
      </div>
      <div class="toolrow">
        <input id="allSearch" class="focusable toolSearch" placeholder="🔍 Search this list… e.g. citizen, trace, fashion, japan" value="${esc(allState.q)}" autocomplete="off">
        <button class="chip focusable doctor" data-doctor-scope>🩺 Check this list</button>
      </div>
      <div id="doctorBox"></div>
      <div class="chips">${catsFor.map(c=>`<button class="chip focusable ${allState.cat===c?'active':''}" data-allcat="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <div class="alphaBar"><button class="focusable ${!allState.letter?"active":""}" data-letter="">All</button>${letters.map(L=>`<button class="focusable ${allState.letter===L?"active":""}" data-letter="${L}">${L}</button>`).join("")}</div>
      <div id="dirDetail"></div>
      <p class="allSummary" id="allSummary"></p>
      <div id="allList" class="guideList"></div>`;
  },
  help(){
    return `<div class="pageHead"><div><h1>Help &amp; Guidance ❔</h1><p>Quick fixes and how-tos. Pick a tile — everything stays inside SAFI TV+.</p></div></div>
    <div class="helptiles">
      <button class="qtile focusable" data-doctor><span class="qi">🩺</span><b>A channel is not working</b><span>Run Channel Doctor — finds working, Booster &amp; offline channels</span></button>
      <button class="qtile focusable" data-nav="allchannels"><span class="qi">☰</span><b>Find any channel</b><span>All Channels A–Z, search &amp; World Directory</span></button>
      <button class="qtile focusable" data-nav="autoscan"><span class="qi">🛰</span><b>Add new channels automatically</b><span>Auto-Scan tests sources &amp; adds working TV/radio</span></button>
      <button class="qtile focusable" data-nav="radio"><span class="qi">📻</span><b>Radio online &amp; offline</b><span>Listen live, record, or play USB audio</span></button>
      <button class="qtile focusable" data-helpsrc="kenya"><span class="qi">🇰🇪</span><b>Kenyan stations list</b><span>Every local station: watch-now + aerial-only</span></button>
      <button class="qtile focusable" data-nav="offline"><span class="qi">🔴</span><b>No internet / data imeisha</b><span>Downloads, recordings, USB &amp; aerial guide</span></button>
      <button class="qtile focusable" data-nav="settings"><span class="qi">📉</span><b>Save data bundles</b><span>Low-Data mode &amp; quality settings</span></button>
      <button class="qtile focusable" data-nav="search"><span class="qi">🔍</span><b>Search by name</b><span>Type a channel or movie name</span></button>
    </div>
    <div id="doctorBox"></div>
    <div class="panel"><h3>📡 If a channel is not working — do this</h3><ol style="margin-left:22px;color:var(--muted);font-size:17px;line-height:1.7">
      <li><b style="color:#fff">Wait 15 seconds</b> — the player automatically tries Direct → Mirrors → ⚡ Booster → fallback.</li>
      <li>Press <b style="color:#fff">🔁 Source</b> (or <kbd>M</kbd>) in the player to try the next source yourself.</li>
      <li>Turn on <b style="color:#fff">Settings → Low-Data</b> if your internet is slow.</li>
      <li>Run <b style="color:#fff">🩺 Channel Doctor</b> (tile above) — then pick channels marked ✓ Working.</li>
      <li>If a station says <b style="color:#fff">Not 24/7</b>, its own encoder is off — nobody can switch it on from an app. Try later, or watch it free with a <b style="color:#fff">DVB-T2 aerial</b> (Offline page).</li></ol></div>
    <div class="panel"><h3>🎮 Remote &amp; keyboard guide</h3><ul>
      <li><kbd>← ↑ → ↓</kbd> move • <kbd>OK / Enter</kbd> select • <kbd>Back / Esc</kbd> back or exit player</li>
      <li><kbd>0–9</kbd> type a channel number to jump straight there (e.g. <kbd>1</kbd><kbd>2</kbd> = CH 12)</li>
      <li><kbd>F</kbd> add/remove ★ favourite • <kbd>CH+ / CH−</kbd> next/previous channel in player</li>
      <li>In player: <kbd>Space</kbd> play/pause • <kbd>← →</kbd> seek or zap • <kbd>↑ ↓</kbd> volume • <kbd>M</kbd> switch source/mirror • <kbd>R</kbd> record</li></ul></div>
    <div class="panel"><h3>🇰🇪 About Kenyan stations</h3>
      <p>SAFI TV+ includes every Kenyan station that offers a public online stream or an official embeddable player (${allChannels().filter(c=>c.co==="Kenya").length} watchable), plus a full directory of ${KENYA_DIRECTORY.length} more local stations that are currently <b>aerial-only</b> (no public online stream). See them all in <b>Channels → 🇰🇪 Kenya — All Local</b>. Citizen/NTV/KTN/KBC/TV47-type stations play via their official embedded player <i>inside</i> our player — Back returns to the list; nothing opens another app.</p></div>
    <div class="panel"><h3>⚡ What is the Booster?</h3>
      <p>Some free streams block TV browsers with CORS/referrer rules even though the stream itself is public. The Booster fetches the stream properly and hands it to the player so it plays inside SAFI TV+. It is <b>built into the APK</b>, and available in a browser when you run the app with <b>server.py</b> at home. Status: <b>${boosterLabel()?boosterLabel()+" ON":"not detected here — use the APK or server.py"}</b>.</p></div>`;
  },
  settings(){
    const saved=store.getItem("safi_m3u_url")||"";
    return `<h1 style="font-size:38px">Settings ⚙️</h1>
    <div class="qtiles">
      <button class="qtile focusable" id="btnLowData"><span class="qi">📉</span><b>Low-Data Mode</b><span class="qstate" data-lowstate></span><span>Save bundles on live streams</span></button>
      <button class="qtile focusable" data-doctor><span class="qi">🩺</span><b>Channel Doctor</b><span>Test every channel now</span></button>
      <button class="qtile focusable" id="btnLanguage"><span class="qi">🌐</span><b>Language / Lugha</b><span class="qstate" id="langState">${LANG_NAMES[uiLang]||"English"}</span><span>English • Kiswahili • Français</span></button>
      <button class="qtile focusable" id="btnBigText"><span class="qi">🔠</span><b>Large Text</b><span class="qstate" id="bigTextState"></span><span>Easier to read from far</span></button>
      <button class="qtile focusable" id="btnMotion"><span class="qi">🎞️</span><b>Reduce Motion</b><span class="qstate" id="motionState"></span><span>Calmer interface</span></button>
      <button class="qtile focusable" data-nav="allchannels"><span class="qi">☰</span><b>All Channels A–Z</b><span>${allChannels().length} curated + World Directory</span></button>
      <button class="qtile focusable" data-nav="autoscan"><span class="qi">🛰</span><b>Auto-Scan</b><span>Find & add new TV/radio automatically</span></button>
      <button class="qtile focusable" data-nav="radio"><span class="qi">📻</span><b>Radio</b><span>${radioStations().length} online stations + offline library</span></button>
      <button class="qtile focusable" data-nav="offline"><span class="qi">💾</span><b>Storage &amp; Offline</b><span>Downloads, recordings, USB</span></button>
      <button class="qtile focusable" data-nav="help"><span class="qi">❔</span><b>Help &amp; Guidance</b><span>Fix channels step-by-step</span></button>
      <button class="qtile focusable" data-exitapp><span class="qi">⏻</span><b>Exit SAFI TV+</b><span>Close the app safely</span></button>
      <div class="qtile"><span class="qi">${navigator.onLine?"🟢":"🔴"}</span><b>${navigator.onLine?"Online":"Offline"}</b><span>${boosterLabel()?boosterLabel()+" ON":"Booster: APK / server.py"}</span></div>
    </div>
    <div class="panel"><h3>➕ Add your own IPTV playlist (M3U)</h3>
      <p>Paste an M3U URL from a provider you subscribe to, or a free public list. Example free Kenya list is already built in. Your list is saved on this TV only.</p>
      <div class="inputrow"><input id="m3uUrl" class="focusable" placeholder="https://example.com/playlist.m3u" value="${esc(saved)}">
      <button class="btn red focusable" id="btnLoadM3u">Load Playlist</button>
      <label class="btn ghost focusable" tabindex="-1" style="display:inline-block">📁 Upload .m3u file <input type="file" id="m3uFile" accept=".m3u,.m3u8,.txt" hidden></label></div>
      <p class="msg" id="m3uMsg">${myChannels.length?`✅ ${myChannels.length} channels loaded from your playlist (see Live TV → My Playlist)`:""}</p>
      <div class="inputrow"><button class="btn ghost focusable" id="btnClearMy">Remove my playlist</button></div></div>

    <div class="panel"><h3>🔒 No-Redirect Promise</h3>
      <p>Everything in SAFI TV+ plays <b>inside this app</b> — channels, movies and all Apps tiles.<br>
      Citizen TV, NTV, KTN, KBC &amp; TV47 use the station's official embedded live player <i>inside our player</i> (their only official online live has no public HLS feed). It never opens the YouTube app/website; press <kbd>Back</kbd> to return to the channel list.<br>
      If one of those shows "offline/upcoming", that station is simply not streaming live on that feed at that time — try a HLS channel like Inooro TV or K24.</p></div>

    <div class="panel"><h3>📺 How to use on your Android Smart TV</h3><ul>
      <li><b>Install the APK</b> (see README) — then just open SAFI TV+ from your TV home screen. That is the normal way to use it.</li>
      <li><b>Best (APK):</b> install <b>SafiTV.apk</b> — see the Installation guide (README) that came with this software. It appears with your other TV apps.</li>
      <li><b>Remote:</b> <kbd>←↑→↓</kbd> move • <kbd>OK</kbd> select • <kbd>Back</kbd> go back / exit player • <kbd>F</kbd> favourite</li>
      <li><b>In player:</b> <kbd>OK/Space</kbd> play-pause • <kbd>←/→</kbd> seek (movies) • <kbd>↑/↓</kbd> volume • <kbd>CH+/CH−</kbd> channel up/down</li></ul></div>

    <div class="panel"><h3>🩺 Channel Doctor + ⚡ Stream Booster</h3>
      <p><b>Booster:</b> ${isNativeApp()?"ON (built into this APK) — it repairs streams blocked by CORS/referrer rules so they play inside the app.":(boosterReady?"ON (home server) — blocked streams are automatically re-tried through the booster.":"Not detected in this browser. Run the app via <b>server.py</b> (home server) or the APK to enable it — many Pluto/CORS-blocked channels need it.")}<br>
      <b>Doctor:</b> checks every channel (uses a little data), marks ✓ Working / ⚡ Booster / ✖ Offline on the cards for 24 hours, and lets the TV Guide hide dead ones.</p>
      <div class="inputrow"><button class="btn red focusable" data-doctor>🩺 Run Channel Doctor (all channels)</button></div>
      <div id="doctorBox"></div></div>

    <div class="panel"><h3>📉 Low-Data Mode (save bundles)</h3>
      <p>When ON, live streams start at the lowest picture quality so they use much less data (good for hotspots / small bundles). Picture will be softer.</p>
      <p class="msg">Use the <b>📉 Low-Data Mode</b> tile in Quick Settings above. Now: <span id="lowDataState"></span></p>
      <p class="msg">For ZERO data viewing, use <b>Offline / USB</b> (downloads, recordings, flash disk) or an aerial — live internet TV always uses some data.</p></div>

    <div class="panel"><h3>🎨 Theme colour</h3><p>Pick your brand colour:</p>
      <div class="inputrow">${["#e50914","#00a651","#0066ff","#ff8a00","#9b30ff"].map(c=>`<button class="btn focusable" data-theme="${c}" style="background:${c};color:#fff">&nbsp;&nbsp;&nbsp;&nbsp;</button>`).join("")}</div></div>

    <div class="panel"><h3>ℹ️ About</h3>
      <p>${esc(CONFIG.appName)} v${esc(CONFIG.version)} — Smart TV / Smart Box software for Android TV.<br>
      Built-in channels are free publicly-listed streams (iptv-org) and free open movies. Some channels marked “Not 24/7” by their owners may be offline at times — try another channel, or add your own playlist above.<br>
      Streams beginning with <b>http://</b> may be blocked in a web browser — they play in the Android TV APK version.</p>
      <div class="inputrow"><button class="btn ghost focusable" id="btnReset">Reset app (clear favourites &amp; playlist)</button></div></div>`;
  }
};

let currentView="home";
let viewHistory=[], viewForward=[];
function updateNavButtons(){
  try{ if(window.AndroidTV && typeof AndroidTV.setAtHome==="function") AndroidTV.setAtHome(currentView==="home"); }catch(e){}
  const p=$("#navPrev"), n=$("#navNext");
  if(p) p.classList.toggle("nav-disabled", !viewHistory.length && currentView==="home");
  if(n) n.classList.toggle("nav-disabled", !viewForward.length);
}
function navigateBack(){
  const ex=$("#exitScreen");
  if(ex && !ex.classList.contains("hidden")){ returnFromExit(); return; }
  if($("#playerWrap")&&$("#playerWrap").classList.contains("open")){ closePlayer(); return; }
  const prev=viewHistory.pop();
  if(prev){ viewForward.push(currentView); show(prev,{fromHistory:true}); }
  else if(currentView!=="home") show("home",{fromHistory:true});
  else toast("⌂ You are already Home");
  updateNavButtons();
}
function navigateForward(){
  if($("#playerWrap")&&$("#playerWrap").classList.contains("open")){ zap(1); return; }
  const next=viewForward.pop();
  if(next){ viewHistory.push(currentView); show(next,{fromHistory:true}); }
  else toast("No next screen");
  updateNavButtons();
}
function goHomeNav(){
  const ex=$("#exitScreen"); if(ex) ex.classList.add("hidden");
  if($("#playerWrap")&&$("#playerWrap").classList.contains("open")) closePlayer();
  if(currentView!=="home") show("home");
  else { $("#main").scrollTop=0; const h=document.querySelector('.navbtn[data-nav="home"]'); if(h) setFocus(h); }
}
function exitApp(){
  try{
    if($("#playerWrap")&&$("#playerWrap").classList.contains("open")) closePlayer();
    if(window.AndroidTV && typeof AndroidTV.exitApp==="function"){ AndroidTV.exitApp(); return; }
  }catch(e){}
  try{ window.close(); }catch(e){}
  setTimeout(()=>{
    const ex=$("#exitScreen");
    if(ex){ ex.classList.remove("hidden"); const b=$("#btnReturnFromExit"); if(b) setFocus(b); }
  },250);
}
function returnFromExit(){
  const ex=$("#exitScreen"); if(ex) ex.classList.add("hidden");
  if(viewHistory.length) navigateBack(); else goHomeNav();
}
function show(view,opts){
  opts=opts||{};
  if(!VIEWS[view]) view="home";
  const previousView=currentView;
  if(!opts.fromHistory && previousView && previousView!==view){
    viewHistory.push(previousView);
    if(viewHistory.length>30) viewHistory.shift();
    viewForward=[];
  }
  currentView=view;
  clearInterval(heroTimer); clearInterval(heroWallTimer);
  document.querySelectorAll(".navbtn").forEach(b=>b.classList.toggle("active",b.dataset.nav===view));
  const box=$("#content");
  box.innerHTML=VIEWS[view]();
  box.classList.remove("view-anim"); void box.offsetWidth; box.classList.add("view-anim");
  $("#main").scrollTop=0;
  bindContent();
  let target=null; const mem=lastFocusByView[view];
  if(mem){
    target = mem.startsWith("#") ? $(mem) : [...box.querySelectorAll("[data-name]")].find(e=>e.dataset.name===mem);
  }
  setFocus(target || box.querySelector("#liveGrid .focusable") || box.querySelector(".focusable"));
  applyLanguage(); updateNavButtons();
}
function showLiveCategory(cat){
  liveState.cat=cat||"All"; liveState.offset=0;
  if(currentView==="live"){ document.querySelectorAll(".chip[data-cat]").forEach(c=>c.classList.toggle("active",c.dataset.cat===liveState.cat)); renderLiveGrid(true); }
  else show("live");
}
function currentLiveList(){
  let list=allChannels();
  if(isCollection(liveState.cat)) list=collectionFilter(list,liveState.cat);
  else if(liveState.cat==="🇰🇪 Kenya Local") list=list.filter(c=>c.co==="Kenya");
  else if(liveState.cat==="🛰 Auto-Scan") list=list.filter(c=>c.src==="scan");
  else if(liveState.cat!=="All") list=list.filter(c=>c.c===liveState.cat);
  if(liveState.q){ const q=liveState.q.toLowerCase(); list=list.filter(c=>(c.n+" "+c.c+" "+(c.d||"")).toLowerCase().includes(q)); }
  if(liveState.hideBad) list=list.filter(c=>healthOf(c.n)!=="fail");
  if(liveState.sort==="az") list=[...list].sort((a,b)=>a.n.localeCompare(b.n));
  else if(liveState.sort==="cat") list=[...list].sort((a,b)=>a.c.localeCompare(b.c)||a.n.localeCompare(b.n));
  else list=smartSort(list);
  return list;
}
function renderLiveGrid(focusFirst){
  const box=$("#liveGrid"); if(!box) return;
  const list=currentLiveList();
  const lc=$("#liveCount"); if(lc) lc.textContent=list.length+" of "+allChannels().length;
  box.className = liveState.view==="list" ? "guideList" : "grid";
  const pageSize=liveState.limit||240;
  liveState.offset=Math.max(0,Math.min(liveState.offset||0,list.length?Math.floor((list.length-1)/pageSize)*pageSize:0));
  const shown=list.slice(liveState.offset,liveState.offset+pageSize);
  const pageNo=Math.floor(liveState.offset/pageSize)+1, pages=Math.max(1,Math.ceil(list.length/pageSize));
  if(lc&&list.length) lc.textContent=(liveState.offset+1)+"–"+(liveState.offset+shown.length)+" of "+list.length+" ("+allChannels().length+" total)";
  const pager=list.length>pageSize?`<div class="pagerRow" style="grid-column:1/-1"><button class="btn ghost focusable" data-liveprev ${liveState.offset<=0?"disabled":""}>← Previous</button><span>Page ${pageNo} of ${pages}</span><button class="btn red focusable" data-livenext ${liveState.offset+pageSize>=list.length?"disabled":""}>Next →</button><button class="btn ghost focusable" data-livefirst>↑ First page</button></div>`:"";
  box.innerHTML = list.length
    ? shown.map(c=>liveState.view==="list"?channelRow(c):channelCard(c)).join("")+pager
    : '<div class="empty">No channels match. Clear the filter, turn OFF "Hide offline", or run Channel Doctor.</div>';
  const _lp=box.querySelector("[data-liveprev]"); if(_lp) _lp.addEventListener("click",()=>{ liveState.offset=Math.max(0,(liveState.offset||0)-pageSize); renderLiveGrid(true); $("#main").scrollTop=0; });
  const _ln=box.querySelector("[data-livenext]"); if(_ln) _ln.addEventListener("click",()=>{ liveState.offset=Math.min(list.length-1,(liveState.offset||0)+pageSize); renderLiveGrid(true); $("#main").scrollTop=0; });
  const _lf=box.querySelector("[data-livefirst]"); if(_lf) _lf.addEventListener("click",()=>{ liveState.offset=0; renderLiveGrid(true); $("#main").scrollTop=0; });
  box.querySelectorAll("[data-kind]").forEach(el=>el.addEventListener("click",()=>activate(el)));
  if(list[0]){ const pv=$("#focusPreview"); if(pv && !pv.dataset.touched){ /* keep invite text */ } }
  if(focusFirst){ const f=box.querySelector(".focusable"); if(f) setFocus(f); }
}
function allListSource(){
  if(allState.src==="world") return WORLD;
  if(allState.src==="kenya") return allChannels().filter(c=>c.co==="Kenya");
  return allChannels();
}
function renderAllList(focusFirst){
  const box=$("#allList"); if(!box) return;
  if(allState.src==="world" && !worldLoaded){
    box.innerHTML='<div class="empty"><div class="spinner"></div>Loading World Directory (7,400+ channels)…</div>';
    loadWorld(()=>{ if(currentView==="allchannels") show("allchannels"); });
    return;
  }
  let list=[...allListSource()];
  if(allState.cat!=="All"){
    list = isCollection(allState.cat) ? collectionFilter(list,allState.cat) : allState.cat==="🇰🇪 Kenya Local" ? list.filter(c=>c.co==="Kenya") : list.filter(c=>c.c===allState.cat);
  }
  if(allState.q){ const q=allState.q.toLowerCase(); list=list.filter(c=>(c.n+" "+c.c+" "+(c.co||"")+" "+(c.d||"")).toLowerCase().includes(q)); }
  list.sort((a,b)=>a.n.localeCompare(b.n));
  if(allState.letter){ list=list.filter(c=> allState.letter==="#" ? /^[^A-Za-z]/.test(c.n) : c.n.toUpperCase().startsWith(allState.letter)); }
  lastAllList=list;
  allState.offset=Math.max(0,Math.min(allState.offset||0,list.length?Math.floor((list.length-1)/allState.limit)*allState.limit:0));
  const shown=list.slice(allState.offset,allState.offset+allState.limit);
  let html=shown.map(channelRow).join("");
  let dirCount=0;
  if(allState.offset===0 && allState.src==="kenya" && (allState.cat==="All"||allState.cat==="🇰🇪 Kenya Local")){
    const _playNorm=new Set(allChannels().map(c=>scanNameKey(c.n)));
    let dirs=KENYA_DIRECTORY.filter(n=>!_playNorm.has(scanNameKey(n))&&(!allState.q||n.toLowerCase().includes(allState.q.toLowerCase())));
    if(allState.letter) dirs=dirs.filter(n=> allState.letter==="#"?/^[^A-Za-z]/.test(n):n.toUpperCase().startsWith(allState.letter));
    dirCount=dirs.length;
    if(dirs.length) html += `<div class="empty" style="margin-top:18px">📡 <b>${dirs.length} more Kenyan stations</b> are free-to-air on aerial (DVB-T2) but offer no public online stream yet — listed so you can see every local station. Select one for guidance.</div>`
      + dirs.map(n=>`<button class="grow dirRow focusable" data-dirname="${esc(n)}"><span class="gno">📡</span><span class="gmain"><b>${esc(n)}</b><small>Kenya • Aerial (DVB-T2) — no public online stream yet</small></span><span class="gbadges"><span class="bdg b-247">Aerial only</span></span></button>`).join("");
  }
  if(!shown.length && !dirCount) html='<div class="empty">No channels match. Clear the search / letter / category.</div>';
  if(list.length>allState.limit){
    const pageNo=Math.floor(allState.offset/allState.limit)+1, pages=Math.ceil(list.length/allState.limit);
    html+=`<div class="pagerRow"><button class="btn ghost focusable" data-allprev ${allState.offset<=0?"disabled":""}>← Previous</button><span>Page ${pageNo} of ${pages}</span><button class="btn red focusable" data-allnext ${allState.offset+allState.limit>=list.length?"disabled":""}>Next →</button><button class="btn ghost focusable" data-allfirst>↑ First page</button></div>`;
  }
  box.innerHTML=html;
  const sum=$("#allSummary");
  if(sum) sum.textContent=`Showing ${shown.length?allState.offset+1:0}–${allState.offset+shown.length} of ${list.length} watchable channels`+(dirCount?` + ${dirCount} aerial-only Kenyan stations below`:"")+(allState.src==="world"?" • World Directory = public listings; use 🩺 Check this list for live status":"");
  box.querySelectorAll("[data-kind]").forEach(el=>el.addEventListener("click",()=>activate(el)));
  const _ap=box.querySelector("[data-allprev]"); if(_ap) _ap.addEventListener("click",()=>{ allState.offset=Math.max(0,(allState.offset||0)-allState.limit); renderAllList(true); $("#main").scrollTop=0; });
  const _an=box.querySelector("[data-allnext]"); if(_an) _an.addEventListener("click",()=>{ allState.offset=Math.min(list.length-1,(allState.offset||0)+allState.limit); renderAllList(true); $("#main").scrollTop=0; });
  const _af=box.querySelector("[data-allfirst]"); if(_af) _af.addEventListener("click",()=>{ allState.offset=0; renderAllList(true); $("#main").scrollTop=0; });
  box.querySelectorAll("[data-dirname]").forEach(el=>el.addEventListener("click",()=>{
    const d=$("#dirDetail"); if(!d) return;
    d.innerHTML=`<div class="doctor"><div class="doctorTop"><b>📡 ${esc(el.dataset.dirname)}</b><span>Kenya • Free-to-air</span></div><p>This station broadcasts free on <b>DVB-T2 aerial</b> but does not publish an online stream we can play inside the app yet — so there is nothing to force; the signal simply is not on the internet. To watch it: plug an aerial into the TV → Source: <b>DTV / Antenna</b> → <b>Auto Scan</b>. Meanwhile ${allChannels().filter(c=>c.co==="Kenya").length} Kenyan stations DO play online in SAFI TV+.</p><div class="inputrow"><button class="btn red focusable" data-diraerial>📡 Aerial setup guide</button><button class="btn ghost focusable" data-dirke>🇰🇪 Watch Kenyan channels online</button></div></div>`;
    const b1=d.querySelector("[data-diraerial]"); if(b1){ b1.addEventListener("click",()=>show("offline")); setFocus(b1); }
    const b2=d.querySelector("[data-dirke]"); if(b2) b2.addEventListener("click",()=>showLiveCategory("🇰🇪 Kenya Local"));
  }));
  if(focusFirst){ const f=box.querySelector(".focusable"); if(f) setFocus(f); }
}
function currentRadioList(){
  let list=radioStations();
  if(radioState.cat==="🇰🇪 Kenya") list=list.filter(s=>s.co==="Kenya");
  else if(radioState.cat==="World") list=list.filter(s=>s.co!=="Kenya");
  else if(radioState.cat==="★ Favourites") list=list.filter(s=>favs.has(s.n));
  else if(radioState.cat!=="All") list=list.filter(s=>s.g===radioState.cat);
  if(radioState.q){ const q=radioState.q.toLowerCase(); list=list.filter(s=>(s.n+" "+(s.g||"")+" "+(s.co||"")+" "+(s.d||"")+" "+(s.f||"")).toLowerCase().includes(q)); }
  return [...list].sort((a,b)=>((b.co==="Kenya")-(a.co==="Kenya"))||a.n.localeCompare(b.n));
}
function renderRadioGrid(focusFirst){
  const box=$("#radioGrid"); if(!box) return;
  const list=currentRadioList();
  const rc=$("#radioCount"); if(rc) rc.textContent=list.length+" of "+radioStations().length;
  box.innerHTML=list.length?list.map(radioCard).join(""):'<div class="empty">No radio stations match. Clear the search or choose another category.</div>';
  box.querySelectorAll("[data-kind]").forEach(el=>el.addEventListener("click",()=>activate(el)));
  if(focusFirst){ const f=box.querySelector(".focusable"); if(f) setFocus(f); }
}
const HERO_WALLS = ["assets/hero-nature.jpg","assets/hero-kenya.jpg","assets/hero-novela.jpg","assets/hero-movie.jpg","assets/hero-sports.jpg","assets/hero-news.jpg","assets/hero-kids.jpg","assets/hero-music.jpg","assets/hero-travel.jpg"];
let heroWallIdx = 0, heroWallFlip = false, heroWallTimer = null;
function setHeroWallpaper(src){
  const hero=$("#hero"); if(!hero||!src) return;
  const a=hero.querySelector(".wallA"), b=hero.querySelector(".wallB");
  if(!a||!b){ hero.style.background="linear-gradient(90deg,rgba(4,7,14,.93) 22%,rgba(4,7,14,.45) 58%,rgba(4,7,14,.12)),url('"+src+"') center 30%/cover"; return; }
  const showEl=heroWallFlip?a:b, hideEl=heroWallFlip?b:a;
  if(showEl.dataset.src!==src){
    showEl.style.backgroundImage="url('"+src+"')"; showEl.dataset.src=src;
    showEl.classList.remove("kenburns"); void showEl.offsetWidth; showEl.classList.add("kenburns");
  }
  showEl.classList.add("on"); hideEl.classList.remove("on");
  heroWallFlip=!heroWallFlip;
  const i=HERO_WALLS.indexOf(src); if(i>=0) heroWallIdx=i;
}
function cycleHeroWallpaper(){
  if(currentView!=="home" || $("#playerWrap").classList.contains("open") || noMotion) return;
  heroWallIdx=(heroWallIdx+1)%HERO_WALLS.length;
  setHeroWallpaper(HERO_WALLS[heroWallIdx]);
}
function applyHero(i){
  const hero=$("#hero"); if(!hero||!heroItems.length) return;
  heroIdx=((i%heroItems.length)+heroItems.length)%heroItems.length;
  const h=heroItems[heroIdx];
  hero.style.setProperty("--hh", h.hue);
  if(h.bg) setHeroWallpaper(h.bg);
  const k=$("#heroKicker"), ti=$("#heroTitle"), su=$("#heroSub");
  if(k) k.textContent="● "+h.kicker;
  if(ti) ti.textContent=h.title;
  if(su) su.textContent=h.sub;
  hero.querySelectorAll(".heroDots i").forEach((d,j)=>d.classList.toggle("on",j===heroIdx));
}
function playHero(){
  const h=heroItems[heroIdx]; if(!h) return;
  if(h.kind==="movie"){ const m=MOVIES.find(x=>x.t===h.name); if(m) playMovie(m); }
  else { const ch=allChannels().find(c=>c.n===h.name); if(ch) playChannel(ch, allChannels()); }
}
function bindContent(){
  $("#content").querySelectorAll("[data-src]").forEach(el=>el.addEventListener("click",()=>{ allState.src=el.dataset.src; allState.cat="All"; allState.limit=120; allState.offset=0; show("allchannels"); }));
  $("#content").querySelectorAll("[data-allcat]").forEach(el=>el.addEventListener("click",()=>{
    allState.cat=el.dataset.allcat; allState.limit=120; allState.offset=0;
    document.querySelectorAll("[data-allcat]").forEach(c=>c.classList.toggle("active",c===el)); renderAllList(true);
  }));
  $("#content").querySelectorAll("[data-letter]").forEach(el=>el.addEventListener("click",()=>{
    allState.letter=el.dataset.letter; allState.limit=120; allState.offset=0;
    document.querySelectorAll("[data-letter]").forEach(c=>c.classList.toggle("active",c===el)); renderAllList(true);
  }));
  const _as=$("#allSearch");
  if(_as) _as.addEventListener("input",()=>{ allState.q=_as.value.trim(); allState.limit=120; allState.offset=0; renderAllList(false); });
  if($("#allList")) renderAllList(false);
  $("#content").querySelectorAll("[data-helpsrc]").forEach(el=>el.addEventListener("click",()=>{ allState.src=el.dataset.helpsrc; show("allchannels"); }));
  $("#content").querySelectorAll("[data-doctor-scope]").forEach(el=>el.addEventListener("click",()=>{
    const scope=lastAllList.slice(0,300);
    if(lastAllList.length>300) toast("🩺 Checking the first 300 matches — filter to check a smaller list fully",4000);
    runChannelDoctor(scope);
  }));
  $("#content").querySelectorAll("[data-loadworld]").forEach(el=>el.addEventListener("click",()=>loadWorld(ok=>{ toast(ok?"🌍 World Directory loaded — search again":"World Directory failed to load"); runSearch(); })));
  const _lang=$("#btnLanguage");
  if(_lang) _lang.addEventListener("click",()=>{
    uiLang = uiLang==="en"?"sw":uiLang==="sw"?"fr":"en";
    store.setItem("safi_lang",uiLang);
    toast("🌐 Language: "+LANG_NAMES[uiLang]);
    show("settings");
  });
  const _bt=$("#btnBigText");
  if(_bt){ const paint=()=>{ const s=$("#bigTextState"); if(s) s.textContent=bigText?"ON":"OFF"; }; paint();
    _bt.addEventListener("click",()=>{ bigText=!bigText; store.setItem("safi_bigtext",bigText?"1":"0"); applyPrefs(); paint(); toast("🔠 Large Text "+(bigText?"ON":"OFF")); }); }
  const _bm=$("#btnMotion");
  if(_bm){ const paint=()=>{ const s=$("#motionState"); if(s) s.textContent=noMotion?"ON (calm)":"OFF"; }; paint();
    _bm.addEventListener("click",()=>{ noMotion=!noMotion; store.setItem("safi_nomotion",noMotion?"1":"0"); applyPrefs(); paint(); toast("🎞️ Reduce Motion "+(noMotion?"ON":"OFF")); }); }

  $("#content").querySelectorAll("[data-radiocat]").forEach(el=>el.addEventListener("click",()=>{
    radioState.cat=el.dataset.radiocat;
    document.querySelectorAll("[data-radiocat]").forEach(c=>c.classList.toggle("active",c===el));
    renderRadioGrid(true);
  }));
  $("#content").querySelectorAll("[data-scanscope]").forEach(el=>el.addEventListener("click",()=>{
    autoScanState.scope=el.dataset.scanscope; store.setItem("safi_scan_scope",autoScanState.scope);
    document.querySelectorAll("[data-scanscope]").forEach(c=>c.classList.toggle("active",c===el)); setFocus(el);
  }));
  const _sl=$("#btnScanLimit");
  if(_sl) _sl.addEventListener("click",()=>{
    const vals=[50,100,200,400]; const i=vals.indexOf(autoScanState.limit);
    autoScanState.limit=vals[(i+1)%vals.length];
    const s=$("#scanLimitState"); if(s) s.textContent=autoScanState.limit;
  });
  const _ss=$("#btnStartScan"); if(_ss) _ss.addEventListener("click",()=>runAutoScan());
  const _st=$("#btnStopScan"); if(_st) _st.addEventListener("click",()=>{ autoScanState.stop=true; paintScan("Stopping after the current tests…"); });
  const _cs=$("#btnClearScan");
  if(_cs) _cs.addEventListener("click",()=>{ scanChannels=[]; scanRadio=[]; saveScanChannels(); saveScanRadio(); toast("🗑 Auto-Scan additions cleared"); show("autoscan"); });
  const _am=$("#btnAutoMode");
  if(_am) _am.addEventListener("click",()=>{
    autoScanMode=autoScanMode==="off"?"auto":autoScanMode==="auto"?"weekly":autoScanMode==="weekly"?"weeklyRadio":"off";
    store.setItem("safi_autoscan_mode",autoScanMode);
    toast("🔄 Automatic scan: "+(autoScanMode==="off"?"OFF":autoScanMode==="auto"?"AUTO (daily Kenya TV + Radio)":autoScanMode==="weekly"?"Weekly Kenya TV":"Weekly Kenya TV + Radio"));
    show("autoscan"); setTimeout(maybeAutoScan,3000);
  });
  $("#content").querySelectorAll("[data-viewscanned]").forEach(el=>el.addEventListener("click",()=>showLiveCategory("🛰 Auto-Scan")));
  if($("#scanBox")) paintScan();
  const _rs=$("#radioSearch");
  if(_rs) _rs.addEventListener("input",()=>{ radioState.q=_rs.value.trim(); renderRadioGrid(false); });
  if($("#radioGrid")) renderRadioGrid(false);
  $("#content").querySelectorAll("[data-kind]").forEach(el=>el.addEventListener("click",()=>activate(el)));
  $("#content").querySelectorAll("[data-action]").forEach(el=>el.addEventListener("click",()=>{
    if(el.dataset.action==="hero-live") playChannel(allChannels()[0], allChannels());
    if(el.dataset.action==="hero-movie") playMovie(MOVIES[0]);
  }));
  $("#content").querySelectorAll("[data-nav]").forEach(el=>el.addEventListener("click",()=>show(el.dataset.nav)));
  $("#content").querySelectorAll("[data-cat]").forEach(el=>el.addEventListener("click",()=>{
    liveState.cat=el.dataset.cat; liveState.limit=240; liveState.offset=0;
    document.querySelectorAll(".chip[data-cat]").forEach(c=>c.classList.toggle("active",c===el));
    renderLiveGrid(true);
  }));
  $("#content").querySelectorAll("[data-livecat]").forEach(el=>el.addEventListener("click",()=>showLiveCategory(el.dataset.livecat)));
  $("#content").querySelectorAll("[data-doctor]").forEach(el=>el.addEventListener("click",()=>runChannelDoctor()));
  if($("#liveGrid")) renderLiveGrid(false);
  const _lvs=$("#liveSearch");
  if(_lvs) _lvs.addEventListener("input",()=>{ liveState.q=_lvs.value.trim(); liveState.limit=240; liveState.offset=0; renderLiveGrid(false); });
  const _sb=$("#content [data-sortbtn]");
  if(_sb) _sb.addEventListener("click",()=>{
    liveState.sort = liveState.sort==="smart"?"az":liveState.sort==="az"?"cat":"smart";
    _sb.textContent="↕ Sort: "+(liveState.sort==="smart"?"Best first":liveState.sort==="az"?"A–Z":"Category");
    renderLiveGrid(false);
  });
  const _vb=$("#content [data-viewbtn]");
  if(_vb) _vb.addEventListener("click",()=>{
    liveState.view = liveState.view==="grid"?"list":"grid";
    _vb.textContent = liveState.view==="grid"?"☰ List view":"▦ Grid view";
    renderLiveGrid(false);
  });
  const _hb=$("#content [data-hidebad]");
  if(_hb) _hb.addEventListener("click",()=>{
    liveState.hideBad=!liveState.hideBad;
    _hb.textContent=liveState.hideBad?"✓ Hiding offline":"Show all";
    if(liveState.hideBad && !Object.keys(healthMap).length) toast("Run Channel Doctor first so we know which are offline",3500);
    renderLiveGrid(false);
  });
  const _hp=$("#content [data-hero-play]"); if(_hp) _hp.addEventListener("click",playHero);
  const _hn=$("#content [data-hero-next]"); if(_hn) _hn.addEventListener("click",()=>applyHero(heroIdx+1));
  const _hprev=$("#content [data-hero-prev]"); if(_hprev) _hprev.addEventListener("click",()=>applyHero(heroIdx-1));
  if($("#hero")){
    HERO_WALLS.forEach(src=>{ const im=new Image(); im.src=src; });
    applyHero(0);
    clearInterval(heroTimer); clearInterval(heroWallTimer);
    heroWallTimer=setInterval(cycleHeroWallpaper,6500);
    heroTimer=setInterval(()=>{
      if(currentView!=="home" || $("#playerWrap").classList.contains("open")) return;
      const f=document.querySelector(".focused");
      if(f && f.closest && f.closest("#hero")) return;
      applyHero(heroIdx+1);
    },9000);
  }
  const si=$("#searchInput");
  if(si){
    si.addEventListener("input",runSearch);
    $("#content").querySelectorAll("[data-key]").forEach(b=>b.addEventListener("click",()=>{
      const k=b.dataset.key;
      if(k==="⌫") si.value=si.value.slice(0,-1); else if(k==="✕") si.value=""; else si.value+=k;
      runSearch();
    }));
  }
  const loadBtn=$("#btnLoadM3u");
  if(loadBtn) loadBtn.addEventListener("click",loadM3uUrl);
  const file=$("#m3uFile");
  if(file) file.addEventListener("change",e=>{const f=e.target.files[0]; if(f) f.text().then(t=>applyM3u(t,"file"));});
  const clr=$("#btnClearMy");
  if(clr) clr.addEventListener("click",()=>{myChannels=[];store.removeItem("safi_my_channels");store.removeItem("safi_m3u_url");toast("My playlist removed");show("settings");});
  const rst=$("#btnReset");
  if(rst) rst.addEventListener("click",()=>{store.clear();favs.clear();myChannels=[];scanChannels=[];scanRadio=[];autoScanMode="auto";viewHistory=[];viewForward=[];toast("App reset");show("home");});
  $("#content").querySelectorAll("[data-theme]").forEach(b=>b.addEventListener("click",()=>{
    document.documentElement.style.setProperty("--accent",b.dataset.theme);
    store.setItem("safi_theme",b.dataset.theme); toast("Theme saved 🎨");
  }));
  if($("#offlineList")) renderOfflineList();
  const lf=$("#localFile");
  if(lf) lf.addEventListener("change",e=>playLocalFile(e.target.files[0]));
  $("#content").querySelectorAll("[data-save-movie]").forEach(b=>b.addEventListener("click",()=>{
    const m=MOVIES.find(x=>x.t===b.dataset.saveMovie); saveMovieOffline(m,b);
  }));
  const ld=$("#btnLowData");
  if(ld){ const paint=()=>{ const txt=lowData?"ON — saving data":"OFF — best quality"; const s=$("#lowDataState"); if(s) s.textContent=txt; document.querySelectorAll("[data-lowstate]").forEach(e=>e.textContent=txt); }; paint();
    ld.addEventListener("click",()=>{ lowData=!lowData; store.setItem("safi_lowdata",lowData?"1":"0"); paint(); toast(lowData?"Low-Data ON - new streams use lowest quality":"Low-Data OFF - best quality"); }); }
}

/* ---------- 🛰 Auto-Scan: find, test & add new TV/radio ----------
   Sources are public directories (iptv-org / bundled World Directory /
   Radio Browser). Only streams that pass a real playback test are added. */
const AFRICA_COUNTRIES = new Set(["Angola","Burkina Faso","Burundi","Benin","Botswana","Democratic Republic of the Congo","Central African Republic","Republic of the Congo","Ivory Coast","Cameroon","Cape Verde","Djibouti","Algeria","Egypt","Western Sahara","Eritrea","Ethiopia","Gabon","Ghana","Gambia","Guinea","Equatorial Guinea","Guinea-Bissau","Kenya","Comoros","Liberia","Lesotho","Libya","Morocco","Madagascar","Mali","Mauritania","Mauritius","Malawi","Mozambique","Namibia","Niger","Nigeria","Reunion","Rwanda","Seychelles","Sudan","Saint Helena","Sierra Leone","Senegal","Somalia","South Sudan","Sao Tome and Principe","Swaziland","Eswatini","Chad","Togo","Tunisia","Tanzania","Uganda","Mayotte","South Africa","Zambia","Zimbabwe"]);
function scanNameKey(n){ return String(n||"").toLowerCase().replace(/\s*\((\d{3,4}[pi]|hd|sd|fhd|uhd)[^)]*\)/gi,"").replace(/\s*\[[^\]]*\]/g,"").replace(/[^a-z0-9]/g,""); }
function cleanScanName(n){ return String(n||"").replace(/\s*\((\d{3,4}[pi]|HD|SD|FHD|UHD)[^)]*\)\s*$/i,"").replace(/\s*\[(Not 24\/7|Geo-blocked)[^\]]*\]/gi,"").replace(/\s+/g," ").trim().slice(0,90); }
function scanUrlKey(u){ return String(u||"").trim().toLowerCase().replace(/\/$/,""); }
function loadWorldAsync(){
  return new Promise(resolve=>{
    let done=false;
    const to=setTimeout(()=>{ if(!done){done=true;resolve(worldLoaded);} },18000);
    loadWorld(ok=>{ if(!done){done=true;clearTimeout(to);resolve(ok);} });
  });
}
async function fetchWithTimeout(url,ms,opts){
  const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(),ms||10000);
  try{ return await fetch(url,{...(opts||{}),signal:ctl.signal,cache:"no-store"}); }
  finally{ clearTimeout(to); }
}
async function readPrefix(resp,maxBytes){
  if(!resp.body||!resp.body.getReader()){ const txt=await resp.text(); return txt.slice(0,maxBytes||700000); }
  const rd=resp.body.getReader(); const dec=new TextDecoder(); let out="",got=0;
  while(got<(maxBytes||700000)){
    const part=await rd.read(); if(part.done) break;
    got+=part.value.length; out+=dec.decode(part.value,{stream:true});
    if(out.length>=(maxBytes||700000)) break;
  }
  try{ await rd.cancel(); }catch(e){}
  return out;
}
async function fetchTextPrefix(url,ms,maxBytes){
  const r=await fetchWithTimeout(url,ms||9000);
  if(!r.ok) throw new Error("HTTP "+r.status);
  return {text:await readPrefix(r,maxBytes||700000), url:r.url||url, ctype:r.headers.get("content-type")||""};
}
async function fetchMediaPrefix(url,ms){
  const r=await fetchWithTimeout(url,ms||9000);
  if(!r.ok) return {ok:false,status:r.status,ctype:r.headers.get("content-type")||"",url:r.url||url};
  let bytes=0;
  if(r.body&&r.body.getReader()){
    const rd=r.body.getReader(); const first=await rd.read(); bytes=first.value?first.value.length:0;
    try{ await rd.cancel(); }catch(e){}
  } else { const b=await r.blob(); bytes=b.size; }
  return {ok:bytes>0,status:r.status,ctype:r.headers.get("content-type")||"",url:r.url||url,bytes};
}
function parseScanM3U(text){
  const lines=String(text||"").split(/\r?\n/), out=[];
  for(let i=0;i<lines.length;i++){
    if(!lines[i].startsWith("#EXTINF")) continue;
    const name=lines[i].substring(lines[i].lastIndexOf(",")+1).trim();
    const logo=(lines[i].match(/tvg-logo="([^"]*)"/)||[])[1]||"";
    const group=(lines[i].match(/group-title="([^"]*)"/)||[])[1]||"";
    let url="";
    for(let j=i+1;j<Math.min(lines.length,i+6);j++){ const s=lines[j].trim(); if(s&&!s.startsWith("#")){url=s;break;} }
    if(name&&(/^https:\/\//i.test(url))) out.push({n:name,u:url,logo,d:group,c:group});
  }
  return out;
}
function normalizeScanCategory(name,cat,co){
  if(co==="Kenya") return "Kenya";
  const first=String(cat||"General").split(";")[0].trim();
  const map={"Movies":"Movies","News":"News","Sports":"Sports","Series":"Series","Kids":"Kids","Music":"Music","Entertainment":"Entertainment","Comedy":"Comedy","Documentary":"Documentary","Lifestyle":"Lifestyle","Education":"Education & Culture","Culture":"Education & Culture","Classic":"Classic TV","Animation":"Anime & Toons","Cooking":"Cooking & Food","Travel":"Travel","Business":"Business","Religious":/jesus|church|gospel|christ|faith|bible/i.test(name)?"Gospel":"World TV"};
  const mapped=map[first]||"World TV";
  if(AFRICA_COUNTRIES.has(co)&&["World TV","Entertainment"].includes(mapped)) return "Africa";
  return mapped;
}
function makeScanTV(raw){
  const n=cleanScanName(raw.n), u=String(raw.u||"").trim();
  if(!n||!/^https:\/\//i.test(u)) return null;
  const item={n,c:normalizeScanCategory(n,raw.c,raw.co),type:"hls",u,logo:/^https:\/\//i.test(raw.logo||"")?raw.logo:"",d:String(raw.d||raw.co||"Auto-Scan").replace(" • World Directory","").slice(0,120),src:"scan"};
  if(raw.co) item.co=raw.co;
  const b=[...new Set((raw.b||[]).filter(x=>/^https:\/\//i.test(x)&&x!==u))].slice(0,2);
  if(b.length) item.b=b;
  return item;
}
function dedupeScanCandidates(items,isRadio){
  const existing=isRadio?radioStations():allChannels();
  const names=new Set(existing.map(x=>scanNameKey(x.n))), urls=new Set(existing.map(x=>scanUrlKey(x.u)));
  const seenN=new Set(), seenU=new Set(), out=[]; let skipped=0;
  for(const item of items){
    if(!item){skipped++;continue;}
    const nk=scanNameKey(item.n), uk=scanUrlKey(item.u);
    if(!nk||names.has(nk)||urls.has(uk)||seenN.has(nk)||seenU.has(uk)){skipped++;continue;}
    seenN.add(nk); seenU.add(uk); out.push(item);
  }
  autoScanState.skipped+=skipped;
  return out;
}
function rotateScanPool(items,scope,limit){
  if(items.length<=limit) return items;
  const key="safi_scan_cursor_"+scope;
  const start=(Number(store.getItem(key)||0)%items.length+items.length)%items.length;
  const rotated=[...items.slice(start),...items.slice(0,start)];
  autoScanState._cursorKey=key; autoScanState._nextCursor=items.length?(start+limit)%items.length:0;
  return rotated.slice(0,limit);
}
async function getScanTVCandidates(scope,limit){
  let raw=[];
  if(scope==="kenya"){
    try{
      const data=await fetchTextPrefix("https://iptv-org.github.io/iptv/countries/ke.m3u",12000,300000);
      raw=parseScanM3U(data.text).map(x=>({...x,co:"Kenya",c:"Kenya",d:(x.d||"Kenya")+" • Auto-Scan"}));
    }catch(e){
      await loadWorldAsync();
      raw=WORLD.filter(x=>x.co==="Kenya");
    }
  } else {
    const ok=await loadWorldAsync(); if(!ok) throw new Error("World Directory could not load");
    raw=(scope==="africa"?WORLD.filter(x=>AFRICA_COUNTRIES.has(x.co)):WORLD).map(x=>({...x}));
    const score=x=>((/english/i.test(x.d||"")?3:0)+(x.b&&x.b.length?2:0)+(x.logo?1:0)+(["Government","Shopping"].includes(x.c)?-4:0));
    raw.sort((a,b)=>score(b)-score(a)||a.n.localeCompare(b.n));
  }
  const items=dedupeScanCandidates(raw.map(makeScanTV),false);
  return rotateScanPool(items,scope,limit);
}
function inferRadioGenre(tags,name){
  const s=(String(tags||"")+" "+String(name||"")).toLowerCase();
  if(/gospel|christian|church|worship|islam|quran|relig/.test(s)) return "Gospel";
  if(/health|education|school|university|campus/.test(s)) return "Education";
  if(/news|talk|politic|current/.test(s)) return "News & Talk";
  return "Music";
}
async function getScanRadioCandidates(scope,limit){
  const hosts=["https://de1.api.radio-browser.info","https://de2.api.radio-browser.info","https://at1.api.radio-browser.info"];
  const path=scope==="radio-ke"
    ? "/json/stations/bycountrycodeexact/ke?order=clickcount&reverse=true&hidebroken=true&limit=300"
    : "/json/stations/topclick/500?hidebroken=true";
  let data=null,lastErr=null;
  for(const h of hosts){
    try{ const r=await fetchWithTimeout(h+path,12000); if(!r.ok) throw new Error("HTTP "+r.status); data=await r.json(); break; }
    catch(e){ lastErr=e; }
  }
  if(!data) throw lastErr||new Error("Radio source unavailable");
  const raw=[];
  for(const s of data){
    let u=String(s.url||"").trim();
    if(/^http:\/\/stream\.zeno\.fm\//i.test(u)) u=u.replace(/^http:/i,"https:");
    if(!/^https:\/\//i.test(u)) u=String(s.url_resolved||"").trim();
    if(!/^https:\/\//i.test(u)) continue;
    try{ if(/^\d+\.\d+\.\d+\.\d+$/.test(new URL(u).hostname)) continue; }catch(e){ continue; }
    const n=cleanScanName(s.name);
    if(n.length<3||/^(classic|re|radio)$/i.test(n)) continue;
    let co=String(s.country||"").replace(/^The /i,"").replace(/ Of Great Britain.*$/i,"").replace(/ Of America$/i,"");
    if(scope==="radio-ke") co="Kenya";
    raw.push({n,g:inferRadioGenre(s.tags,n),type:"radio",u,logo:/^https:\/\//i.test(s.favicon||"")?s.favicon:"",d:String(s.tags||s.language||"Online radio").slice(0,100),co,f:"",src:"scan"});
  }
  return dedupeScanCandidates(raw,true).slice(0,limit);
}
function firstPlaylistUri(text,wantVariant){
  const lines=String(text||"").split(/\r?\n/).map(x=>x.trim());
  if(wantVariant){
    for(let i=0;i<lines.length;i++) if(lines[i].startsWith("#EXT-X-STREAM-INF")){
      for(let j=i+1;j<lines.length;j++) if(lines[j]&&!lines[j].startsWith("#")) return lines[j];
    }
    return null;
  }
  return lines.find(x=>x&&!x.startsWith("#"))||null;
}
async function testScanTVOnce(url){
  const first=await fetchTextPrefix(url,9000,700000);
  if(!first.text.includes("#EXTM3U")||first.text.includes("#EXT-X-ENDLIST")) return false; // endlist = VOD/pre-recorded, not live
  if(/#EXT-X-(?:KEY|SESSION-KEY):[^\n]*(?:KEYFORMAT="urn:uuid|METHOD=(?:SAMPLE-AES|SAMPLE-AES-CTR))/i.test(first.text)) return false; // DRM cannot play in the standard in-app HLS player
  let text=first.text, base=first.url;
  if(text.includes("#EXT-X-STREAM-INF")){
    const v=firstPlaylistUri(text,true); if(!v) return false;
    const next=await fetchTextPrefix(new URL(v,base).toString(),9000,700000);
    if(!next.text.includes("#EXT")||next.text.includes("#EXT-X-ENDLIST")) return false;
    if(/#EXT-X-KEY:[^\n]*(?:KEYFORMAT="urn:uuid|METHOD=(?:SAMPLE-AES|SAMPLE-AES-CTR))/i.test(next.text)) return false;
    text=next.text; base=next.url;
  }
  let seg=firstPlaylistUri(text,false); if(!seg) return false;
  let segUrl=new URL(seg,base).toString();
  if(/\.m3u8($|\?)/i.test(segUrl)){
    const next=await fetchTextPrefix(segUrl,9000,700000);
    const seg2=firstPlaylistUri(next.text,false); if(!seg2) return false;
    segUrl=new URL(seg2,next.url).toString();
  }
  const media=await fetchMediaPrefix(segUrl,9000);
  return media.ok && !/text\/html/i.test(media.ctype||"");
}
async function testScanTV(ch){
  const urls=[ch.u,...(ch.b||[])];
  for(const u of urls){ try{ if(await testScanTVOnce(u)) return "ok"; }catch(e){} }
  if(boosterReady){
    for(const u of urls){ try{ if(await testScanTVOnce(new URL(proxyUrl(u),location.href).toString())) return "boost"; }catch(e){} }
  }
  return "fail";
}
function testRadioWithMedia(url){
  return new Promise(resolve=>{
    const a=new Audio(); let done=false;
    const finish=v=>{ if(done)return; done=true; clearTimeout(to); try{a.pause();a.removeAttribute("src");a.load();}catch(e){} resolve(v); };
    const to=setTimeout(()=>finish(false),9000);
    a.muted=true; a.volume=0; a.preload="auto";
    a.addEventListener("canplay",()=>finish(true),{once:true});
    a.addEventListener("playing",()=>finish(true),{once:true});
    a.addEventListener("error",()=>finish(false),{once:true});
    a.src=url;
    const p=a.play(); if(p&&p.catch) p.catch(()=>{ setTimeout(()=>{ if(a.readyState>=2) finish(true); },1200); });
  });
}
async function testScanRadio(st){
  if(/\.m3u8($|\?)/i.test(st.u)){
    const s=await testScanTV({u:st.u,b:st.b||[]}); return s==="fail"?"fail":s;
  }
  try{
    const m=await fetchMediaPrefix(st.u,8000);
    if(m.ok&&(/audio\//i.test(m.ctype||"")||/octet-stream/i.test(m.ctype||""))) return "ok";
  }catch(e){}
  return (await testRadioWithMedia(st.u))?"ok":"fail";
}
function paintScan(message){
  const box=$("#scanBox");
  const S=autoScanState;
  if(message) S.lastMessage=message;
  if(box){
    const pct=S.total?Math.round(S.tested/S.total*100):0;
    box.innerHTML='<div class="doctor"><div class="doctorTop"><b>'+(S.running?"🛰 Scanning…":"🛰 Auto-Scan")+' '+S.tested+' / '+S.total+'</b><span>✅ Added '+S.added+' &nbsp; ✖ Failed '+S.failed+' &nbsp; ↷ Skipped '+S.skipped+'</span></div><div class="dtrack"><i style="width:'+pct+'%"></i></div><p>'+esc(S.lastMessage||"Choose a source and press Start Auto-Scan.")+(S.current?'<br>Now testing: <b>'+esc(S.current)+'</b>':"")+'</p></div>';
  }
  const res=$("#scanResults");
  if(res){
    const latest=(S.results&&S.results.length)?S.results.slice(-24).reverse():[...scanChannels.slice(-12).reverse(),...scanRadio.slice(-12).reverse()];
    res.innerHTML=latest.length?latest.map(x=>x.type==="radio"?radioRow(x):channelRow(x)).join(""):'<div class="empty">Nothing added yet. Run a scan above — verified channels appear here and in the TV/Radio guides.</div>';
    res.querySelectorAll("[data-kind]").forEach(el=>el.addEventListener("click",()=>activate(el)));
  }
  const start=$("#btnStartScan"); if(start) start.textContent=S.running?"🛰 Scanning…":"🛰 Scan & Add New Channels";
}
async function runAutoScan(opts){
  opts=opts||{};
  if(autoScanState.running){ if(!opts.background) toast("Auto-Scan is already running…"); return; }
  if(doctorRunning){ if(!opts.background) toast("Channel Doctor is running — try Auto-Scan after it finishes",3500); return; }
  if(!navigator.onLine){ if(!opts.background) toast("🔴 You are offline — Auto-Scan needs internet",3500); return; }
  const scope=opts.scope||autoScanState.scope;
  const limit=opts.limit||autoScanState.limit||100;
  const isRadio=scope.startsWith("radio");
  autoScanState={...autoScanState,scope,limit,running:true,stop:false,tested:0,total:0,added:0,failed:0,skipped:0,current:"",results:[],lastMessage:"Preparing "+scope+" source…"};
  paintScan();
  try{
    const candidates=isRadio?await getScanRadioCandidates(scope,limit):await getScanTVCandidates(scope,limit);
    autoScanState.total=candidates.length;
    if(!candidates.length){ paintScan("No new candidates were found in this source. Try another source, or clear old scanned additions if you want to test them again."); return; }
    paintScan("Testing "+candidates.length+" new candidates — only working streams will be added…");
    let idx=0;
    const worker=async()=>{
      while(idx<candidates.length&&!autoScanState.stop){
        const cand=candidates[idx++];
        autoScanState.current=cand.n;
        const status=isRadio?await testScanRadio(cand):await testScanTV(cand);
        autoScanState.tested++;
        if(status!=="fail"){
          if(isRadio){ scanRadio.push(cand); saveScanRadio(); }
          else { scanChannels.push(cand); saveScanChannels(); }
          healthMap[cand.n]={s:status==="boost"?"boost":"ok",t:Date.now()}; saveHealth();
          autoScanState.added++; autoScanState.results.push(cand);
        } else autoScanState.failed++;
        if(autoScanState.tested%3===0||autoScanState.tested>=candidates.length) paintScan();
      }
    };
    const workers=isRadio?2:4;
    await Promise.all(Array.from({length:workers},()=>worker()));
    if(autoScanState._cursorKey) store.setItem(autoScanState._cursorKey,String(autoScanState._nextCursor||0));
    const summary=(autoScanState.stop?"Stopped. ":"Finished. ")+"Added "+autoScanState.added+" new • "+autoScanState.failed+" dead/blocked • "+autoScanState.skipped+" duplicates skipped.";
    paintScan(summary);
    if(!opts.background||autoScanState.added) toast("🛰 Auto-Scan: "+summary,5000);
    if(currentView==="live") renderLiveGrid(false);
    if(currentView==="radio") renderRadioGrid(false);
    if(currentView==="allchannels") renderAllList(false);
    if(currentView==="home"&&autoScanState.added) show("home",{fromHistory:true});
  }catch(e){
    paintScan("Auto-Scan could not reach that source ("+(e.message||e)+"). Check internet and try another source.");
    if(!opts.background) toast("🛰 Auto-Scan source unavailable — try another source",4000);
  }finally{
    autoScanState.running=false; autoScanState.current="";
    paintScan();
  }
}
let autoScanRetryTimer=null;
function scheduleAutoScanRetry(){
  if(autoScanRetryTimer) return;
  autoScanRetryTimer=setTimeout(()=>{ autoScanRetryTimer=null; maybeAutoScan(); },10*60*1000);
}
function maybeAutoScan(){
  if(autoScanMode==="off"||!navigator.onLine) return;
  if(autoScanState.running||doctorRunning||($("#playerWrap")&&$("#playerWrap").classList.contains("open"))){ scheduleAutoScanRetry(); return; }
  const now=Date.now(), DAY=24*3600*1000, WEEK=7*DAY;
  const lastDaily=Number(store.getItem("safi_autoscan_daily_last")||0);
  const lastWeekly=Number(store.getItem("safi_autoscan_weekly_last")||store.getItem("safi_autoscan_last")||0);
  if(autoScanMode==="auto"){
    const doDaily=now-lastDaily>=DAY, doWeekly=now-lastWeekly>=WEEK;
    if(!doDaily&&!doWeekly) return;
    (async()=>{
      if(doDaily){
        await runAutoScan({scope:"kenya",limit:100,background:true});
        await runAutoScan({scope:"radio-ke",limit:75,background:true});
        store.setItem("safi_autoscan_daily_last",String(Date.now()));
        store.setItem("safi_autoscan_last",String(Date.now()));
      }
      if(doWeekly){
        await runAutoScan({scope:"africa",limit:100,background:true});
        store.setItem("safi_autoscan_weekly_last",String(Date.now()));
        store.setItem("safi_autoscan_last",String(Date.now()));
      }
    })();
    return;
  }
  if(now-lastWeekly<WEEK) return;
  (async()=>{
    await runAutoScan({scope:"kenya",limit:100,background:true});
    store.setItem("safi_autoscan_weekly_last",String(Date.now()));
    store.setItem("safi_autoscan_last",String(Date.now()));
    if(autoScanMode==="weeklyRadio") await runAutoScan({scope:"radio-ke",limit:100,background:true});
  })();
}
window.addEventListener("online",()=>setTimeout(maybeAutoScan,8000));

/* ---------- ⚡ Booster (home server) detection ---------- */
function proxyUrl(u){ return "/proxy?u="+encodeURIComponent(u); }
async function detectBooster(){
  if(isNativeApp()){ boosterReady=false; if(window.__paintNet) window.__paintNet(); return; }
  if(!/^https?:$/.test(location.protocol)) return;
  try{
    const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(),3500);
    const r=await fetch("/__proxy_health__",{signal:ctl.signal,cache:"no-store"}); clearTimeout(to);
    if(r.ok){ const j=await r.json(); boosterReady=!!j.ok; }
  }catch(e){ boosterReady=false; }
  if(window.__paintNet) window.__paintNet();
  if(boosterReady) console.log("[SAFI] Stream Booster detected");
}
/* ---------- 🩺 Channel Doctor ---------- */
async function fetchLivePlaylist(url, ms){
  // True only for a LIVE HLS playlist (or a live variant of a master):
  // valid #EXTM3U, has segments, and NO #EXT-X-ENDLIST (endlist = finished/VOD).
  const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(), ms||8000);
  try{
    const r=await fetch(url,{signal:ctl.signal,cache:"no-store"});
    if(!r.ok) return false;
    const txt=await r.text();
    if(!txt.includes("#EXTM3U")||txt.includes("#EXT-X-ENDLIST")) return false;
    if(txt.includes("#EXT-X-STREAM-INF")){
      const lines=txt.split(/\r?\n/).map(s=>s.trim());
      let v=null;
      for(let i=0;i<lines.length;i++){ if(lines[i].startsWith("#EXT-X-STREAM-INF")){ for(let j=i+1;j<lines.length;j++){ if(lines[j]&&!lines[j].startsWith("#")){v=lines[j];break;} } break; } }
      if(!v) return false;
      const r2=await fetch(new URL(v,r.url||url).toString(),{signal:ctl.signal,cache:"no-store"});
      if(!r2.ok) return false;
      const t2=await r2.text();
      return t2.includes("#EXTINF")&&!t2.includes("#EXT-X-ENDLIST");
    }
    return txt.includes("#EXTINF");
  }catch(e){ return false; }
  finally{ clearTimeout(to); }
}
async function fetchStartsWithM3U(url, ms){
  const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(), ms||7000);
  try{
    const r=await fetch(url,{signal:ctl.signal,cache:"no-store"});
    if(!r.ok) return false;
    if(r.body && r.body.getReader){
      const rd=r.body.getReader(); const first=await rd.read(); try{ await rd.cancel(); }catch(e){}
      const txt=new TextDecoder().decode(first.value||new Uint8Array());
      return txt.includes("#EXTM3U");
    }
    const txt=await r.text(); return txt.includes("#EXTM3U");
  }catch(e){ return false; }
  finally{ clearTimeout(to); }
}
async function checkChannelHealth(ch){
  if(ch.type==="embed") return "embed";
  const urls=[ch.u,...(ch.b||[])];
  for(const u of urls){ if(await fetchLivePlaylist(u)) return "ok"; }
  if(boosterReady){ for(const u of urls){ if(await fetchLivePlaylist(proxyUrl(u))) return "boost"; } }
  if(isNativeApp()) return "fail"; /* native booster already applied to the direct fetch above */
  return "fail";
}
async function runChannelDoctor(scopeList){
  if(doctorRunning){ toast("Doctor is already checking…"); return; }
  const box=$("#doctorBox"); if(!box) return;
  doctorRunning=true;
  const list=(scopeList&&scopeList.length)?scopeList:allChannels(); let done=0, ok=0, boost=0, emb=0, fail=0; let idx=0;
  const paint=()=>{
    box.innerHTML='<div class="doctor"><div class="doctorTop"><b>🩺 Checking '+done+' / '+list.length+'</b><span>✓ '+ok+' &nbsp; ⚡ '+boost+' &nbsp; ▸ '+emb+' embedded &nbsp; ✖ '+fail+'</span></div><div class="dtrack"><i style="width:'+(list.length?Math.round(done/list.length*100):0)+'%"></i></div><p>Checking uses a little data. You can keep browsing — results save automatically.</p></div>';
  };
  paint();
  async function worker(){
    while(idx<list.length){
      const ch=list[idx++];
      const s=await checkChannelHealth(ch);
      healthMap[ch.n]={s,t:Date.now()};
      done++; if(s==="ok")ok++; else if(s==="boost")boost++; else if(s==="embed")emb++; else fail++;
      if(done%8===0){ paint(); saveHealth(); }
    }
  }
  await Promise.all([worker(),worker(),worker(),worker(),worker(),worker()]);
  saveHealth(); doctorRunning=false;
  box.innerHTML='<div class="doctor done"><div class="doctorTop"><b>🩺 Doctor finished</b><span>✓ '+ok+' working &nbsp; ⚡ '+boost+' via Booster &nbsp; ▸ '+emb+' embedded &nbsp; ✖ '+fail+' offline now</span></div><p>Cards are now marked. In the TV Guide use <b>Hide offline</b> to hide the ✖ ones. Not-24/7 stations may come back later — run the Doctor again any time.</p></div>';
  toast("🩺 Doctor: "+ok+" working, "+boost+" via Booster, "+fail+" offline now",5000);
  if(currentView==="live") renderLiveGrid(false);
  else if(currentView==="allchannels") renderAllList(false);
  else if(currentView==="home") show("home");
}

function runSearch(){
  const q=$("#searchInput").value.trim().toLowerCase(); const box=$("#searchResults");
  if(!q){box.innerHTML="";return;}
  const cs=everyChannel().filter(c=>(c.n+" "+c.c+" "+(c.co||"")).toLowerCase().includes(q)).slice(0,80);
  const rs=radioStations().filter(s=>(s.n+" "+(s.g||"")+" "+(s.co||"")).toLowerCase().includes(q)).slice(0,40);
  const ms=MOVIES.filter(m=>(m.t+" "+m.g).toLowerCase().includes(q));
  box.innerHTML=(cs.map(channelCard).join("")+rs.map(radioCard).join("")+ms.map(movieCard).join(""))||'<div class="empty">No results for “'+esc(q)+'”</div>';
  bindContent();
}

/* ---------- Activation ---------- */
function activate(el){
  const kind=el.dataset.kind, name=el.dataset.name;
  if(kind==="channel"){
    const list=(currentView==="allchannels"&&lastAllList.length)?lastAllList:(currentView==="live")?currentLiveList():everyChannel();
    const ch=list.find(c=>c.n===name)||everyChannel().find(c=>c.n===name);
    if(ch) playChannel(ch, list.some(c=>c.n===ch.n)?list:everyChannel());
  }
  if(kind==="radio"){ const list=(currentView==="radio")?currentRadioList():radioStations(); const st=list.find(s=>s.n===name)||radioStations().find(s=>s.n===name); if(st) playRadio(st,list.some(s=>s.n===st.n)?list:radioStations()); }
  if(kind==="movie"){const m=MOVIES.find(x=>x.t===name); if(m) playMovie(m);}
  if(kind==="app"){const a=APPS.find(x=>x.n===name); if(a) openHub(a);}
}
/* Hubs navigate INSIDE this app only. There is deliberately NO function
   that opens an external URL, browser tab, or another Android app. */
function openHub(a){
  if(a.view==="live" && a.cat) showLiveCategory(a.cat);
  else show(a.view||"home");
}
function toggleFav(name){
  if(favs.has(name)){favs.delete(name);toast("Removed from favourites");}else{favs.add(name);toast("★ Added to favourites");}
  saveFavs();
}

/* ---------- M3U ---------- */
function parseM3U(text){
  const lines=text.split(/\r?\n/), out=[];
  for(let i=0;i<lines.length;i++){
    if(lines[i].startsWith("#EXTINF")){
      const name=lines[i].rsplit?null:lines[i].substring(lines[i].lastIndexOf(",")+1).trim();
      const logo=(lines[i].match(/tvg-logo="([^"]*)"/)||[])[1]||"";
      const group=(lines[i].match(/group-title="([^"]*)"/)||[])[1]||"My Playlist";
      const url=(lines[i+1]||"").trim();
      if(name&&/^https?:\/\//.test(url)) out.push({n:name,c:"My Playlist",type:"hls",u:url,logo,d:group});
    }
  }
  return out.slice(0,3000);
}
async function loadM3uUrl(){
  const url=$("#m3uUrl").value.trim(), msg=$("#m3uMsg");
  if(!url){msg.textContent="⚠️ Paste an M3U URL first.";msg.className="msg err";return;}
  msg.textContent="⏳ Loading playlist…"; msg.className="msg";
  try{
    const r=await fetch(url); if(!r.ok) throw new Error("HTTP "+r.status);
    applyM3u(await r.text(),"url"); store.setItem("safi_m3u_url",url);
  }catch(e){
    msg.textContent="❌ Could not load that URL ("+e.message+"). The provider may block browsers (CORS) — download the .m3u file and use “Upload .m3u file”, or use the APK version.";
    msg.className="msg err";
  }
}
function applyM3u(text,src){
  const list=sanitizeChannelList(parseM3U(text),false,3000); const msg=$("#m3uMsg");
  if(!list.length){ if(msg){msg.textContent="❌ No channels found in that playlist.";msg.className="msg err";} return; }
  myChannels=list; store.setItem("safi_my_channels",JSON.stringify(list));
  if(msg){msg.textContent=`✅ Loaded ${list.length} channels! Go to Live TV → “My Playlist”.`;msg.className="msg ok";}
  toast(`✅ ${list.length} channels added`);
}


/* ---------- Offline storage (IndexedDB: recordings + downloaded movies) ---------- */
function idbOpen(){
  return new Promise((res,rej)=>{
    if(!window.indexedDB) return rej(new Error("Storage not supported on this TV/browser"));
    const rq=indexedDB.open("safi-offline-db",1);
    rq.onupgradeneeded=()=>{ rq.result.createObjectStore("media",{keyPath:"id",autoIncrement:true}); };
    rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error||new Error("Storage error"));
  });
}
async function idbAdd(item){
  const db=await idbOpen();
  return new Promise((res,rej)=>{ const tx=db.transaction("media","readwrite");
    tx.objectStore("media").add(item); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
}
async function idbAll(){
  const db=await idbOpen();
  return new Promise((res,rej)=>{ const out=[]; const rq=db.transaction("media").objectStore("media").openCursor();
    rq.onsuccess=()=>{ const cur=rq.result; if(cur){ out.push(cur.value); cur.continue(); } else res(out.reverse()); };
    rq.onerror=()=>rej(rq.error); });
}
async function idbDel(id){
  const db=await idbOpen();
  return new Promise((res,rej)=>{ const tx=db.transaction("media","readwrite");
    tx.objectStore("media").delete(id); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
}
function fmtBytes(b){ if(b===undefined||b===null) return ""; if(b<1048576) return Math.round(b/1024)+" KB"; if(b<1073741824) return (b/1048576).toFixed(1)+" MB"; return (b/1073741824).toFixed(2)+" GB"; }
async function renderOfflineList(){
  const box=$("#offlineList"); if(!box) return;
  try{ offlineCache=await idbAll(); }
  catch(e){ box.innerHTML='<div class="empty">Offline storage is not available on this TV/browser.<br>USB file playing above still works offline.</div>'; return; }
  const si=$("#storageInfo");
  if(si && navigator.storage && navigator.storage.estimate){
    try{ const est=await navigator.storage.estimate();
      si.innerHTML="Your recordings and downloaded movies ("+offlineCache.length+"). Storage used by this app: <b>"+fmtBytes(est.usage||0)+"</b>"+(est.quota?" of about "+fmtBytes(est.quota):"")+". Delete old items if space runs out."; }catch(e){}
  }
  if(!offlineCache.length){ box.innerHTML='<div class="empty">Nothing saved yet.<br><br>Download a movie below, record TV, or open Radio and press <b>Record</b> — then it appears here and plays with <b>no internet</b>.</div>'; return; }
  box.innerHTML=`<div class="grid">${offlineCache.map(it=>`<div class="card" style="width:auto">
      <div class="logo"><span class="initials">${/radio|audio/i.test(it.kind||"")||/^(audio\/|audio$)/.test(it.mime||"")?"📻":it.kind==="Live TV recording"?"⏺":"🎬"}</span></div>
      <h3 style="min-height:auto">${esc(it.title)}</h3>
      <p>${esc(it.kind)} • ${fmtBytes(it.size||(it.blob?it.blob.size:0))}<br>${new Date(it.date||Date.now()).toLocaleString("en-KE")}</p>
      <div class="inputrow">
        <button class="btn red focusable" data-off-play="${it.id}">▶ Play offline</button>
        <button class="btn ghost focusable" data-off-del="${it.id}">🗑 Delete</button>
      </div></div>`).join("")}</div>`;
  box.querySelectorAll("[data-off-play]").forEach(b=>b.addEventListener("click",()=>{
    const it=offlineCache.find(x=>x.id==b.dataset.offPlay); if(!it) return;
    if(lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl=URL.createObjectURL(it.blob);
    const isAudio=/radio|audio/i.test(it.kind||"")||/^(audio\/|audio$)/.test(it.mime||"")||(it.blob&&/^audio\//.test(it.blob.type||""));
    currentList=[]; currentItem={t:it.title,n:it.title,type:isAudio?"radio":"mp4",g:isAudio?"Offline Radio":"",co:"Saved offline",d:it.kind||""};
    playUrl({title:it.title, sub:"Saved on this device — playing OFFLINE (no data)", u:lastObjectUrl, type:isAudio?"radio":"mp4", radio:isAudio?currentItem:null});
  }));
  box.querySelectorAll("[data-off-del]").forEach(b=>b.addEventListener("click",async()=>{
    const it=offlineCache.find(x=>x.id==b.dataset.offDel);
    await idbDel(Number(b.dataset.offDel));
    toast("Deleted: "+(it?it.title:"video"));
    renderOfflineList();
  }));
}
async function saveMovieOffline(m, btn){
  if(!m) return;
  try{
    const all=await idbAll().catch(()=>[]);
    if(all.some(x=>x.title===m.t)){ toast("Already saved offline: "+m.t); if($("#offlineList")) renderOfflineList(); return; }
    if(btn && btn.classList.contains("card")) btn.innerHTML='<div class="logo"><span class="initials">⬇</span></div><h3>'+esc(m.t)+'</h3><p>Downloading... 0%</p>';
    toast("Downloading "+m.t+" — keep internet on until done",3500);
    const res=await fetch(m.u); if(!res.ok) throw new Error("Download failed (HTTP "+res.status+")");
    let blob;
    const total=Number(res.headers.get("content-length")||0);
    if(res.body && res.body.getReader){
      const reader=res.body.getReader(), chunks=[]; let got=0, lastPaint=0;
      while(true){ const r=await reader.read(); if(r.done) break; chunks.push(r.value); got+=r.value.length;
        if(btn && btn.classList.contains("card") && total && Date.now()-lastPaint>800){ lastPaint=Date.now();
          btn.innerHTML='<div class="logo"><span class="initials">⬇</span></div><h3>'+esc(m.t)+'</h3><p>Downloading... '+Math.round(got/total*100)+'% ('+fmtBytes(got)+')</p>'; } }
      blob=new Blob(chunks,{type:"video/mp4"});
    } else { blob=await res.blob(); }
    await idbAdd({title:m.t, kind:"Downloaded movie", blob, size:blob.size, mime:"video/mp4", date:Date.now()});
    toast("Saved offline: "+m.t+" ("+fmtBytes(blob.size)+") — open Offline/USB any time, even with data off",4500);
    if($("#offlineList")) renderOfflineList(); else if(btn) btn.textContent="Saved offline ✓";
  }catch(e){
    toast("Could not save "+m.t+": "+e.message,4500);
    if(btn && $("#offlineList")) renderOfflineList();
  }
}
function playLocalFile(file){
  if(!file) return;
  if(lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  lastObjectUrl=URL.createObjectURL(file);
  const isAudio=/^audio\//.test(file.type||"")||/\.(mp3|aac|m4a|ogg|opus|wav|flac)$/i.test(file.name);
  currentList=[]; currentItem={t:file.name,n:file.name,type:isAudio?"radio":"mp4",g:isAudio?"USB Audio":"",co:"USB / device",d:fmtBytes(file.size)};
  playUrl({title:file.name, sub:"Playing from USB / device storage — OFFLINE (no data) • "+fmtBytes(file.size), u:lastObjectUrl, type:isAudio?"radio":"mp4", radio:isAudio?currentItem:null});
}
/* ---------- Record live TV (watch later offline) ---------- */
function toggleRecording(){
  if(mediaRecorder && mediaRecorder.state==="recording"){ mediaRecorder.stop(); toast("Stopping — saving recording..."); return; }
  if(isEmbed){ toast("This embedded station (Citizen/NTV/KTN/TV47) cannot be recorded. Try a normal channel e.g. Inooro, K24.",4000); return; }
  const v=video();
  if(!window.MediaRecorder || !v.captureStream){
    playerShowMsg("⚠️ <b>Recording is not supported on this TV/browser.</b><br><br>You can still watch offline by downloading a movie or playing a file from USB (Offline / USB page).");
    return;
  }
  try{
    const isRadioRec=playerMediaKind==="radio"||!!(currentItem&&currentItem.type==="radio");
    recKind=isRadioRec?"Radio recording":"Live TV recording";
    let recStream=v.captureStream();
    if(isRadioRec && recStream.getAudioTracks && recStream.getAudioTracks().length){
      try{ recStream=new MediaStream(recStream.getAudioTracks()); }catch(e){}
    }
    const mimeList=isRadioRec?["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg;codecs=opus"]:["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"];
    const mime=mimeList.find(x=>{try{return MediaRecorder.isTypeSupported(x)}catch(e){return false}})||"";
    mediaRecorder=new MediaRecorder(recStream, mime?{mimeType:mime,...(isRadioRec?{audioBitsPerSecond:128000}:{videoBitsPerSecond:lowData?1000000:2500000})}:undefined);
    recChunks=[]; recStartedAt=Date.now();
    recTitle=(currentItem&&(currentItem.n||currentItem.t))||"Live TV";
    mediaRecorder.ondataavailable=e=>{ if(e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop=async()=>{
      clearInterval(recTimer); clearTimeout(recAutoStopTimer); recAutoStopTimer=null; const btnR=$("#btnRec"); if(btnR) btnR.textContent="⏺ Record";
      const blob=new Blob(recChunks,{type:(mediaRecorder&&mediaRecorder.mimeType)||"video/webm"}); recChunks=[]; mediaRecorder=null;
      if(!blob.size){ toast("Recording was empty — this stream may have blocked recording"); return; }
      try{
        await idbAdd({title:recTitle+" — "+new Date(recStartedAt).toLocaleString("en-KE"), kind:recKind, blob, size:blob.size, mime:blob.type, date:recStartedAt});
        toast("Recording saved ("+fmtBytes(blob.size)+") — find it in Offline/USB. Plays with NO internet.",5000);
      }catch(e){ toast("Could not save recording (storage full?): "+e.message,4500); }
    };
    mediaRecorder.start(1000);
    if(recKind==="Radio recording"){
      clearTimeout(recAutoStopTimer);
      recAutoStopTimer=setTimeout(()=>{ if(mediaRecorder&&mediaRecorder.state==="recording"){ toast("📻 30 minutes reached — saving your offline radio recording",4000); mediaRecorder.stop(); } },30*60*1000);
    }
    const upd=()=>{ const s=Math.floor((Date.now()-recStartedAt)/1000); const b=$("#btnRec"); if(b) b.textContent="⏹ Stop "+Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); };
    upd(); recTimer=setInterval(upd,1000); wakeUI();
    toast(recKind==="Radio recording"?"📻 Recording radio (max 30 min) — the saved copy plays offline":"Recording... data is being used NOW; the saved copy plays offline later",4000);
  }catch(e){
    playerShowMsg("⚠️ <b>Could not start recording.</b><br><br>"+esc(e.message)+"<br><br>Some streams block recording. Try another channel, or use movie downloads / USB (Offline page).");
    mediaRecorder=null;
  }
}

/* ---------- Player ---------- */
const video=()=>$("#video");
function playerShowMsg(html){
  const m=$("#playerMsg");
  if(html){
    const isErr=html.includes("errCard");
    if(!isErr){ html='<div class="spinOnly">'+html+'</div>'; playerErrorOpen=false; }
    m.classList.toggle("loadingOnly",!isErr);
    m.classList.toggle("errorCard",isErr);
    m.innerHTML=html; m.classList.add("show");
  } else { m.classList.remove("show","loadingOnly","errorCard"); playerErrorOpen=false; }
}
function wakeUI(){ $("#playerUI").classList.remove("hide"); clearTimeout(uiTimer); uiTimer=setTimeout(()=>$("#playerUI").classList.add("hide"),4500); }
function openPlayer(title,sub){
  $("#playerWrap").classList.add("open");
  const _isRadio=playerMediaKind==="radio";
  $("#playerWrap").classList.toggle("radio-open",_isRadio);
  const _rv=$("#radioVisual");
  if(_rv){
    _rv.classList.toggle("show",_isRadio);
    if(_isRadio){
      const st=(currentItem&&currentItem.type==="radio")?currentItem:{n:title,g:"Saved audio",co:"Offline"};
      const ini=$("#radioInitials"); if(ini) ini.textContent=initials(st.n||title)||"📻";
      const rm=$("#radioMeta"); if(rm) rm.innerHTML='<b>'+esc(st.n||title)+'</b><span>'+esc(st.f||"LIVE RADIO")+' • '+esc(st.g||"")+' • '+esc(st.co||"")+'</span>';
      _rv.style.setProperty("--rh",hueFor(st.n||title));
    }
  }
  const _bp2=$("#btnPrev"), _bn2=$("#btnNext");
  if(_bp2) _bp2.textContent=_isRadio?"⏮ Prev Station":"⏮ Prev Channel";
  if(_bn2) _bn2.textContent=_isRadio?"Next Station ⏭":"Next Channel ⏭";
  playerTitle=title; playerBaseSub=sub||"";
  $("#pTitle").textContent=title; $("#pSub").textContent=sub||"";
  const _ps=$("#pSource"); if(_ps) _ps.textContent="Connecting…";
  const _bp=$("#btnPlay"); if(_bp) _bp.textContent="⏸ Pause";
  $("#btnFav").textContent = favs.has(title)?"★ Favourited":"☆ Favourite";
  playerShowMsg('<div class="spinner"></div>Loading… please wait');
  wakeUI();
  if(document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(()=>{});
}
function clearEmbed(){
  $("#playerWrap").classList.remove("embed-open");
  const f=$("#embedFrame"); if(f){ f.removeAttribute("src"); f.classList.remove("open"); }
  const v=video(); if(v) v.style.display="";
  isEmbed=false;
}
function closePlayer(){
  playSession++;
  clearTimeout(watchdog);
  const v0=video();
  if(currentItem && currentItem.t && isFinite(v0.duration) && v0.currentTime>5){
    addHistory("movie", currentItem.t, (v0.duration-v0.currentTime>15)?v0.currentTime:0);
  }
  if(mediaRecorder && mediaRecorder.state==="recording") mediaRecorder.stop();
  clearTimeout(recAutoStopTimer); recAutoStopTimer=null;
  $("#playerWrap").classList.remove("radio-open"); const _rv2=$("#radioVisual"); if(_rv2) _rv2.classList.remove("show"); playerMediaKind="video";
  clearEmbed();
  const v=video(); v.pause(); v.removeAttribute("src"); v.load();
  if(hls){hls.destroy();hls=null;}
  $("#playerWrap").classList.remove("open"); playerShowMsg("");
  if(document.fullscreenElement) document.exitFullscreen().catch(()=>{});
  if(lastObjectUrl){ URL.revokeObjectURL(lastObjectUrl); lastObjectUrl=null; }
  currentItem=null; attemptSources=[]; attemptIdx=0; resumeAt=0; playerErrorOpen=false;
  if(currentView==="home") show("home");
  else { const f=document.querySelector(".focused")||$("#content .focusable"); if(f) setFocus(f); }
}
/* ================= Resilient Player Engine v2 =================
   Tries, in order: Direct -> Mirror(s) -> Booster -> Embedded fallback.
   Network/media errors are auto-repaired; a watchdog switches source
   if a stream produces no picture. Nothing ever leaves the app. */
let resumeAt = 0;
function setSourceUI(src){
  const ps=$("#pSource"); if(ps) ps.textContent=src?src.label:"";
  const mb=$("#btnMirror"); if(mb) mb.textContent="🔁 Source "+(attemptIdx+1)+"/"+Math.max(1,attemptSources.length);
  $("#pSub").textContent=playerBaseSub+(attemptSources.length>1&&src?" • "+src.label:"");
}
function cleanupAttempt(){
  clearTimeout(watchdog);
  if(hls){ try{hls.destroy();}catch(e){} hls=null; }
  const v=video(); v.oncanplay=null; v.onerror=null;
}
function friendlyReason(r){
  r=String(r||"");
  if(/offline/i.test(r)) return "No internet connection";
  if(/manifest|network|404|no picture|slow|no signal/i.test(r)) return "Station not sending a stream";
  if(/cors/i.test(r)) return "Stream blocked the TV browser";
  if(/media|codec|decode/i.test(r)) return "Picture format problem";
  if(/help/i.test(r)) return "You opened Fix / Help";
  return r ? r.slice(0,60) : "Unknown";
}
function showPlayerError(reason, isHelp){
  lastErrorReason=reason||"";
  const ch=(currentItem&&currentItem.n)?currentItem:null;
  const not247=!!(ch&&/Not 24\/7/.test(ch.d||""));
  const why = !navigator.onLine
    ? "Your device is <b>offline</b> right now — live streams need internet (or an aerial). Your saved videos still work with zero data."
    : not247
    ? "Most likely this station's own encoder is <b>off air</b> — it is marked <b>Not 24/7</b> by its owner and only appears when they switch it on. No app can switch a broadcaster on, but the buttons below find you something working."
    : /cors/i.test(reason||"")
    ? "This stream <b>blocked the TV browser</b> (a CORS/referrer rule). The ⚡ Booster fixes exactly this — it is built into the APK and into server.py."
    : "Most likely the station is <b>off air, its stream address died, or it is blocked in your area</b>. That is on the broadcaster's side — your TV and SAFI TV+ are fine.";
  const facts=[`Sources tried: <b>${Math.max(1,attemptSources.length)}</b>`,`Internet: <b>${navigator.onLine?"Online 🟢":"Offline 🔴"}</b>`,`Booster: <b>${boosterLabel()?"ON ⚡":"Off — APK/server.py"}</b>`,`Problem: <b>${esc(friendlyReason(reason))}</b>`];
  playerShowMsg(`<div class="errCard">
    <div class="errHead"><div class="errIcon">${isHelp?"❔":"📡"}</div><div>
      <h2>${isHelp?"Channel help":"No signal on this channel"}</h2>
      <p>${esc(playerTitle||"")} — SAFI TV+ already auto-tries Direct → Mirror → ⚡ Booster → fallback, all inside the app.</p></div></div>
    <div class="errFacts">${facts.map(f=>`<span class="bdg b-boost">${f}</span>`).join("")}</div>
    <p class="errWhy">${why}</p>
    <ol class="errSteps"><li><b>Try Again</b> — streams often recover in seconds.</li><li><b>Next Source</b> — a mirror or Booster route may work.</li><li>Slow internet? Turn on <b>Settings → Low-Data</b>.</li><li>Run <b>🩺 Channel Doctor</b>, then pick a ✓ Working channel.</li></ol>
    <div class="errBtns">
      ${!navigator.onLine?'<button class="ebtn primary focusable" data-perr="offline">⬇ Watch Offline / USB (no data)</button>':""}
      ${isHelp?'<button class="ebtn primary focusable" data-perr="resume">▶ Resume watching</button>':""}
      <button class="ebtn ${(!isHelp&&navigator.onLine)?"primary":""} focusable" data-perr="retry">↻ Try Again</button>
      <button class="ebtn focusable" data-perr="mirror">🔁 Next Source</button>
      <button class="ebtn focusable" data-perr="similar">▶ Similar Working Channel</button>
      <button class="ebtn focusable" data-perr="doctor">🩺 Channel Doctor</button>
      <button class="ebtn focusable" data-perr="prevch">⏮ Previous Channel</button>
      <button class="ebtn focusable" data-perr="nextch">Next Channel ⏭</button>
      <button class="ebtn focusable" data-perr="all">☰ All Channels</button>
      <button class="ebtn focusable" data-perr="home">⌂ Home</button>
      <button class="ebtn focusable" data-perr="back">← Previous Screen</button>
      <button class="ebtn focusable" data-perr="exit">⏻ Exit</button>
    </div></div>`);
  playerErrorOpen=true;
  $("#playerMsg").querySelectorAll("[data-perr]").forEach(b=>b.addEventListener("click",()=>playerErrorAction(b.dataset.perr)));
  wakeUI();
  const f=$("#playerMsg .ebtn"); if(f) setFocus(f);
}
function playerErrorAction(act){
  if(act==="resume"){ playerShowMsg(""); return; }
  if(act==="retry"){
    playerErrorOpen=false; attemptIdx=0; cleanupAttempt(); clearEmbed();
    const v=video(); try{v.pause(); v.removeAttribute("src"); v.load();}catch(e){}
    attemptSource(playSession); return;
  }
  if(act==="mirror"){ playerErrorOpen=false; cycleMirror(); return; }
  if(act==="similar"){
    if(currentItem&&currentItem.type==="radio"){
      const pool=radioStations().filter(s=>s!==currentItem&&(s.co===currentItem.co||s.g===currentItem.g));
      const nxt=pool.find(s=>healthOf(s.n)==="ok")||pool[0]||radioStations().find(s=>s!==currentItem);
      if(nxt){ toast("📻 "+nxt.n); playRadio(nxt,currentList&&currentList.some(s=>s.n===nxt.n)?currentList:radioStations()); }
      return;
    }
    const base=(currentList&&currentList.length)?currentList:allChannels();
    const cat=currentItem&&currentItem.c;
    let pool=smartSort(base.filter(c=>c!==currentItem&&(!cat||c.c===cat)));
    if(!pool.length) pool=smartSort(allChannels().filter(c=>c!==currentItem));
    const nxt=pool.find(c=>["ok","boost","embed"].includes(healthOf(c.n))||c.type==="embed")||pool[0];
    if(nxt){ toast("▶ "+nxt.n); playChannel(nxt, base.some(c=>c.n===nxt.n)?base:allChannels()); }
    return;
  }
  if(act==="prevch"){ playerErrorOpen=false; zap(-1); return; }
  if(act==="nextch"){ playerErrorOpen=false; zap(1); return; }
  if(act==="home"){ closePlayer(); show("home"); return; }
  if(act==="exit"){ exitApp(); return; }
  if(act==="doctor"){ closePlayer(); show("live"); setTimeout(()=>runChannelDoctor(),350); return; }
  if(act==="all"){ closePlayer(); show("allchannels"); return; }
  if(act==="offline"){ closePlayer(); show("offline"); return; }
  if(act==="back"){ closePlayer(); return; }
}
function movePlayerFocus(dir){
  const els=[...document.querySelectorAll("#playerWrap .focusable")].filter(el=>el.offsetParent!==null);
  const cur=document.querySelector("#playerWrap .focused")||els[0]; if(!cur) return;
  const r=cur.getBoundingClientRect(), cx=r.left+r.width/2, cy=r.top+r.height/2;
  let best=null,bestScore=Infinity;
  for(const el of els){
    if(el===cur) continue;
    const q=el.getBoundingClientRect(), x=q.left+q.width/2, y=q.top+q.height/2, dx=x-cx, dy=y-cy;
    if(dir==="left"&&dx>=-8) continue; if(dir==="right"&&dx<=8) continue;
    if(dir==="up"&&dy>=-8) continue; if(dir==="down"&&dy<=8) continue;
    const primary=(dir==="left"||dir==="right")?Math.abs(dx):Math.abs(dy);
    const secondary=(dir==="left"||dir==="right")?Math.abs(dy):Math.abs(dx);
    const score=primary+secondary*2.5;
    if(score<bestScore){bestScore=score;best=el;}
  }
  if(best) setFocus(best);
}
function finalFail(reason){
  clearTimeout(watchdog);
  if(currentItem&&currentItem.n){ healthMap[currentItem.n]={s:"fail",t:Date.now()}; saveHealth(); }
  showPlayerError(reason);
}
function nextSource(reason){
  if(attemptIdx+1>=attemptSources.length){ finalFail(reason); return; }
  const session=playSession;
  attemptIdx++;
  cleanupAttempt(); clearEmbed();
  const v=video(); try{v.pause(); v.removeAttribute("src"); v.load();}catch(e){}
  playerShowMsg('<div class="spinner"></div>Switching source… ('+(attemptIdx+1)+"/"+attemptSources.length+")");
  setTimeout(()=>attemptSource(session), 350);
}
function attemptSource(session){
  if(session!==playSession) return;
  const src=attemptSources[attemptIdx];
  if(!src){ finalFail("no source"); return; }
  attemptNet=0; attemptMedia=0;
  setSourceUI(src);
  playerShowMsg('<div class="spinner"></div>Connecting… '+esc(src.label)+(attemptSources.length>1?" ("+(attemptIdx+1)+"/"+attemptSources.length+")":""));
  wakeUI();
  const v=video();
  if(src.type==="embed"){
    isEmbed=true; $("#playerWrap").classList.add("embed-open");
    cleanupAttempt();
    try{ v.pause(); v.removeAttribute("src"); v.load(); }catch(e){}
    v.style.display="none";
    const f=$("#embedFrame");
    f.onload=()=>{ if(session===playSession) playerShowMsg(""); };
    f.src=src.u; f.classList.add("open");
    $("#ptime").textContent="● LIVE — inside SAFI TV+ (Back = channel list)";
    setTimeout(()=>{ if(session===playSession) playerShowMsg(""); }, 4500);
    return;
  }
  clearEmbed();
  cleanupAttempt();
  const isHls = src.type==="hls" || src.u.includes(".m3u8");
  const onMeta=()=>{
    v.removeEventListener("loadedmetadata", onMeta);
    if(session!==playSession) return;
    if(resumeAt>10 && isFinite(v.duration) && resumeAt<v.duration-15){
      try{ v.currentTime=resumeAt; toast("▶ Resumed where you left off"); }catch(e){}
    }
  };
  v.addEventListener("loadedmetadata", onMeta);
  const onPlaying=()=>{
    v.removeEventListener("playing", onPlaying);
    if(session!==playSession) return;
    clearTimeout(watchdog); playerShowMsg("");
    if(currentItem && currentItem.n){
      const s = (isNativeApp()||src.label.includes("Booster")) ? healthOf(currentItem.n)==="ok"?"ok":(src.label.includes("Booster")?"boost":"ok") : "ok";
      if(healthOf(currentItem.n)!==s){ healthMap[currentItem.n]={s,t:Date.now()}; saveHealth(); }
    }
  };
  v.addEventListener("playing", onPlaying);
  const armWatchdog=(ms)=>{
    clearTimeout(watchdog);
    watchdog=setTimeout(()=>{
      if(session===playSession && $("#playerWrap").classList.contains("open") && !isEmbed && v.readyState<3)
        nextSource("no picture (slow / no signal)");
    }, ms||16000);
  };
  armWatchdog(src.label.includes("Booster")?22000:16000);

  if(isHls && window.Hls && Hls.isSupported()){
    const cfg={ enableWorker:true,
      startLevel: lowData?0:-1, capLevelToPlayerSize:true,
      maxBufferLength:30, maxMaxBufferLength:120, backBufferLength:30,
      manifestLoadingMaxRetry:2, manifestLoadingRetryDelay:800, manifestLoadingMaxRetryTimeout:10000,
      levelLoadingMaxRetry:6, levelLoadingRetryDelay:1000, levelLoadingMaxRetryTimeout:60000,
      fragLoadingMaxRetry:6, fragLoadingRetryDelay:1000, fragLoadingMaxRetryTimeout:60000,
      liveSyncDurationCount:3 };
    const my=new Hls(cfg); hls=my;
    my.loadSource(src.u); my.attachMedia(v);
    my.on(Hls.Events.MANIFEST_PARSED,()=>{
      if(session!==playSession||hls!==my) return;
      if(lowData) my.autoLevelCapping=0;
      v.play().catch(()=>{});
    });
    my.on(Hls.Events.LEVEL_SWITCHED,(e,d)=>{
      if(session!==playSession||hls!==my) return;
      try{ const lv=my.levels&&my.levels[d.level]; const ps=$("#pSource");
        if(ps&&lv&&lv.height) ps.textContent=src.label+" • "+lv.height+"p"; }catch(e){}
    });
    my.on(Hls.Events.ERROR,(e,d)=>{
      if(session!==playSession||hls!==my||!d) return;
      if(!d.fatal) return;
      if(d.type===Hls.ErrorTypes.NETWORK_ERROR){
        if(attemptNet<2){
          attemptNet++;
          playerShowMsg('<div class="spinner"></div>Network hiccup — auto-retry '+attemptNet+'/2…');
          armWatchdog(18000);
          setTimeout(()=>{ if(session===playSession&&hls===my){ try{my.startLoad();}catch(e){} } }, 900*attemptNet);
        } else nextSource(d.details||"network error");
      } else if(d.type===Hls.ErrorTypes.MEDIA_ERROR){
        if(attemptMedia===0){ attemptMedia++; try{my.recoverMediaError();}catch(e){ nextSource("media error"); } }
        else if(attemptMedia===1){ attemptMedia++; try{my.swapAudioCodec(); my.recoverMediaError();}catch(e){ nextSource("media error"); } }
        else nextSource(d.details||"media error");
      } else nextSource(d.details||"stream error");
    });
  } else {
    v.src=src.u;
    v.oncanplay=()=>{ if(session===playSession) playerShowMsg(""); };
    v.onerror=()=>{ if(session===playSession) nextSource("file/stream error"); };
    v.play().catch(()=>{});
  }
}
function playUrl(item){
  const session=++playSession;
  playerMediaKind=item.radio?"radio":"video";
  resumeAt=item.resumeAt||0;
  attemptSources = item.sources && item.sources.length ? item.sources
    : [{u:item.u, type:item.type, label:item.type==="embed"?"Embedded live":"Direct"}];
  attemptIdx=0;
  openPlayer(item.title, item.sub);
  const needsNet = attemptSources.some(s=>/^https?:/.test(s.u));
  if(needsNet && !navigator.onLine){ showPlayerError("offline"); return; }
  attemptSource(session);
}
function closePlayerSilent(){ playSession++; clearTimeout(watchdog); clearEmbed(); if(hls){hls.destroy();hls=null;} $("#playerWrap").classList.remove("open","radio-open"); const _rv3=$("#radioVisual"); if(_rv3) _rv3.classList.remove("show"); playerMediaKind="video"; }
function channelSources(ch){
  const srcs=[];
  const push=(u,type,label)=>{ if(u&&!srcs.some(s=>s.u===u)) srcs.push({u,type:/\.m3u8($|\?)/i.test(u)?"hls":type,label}); };
  if(ch.type==="embed"){
    push(ch.u,"embed","Live player");
    (ch.b||[]).forEach((u,i)=>push(u,"embed","Player "+(i+2)));
    if(ch.e) push(ch.e,"embed","Live fallback");
    if(boosterReady) srcs.filter(s=>s.type==="hls").forEach(s=>push(proxyUrl(s.u),"hls","⚡ Booster"));
    return srcs;
  }
  const urls=[...new Set([ch.u,...(ch.b||[])].filter(Boolean))];
  urls.forEach((u,i)=>push(u,"hls",i?("Mirror "+(i+1)):"Direct"));
  if(boosterReady) urls.forEach((u,i)=>{ if(/^https?:/.test(u)) push(proxyUrl(u),"hls","⚡ Booster"+(i?" "+(i+1):"")); });
  if(ch.e) push(ch.e,"embed","Live fallback");
  return srcs;
}
function playChannel(ch,list){
  currentList=(list||allChannels());
  currentIndex=currentList.indexOf(ch); currentItem=ch;
  addHistory("channel", ch.n);
  playUrl({title:ch.n, sub:`CH ${chGlobalNo(ch)} • ${ch.c} • ${ch.d||""} — CH+/CH− zap`, u:ch.u, type:ch.type, sources:channelSources(ch)});
}
function radioSources(st){
  const urls=[...new Set([st.u,...(st.b||[])].filter(Boolean))];
  const srcs=urls.map((u,i)=>({u,type:/\.m3u8($|\?)/i.test(u)?"hls":"audio",label:i?("Radio Mirror "+(i+1)):"Live Radio"}));
  if(boosterReady) urls.forEach((u,i)=>{ if(/\.m3u8($|\?)/i.test(u)) srcs.push({u:proxyUrl(u),type:"hls",label:"⚡ Booster Radio"+(i?" "+(i+1):"")}); });
  return srcs;
}
function playRadio(st,list){
  currentList=(list&&list.length)?list:radioStations();
  currentIndex=currentList.indexOf(st); currentItem=st;
  addHistory("radio",st.n);
  playUrl({title:st.n, sub:`📻 ${st.f||"Online Radio"} • ${st.g||""} • ${st.co||""} — CH+/CH− station`, u:st.u, type:"radio", sources:radioSources(st), radio:st});
}
function zap(dir){
  if(!currentList.length) return;
  currentIndex=(currentIndex+dir+currentList.length)%currentList.length;
  const it=currentList[currentIndex]; if(!it) return;
  if(it.type==="radio") playRadio(it,currentList); else playChannel(it,currentList);
}
function cycleMirror(){
  if(!attemptSources.length) return;
  if(attemptSources.length<2){ toast(boosterReady||isNativeApp()?"Only one source exists for this channel":"Only one source — enable the Booster (server.py / APK) for a second way in",3500); return; }
  attemptIdx=(attemptIdx+1)%attemptSources.length;
  const session=playSession;
  cleanupAttempt(); clearEmbed();
  const v=video(); try{v.pause(); v.removeAttribute("src"); v.load();}catch(e){}
  attemptSource(session);
}
function playMovie(m){
  currentList=[]; currentItem=m;
  const h=watchHistory.find(x=>x.kind==="movie"&&x.name===m.t);
  const resume=(h&&h.pos>10)?h.pos:0;
  addHistory("movie", m.t, resume);
  playUrl({title:m.t, sub:`${m.y} • ${m.g} • ★ ${m.r} • ${m.dur} — ${m.d}`, u:m.u, type:m.type, resumeAt:resume});
}
video().addEventListener("timeupdate",()=>{
  const v=video();
  if(v.duration){ $("#progress i").style.width=(v.currentTime/v.duration*100)+"%";
    if(currentItem && currentItem.t && isFinite(v.duration) && v.currentTime>5 && Date.now()-lastPosSave>6000){
      lastPosSave=Date.now(); addHistory("movie", currentItem.t, (v.duration-v.currentTime>15)?v.currentTime:0);
    }
    const f=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;
    $("#ptime").textContent=isFinite(v.duration)?`${f(v.currentTime)} / ${f(v.duration)}`:"● LIVE";
  } else $("#ptime").textContent=playerMediaKind==="radio"?"● LIVE RADIO":"● LIVE";
});
$("#btnBack").addEventListener("click",closePlayer);
$("#btnPlay").addEventListener("click",()=>{ if(isEmbed){ toast("Use the ⏯ button in the centre of the video (Back = exit)"); wakeUI(); return; } const v=video(); v.paused?v.play():v.pause(); $("#btnPlay").textContent=v.paused?"▶ Play":"⏸ Pause"; wakeUI();});
$("#btnPrev").addEventListener("click",()=>zap(-1));
$("#btnNext").addEventListener("click",()=>zap(1));
$("#btnFav").addEventListener("click",()=>{ if(currentItem){toggleFav(currentItem.n||currentItem.t); $("#btnFav").textContent=favs.has(currentItem.n||currentItem.t)?"★ Favourited":"☆ Favourite";} wakeUI();});
$("#btnFull").addEventListener("click",()=>{document.documentElement.requestFullscreen?.().catch(()=>{}); wakeUI();});
$("#btnRec").addEventListener("click",()=>{ toggleRecording(); wakeUI(); });
$("#btnMirror").addEventListener("click",()=>{ cycleMirror(); wakeUI(); });
$("#btnHelp").addEventListener("click",()=>{ showPlayerError(lastErrorReason||"help", true); });
$("#btnSave").addEventListener("click",(e)=>{
  if(currentItem && currentItem.t && currentItem.u && /^https?:/.test(currentItem.u) && currentItem.type==="mp4"){
    const m=MOVIES.find(x=>x.t===currentItem.t)||{t:currentItem.t,u:currentItem.u}; saveMovieOffline(m, e.currentTarget);
  } else if(currentItem && currentItem.type==="radio"){ toast("📻 Recording live radio for offline — press Stop any time (auto-stops at 30 min)",4500); toggleRecording(); }
  else if(isEmbed){ toast("Embedded stations cannot be downloaded/recorded. Use a normal channel + Record.",4000); }
  else { toast("For LIVE TV use the Record button: watch now, save it, replay offline later.",4500); }
  wakeUI();
});
$("#playerWrap").addEventListener("mousemove",wakeUI);

/* ---------- Keys / Remote ---------- */
function showNumOsd(){ const o=$("#numOsd"); if(o){ o.textContent="CH "+digitBuffer+"_"; o.classList.add("show"); } }
function hideNumOsd(){ const o=$("#numOsd"); if(o) o.classList.remove("show"); }
document.addEventListener("keydown",e=>{
  const inPlayer=$("#playerWrap").classList.contains("open");
  const typing=/INPUT|TEXTAREA/.test(document.activeElement?.tagName||"");
  const back=["Escape","Backspace","BrowserBack"].includes(e.key)||e.keyCode===10009||e.keyCode===461; // Samsung/LG back
  if(/^[0-9]$/.test(e.key) && !typing && currentView!=="search"){
    e.preventDefault();
    digitBuffer=(digitBuffer+e.key).slice(-3); showNumOsd();
    clearTimeout(digitTimer);
    digitTimer=setTimeout(()=>{
      const n=parseInt(digitBuffer,10); digitBuffer=""; hideNumOsd();
      const list=allChannels();
      if(n>=1&&n<=list.length) playChannel(list[n-1], list);
      else toast("No channel "+n+" (1–"+list.length+")");
    },1200);
    return;
  }
  if(!inPlayer && !typing && (e.key==="BrowserForward" || (e.altKey&&e.key==="ArrowRight"))){ e.preventDefault(); navigateForward(); return; }
  if(!inPlayer && !typing && e.altKey && e.key==="ArrowLeft"){ e.preventDefault(); navigateBack(); return; }
  if(inPlayer){
    wakeUI();
    if(back){e.preventDefault();closePlayer();return;}
    if(playerErrorOpen){
      if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){ e.preventDefault(); movePlayerFocus(e.key.replace("Arrow","").toLowerCase()); return; }
      if(e.key==="Enter"||e.key===" "){ const f=document.querySelector("#playerWrap .focused"); if(f){ e.preventDefault(); f.click(); return; } }
      if(/^[a-zA-Z]$/.test(e.key)) return;
    }
    const v=video();
    if(e.key===" "||e.key==="Enter"||e.key==="MediaPlayPause"){e.preventDefault(); if(!isEmbed){ v.paused?v.play():v.pause(); $("#btnPlay").textContent=v.paused?"▶ Play":"⏸ Pause"; } }
    else if(e.key==="ArrowLeft"){e.preventDefault(); if(isFinite(v.duration)) v.currentTime=Math.max(0,v.currentTime-10); else zap(-1);}
    else if(e.key==="ArrowRight"){e.preventDefault(); if(isFinite(v.duration)) v.currentTime=Math.min(v.duration||0,v.currentTime+10); else zap(1);}
    else if(e.key==="ArrowUp"){e.preventDefault(); if(isEmbed) zap(-1); else { v.volume=Math.min(1,v.volume+0.1); toast("🔊 "+Math.round(v.volume*100)+"%",900); } }
    else if(e.key==="ArrowDown"){e.preventDefault(); if(isEmbed) zap(1); else { v.volume=Math.max(0,v.volume-0.1); toast("🔉 "+Math.round(v.volume*100)+"%",900); } }
    else if(e.key==="ChannelUp"||e.key==="PageUp"){e.preventDefault();zap(1);}
    else if(e.key==="ChannelDown"||e.key==="PageDown"){e.preventDefault();zap(-1);}
    else if(e.key.toLowerCase()==="m"){ cycleMirror(); }
    else if(e.key.toLowerCase()==="r"){ toggleRecording(); }
    else if(e.key.toLowerCase()==="f"){ if(currentItem) toggleFav(currentItem.n||currentItem.t); }
    return;
  }
  if(typing && !["ArrowUp","ArrowDown","Escape"].includes(e.key)) return;
  if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();move(e.key.replace("Arrow","").toLowerCase());}
  else if(e.key==="Enter"){const f=document.querySelector(".focused"); if(f){e.preventDefault();
    if(f.tagName==="INPUT"){f.focus();} else f.click();}}
  else if(back && !typing){ e.preventDefault(); navigateBack(); }
  else if(e.key.toLowerCase()==="f"&&!typing){const f=document.querySelector(".focused"); if(f&&f.dataset.name) toggleFav(f.dataset.name); show(currentView);}
  /* digit channel tuning handled at the top of this handler */
});
document.querySelectorAll(".navbtn").forEach(b=>b.addEventListener("click",()=>show(b.dataset.nav)));
document.querySelectorAll("[data-topsearch]").forEach(b=>b.addEventListener("click",()=>show("search")));
document.querySelectorAll("[data-navicon]").forEach(b=>b.addEventListener("click",()=>show(b.dataset.navicon)));
const _navPrev=$("#navPrev"); if(_navPrev) _navPrev.addEventListener("click",navigateBack);
const _navNext=$("#navNext"); if(_navNext) _navNext.addEventListener("click",navigateForward);
const _navHome=$("#navHome"); if(_navHome) _navHome.addEventListener("click",goHomeNav);
document.querySelectorAll("[data-exitapp]").forEach(b=>b.addEventListener("click",exitApp));
const _bHomeP=$("#btnHomePlayer"); if(_bHomeP) _bHomeP.addEventListener("click",goHomeNav);
const _bExitP=$("#btnExitPlayer"); if(_bExitP) _bExitP.addEventListener("click",exitApp);
const _bRet=$("#btnReturnFromExit"); if(_bRet) _bRet.addEventListener("click",returnFromExit);
const _bClose=$("#btnCloseTab"); if(_bClose) _bClose.addEventListener("click",()=>{ try{window.close();}catch(e){} toast("Use your TV/browser Back or Home button to leave this tab"); });

function showBootRecovery(err){
  try{
    console.error("[SAFI boot]",err);
    const box=document.querySelector("#content"); if(!box) return;
    box.innerHTML='<div class="empty" style="max-width:760px;margin:60px auto;text-align:center"><h1 style="font-size:34px;margin-bottom:12px">SAFI TV+ needs a quick restart</h1><p>A startup problem was stopped before it could freeze the app.</p><div class="inputrow" style="justify-content:center"><button class="btn red focusable" id="btnBootReload">↻ Reload SAFI TV+</button><button class="btn ghost focusable" id="btnBootReset">Clear saved app data & reload</button></div></div>';
    const r=document.querySelector("#btnBootReload"); if(r) r.addEventListener("click",()=>location.reload());
    const x=document.querySelector("#btnBootReset"); if(x) x.addEventListener("click",()=>{ try{store.clear();}catch(_){ } if(window.safiHardReload) safiHardReload(); else location.reload(); });
    if(r) setFocus(r);
    if(window.__safiRemoveSplash) window.__safiRemoveSplash();
  }catch(_){ }
}
/* ---------- Boot ---------- */
(function boot(){
  document.title=CONFIG.appName+" — Smart TV Box";
  document.querySelectorAll(".appname").forEach(el=>el.innerHTML=CONFIG.appName.replace("TV","TV<span>").replace("SAFI ","SAFI ")+"</span>");
  const th=store.getItem("safi_theme"); if(th) document.documentElement.style.setProperty("--accent",th);
  window.__paintNet=()=>{ const b=$("#netBadge"); if(b) b.textContent=(navigator.onLine?"🟢 Online":"🔴 Offline — saved videos in Offline/USB")+(boosterLabel()?" • "+boosterLabel():""); };
  const paintNet=window.__paintNet;
  window.addEventListener("online",()=>{paintNet(); toast("🟢 Back online");});
  window.addEventListener("offline",()=>{paintNet(); toast("🔴 You are offline — Offline/USB page works with no data",4000);});
  paintNet(); detectBooster(); updateNavButtons();
  if("serviceWorker" in navigator && /^https?:$/.test(location.protocol) && location.hostname!=="appassets.androidplatform.net"){ navigator.serviceWorker.register("sw.js",{updateViaCache:"none"}).then(r=>{ try{ r.update(); }catch(e){} }).catch(()=>{}); } /* in the APK the UI already lives offline in the app */
  try{ applyPrefs(); tick(); show("home"); }catch(e){ showBootRecovery(e); }
  setTimeout(maybeAutoScan,12000);
  setTimeout(()=>{ if(window.__safiRemoveSplash) window.__safiRemoveSplash(); else { const s=$("#splash"); if(s){ s.classList.add("hide"); setTimeout(()=>s.remove(),650); } } },450);
})();
