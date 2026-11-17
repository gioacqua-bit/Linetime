/*
 * Linetime — the interface.
 * Copyright (C) 2026 The Linetime authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. See the LICENSE file for details.
 */
"use strict";
const $ = id => document.getElementById(id);
const FIELDS = ["title","kind","status","summary","notes","text"];
const STATUS_LABEL = {idea:"Idea", draft:"Draft", revision:"Revision", final:"Final"};
const COLORS = [["c1","Indigo"],["c2","Amber"],["c3","Stone"],["c4","Green"],["c5","Rose"],["c6","Teal"]];
const SHAPES = [["disc","Disc"],["ring","Ring"],["diamond","Diamond"],["square","Square"]];
const TEMPLATES = {
  single: {label:"Chapters", note:"One type of piece.", types:[{id:"chapter",name:"Chapter",shape:"disc",color:"c1",emph:false}]},
  interludes: {label:"Chapters and interludes", note:"A main sequence with shorter pieces in between.", types:[
    {id:"chapter",name:"Chapter",shape:"disc",color:"c1",emph:false},{id:"interlude",name:"Interlude",shape:"ring",color:"c2",emph:true}]},
  threads: {label:"Two threads and a frame", note:"Alternating storylines, plus prologue, epilogue or essays.", types:[
    {id:"thread-a",name:"Thread A",shape:"ring",color:"c2",emph:false},{id:"thread-b",name:"Thread B",shape:"disc",color:"c1",emph:true},
    {id:"frame",name:"Frame",shape:"diamond",color:"c3",emph:false}]}
};
const DESKTOP = !!window.LinetimeDesktop;
const FS = typeof window.showDirectoryPicker === "function";

let recents = [], cur = null;               // cur: {key, source, meta, impl, name}
let pieces = [], activeId = null, popupId = null;
let draft = null, savedSig = "", savedTitle = "", hist = [], hi = -1, snapTimer = null, saving = false;
let spacing = "even", query = "", mode = "edit";
let bibleOpen = false, bibleExists = false, savedWords = 0, bookOpen = false, bookIdeas = false;
let inserting = false, drag = null, suppressClick = false;
const bibleFile = () => (cur && cur.meta.bibleFile) || "story-bible.md";

/* ---------- helpers ---------- */
const plainText = t => (t||"").replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm," ").replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/gm," ").replace(/\]\([^)\s]*\)/g,"]").replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm,"").replace(/[*_`~|#\[\]]/g,"");
const WORD_RE = /\p{N}+(?:[.,:]\p{N}+)*|[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const words = t => (plainText(t).match(WORD_RE)||[]).length;
const fmtN = n => n.toLocaleString("en");
const readMin = n => n<1 ? "0 min" : n<230*60 ? `about ${Math.max(1,Math.round(n/230))} min` : `about ${(n/230/60).toFixed(1)} h`;
const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const sig = d => JSON.stringify(FIELDS.map(f => d[f] ?? ""));
const byId = id => pieces.find(p => p.id === id);
const newId = p => (p||"p") + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const slug = s => (s||"untitled").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,60)||"untitled";
const project = () => cur ? cur.meta : null;
const types = () => { const t = project()?.types; return Array.isArray(t) && t.length ? t : TEMPLATES.single.types; };
const typeOf = id => types().find(t => t.id === id) || types()[0];
function toast(msg){ const t=$("toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(toast.t); toast.t=setTimeout(()=>t.classList.remove("show"),3000); }
function countMatches(text, q){ if(!q) return 0; const h=(text||"").toLowerCase(), n=q.toLowerCase(); let c=0,i=0; while((i=h.indexOf(n,i))!==-1){ c++; i+=n.length; } return c; }
function errText(e){
  if(e&&e.name==="NotAllowedError") return "Linetime doesn’t have permission to write to this folder.";
  if(e&&e.name==="QuotaExceededError") return "The browser’s storage is full.";
  if(e&&e.name==="NotFoundError") return "The file or folder no longer exists.";
  return "Not saved: "+((e&&e.message)||"unknown error");
}
function dotHTML(t){ return `<span class="node sh-${t.shape||"disc"}${t.emph?" emph":""}" style="--c:var(--${t.color||"c1"})"><span class="dot"></span></span>`; }
async function download(filename, data){
  if(DESKTOP){
    try{ const saved=await LinetimeDesktop.saveFile(filename, data); if(saved) toast("Exported to "+saved); }
    catch(e){ toast("Not exported: "+((e&&e.message)||"unknown error")); }
    return;
  }
  const blob=data instanceof Blob?data:new Blob([data],{type:"text/plain;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename; document.body.append(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}

/* ---------- markdown → HTML ---------- */
function inline(s){
  const keep=[]; const stash=h=>"\u0000"+(keep.push(h)-1)+"\u0001";
  s = s.replace(/`([^`\n]+)`/g,(m,c)=>stash("<code>"+esc(c)+"</code>"));
  s = s.replace(/\\([\\`*_{}\[\]()#+.!|>~-])/g,(m,c)=>stash(esc(c)));
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g,(m,t,u)=>/^\s*(javascript|data|vbscript):/i.test(u)?m:stash(`<a href="${u}" target="_blank" rel="noopener">`)+t+stash("</a>"));
  s = s.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g,"<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,"$1<em>$2</em>");
  s = s.replace(/(^|[\s(“"\u0001])_([^_\n]+)_(?=[\s.,;:!?)”"\u0000]|$)/g,"$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g,"<del>$1</del>");
  s = s.replace(/\[([^\]\n]*)\](?!\()/g,'<span class="draft">[$1]</span>');
  for(let k=0;k<3&&s.includes("\u0000");k++) s = s.replace(/\u0000(\d+)\u0001/g,(m,n)=>keep[+n]);
  return s;
}
function blocksOf(src){ return (src||"").replace(/\r/g,"").split(/\n[ \t]*\n+/).map(b=>b.replace(/^\n+|\s+$/g,"")).filter(b=>b.trim()); }

/* Markdown → HTML, line based: headings, rules, block quotes, fenced code, nested lists, pipe tables, paragraphs */
const MD = {
  blank: l => !l.trim(),
  hr: l => /^ {0,3}([-*_])( *\1){2,} *$/.test(l),
  head: l => /^ {0,3}#{1,6}( |\t|$)/.test(l),
  fence: l => /^ {0,3}(```|~~~)/.test(l),
  quote: l => /^ {0,3}>/.test(l),
  item: l => /^( *)([-*+]|\d{1,9}[.)])( +|\t|$)/.exec(l),
  ind: l => l.match(/^ */)[0].length,
  cells(l){
    let s=l.trim(); if(s.startsWith("|")) s=s.slice(1); if(s.endsWith("|")&&!s.endsWith("\\|")) s=s.slice(0,-1);
    const out=[]; let cur="", code=false;
    for(let k=0;k<s.length;k++){
      const c=s[k];
      if(c==="\\"&&s[k+1]==="|"){ cur+=code?"\\|":"\\|"; k++; continue; }
      if(c==="`") code=!code;
      if(c==="|"&&!code){ out.push(cur.trim()); cur=""; continue; }
      cur+=c;
    }
    out.push(cur.trim()); return out;
  },
  sep: l => l.includes("-") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && (l.includes("|") || false),
  tableAt(L,i){ return i+1<L.length && L[i].includes("|") && MD.sep(L[i+1]) && MD.cells(L[i]).length===MD.cells(L[i+1]).length; }
};
function startsBlock(L,i){ const l=L[i]; return MD.hr(l)||MD.head(l)||MD.fence(l)||MD.quote(l)||MD.tableAt(L,i)||(MD.item(l)&&MD.ind(l)<4); }
function md(src){
  const L=(src||"").replace(/\r/g,"").replace(/\t/g,"    ").split("\n"), n=L.length;
  let i=0, out="";
  while(i<n){
    const l=L[i];
    if(MD.blank(l)){ i++; continue; }
    if(MD.fence(l)){
      const f=l.trim().slice(0,3), buf=[]; i++;
      while(i<n && !L[i].trim().startsWith(f)) buf.push(L[i++]);
      i++; out+=`<pre><code>${esc(buf.join("\n"))}</code></pre>`; continue;
    }
    if(MD.hr(l)){ out+="<hr>"; i++; continue; }
    const h=l.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/);
    if(h){ out+=`<h${h[1].length}>${inline(h[2]||"")}</h${h[1].length}>`; i++; continue; }
    if(MD.tableAt(L,i)){
      const head=MD.cells(L[i]), al=MD.cells(L[i+1]).map(c=>/^:-+:$/.test(c)?"center":/-:$/.test(c)?"right":/^:/.test(c)?"left":"");
      const st=k=>al[k]?` style="text-align:${al[k]}"`:"";
      let t="<thead><tr>"+head.map((c,k)=>`<th${st(k)}>${inline(c)}</th>`).join("")+"</tr></thead><tbody>";
      i+=2;
      while(i<n && !MD.blank(L[i]) && (L[i].includes("|")) && !MD.quote(L[i]) && !MD.fence(L[i]) && !MD.head(L[i])){
        const r=MD.cells(L[i]); t+="<tr>"+head.map((_,k)=>`<td${st(k)}>${inline(r[k]??"")}</td>`).join("")+"</tr>"; i++;
      }
      out+=`<div class="tbl"><table>${t}</tbody></table></div>`; continue;
    }
    if(MD.quote(l)){
      const buf=[];
      while(i<n && !MD.blank(L[i])){ buf.push(L[i].replace(/^ {0,3}> ?/,"")); i++; }
      out+="<blockquote>"+md(buf.join("\n"))+"</blockquote>"; continue;
    }
    const m=MD.item(l);
    if(m && MD.ind(l)<4){
      const base=m[1].length, ordered=/\d/.test(m[2]), items=[];
      const start=ordered?parseInt(m[2],10):1;
      let loose=false;
      while(i<n){
        const li=L[i], mi=MD.item(li);
        if(mi && Math.abs(mi[1].length-base)<2 && /\d/.test(mi[2])===ordered){
          const w=mi[0].length===mi[1].length+mi[2].length ? mi[0].length+1 : mi[0].length;
          items.push({w, lines:[li.slice(mi[0].length)]}); i++; continue;
        }
        if(!items.length) break;
        const it=items[items.length-1];
        if(MD.blank(li)){
          let j=i; while(j<n && MD.blank(L[j])) j++;
          if(j<n && (MD.ind(L[j])>=it.w || (MD.item(L[j]) && Math.abs(MD.ind(L[j])-base)<2 && /\d/.test(MD.item(L[j])[2])===ordered))){
            if(MD.ind(L[j])>=it.w) it.lines.push(""); else loose=true;
            i=j; continue;
          }
          break;
        }
        if(MD.ind(li)>=it.w || (MD.ind(li)>base && MD.item(li))){ it.lines.push(li.slice(Math.min(MD.ind(li),it.w))); i++; continue; }
        if(!startsBlock(L,i) && !MD.blank(L[i-1]||"")){ it.lines.push(li.trim()); i++; continue; }  // lazy continuation
        break;
      }
      const body=it=>{
        const c=it.lines;
        if(!loose && !c.some(x=>!x.trim())){
          let k=0; while(k<c.length && !(k>0 && startsBlock(c,k))) k++;
          const txt=c.slice(0,k).map((x,q)=>inline(x.trim())+(q<k-1?(/ {2,}$/.test(x)?"<br>":" "):"")).join("");
          return txt+(k<c.length?md(c.slice(k).join("\n")):"");
        }
        return md(c.join("\n"));
      };
      const tag=ordered?"ol":"ul";
      out+=`<${tag}${ordered&&start!==1?` start="${start}"`:""}>`+items.map(it=>"<li>"+body(it)+"</li>").join("")+`</${tag}>`;
      continue;
    }
    const buf=[l]; i++;
    while(i<n && !MD.blank(L[i]) && !startsBlock(L,i)) buf.push(L[i++]);
    out+="<p>"+buf.map((x,q)=>inline(x.trim())+(q<buf.length-1?(/ {2,}$/.test(x)?"<br>":" "):"")).join("")+"</p>";
  }
  return out;
}
function highlight(root, q){
  if(!q) return;
  const w=document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes=[]; while(w.nextNode()) nodes.push(w.currentNode);
  const n=q.toLowerCase();
  for(const tn of nodes){
    const s=tn.nodeValue, low=s.toLowerCase(); if(low.indexOf(n)===-1) continue;
    const frag=document.createDocumentFragment(); let i=0,j;
    while((j=low.indexOf(n,i))!==-1){ frag.append(s.slice(i,j)); const m=document.createElement("mark"); m.textContent=s.slice(j,j+n.length); frag.append(m); i=j+n.length; }
    frag.append(s.slice(i)); tn.replaceWith(frag);
  }
}

/* ---------- markdown → LaTeX ---------- */
const TEXMAP = {"\\":"\\textbackslash{}","#":"\\#","$":"\\$","%":"\\%","&":"\\&","_":"\\_","{":"\\{","}":"\\}","~":"\\textasciitilde{}","^":"\\textasciicircum{}"};
const texText = s => s.replace(/[\\#$%&_{}~^]/g, c=>TEXMAP[c]).replace(/"([^"\n]*)"/g,"``$1''");
function texInline(s){
  const re=/\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`|_([^_\n]+)_/g;
  let out="", last=0;
  for(const m of s.matchAll(re)){
    if(m[4]!==undefined){ const pre=s[m.index-1], post=s[m.index+m[0].length]; if((pre&&/\w/.test(pre))||(post&&/\w/.test(post))) continue; }
    out += texText(s.slice(last,m.index));
    if(m[1]!==undefined) out += "\\textbf{"+texInline(m[1])+"}";
    else if(m[3]!==undefined) out += "\\texttt{"+texText(m[3])+"}";
    else out += "\\emph{"+texInline(m[2]??m[4])+"}";
    last = m.index+m[0].length;
  }
  return out + texText(s.slice(last));
}
function tex(src, headCmds){
  const out=[]; let afterBreak=false;
  for(const t of blocksOf(src)){
    const lines=t.split("\n");
    if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(t)){ out.push("\\scenebreak"); afterBreak=true; continue; }
    const h=lines[0].match(/^(#{1,6})\s+(.*)$/);
    if(h){ const cmd=headCmds[Math.min(h[1].length,headCmds.length)-1]; out.push(`\\${cmd}{${texInline(h[2])}}`); if(lines.length>1) out.push(tex(lines.slice(1).join("\n"),headCmds)); afterBreak=false; continue; }
    if(lines.every(l=>/^>\s?/.test(l))){ out.push("\\begin{quote}\n"+tex(lines.map(l=>l.replace(/^>\s?/,"")).join("\n"),headCmds)+"\n\\end{quote}"); continue; }
    if(lines.every(l=>/^\d+[.)]\s+/.test(l))){ out.push("\\begin{enumerate}\n"+lines.map(l=>"  \\item "+texInline(l.replace(/^\d+[.)]\s+/,""))).join("\n")+"\n\\end{enumerate}"); continue; }
    if(lines.every(l=>/^[-*+]\s+/.test(l))){ out.push("\\begin{itemize}\n"+lines.map(l=>"  \\item "+texInline(l.replace(/^[-*+]\s+/,""))).join("\n")+"\n\\end{itemize}"); continue; }
    out.push((afterBreak?"\\noindent ":"")+lines.map((l,i)=>texInline(l.trim())+(i<lines.length-1&&/ {2,}$/.test(l)?" \\\\":"")).join("\n"));
    afterBreak=false;
  }
  return out.join("\n\n");
}

/* ---------- zip (stored, no compression) ---------- */
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(b){ let c=0xFFFFFFFF; for(let i=0;i<b.length;i++) c=CRC[(c^b[i])&255]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
function makeZip(files){
  const enc=new TextEncoder(), parts=[], central=[]; let offset=0;
  const d=new Date(), time=(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1), date=((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate();
  for(const f of files){
    const name=enc.encode(f.name), data=enc.encode(f.text), crc=crc32(data);
    const lh=new DataView(new ArrayBuffer(30));
    lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(6,0x0800,true); lh.setUint16(10,time,true); lh.setUint16(12,date,true);
    lh.setUint32(14,crc,true); lh.setUint32(18,data.length,true); lh.setUint32(22,data.length,true); lh.setUint16(26,name.length,true);
    parts.push(new Uint8Array(lh.buffer),name,data);
    const ch=new DataView(new ArrayBuffer(46));
    ch.setUint32(0,0x02014b50,true); ch.setUint16(4,20,true); ch.setUint16(6,20,true); ch.setUint16(8,0x0800,true); ch.setUint16(12,time,true); ch.setUint16(14,date,true);
    ch.setUint32(16,crc,true); ch.setUint32(20,data.length,true); ch.setUint32(24,data.length,true); ch.setUint16(28,name.length,true); ch.setUint32(42,offset,true);
    central.push(new Uint8Array(ch.buffer),name);
    offset+=30+name.length+data.length;
  }
  const csize=central.reduce((a,b)=>a+b.length,0), end=new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true); end.setUint16(8,files.length,true); end.setUint16(10,files.length,true); end.setUint32(12,csize,true); end.setUint32(16,offset,true);
  return new Blob([...parts,...central,new Uint8Array(end.buffer)],{type:"application/zip"});
}

/* ---------- piece files (Markdown with front matter) ---------- */
function parseMd(src){
  src=src.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n");
  const m=src.match(/^---\n([\s\S]*?)\n---[ \t]*(\n|$)/);
  if(!m) return {meta:{}, text:src};
  const meta={}, lines=m[1].split("\n");
  for(let i=0;i<lines.length;i++){
    const mm=lines[i].match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/); if(!mm) continue;
    let k=mm[1], v=mm[2].trim();
    if(/^[|>][-+]?$/.test(v)){
      const block=[]; while(i+1<lines.length && (/^\s/.test(lines[i+1])||lines[i+1]==="")) block.push(lines[++i]);
      const ind=Math.min(...block.filter(l=>l.trim()).map(l=>l.match(/^ */)[0].length));
      v=block.map(l=>l.slice(Number.isFinite(ind)?ind:0)).join("\n").replace(/\n+$/,"");
    } else if(/^".*"$/.test(v)){ try{ v=JSON.parse(v); }catch(e){ v=v.slice(1,-1); } }
    else if(/^'.*'$/.test(v)) v=v.slice(1,-1).replace(/''/g,"'");
    meta[k]=v;
  }
  return {meta, text:src.slice(m[0].length).replace(/^\n+/,"")};
}
function parsePiece(src, id){
  const {meta, text} = parseMd(src);
  let title=meta.title, body=text;
  if(!title){ const h=body.match(/^#\s+(.+)\n?/); if(h){ title=h[1].trim(); body=body.slice(h[0].length).replace(/^\n+/,""); } }
  return {id, title:title||id.replace(/\.(md|markdown|txt)$/i,""), kind:meta.type||"", status:STATUS_LABEL[meta.status]?meta.status:"draft",
    summary:meta.summary||"", notes:meta.notes||"", text:body.replace(/\s+$/,"")};
}
function serializePiece(p){
  const fm=(k,v)=>{ v=String(v??""); return v.includes("\n") ? `${k}: |-\n`+v.split("\n").map(l=>l?"  "+l:"").join("\n") : `${k}: ${JSON.stringify(v)}`; };
  return ["---", fm("title",p.title), `type: ${JSON.stringify(p.kind||"")}`, `status: ${p.status||"draft"}`, fm("summary",p.summary), fm("notes",p.notes), "---", "", (p.text||"").replace(/\s+$/,""), ""].join("\n");
}
function uniqueId(title, except){
  const base=slug(title); let n=base+".md", i=2;
  while(pieces.some(p=>p.id!==except && p.id.toLowerCase()===n)) n=`${base}-${i++}.md`;
  return n;
}
function defaultMeta(title, tpl){
  return {format:"linetime", version:1, title:title||"Untitled project", subtitle:"", author:"",
    types:(TEMPLATES[tpl]||TEMPLATES.single).types.map(t=>({...t})),
    latex:{pieceAs:"chapter",engine:"pdflatex",preamble:"",skipIdeas:true}, order:[]};
}
function normalizeMeta(m, title){
  const d=defaultMeta(title);
  m={...d,...(m||{})}; m.latex={...d.latex,...(m.latex||{})};
  if(!Array.isArray(m.types)||!m.types.length) m.types=d.types;
  if(!Array.isArray(m.order)) m.order=[];
  return m;
}
function ordered(list, order){
  const map=new Map(list.map(p=>[p.id,p])), out=[];
  for(const id of order) if(map.has(id)){ out.push(map.get(id)); map.delete(id); }
  return out.concat([...map.values()].sort((a,b)=>a.id.localeCompare(b.id)));
}

/* ---------- storage: IndexedDB (settings, folder handles, browser projects) ---------- */
const idb = DESKTOP ? LinetimeDesktop.kv : (()=>{
  let dbp=null, mem=null;
  const open=()=>dbp||(dbp=new Promise((res,rej)=>{ try{ const r=indexedDB.open("linetime",1);
    r.onupgradeneeded=()=>r.result.createObjectStore("kv"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }catch(e){ rej(e); } }));
  const run=async(mode,fn)=>{
    if(mem) return fn(null);
    let db; try{ db=await open(); }catch(e){ mem=new Map(); idb.ok=false; return fn(null); }
    return new Promise((res,rej)=>{ const t=db.transaction("kv",mode), r=fn(t.objectStore("kv")); t.oncomplete=()=>res(r&&r.result); t.onerror=()=>rej(t.error); t.onabort=()=>rej(t.error); });
  };
  return { ok:true,
    get:k=>run("readonly",s=>s?s.get(k):mem.get(k)),
    set:(k,v)=>run("readwrite",s=>s?s.put(v,k):(mem.set(k,v),null)),
    del:k=>run("readwrite",s=>s?s.delete(k):(mem.delete(k),null)) };
})();
async function saveRecents(){
  try{ await idb.set("recents", recents.map(r=>(DESKTOP
    ? {key:r.key,source:r.source,title:r.title,path:r.handle&&r.handle.path,lastOpened:r.lastOpened}
    : {key:r.key,source:r.source,title:r.title,handle:r.handle,lastOpened:r.lastOpened}))); }catch(e){}
}
function upsertRecent(e){ const i=recents.findIndex(r=>r.key===e.key); if(i<0) recents.push(e); else recents[i]=e; saveRecents(); }

/* ---------- storage backends ---------- */
async function writeText(dir, name, text){ const fh=await dir.getFileHandle(name,{create:true}); const w=await fh.createWritable(); await w.write(text); await w.close(); }
async function scanFolder(dir){
  let meta=null, exists=false;
  try{ const f=await (await dir.getFileHandle("linetime.json")).getFile(); exists=true; meta=JSON.parse(await f.text()); }
  catch(e){ if(exists) throw new Error("linetime.json in this folder can’t be read. Fix or remove it, then open the folder again."); }
  meta=normalizeMeta(meta, dir.name);
  const pd=await dir.getDirectoryHandle("pieces",{create:true});
  const list=[];
  for await (const [name,h] of pd.entries()){
    if(h.kind!=="file"||!/\.(md|markdown|txt)$/i.test(name)||name.startsWith(".")) continue;
    const f=await h.getFile(); list.push(parsePiece(await f.text(), name));
  }
  return {meta, exists, list:ordered(list, meta.order), pd};
}
function folderImpl(dir, pd){
  return {
    savePiece:p=>writeText(pd, p.id, serializePiece(p)),
    removePiece:id=>pd.removeEntry(id),
    saveMeta:m=>writeText(dir, "linetime.json", JSON.stringify(m,null,2)+"\n"),
    rescan:()=>scanFolder(dir),
    async readRoot(name){ try{ return await (await (await dir.getFileHandle(name)).getFile()).text(); }catch(e){ if(e&&(e.name==="NotFoundError"||e.name==="TypeMismatchError")) return null; throw e; } },
    saveRoot:(name,text)=>writeText(dir, name, text),
    async rootMd(){ const out=[]; for await (const [n,h] of dir.entries()) if(h.kind==="file"&&/\.md$/i.test(n)) out.push(n); return out; }
  };
}
function browserImpl(key, rec){
  const put=()=>idb.set("proj:"+key, rec);
  const body=p=>{ const o={}; FIELDS.forEach(f=>o[f]=p[f]??""); return o; };
  return {
    savePiece:async p=>{ rec.pieces[p.id]=body(p); await put(); },
    removePiece:async id=>{ delete rec.pieces[id]; await put(); },
    saveMeta:async m=>{ rec.meta=m; await put(); },
    readRoot:async()=>typeof rec.bible==="string"?rec.bible:null,
    saveRoot:async(name,text)=>{ rec.bible=text; await put(); },
    rootMd:async()=>[]
  };
}

/* ---------- projects ---------- */
function storeNoteText(){
  if(!cur) return "";
  if(cur.source==="folder") return `Saved to the folder “${cur.name}”`;
  return idb.ok ? "Saved in this browser" : "This browser blocks storage here: changes last only until you close the tab";
}
async function setCurrent(c, list){
  cur=c; pieces=list; popupId=null; activeId=null; draft=null; bibleOpen=false; closeBook();
  document.body.classList.remove("side-open","focus","bible"); $("b-bible").setAttribute("aria-pressed","false");
  renderBrand(); layout(); $("storeNote").textContent=storeNoteText();
}
async function ensurePerm(h){
  try{ if(await h.queryPermission({mode:"readwrite"})==="granted") return true; return (await h.requestPermission({mode:"readwrite"}))==="granted"; }
  catch(e){ return false; }
}
async function leaveCurrent(){
  if(draft && !(await closeSide())) return false;
  return true;
}
async function openEntry(entry){
  if(cur && cur.key===entry.key) return;
  if(!(await leaveCurrent())) return;
  if(entry.source==="folder"){
    if(!(await ensurePerm(entry.handle))){ toast("Linetime needs permission to read and write this folder."); return; }
    let s; try{ s=await scanFolder(entry.handle); }catch(e){ toast(e.message||"This folder can’t be read."); return; }
    const impl=folderImpl(entry.handle, s.pd);
    let metaChanged=!s.exists;
    if(!s.exists) s.meta.order=s.list.map(p=>p.id);
    if(!s.meta.bibleFile){
      try{ const md=await impl.rootMd(); const cand=md.filter(n=>/bible/i.test(n));
        if(!md.includes("story-bible.md") && cand.length===1){ s.meta.bibleFile=cand[0]; metaChanged=true; } }catch(e){}
    }
    if(metaChanged){ try{ await impl.saveMeta(s.meta); }catch(e){ toast(errText(e)); } }
    entry.title=s.meta.title; entry.lastOpened=Date.now(); upsertRecent(entry);
    await setCurrent({key:entry.key, source:"folder", meta:s.meta, impl, name:entry.handle.name}, s.list);
  } else {
    let rec=null; try{ rec=await idb.get("proj:"+entry.key); }catch(e){}
    if(!rec){ toast("This project is no longer stored in this browser."); recents=recents.filter(r=>r.key!==entry.key); saveRecents(); renderBrand(); layout(); return; }
    rec.meta=normalizeMeta(rec.meta, entry.title);
    const list=ordered(Object.entries(rec.pieces||{}).map(([id,b])=>({id,...b})), rec.meta.order);
    entry.title=rec.meta.title; entry.lastOpened=Date.now(); upsertRecent(entry);
    await setCurrent({key:entry.key, source:"browser", meta:rec.meta, impl:browserImpl(entry.key, rec), name:""}, list);
  }
}
async function pickFolder(){
  let h; try{ h=await window.showDirectoryPicker({mode:"readwrite", id:"linetime"}); }catch(e){ return; }
  for(const r of recents) if(r.source==="folder" && r.handle){ try{ if(await r.handle.isSameEntry(h)){ await openEntry(r); return; } }catch(e){} }
  let isProject=false; try{ await h.getFileHandle("linetime.json"); isProject=true; }catch(e){}
  if(!isProject){
    const c=await ask(`“${h.name}” isn’t a Linetime project yet. Make it one? Linetime will add a linetime.json file and a pieces folder. Markdown files already in a pieces folder become pieces.`,[["ok","Make it a project","primary"],["cancel","Cancel"]]);
    if(c!=="ok") return;
  }
  await openEntry({key:newId("f"), source:"folder", handle:h, title:h.name});
}
async function saveMeta(){
  try{ await cur.impl.saveMeta(cur.meta); return true; }catch(e){ toast(errText(e)); return false; }
}
async function rescan(){
  if(!cur || cur.source!=="folder" || saving || rescan.busy) return;
  if(Date.now()-(rescan.last||0)<1500) return;
  rescan.busy=true; rescan.last=Date.now();
  try{
    const s=await cur.impl.rescan();
    if(JSON.stringify(s.meta)!==JSON.stringify(cur.meta)){ cur.meta=s.meta; renderBrand(); }
    onPieces(s.list);
    if(bibleOpen && !saving){
      const t=await cur.impl.readRoot(bibleFile());
      if(t!==null && !dirty() && t.replace(/\s+$/,"")!==draft.text.replace(/\s+$/,"")){ loadBibleText(t); toast("Reloaded: the story bible changed outside Linetime"); }
    }
  }catch(e){}
  rescan.busy=false;
}

/* ---------- header: project menu, legend ---------- */
function renderBrand(){
  const p=project();
  $("ptitle").textContent=p?(p.title||"Untitled project"):"Linetime";
  $("psub").textContent=p?(p.subtitle||""):"";
  document.title=(p?(p.title||"Untitled project")+" – ":"")+"Linetime";
  $("f-kind").innerHTML=types().map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  if(draft) $("f-kind").value=typeOf(draft.kind).id;
  $("legend").innerHTML=p&&types().length>1?types().map(t=>`<span>${dotHTML(t)}${esc(t.name)}</span>`).join(""):"";
  ["b-add","b-import","b-export","b-bible","b-book"].forEach(id=>$(id).disabled=!cur);
}
function renderMenu(){
  const list=[...recents].sort((a,b)=>(a.title||"").localeCompare(b.title||""));
  $("pmenu").innerHTML=list.map(r=>`<button role="menuitem" data-key="${esc(r.key)}" class="${cur&&r.key===cur.key?"cur":""}"><span class="chk">${cur&&r.key===cur.key?"✓":""}</span><span>${esc(r.title||"Untitled project")} <small class="src">${r.source==="folder"?"folder":"browser"}</small></span></button>`).join("")
    +(list.length?"<hr>":"")+`<button role="menuitem" data-mact="new"><span class="chk"></span>New project…</button>`
    +(FS?`<button role="menuitem" data-mact="open"><span class="chk"></span>Open project folder…</button>`:`<button role="menuitem" data-mact="importdir"><span class="chk"></span>Import project folder…</button>`)
    +(cur?`<button role="menuitem" data-mact="settings"><span class="chk"></span>Project settings…</button>`:"");
}
function toggleMenu(open){
  const m=$("pmenu"); open=open??m.hidden; if(open) renderMenu();
  m.hidden=!open; $("brand").setAttribute("aria-expanded",String(open));
  if(open) m.querySelector("button")?.focus();
}

/* ---------- timeline ---------- */
function layout(){
  const track=$("track"), inner=$("inner");
  inner.querySelectorAll(".node,.popup,.empty,.gap,.dropind").forEach(e=>e.remove());
  const n=pieces.length, H=Math.max(track.clientHeight,420), lineY=Math.round(H*0.42);
  if(!cur||!n){
    $("rule").style.display="none"; inner.style.width="100%";
    const e=document.createElement("div"); e.className="empty";
    if(cur) e.innerHTML=`<div>This project has no pieces yet.</div><div><button class="btn" data-act="add">Add piece</button> <button class="btn" data-act="import">Import .md files</button></div>`;
    else {
      const last=[...recents].sort((a,b)=>(b.lastOpened||0)-(a.lastOpened||0))[0];
      e.innerHTML=(last?`<div>Pick up where you left off.</div><div><button class="btn primary" data-act="reopen" data-key="${esc(last.key)}">Reopen “${esc(last.title||"Untitled project")}”</button></div>`
        : FS ? `<div style="max-width:46ch;line-height:1.5">Linetime keeps each project in a folder on your computer: one Markdown file per piece, plus a linetime.json file for the order and settings.</div>`
             : `<div style="max-width:46ch;line-height:1.5">This browser can’t write to folders, so projects are stored inside the browser. Use Export to keep a copy as files.</div>`)
        +`<div><button class="btn${last?"":" primary"}" data-act="newproj">New project</button> `
        +(FS?`<button class="btn" data-act="open">Open project folder</button>`:`<button class="btn" data-act="importdir">Import project folder</button>`)+`</div>`;
    }
    inner.append(e); return;
  }
  const pad=100, minW=165, avail=Math.max(track.clientWidth-2*pad, n*minW);
  let widths;
  if(spacing==="length"){
    const ws=pieces.map(p=>Math.max(words(p.text),1)), sum=ws.reduce((a,b)=>a+b,0), base=150, extra=Math.max(avail-n*base,0)+n*40;
    widths=ws.map(w=>base+extra*w/sum);
  } else widths=pieces.map(()=>avail/n);
  const total=widths.reduce((a,b)=>a+b,0);
  inner.style.width=(total+2*pad)+"px";
  const rule=$("rule"); rule.style.display=""; rule.style.top=lineY+"px"; inner.style.setProperty("--ly",lineY+"px"); rule.style.left=(pad-30)+"px"; rule.style.width=(total+60)+"px";
  document.body.classList.toggle("searching", !!query);
  let x=pad;
  pieces.forEach((p,i)=>{
    const cx=x+widths[i]/2; x+=widths[i]; p._x=cx; p._y=lineY;
    const t=typeOf(p.kind), c=countMatches(p.title+"\n"+p.summary+"\n"+p.text, query), wc=words(p.text);
    const el=document.createElement("div");
    el.className=`node sh-${t.shape||"disc"} status-${p.status||"draft"}`+(t.emph?" emph":"")+(p.id===activeId?" active":"")+(query&&!c?" miss":"");
    el.style.cssText=`left:${cx}px;top:${lineY}px;--c:var(--${t.color||"c1"})`; el.dataset.id=p.id;
    el.innerHTML=`<div class="ntitle">${esc(p.title||"Untitled")}</div><span class="dot"></span>
      <div class="nmeta">${wc?wc.toLocaleString("en")+" words":STATUS_LABEL[p.status]||""}${c?`<span class="badge">${c}</span>`:""}</div>
      <button class="hitbox" aria-label="${esc(p.title||"Untitled")}: show summary"></button>`;
    inner.append(el);
  });
  let gx=pad;
  for(let k=0;k<=n;k++){
    const g=document.createElement("button"); g.className="gap"; g.dataset.at=k;
    g.style.cssText=`left:${gx}px;top:${lineY}px`;
    const before=pieces[k], after=pieces[k-1];
    g.title=before&&after?`Add a piece between “${after.title||"Untitled"}” and “${before.title||"Untitled"}”`:before?"Add a piece at the start":"Add a piece at the end";
    g.setAttribute("aria-label",g.title); g.innerHTML="<span>+</span>";
    inner.append(g); if(k<n) gx+=widths[k];
  }
  if(popupId && byId(popupId)) showPopup(popupId,false);
}
function showPopup(id, scroll=true){
  popupId=id; const p=byId(id); if(!p) return;
  $("inner").querySelectorAll(".popup").forEach(e=>e.remove());
  const el=document.createElement("div"); el.className="popup"; el.tabIndex=0; el.setAttribute("role","button");
  el.setAttribute("aria-label","Open the full text of "+(p.title||"Untitled"));
  const wc=words(p.text), meta=[types().length>1?typeOf(p.kind).name:"", (STATUS_LABEL[p.status]||"").toLowerCase(), wc?wc.toLocaleString("en")+" words":""].filter(Boolean);
  if(meta.length) meta[0]=meta[0][0].toUpperCase()+meta[0].slice(1);
  el.innerHTML=`<h2>${esc(p.title||"Untitled")}</h2><div class="k">${esc(meta.join(", "))}</div>
    <p>${esc(p.summary||"No summary yet.")}</p>
    <div class="pact"><button data-pa="open" class="go">Open the full text</button><span class="sp"></span>
      <button data-pa="left" ${pieces[0]&&pieces[0].id===id?"disabled":""} title="Move earlier (Alt+←)" aria-label="Move earlier"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></button>
      <button data-pa="right" ${pieces.length&&pieces[pieces.length-1].id===id?"disabled":""} title="Move later (Alt+→)" aria-label="Move later"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></button>
      <button data-pa="del" class="del" title="Delete this piece (Delete)" aria-label="Delete this piece"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></button></div>`;
  const inner=$("inner"), w=320, left=Math.min(Math.max(p._x-w/2,12), inner.scrollWidth-w-12);
  el.style.left=left+"px"; el.style.top=(p._y+52)+"px"; el.style.setProperty("--tip",(p._x-left-1)+"px"); inner.append(el);
  if(scroll){ const tr=$("track"); if(left<tr.scrollLeft||left+w>tr.scrollLeft+tr.clientWidth) tr.scrollTo({left:Math.max(p._x-tr.clientWidth/2,0),behavior:"smooth"}); }
}
function hidePopup(){ popupId=null; $("inner").querySelectorAll(".popup").forEach(e=>e.remove()); }

/* ---------- sidebar & editor ---------- */
const dirty = () => !!draft && sig(draft)!==savedSig;
function fillFields(){
  $("f-title").value=draft.title||""; $("f-kind").value=typeOf(draft.kind).id; $("f-status").value=draft.status||"draft";
  $("f-summary").value=draft.summary||""; $("f-notes").value=draft.notes||""; $("f-text").value=draft.text||"";
  $("f-title").readOnly=bibleOpen;
}
function readFields(){
  draft.title=$("f-title").value; draft.kind=$("f-kind").value; draft.status=$("f-status").value;
  draft.summary=$("f-summary").value; draft.notes=$("f-notes").value; draft.text=$("f-text").value;
}
function refreshState(msg, cls){
  if(!draft) return;
  const d=$("dirty");
  if(msg){ d.textContent=msg; d.className=cls||""; }
  else if(dirty()){ d.textContent="Unsaved changes"; d.className="unsaved"; }
  else { d.textContent="Saved"; d.className=""; }
  $("b-save").disabled=!dirty()||saving;
  $("b-undo").disabled=hi<=0; $("b-redo").disabled=hi>=hist.length-1;
  updateWc();
  const i=pieces.findIndex(p=>p.id===activeId);
  $("b-left").disabled=i<=0; $("b-right").disabled=i<0||i>=pieces.length-1;
  $("f-file").textContent=cur&&cur.source==="folder"&&!bibleOpen?`File: pieces/${draft.id}`:"";
  $("f-src").textContent=bibleOpen?(cur.source==="folder"?bibleFile()+(bibleExists?"":" (created when you save)"):""):"";
}
function updateWc(){
  if(!draft) return;
  const n=words(draft.text), ta=$("f-text");
  let sel="";
  if(mode==="edit" && document.activeElement===ta && ta.selectionEnd>ta.selectionStart) sel=` <span>(${fmtN(words(ta.value.slice(ta.selectionStart,ta.selectionEnd)))} selected)</span>`;
  const d=n-savedWords;
  $("wc").innerHTML=`<b>${fmtN(n)}</b> words${sel}${d&&dirty()?`<span class="delta">${d>0?"+":"−"}${fmtN(Math.abs(d))}</span>`:""}`;
  $("wc").title=`${fmtN(plainText(draft.text).replace(/\s+/g," ").trim().length)} characters, ${readMin(n)} reading`+(d&&dirty()?`\n${d>0?"+":"−"}${fmtN(Math.abs(d))} words since the last save`:"");
}
function pushHist(){
  clearTimeout(snapTimer); snapTimer=null; if(!draft) return;
  const s=JSON.stringify(FIELDS.map(f=>draft[f]??""));
  if(hist[hi]===s) return;
  hist=hist.slice(0,hi+1); hist.push(s); if(hist.length>300) hist.shift(); hi=hist.length-1;
}
function applyHist(){
  const vals=JSON.parse(hist[hi]), oldText=$("f-text").value;
  FIELDS.forEach((f,i)=>draft[f]=vals[i]); fillFields();
  if(mode==="edit" && oldText!==draft.text){
    let k=0; while(k<oldText.length&&k<draft.text.length&&oldText[k]===draft.text[k]) k++;
    const ta=$("f-text"); ta.focus(); ta.setSelectionRange(k,k);
  }
  if(mode==="preview") renderPreview();
  refreshState();
}
function undo(){ if(snapTimer) pushHist(); if(hi>0){ hi--; applyHist(); } }
function redo(){ if(snapTimer) pushHist(); if(hi<hist.length-1){ hi++; applyHist(); } }
function onEdit(){ readFields(); clearTimeout(snapTimer); snapTimer=setTimeout(()=>{pushHist();refreshState();},600); refreshState(); }
function loadDraft(p){
  draft={id:p.id}; FIELDS.forEach(f=>draft[f]=p[f]??""); draft.kind=typeOf(draft.kind).id;
  savedSig=sig(draft); savedTitle=draft.title; savedWords=words(draft.text); hist=[]; hi=-1; pushHist(); fillFields();
  if(mode==="preview") renderPreview();
  refreshState();
}
async function confirmLeave(action){
  if(!dirty()) return true;
  const what=bibleOpen?"the story bible":`“${draft.title||"Untitled"}”`;
  const c=await ask(`${action}? Your changes to ${what} aren’t saved yet.`,[["save","Save first","primary"],["discard","Discard changes"],["cancel","Cancel"]]);
  if(c==="cancel") return false; if(c==="save") return await save(); return true;
}
async function openSide(id){
  if(draft && (bibleOpen || activeId!==id) && !(await confirmLeave(bibleOpen?"Open this piece":"Open another piece"))) return;
  const p=byId(id); if(!p) return;
  if(bibleOpen) shutSide();
  closeBook();
  hidePopup(); activeId=id; loadDraft(p);
  document.body.classList.add("side-open"); layout();
  requestAnimationFrame(()=>{ const tr=$("track"); tr.scrollTo({left:Math.max(p._x-tr.clientWidth/2,0),behavior:"smooth"}); });
}
function shutSide(){ activeId=null; draft=null; bibleOpen=false; setFocus(false); document.body.classList.remove("side-open","bible"); $("b-bible").setAttribute("aria-pressed","false"); }
async function closeSide(){
  if(!(await confirmLeave("Close the editor"))) return false;
  shutSide(); layout(); return true;
}
function loadBibleText(t){
  draft={id:"", title:"Story bible", kind:"", status:"", summary:"", notes:"", text:(t||"").replace(/\s+$/,"")};
  savedSig=sig(draft); savedTitle=draft.title; savedWords=words(draft.text); hist=[]; hi=-1; pushHist(); fillFields();
  if(mode==="preview") renderPreview();
  refreshState();
}
async function openBible(){
  if(!cur) return;
  if(bibleOpen){ await closeSide(); return; }
  if(draft && !(await confirmLeave("Open the story bible"))) return;
  let t; try{ t=await cur.impl.readRoot(bibleFile()); }catch(e){ toast(errText(e).replace(/^Not saved: /,"")); return; }
  shutSide(); hidePopup(); closeBook();
  bibleOpen=true; bibleExists=t!==null;
  document.body.classList.add("side-open","bible"); $("b-bible").setAttribute("aria-pressed","true");
  loadBibleText(t); layout();
  if(mode==="edit") $("f-text").focus();
}
function bookList(){
  return pieces.map(p=>(draft && !bibleOpen && p.id===activeId) ? {...p, ...draft, id:p.id} : p);
}
function renderBook(){
  if(!cur) return;
  const all=bookList(), list=all.filter(p=>bookIdeas||p.status!=="idea");
  const wc=list.map(p=>words(p.text)), total=wc.reduce((a,b)=>a+b,0), max=Math.max(1,...wc);
  const multi=types().length>1;
  const byType=types().map(t=>({t, n:list.reduce((a,p,i)=>a+(typeOf(p.kind).id===t.id?wc[i]:0),0)}));
  const hidden=all.length-list.length;
  $("book-toc").innerHTML=`<div class="bk-total">${fmtN(total)}<small>words in ${list.length} piece${list.length===1?"":"s"}, ${readMin(total)} reading</small></div>`
    +(multi?`<div class="bk-types">${byType.map(x=>`<div>${dotHTML(x.t)}<span>${esc(x.t.name)}</span><b>${fmtN(x.n)}</b></div>`).join("")}</div>`:"")
    +`<label class="bk-opt"><input type="checkbox" id="bk-ideas" ${bookIdeas?"checked":""}> Include pieces with status Idea${hidden&&!bookIdeas?` (${hidden})`:""}</label>`
    +`<div class="bk-label">Contents</div>`
    +list.map((p,i)=>{ const t=typeOf(p.kind); return `<button class="toc-i${t.emph?" emph":""}${p.status==="idea"?" idea":""}" data-bk="${i}" style="--c:var(--${t.color||"c1"})"><span class="n">${String(i+1).padStart(2,"0")}</span><span class="t">${esc(p.title||"Untitled")}</span><span class="w">${fmtN(wc[i])}</span><span class="bar"><i style="width:${(100*wc[i]/max).toFixed(1)}%"></i></span></button>`; }).join("");
  const unsaved=draft && !bibleOpen && dirty() && list.some(p=>p.id===activeId);
  const main=$("book-main"), y=main.scrollTop;
  main.innerHTML=(unsaved?`<div class="bk-note">Includes unsaved changes to “${esc(draft.title||"Untitled")}”.</div>`:"")
    +(list.length?list.map((p,i)=>{ const t=typeOf(p.kind); return (i?`<div class="bk-orn" aria-hidden="true"><span></span></div>`:"")
      +`<article class="bk-art" id="bk-${i}" style="--c:var(--${t.color||"c1"})"><div class="bk-head">${multi?`<div class="bk-kind">${esc(t.name)}</div>`:""}<h1>${esc(p.title||"Untitled")}</h1>`
      +`<div class="bk-meta">${fmtN(wc[i])} words, ${(STATUS_LABEL[p.status]||"").toLowerCase()}<button data-edit="${esc(p.id)}">Edit</button></div></div>`
      +(p.text&&p.text.trim()?`<div class="prose">${md(p.text)}</div>`:`<p class="bk-empty">No text yet.</p>`)+`</article>`; }).join("")
      :`<p class="bk-empty">No pieces to show.</p>`);
  highlight(main, query);
  main.scrollTop=y;
}
function openBook(){
  if(!cur) return;
  if(bookOpen){ closeBook(); return; }
  hidePopup(); bookOpen=true; renderBook();
  $("book").hidden=false; $("b-book").setAttribute("aria-pressed","true"); $("book-main").scrollTop=0;
}
function closeBook(){
  if(!bookOpen) return;
  bookOpen=false; $("book").hidden=true; $("b-book").setAttribute("aria-pressed","false");
}
function setMode(m){
  mode=m; $("m-edit").setAttribute("aria-pressed",m==="edit"); $("m-prev").setAttribute("aria-pressed",m==="preview");
  $("f-text").hidden=m!=="edit"; $("preview").hidden=m!=="preview";
  if(m==="preview") renderPreview(); else $("f-text").focus();
}
function setFocus(on){
  document.body.classList.toggle("focus",on);
  $("b-focus").textContent=on?"Exit focus":"Focus";
  if(on&&mode==="edit") $("f-text").focus();
}
function renderPreview(){ const pv=$("preview"); pv.innerHTML=draft?md(draft.text):""; highlight(pv, query); }

async function save(){
  if(!draft||saving) return false;
  if(snapTimer) pushHist();
  readFields(); saving=true; refreshState("Saving…");
  if(bibleOpen){
    try{ await cur.impl.saveRoot(bibleFile(), draft.text.replace(/\s+$/,"")+"\n"); bibleExists=true; savedSig=sig(draft); savedWords=words(draft.text); saving=false; refreshState(); rescan.last=Date.now(); return true; }
    catch(e){ saving=false; refreshState(errText(e),"err"); return false; }
  }
  const oldId=draft.id;
  const newIdv = draft.title!==savedTitle ? uniqueId(draft.title||"untitled", oldId) : oldId;
  const p={id:newIdv}; FIELDS.forEach(f=>p[f]=draft[f]);
  try{
    await cur.impl.savePiece(p);
    if(newIdv!==oldId){
      try{ await cur.impl.removePiece(oldId); }catch(e){}
      cur.meta.order=pieces.map(x=>x.id===oldId?newIdv:x.id);
      await cur.impl.saveMeta(cur.meta);
      activeId=newIdv; draft.id=newIdv;
    }
    const i=pieces.findIndex(x=>x.id===oldId); if(i>=0) pieces[i]=p;
    savedSig=sig(draft); savedTitle=draft.title; savedWords=words(draft.text); saving=false; refreshState(); layout(); rescan.last=Date.now();
    if(bookOpen) renderBook();
    return true;
  }catch(e){ saving=false; refreshState(errText(e),"err"); return false; }
}

/* ---------- piece operations ---------- */
function setInserting(on){
  inserting=on; document.body.classList.toggle("inserting",on); $("insbar").hidden=!on;
  $("b-add").setAttribute("aria-pressed",String(on));
  if(on){ hidePopup(); closeBook(); }
}
async function addPiece(){
  if(!cur) return;
  if(!pieces.length){ await addPieceAt(0); return; }
  setInserting(!inserting);
}
async function addPieceAt(at){
  if(!cur) return;
  setInserting(false);
  if(draft && !(await confirmLeave("Add a piece"))) return;
  at=Math.max(0,Math.min(at,pieces.length));
  const a=pieces[at-1]||pieces[at];
  const p={id:uniqueId("untitled"),title:"Untitled",kind:a?typeOf(a.kind).id:types()[0].id,status:"idea",summary:"",notes:"",text:""};
  try{ await cur.impl.savePiece(p); }catch(e){ toast(errText(e)); return; }
  pieces.splice(at,0,p); cur.meta.order=pieces.map(x=>x.id); await saveMeta();
  if(bookOpen) renderBook();
  shutSide(); await openSide(p.id);
  $("details").hidden=false; $("b-details").setAttribute("aria-expanded","true");
  $("f-title").select();
}
async function movePiece(id, to){
  const from=pieces.findIndex(p=>p.id===id); if(from<0) return;
  to=Math.max(0,Math.min(to,pieces.length-1)); if(to===from){ layout(); return; }
  const [p]=pieces.splice(from,1); pieces.splice(to,0,p);
  cur.meta.order=pieces.map(x=>x.id); await saveMeta(); layout();
  if(draft) refreshState(); if(bookOpen) renderBook();
}
async function move(dir){
  const i=pieces.findIndex(p=>p.id===activeId); if(i<0) return;
  await movePiece(activeId, i+dir);
}
async function deletePiece(id){
  const p=byId(id); if(!p||!cur) return;
  const isOpen=!bibleOpen && activeId===id;
  const where=cur.source==="folder"?` The file pieces/${id} will be deleted from the folder.`:"";
  const unsaved=isOpen&&dirty()?" It also has unsaved changes.":"";
  const c=await ask(`Delete “${(isOpen?draft.title:p.title)||"Untitled"}” and its text?${where}${unsaved} This can’t be undone.`,[["del","Delete piece","danger"],["cancel","Cancel"]]);
  if(c!=="del") return;
  try{ await cur.impl.removePiece(id); }catch(e){ toast(errText(e)); return; }
  pieces=pieces.filter(x=>x.id!==id); cur.meta.order=pieces.map(x=>x.id); await saveMeta();
  if(isOpen) shutSide();
  if(popupId===id) popupId=null;
  layout(); if(bookOpen) renderBook(); toast("Piece deleted");
}
async function delPiece(){ if(activeId) await deletePiece(activeId); }

/* ---------- dragging nodes to reorder ---------- */
function dragMove(e){
  if(!drag) return;
  if(!drag.started){
    if(Math.abs(e.clientX-drag.x0)<6) return;
    drag.started=true; hidePopup(); document.body.classList.add("dragging"); drag.el.classList.add("lifted");
    drag.ind=document.createElement("div"); drag.ind.className="dropind"; drag.ind.style.top=drag.y+"px"; $("inner").append(drag.ind);
  }
  const r=$("inner").getBoundingClientRect(), x=e.clientX-r.left;
  drag.el.style.left=x+"px";
  const others=pieces.filter(p=>p.id!==drag.id), to=others.filter(p=>p._x<x).length;
  drag.to=to;
  const a=others[to-1], b=others[to];
  drag.ind.style.left=(a&&b?(a._x+b._x)/2:a?a._x+80:b?b._x-80:x)+"px";
  const tr=$("track"), tb=tr.getBoundingClientRect();
  if(e.clientX<tb.left+70) tr.scrollLeft-=14; else if(e.clientX>tb.right-70) tr.scrollLeft+=14;
}
async function dragEnd(e, cancel){
  if(!drag) return;
  const d=drag; drag=null;
  if(!d.started) return;
  suppressClick=true; setTimeout(()=>{ suppressClick=false; },60);
  document.body.classList.remove("dragging");
  const from=pieces.findIndex(p=>p.id===d.id);
  if(!cancel && d.to!=null && d.to!==from){ await movePiece(d.id, d.to); toast("Order saved"); }
  else layout();
}
async function importFiles(files){
  if(!cur||!files.length) return;
  let n=0;
  for(const f of files){
    const p=parsePiece(await f.text(), f.name);
    if(!types().some(t=>t.id===p.kind)) p.kind=types()[0].id;
    p.id=uniqueId(p.title);
    try{ await cur.impl.savePiece(p); pieces.push(p); n++; }catch(e){ toast(errText(e)); break; }
  }
  cur.meta.order=pieces.map(x=>x.id); await saveMeta(); layout();
  if(n) toast(`Imported ${n} piece${n>1?"s":""}`);
}
async function importProjectFolder(files){
  files=[...files]; if(!files.length) return;
  const rel=f=>(f.webkitRelativePath||f.name).split("/").slice(1).join("/");
  let meta=null; const mf=files.find(f=>rel(f)==="linetime.json");
  if(mf){ try{ meta=JSON.parse(await mf.text()); }catch(e){ toast("linetime.json in that folder can’t be read."); return; } }
  const root=(files[0].webkitRelativePath||"").split("/")[0]||"Imported project";
  meta=normalizeMeta(meta, root);
  const rootMd=files.filter(f=>/^[^/]+\.md$/i.test(rel(f)));
  let bf=rootMd.find(f=>rel(f)===(meta.bibleFile||"story-bible.md"));
  if(!bf&&!meta.bibleFile){ const c=rootMd.filter(f=>/bible/i.test(rel(f))); if(c.length===1){ bf=c[0]; meta.bibleFile=rel(bf); } }
  let mdf=files.filter(f=>/^pieces\/[^/]+\.(md|markdown|txt)$/i.test(rel(f)));
  if(!mdf.length) mdf=rootMd.filter(f=>f!==bf);
  const rec={meta, pieces:{}};
  if(bf) rec.bible=await bf.text();
  for(const f of mdf){ const p=parsePiece(await f.text(), f.name); const {id,...b}=p; rec.pieces[id]=b; }
  if(!mf) meta.order=Object.keys(rec.pieces).sort();
  const key=newId("b");
  try{ await idb.set("proj:"+key, rec); }catch(e){ toast(errText(e)); return; }
  await openEntry({key, source:"browser", title:meta.title});
  toast(`Imported ${Object.keys(rec.pieces).length} pieces`);
}

/* ---------- export ---------- */
function buildLatex(p, list, opt){
  const pieceAs=opt.pieceAs, isBook=pieceAs!=="section";
  const head = pieceAs==="section" ? ["subsection","subsubsection","paragraph"] : ["section","subsection","subsubsection"];
  const folder=slug(p.title), files=[], inputs=[];
  list.forEach((pc,i)=>{
    const name=`chapters/${String(i+1).padStart(2,"0")}-${slug(pc.title)}.tex`;
    const cmd = pieceAs==="section"?"section":pieceAs==="unnumbered"?"chapter*":"chapter";
    let body=`% ${pc.title||"Untitled"}\n\\${cmd}{${texInline(pc.title||"Untitled")}}`;
    if(pieceAs==="unnumbered") body+=`\n\\addcontentsline{toc}{chapter}{${texInline(pc.title||"Untitled")}}`;
    const b=tex(pc.text||"", head);
    body+="\n\n"+(b||"% No text yet.")+"\n";
    files.push({name:`${folder}/${name}`, text:body}); inputs.push(`\\input{${name.replace(/\.tex$/,"")}}`);
  });
  const fonts = opt.engine==="lualatex" ? "\\usepackage{fontspec}" : "\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}";
  const pre=(opt.preamble||"").trim();
  const main=[
    `% ${p.title||"Untitled project"}: generated by Linetime on ${new Date().toISOString().slice(0,10)}`,
    `% Compile with ${opt.engine==="lualatex"?"LuaLaTeX or XeLaTeX":"pdfLaTeX"}.`,
    `\\documentclass[11pt]{${isBook?"book":"article"}}`, fonts, "\\usepackage{microtype}",
    ...(pre?["","% Project preamble additions",pre]:[]),
    "", "% Scene break used for --- in Markdown",
    "\\providecommand{\\scenebreak}{\\par\\begin{center}\\rule{3.33cm}{0.4pt}\\end{center}\\par}",
    "", `\\title{${texInline(p.title||"Untitled project")}${p.subtitle?`\\\\[0.5em]\\large ${texInline(p.subtitle)}`:""}}`,
    `\\author{${texInline(p.author||"")}}`, "\\date{}",
    "", "\\begin{document}", "\\maketitle", "", ...inputs, "", "\\end{document}", ""
  ].join("\n");
  files.unshift({name:`${folder}/main.tex`, text:main});
  return makeZip(files);
}
async function projectZip(){
  const folder=slug(cur.meta.title), meta={...cur.meta, order:pieces.map(p=>p.id)};
  let bible=null; try{ bible=await cur.impl.readRoot(bibleFile()); }catch(e){}
  return makeZip([{name:`${folder}/linetime.json`, text:JSON.stringify(meta,null,2)+"\n"},
    ...(bible!==null?[{name:`${folder}/${bibleFile()}`, text:bible}]:[]),
    ...pieces.map(p=>({name:`${folder}/pieces/${p.id}`, text:serializePiece(p)}))]);
}
function exportDialog(){
  const p=project(); if(!p) return;
  const L=p.latex||{}, open=!!draft&&!bibleOpen;
  const fmt0=L.lastFormat||"md";
  const m=openModal(`<h3>Export</h3>
    <div class="grid">
      <fieldset><legend>Format</legend>
        <label class="opt"><input type="radio" name="fmt" value="md" ${fmt0==="md"?"checked":""}> <span>Markdown<small>One .md file</small></span></label>
        <label class="opt"><input type="radio" name="fmt" value="latex" ${fmt0==="latex"?"checked":""}> <span>LaTeX<small>A .zip with main.tex and one file per piece</small></span></label>
        <label class="opt"><input type="radio" name="fmt" value="project" ${fmt0==="project"?"checked":""}> <span>Linetime project<small>A .zip of the project folder, for backup or another computer</small></span></label>
      </fieldset>
      <fieldset id="x-scope"><legend>What</legend>
        <label class="opt"><input type="radio" name="scope" value="all" checked> Whole project</label>
        <label class="opt"><input type="radio" name="scope" value="piece" ${open?"":"disabled"}> Open piece only${open?"":" <small>Open a piece first</small>"}</label>
      </fieldset>
    </div>
    <div id="x-latex">
      <div class="sect">LaTeX options</div>
      <div class="grid">
        <label class="f">Each piece becomes
          <select id="x-as"><option value="chapter">A chapter</option><option value="unnumbered">An unnumbered chapter</option><option value="section">A section (article class)</option></select></label>
        <label class="f">Engine
          <select id="x-engine"><option value="pdflatex">pdfLaTeX</option><option value="lualatex">LuaLaTeX or XeLaTeX</option></select></label>
        <div class="hint wide" id="x-uni" hidden></div>
        <details class="wide"><summary>Preamble additions</summary>
          <textarea class="in code" id="x-pre" rows="5" spellcheck="false" placeholder="\\usepackage[paperwidth=6in,paperheight=9in]{geometry}"></textarea>
          <div class="hint">Added after the default packages. To change the scene break, define <code>\\scenebreak</code> here.</div></details>
      </div>
    </div>
    <div id="x-skipw"><div class="sect"></div>
    <label class="opt"><input type="checkbox" id="x-skip" ${L.skipIdeas===false?"":"checked"}> Leave out pieces with status Idea</label></div>
    <div class="row"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="go">Export</button></div>`, true);
  const el=m.el;
  el.querySelector("#x-as").value=L.pieceAs||"chapter"; el.querySelector("#x-engine").value=L.engine||"pdflatex"; el.querySelector("#x-pre").value=L.preamble||"";
  const odd=[...new Set((pieces.map(x=>x.title+x.text).join("")+(draft?draft.text:"")).match(/[^\u0000-\u017F\u2000-\u206F\u20AC\u2122]/gu)||[])];
  const sync=()=>{
    const f=el.querySelector('input[name=fmt]:checked').value;
    el.querySelector("#x-latex").hidden=f!=="latex"; el.querySelector("#x-scope").hidden=f==="project"; el.querySelector("#x-skipw").hidden=f==="project";
    const u=el.querySelector("#x-uni"), pdf=el.querySelector("#x-engine").value==="pdflatex", sample=odd.slice(0,8).join(" ")+(odd.length>8?" …":"");
    u.hidden=!odd.length;
    u.textContent=pdf ? `The text contains characters that pdfLaTeX can’t typeset by default (${sample}). LuaLaTeX or XeLaTeX with a font that covers them avoids errors.`
      : `The text contains ${sample}. Choose a main font that covers these characters, for example with \\setmainfont in the preamble additions.`;
  };
  el.querySelectorAll("input[name=fmt]").forEach(r=>r.onchange=sync); el.querySelector("#x-engine").onchange=sync; sync();
  el.querySelector('[data-x=cancel]').onclick=()=>m.close();
  el.querySelector('[data-x=go]').onclick=async()=>{
    const fmt=el.querySelector('input[name=fmt]:checked').value, scope=el.querySelector('input[name=scope]:checked').value;
    const latex={...L, pieceAs:el.querySelector("#x-as").value, engine:el.querySelector("#x-engine").value, preamble:el.querySelector("#x-pre").value, skipIdeas:el.querySelector("#x-skip").checked, lastFormat:fmt};
    m.close();
    if(JSON.stringify(latex)!==JSON.stringify(L)){ cur.meta.latex=latex; await saveMeta(); }
    if(fmt==="project"){ download(slug(p.title)+"-linetime.zip", await projectZip()); return; }
    let list = scope==="piece" ? [{...byId(activeId), ...draft}] : pieces.slice();
    if(scope==="all"&&latex.skipIdeas) list=list.filter(x=>x.status!=="idea");
    if(!list.length){ toast("Nothing to export: every piece has status Idea"); return; }
    const base = scope==="piece" ? slug(list[0].title) : slug(p.title);
    if(fmt==="md") download(base+".md", list.map(x=>`# ${x.title||"Untitled"}\n\n${(x.text||"").trim()}\n`).join("\n"));
    else download(base+"-latex.zip", buildLatex(p, list, latex));
  };
}

/* ---------- project dialogs ---------- */
function newProjectDialog(){
  const m=openModal(`<h3>New project</h3>
    <label class="f">Title<input class="in" id="np-title" placeholder="For example, the title of the book"></label>
    <div class="sect">Types of piece</div>
    <fieldset>${Object.entries(TEMPLATES).map(([k,t],i)=>`<label class="opt"><input type="radio" name="tpl" value="${k}" ${i===0?"checked":""}><span>${esc(t.label)}<small>${esc(t.note)}</small></span></label>`).join("")}</fieldset>
    <div class="hint">You can rename, add or remove types later in the project settings.</div>
    <div class="sect"${DESKTOP?" hidden":""}>Where to keep it</div>
    <fieldset>
      <label class="opt"${DESKTOP?" hidden":""}><input type="radio" name="loc" value="folder" ${FS?"checked":"disabled"}><span>In a folder on this computer<small>${FS?"You choose where. Linetime creates a folder named after the project, with one Markdown file per piece.":"This browser can’t write to folders. Chrome, Edge and other Chromium browsers can."}</small></span></label>
      <label class="opt"${DESKTOP?" hidden":""}><input type="radio" name="loc" value="browser" ${FS?"":"checked"}><span>In this browser<small>Stays in this browser’s storage on this computer. Use Export to keep copies as files.</small></span></label>
    </fieldset>
    <div class="row"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="go">${FS?"Choose location and create":"Create project"}</button></div>`);
  const el=m.el, inp=el.querySelector("#np-title"); setTimeout(()=>inp.focus(),0);
  el.querySelectorAll("input[name=loc]").forEach(r=>r.onchange=()=>{ el.querySelector("[data-x=go]").textContent=el.querySelector("input[name=loc]:checked").value==="folder"?"Choose location and create":"Create project"; });
  el.querySelector('[data-x=cancel]').onclick=()=>m.close();
  const go=async()=>{
    const title=inp.value.trim()||"Untitled project", tpl=el.querySelector('input[name=tpl]:checked').value, loc=el.querySelector('input[name=loc]:checked').value;
    const meta=defaultMeta(title, tpl);
    if(loc==="folder"){
      let parent; try{ parent=await window.showDirectoryPicker({mode:"readwrite", id:"linetime-parent"}); }catch(e){ return; }
      const fname=title.replace(/[\\/:*?"<>|\u0000-\u001f]/g,"-").replace(/^[.\s]+|[.\s]+$/g,"")||"Untitled project";
      let dir;
      try{
        try{ await parent.getDirectoryHandle(fname); toast(`A folder named “${fname}” already exists there. Choose another location or title.`); return; }catch(e){}
        dir=await parent.getDirectoryHandle(fname,{create:true});
        await writeText(dir,"linetime.json",JSON.stringify(meta,null,2)+"\n"); await dir.getDirectoryHandle("pieces",{create:true});
      }catch(e){ toast(errText(e)); return; }
      m.close(); await openEntry({key:newId("f"), source:"folder", handle:dir, title});
    } else {
      const key=newId("b");
      try{ await idb.set("proj:"+key,{meta,pieces:{}}); }catch(e){ toast(errText(e)); return; }
      m.close(); await openEntry({key, source:"browser", title});
    }
  };
  el.querySelector('[data-x=go]').onclick=go;
  inp.addEventListener("keydown",e=>{ if(e.key==="Enter") go(); });
}
function settingsDialog(){
  const p=project(); if(!p) return;
  let tps=types().map(t=>({...t}));
  const used=id=>pieces.filter(x=>typeOf(x.kind).id===id).length;
  const folder=cur.source==="folder";
  const m=openModal(`<h3>Project settings</h3>
    <div class="grid">
      <label class="f wide">Title<input class="in" id="ps-title"></label>
      <label class="f">Subtitle<input class="in" id="ps-sub"></label>
      <label class="f">Author<input class="in" id="ps-author"></label>
    </div>
    <div class="sect">Types of piece</div>
    <div id="ps-types"></div>
    <button class="btn" id="ps-addtype">Add type</button>
    <div class="hint">Each type has its own marker on the timeline. Titles of types marked Italic are also set in the type’s color.</div>
    <div class="sect">Story bible</div>
    <label class="f">File name<input class="in" id="ps-bible" spellcheck="false"></label>
    <div class="hint">${folder?"A Markdown file in the project folder, next to linetime.json, not in the pieces folder.":"Stored with the project in this browser. The name is used when you export the project."}</div>
    <div class="sect">Storage</div>
    <div class="hint" style="font-size:14px">${folder?`Folder “${esc(cur.name)}” on this computer. Pieces are in its pieces subfolder.`:"Stored in this browser on this computer."}</div>
    <div class="row"><button class="btn danger left" data-x="del">${folder?"Remove from list":"Delete project"}</button><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="go">Save settings</button></div>`, true);
  const el=m.el;
  el.querySelector("#ps-title").value=p.title||""; el.querySelector("#ps-sub").value=p.subtitle||""; el.querySelector("#ps-author").value=p.author||""; el.querySelector("#ps-bible").value=bibleFile();
  const draw=()=>{
    el.querySelector("#ps-types").innerHTML=tps.map((t,i)=>{ const u=used(t.id); return `<div class="trow" data-i="${i}">
      ${dotHTML(t)}
      <input class="in" data-k="name" value="${esc(t.name)}" aria-label="Type name">
      <select data-k="shape" aria-label="Marker shape">${SHAPES.map(([v,l])=>`<option value="${v}" ${t.shape===v?"selected":""}>${l}</option>`).join("")}</select>
      <select class="color" data-k="color" aria-label="Color">${COLORS.map(([v,l])=>`<option value="${v}" ${t.color===v?"selected":""}>${l}</option>`).join("")}</select>
      <label><input type="checkbox" data-k="emph" ${t.emph?"checked":""}> Italic</label>
      <button class="icon" data-k="rm" ${tps.length<2||u?"disabled":""} title="${u?`Used by ${u} piece${u>1?"s":""}; change their type first`:tps.length<2?"A project needs at least one type":"Remove type"}" aria-label="Remove type">×</button>
    </div>`; }).join("");
  };
  draw();
  el.querySelector("#ps-types").addEventListener("input",e=>{
    const row=e.target.closest(".trow"); if(!row) return; const t=tps[+row.dataset.i], k=e.target.dataset.k;
    if(k==="name") t.name=e.target.value; else if(k==="emph") t.emph=e.target.checked; else if(k){ t[k]=e.target.value; draw(); }
  });
  el.querySelector("#ps-types").addEventListener("click",e=>{ const b=e.target.closest("[data-k=rm]"); if(!b||b.disabled) return; tps.splice(+b.closest(".trow").dataset.i,1); draw(); });
  el.querySelector("#ps-addtype").onclick=()=>{ const c=COLORS[tps.length%COLORS.length][0]; tps.push({id:newId("t"),name:"New type",shape:"disc",color:c,emph:false}); draw(); el.querySelector(".trow:last-child input").select(); };
  el.querySelector('[data-x=cancel]').onclick=()=>m.close();
  el.querySelector('[data-x=go]').onclick=async()=>{
    tps.forEach(t=>t.name=t.name.trim()||"Untitled type");
    let bname=el.querySelector("#ps-bible").value.trim()||"story-bible.md";
    if(!/\.md$/i.test(bname)) bname+=".md";
    if(/[\\/:*?"<>|]/.test(bname)){ toast("The story bible’s file name can’t contain \\ / : * ? \" < > |"); return; }
    if(bname!==bibleFile()){
      if(bibleOpen && dirty()){ toast("Save or close the story bible before changing its file name."); return; }
      if(bibleOpen) shutSide();
      cur.meta.bibleFile=bname;
    }
    Object.assign(cur.meta,{title:el.querySelector("#ps-title").value.trim()||"Untitled project",subtitle:el.querySelector("#ps-sub").value.trim(),author:el.querySelector("#ps-author").value.trim(),types:tps});
    m.close();
    if(await saveMeta()){ const r=recents.find(r=>r.key===cur.key); if(r){ r.title=cur.meta.title; saveRecents(); } toast("Settings saved"); }
    renderBrand(); layout();
  };
  el.querySelector('[data-x=del]').onclick=async()=>{
    m.close();
    const msg=folder?`Remove “${p.title}” from Linetime’s list? The folder and its files stay on your computer, and you can open it again later.`
      :`Delete the project “${p.title}” and all ${pieces.length} of its pieces from this browser? This can’t be undone. Export it first if you want a copy.`;
    const c=await ask(msg,[["del",folder?"Remove from list":"Delete project","danger"],["cancel","Cancel"]]);
    if(c!=="del") return;
    if(!(await leaveCurrent())) return;
    if(!folder){ try{ await idb.del("proj:"+cur.key); }catch(e){} }
    recents=recents.filter(r=>r.key!==cur.key); saveRecents();
    cur=null; pieces=[]; renderBrand(); layout(); $("storeNote").textContent="";
  };
}

/* ---------- modals ---------- */
function openModal(html, wide){
  const s=document.createElement("div"); s.className="scrim";
  s.innerHTML=`<div class="modal${wide?" wide-m":""}" role="dialog" aria-modal="true">${html}</div>`;
  const prev=document.activeElement;
  const close=()=>{ s.remove(); document.removeEventListener("keydown",k,true); prev&&prev.focus&&prev.focus(); };
  const k=e=>{ if(e.key==="Escape"){ e.stopPropagation(); close(); } };
  s.addEventListener("mousedown",e=>{ if(e.target===s) close(); });
  document.addEventListener("keydown",k,true); document.body.append(s);
  return {el:s.querySelector(".modal"), close};
}
function ask(msg, buttons){
  return new Promise(res=>{
    const m=openModal(`<p></p><div class="row"></div>`); m.el.querySelector("p").textContent=msg;
    let v="cancel"; const row=m.el.querySelector(".row"), obs=new MutationObserver(()=>{ if(!m.el.isConnected){ obs.disconnect(); res(v); } });
    obs.observe(document.body,{childList:true});
    buttons.slice().reverse().forEach(([val,label,cls])=>{ const b=document.createElement("button"); b.className="btn "+(cls||""); b.textContent=label; b.onclick=()=>{ v=val; m.close(); }; row.append(b); });
    row.lastChild.focus();
  });
}

/* ---------- external changes ---------- */
function onPieces(list){
  pieces=list;
  if(activeId){
    const p=byId(activeId);
    if(!p){ if(!dirty()){ shutSide(); toast("This piece was removed from the folder"); } }
    else {
      const inc={}; FIELDS.forEach(f=>inc[f]=p[f]??""); inc.kind=typeOf(inc.kind).id;
      if(!dirty() && sig(inc)!==savedSig){ loadDraft(p); toast("Reloaded: the file changed outside Linetime"); }
      else refreshState();
    }
  }
  if(popupId && !byId(popupId)) popupId=null;
  layout();
  if(bookOpen) renderBook();
}

/* ---------- quitting with unsaved changes (desktop) ---------- */
window.linetimeConfirmQuit = async function(){
  return await confirmLeave("Quit Linetime");
};

/* ---------- start ---------- */
async function init(){
  renderBrand(); layout();
  try{ recents=(await idb.get("recents"))||[]; }catch(e){ recents=[]; }
  if(DESKTOP) recents=recents.filter(r=>r.source==="folder"&&r.path).map(r=>({...r, handle:new LinetimeDesktop.DirHandle(r.path)}));
  if(!FS) recents=recents.filter(r=>r.source!=="folder");
  const last=[...recents].sort((a,b)=>(b.lastOpened||0)-(a.lastOpened||0))[0];
  if(last){
    if(last.source==="browser") await openEntry(last);
    else { try{ if(await last.handle.queryPermission({mode:"readwrite"})==="granted") await openEntry(last); }catch(e){} }
  }
  layout();
}

/* ---------- events ---------- */
$("brand").addEventListener("click",e=>{ e.stopPropagation(); toggleMenu(); });
$("pmenu").addEventListener("click",e=>{
  e.stopPropagation(); const b=e.target.closest("button"); if(!b) return; toggleMenu(false);
  const r=b.dataset.key&&recents.find(x=>x.key===b.dataset.key);
  if(r) openEntry(r); else ({new:newProjectDialog, open:pickFolder, importdir:()=>$("dirfile").click(), settings:settingsDialog})[b.dataset.mact]?.();
});
document.addEventListener("click",e=>{
  const t=e.target;
  if(suppressClick){ suppressClick=false; return; }
  if(t.closest("#insbar")){ if(t.closest("[data-act=cancelins]")) setInserting(false); return; }
  const gap=t.closest("#inner .gap");
  if(gap){ addPieceAt(+gap.dataset.at); return; }
  const pa=t.closest("[data-pa]");
  if(pa){
    const id=popupId, i=pieces.findIndex(p=>p.id===id), a=pa.dataset.pa;
    if(a==="open") openSide(id); else if(a==="left") movePiece(id,i-1); else if(a==="right") movePiece(id,i+1); else if(a==="del") deletePiece(id);
    return;
  }
  if(!$("pmenu").hidden && !t.closest("#pmenu")) toggleMenu(false);
  if(t.closest(".scrim")||t.closest("aside")||t.closest("header")||t.closest("#book")) return;
  const act=t.closest("[data-act]");
  if(act){
    const a=act.dataset.act;
    if(a==="add") addPiece(); else if(a==="import") $("file").click(); else if(a==="newproj") newProjectDialog();
    else if(a==="open") pickFolder(); else if(a==="importdir") $("dirfile").click();
    else if(a==="reopen"){ const r=recents.find(x=>x.key===act.dataset.key); if(r) openEntry(r); }
    return;
  }
  if(inserting && !t.closest(".gap")){ setInserting(false); }
  if(t.closest(".popup")){ openSide(popupId); return; }
  const node=t.closest("#inner .node");
  if(node){ const id=node.dataset.id; if(popupId===id) hidePopup(); else showPopup(id); return; }
  hidePopup();
});
$("inner").addEventListener("keydown",e=>{ if((e.key==="Enter"||e.key===" ")&&e.target.classList.contains("popup")){ e.preventDefault(); openSide(popupId); } });
document.addEventListener("keydown",e=>{
  if(document.querySelector(".scrim")) return;
  const mod=e.ctrlKey||e.metaKey, k=e.key.toLowerCase();
  if(mod&&k==="s"){ e.preventDefault(); if(draft) save(); return; }
  if(draft){
    if(mod&&k==="z"&&!e.shiftKey){ e.preventDefault(); undo(); return; }
    if(mod&&(k==="y"||(k==="z"&&e.shiftKey))){ e.preventDefault(); redo(); return; }
    if(mod&&e.shiftKey&&k==="f"){ e.preventDefault(); setFocus(!document.body.classList.contains("focus")); return; }
  }
  const typing=/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement||{}).tagName||"");
  if(popupId && !typing){
    const i=pieces.findIndex(p=>p.id===popupId);
    if(e.key==="Delete"||e.key==="Backspace"){ e.preventDefault(); deletePiece(popupId); return; }
    if(e.altKey&&e.key==="ArrowLeft"){ e.preventDefault(); movePiece(popupId,i-1); return; }
    if(e.altKey&&e.key==="ArrowRight"){ e.preventDefault(); movePiece(popupId,i+1); return; }
  }
  if(e.key==="Escape"){
    if(drag){ dragEnd(e,true); return; }
    if(inserting){ setInserting(false); return; }
    if(!$("pmenu").hidden) toggleMenu(false);
    else if(popupId) hidePopup();
    else if(bookOpen) closeBook();
    else if(document.body.classList.contains("focus")) setFocus(false);
    else if(draft) closeSide();
  }
});
["f-title","f-summary","f-notes","f-text"].forEach(id=>{ $(id).addEventListener("input",onEdit); $(id).addEventListener("blur",()=>{ if(snapTimer){ pushHist(); refreshState(); } }); });
["f-kind","f-status"].forEach(id=>$(id).addEventListener("change",()=>{ onEdit(); pushHist(); refreshState(); }));
$("b-save").onclick=save; $("b-undo").onclick=undo; $("b-redo").onclick=redo; $("b-close").onclick=closeSide;
$("b-focus").onclick=()=>setFocus(!document.body.classList.contains("focus"));
$("m-edit").onclick=()=>setMode("edit"); $("m-prev").onclick=()=>setMode("preview");
$("b-details").onclick=()=>{ const d=$("details"); d.hidden=!d.hidden; $("b-details").setAttribute("aria-expanded",String(!d.hidden)); };
$("b-left").onclick=()=>move(-1); $("b-right").onclick=()=>move(1); $("b-del").onclick=delPiece;
const THEME_KEY="linetime-theme";
const themeNow=()=>document.documentElement.dataset.theme||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");
function syncThemeButton(){
  const next=themeNow()==="light"?"dark":"light", label=`Switch to ${next} mode`;
  $("b-theme").title=label; $("b-theme").setAttribute("aria-label",label);
}
function setTheme(t){
  document.documentElement.dataset.theme=t;
  try{ localStorage.setItem(THEME_KEY,t); }catch(e){}
  syncThemeButton();
}
try{ const t=localStorage.getItem(THEME_KEY); if(t==="light"||t==="dark") document.documentElement.dataset.theme=t; }catch(e){}
syncThemeButton();
matchMedia("(prefers-color-scheme: light)").addEventListener("change",syncThemeButton);
$("b-theme").onclick=()=>setTheme(themeNow()==="light"?"dark":"light");
$("b-bible").onclick=openBible;
$("inner").addEventListener("pointerdown",e=>{
  const hb=e.target.closest(".hitbox"); if(!hb||e.button!==0||!cur||inserting) return;
  const node=hb.closest(".node"); drag={id:node.dataset.id, el:node, x0:e.clientX, y:parseFloat(node.style.top), started:false, to:null};
});
window.addEventListener("pointermove",dragMove);
window.addEventListener("pointerup",e=>dragEnd(e,false));
window.addEventListener("pointercancel",e=>dragEnd(e,true));
$("b-book").onclick=openBook;
$("book-toc").addEventListener("click",e=>{ const b=e.target.closest("[data-bk]"); if(b){ const a=$("bk-"+b.dataset.bk); if(a) a.scrollIntoView({behavior:"smooth",block:"start"}); } });
$("book-toc").addEventListener("change",e=>{ if(e.target.id==="bk-ideas"){ bookIdeas=e.target.checked; renderBook(); } });
$("book-main").addEventListener("click",e=>{ const b=e.target.closest("[data-edit]"); if(b) openSide(b.dataset.edit); });
document.addEventListener("selectionchange",()=>{ if(draft && document.activeElement===$("f-text")) updateWc(); });
$("b-add").onclick=addPiece; $("b-import").onclick=()=>$("file").click(); $("b-export").onclick=exportDialog;
$("file").addEventListener("change",async e=>{ const fs=[...e.target.files]; e.target.value=""; await importFiles(fs); });
$("dirfile").addEventListener("change",async e=>{ const fs=[...e.target.files]; e.target.value=""; await importProjectFolder(fs); });
$("sp-even").onclick=()=>{ spacing="even"; $("sp-even").setAttribute("aria-pressed","true"); $("sp-len").setAttribute("aria-pressed","false"); layout(); };
$("sp-len").onclick=()=>{ spacing="length"; $("sp-len").setAttribute("aria-pressed","true"); $("sp-even").setAttribute("aria-pressed","false"); layout(); };
let qt; $("q").addEventListener("input",e=>{ clearTimeout(qt); qt=setTimeout(()=>{ query=e.target.value.trim(); layout(); if(draft&&mode==="preview") renderPreview(); if(bookOpen) renderBook(); },180); });
new ResizeObserver(()=>layout()).observe($("track"));
const hdr=document.querySelector("header");
new ResizeObserver(()=>document.documentElement.style.setProperty("--hh",hdr.getBoundingClientRect().bottom+"px")).observe(hdr);
window.addEventListener("focus",rescan);
document.addEventListener("visibilitychange",()=>{ if(!document.hidden) rescan(); });
window.addEventListener("beforeunload",e=>{ if(dirty()){ e.preventDefault(); e.returnValue=""; } });
init();
