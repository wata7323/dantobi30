// 30段跳び：ランキングの API と遊んだ回数の集計。それ以外のパスは静的ファイル（index.html）をそのまま返す
//   GET  /api/rank                 → {all:[…],day:[…],today:'YYYY-MM-DD'}
//                                     1件は {id,u,s,p,j,k,t}（u なまえ、s 記録 m、p PERFECT の数、j JUST の数、k 結果の種類、t 登録時刻）
//   POST /api/rank {s,u,p,j,k,d,at}   → 中身を検証し、全期間か今日の上位に入れば保存して {pos,dpos,id,best,…上と同じ一覧}
//                                     d は端末番号（無いものは受け付けない）。各一覧に1端末1件（自己ベストだけ）。より良い記録なら入れ替えて best=true
//                                     at はその記録を出した時刻。今日の一覧には、今日出した記録だけを入れる（ゲームは自己ベストを送る）
//   POST /api/play {e,f,v,l}        → 1回の遊びを数えて、調整用に1行残す（e はプレイごとの番号。同じ e の送り直しは数えない）
//                                     f=1 ならその端末で初めて遊んだ回（＝新しい人）。v は版。l は {why,d,p,j,c,n,t}
//                                     （終わったわけ・記録 m・PERFECT・JUST・最大コンボ・何段目まで跳んだか・秒）
//   GET  /stats                     → 合言葉の入力欄だけ
//   POST /stats {k,a,id,ver}        → 合言葉が合えば、集計（日本時間の日ごと）・分析・ランキングの全件を見せる
//                                     a=reset で集計を0に（ランキングは残す）、a=del でランキングの1件を消す、a=csv で記録を CSV で保存
//   GET  /k/<キー>                → 結果の種類ごとのプレビュー（OGP）だけのページ。開くとすぐゲームへ移る。キーは決まった英字だけ
//   GET  /（index.html）           → 中の %ORIGIN% を公開先の https://… に置き換えて返す（プレビュー画像は絶対 URL でないと X が読まない）
//   POST /admin {k,a,id}            → 合言葉が合えば、a=list で全件（JSON）、a=del で id の1件を消す。GET /admin は /stats へ
//                                     合言葉は Cloudflare の Secret「ADMIN_KEY」に登録する（コードには書かない。未登録なら使えない）
// 保存先は Durable Object（SQLite、無料プランで使える）1つ。自由な文字は受け取らない（なまえはひらがな・カタカナ8文字まで）
import {DurableObject} from 'cloudflare:workers';

const KEEP=100;
const S_MAX=470000;   // 記録の上限 m（自動プレイで全部 JUST のとき約434km。それ＋少し）
const JUMPS=30;
// なまえ：ひらがな・カタカナ・「ー」で8文字まで（空なら名無し）。よくある悪口は弾く（カタカナはひらがなに直して比べる）
const NAME_NG=['しね','しんで','ころす','ころせ','ちんこ','ちんぽ','まんこ','せっくす','れいぷ','きちがい','がいじ','うんこ','ぶす','かす'];
const hira=s=>s.replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60));
function validUser(u){
  if(u===undefined||u==='')return '';
  if(typeof u!=='string'||!/^[ぁ-ゖァ-ヺー]{1,8}$/.test(u)||NAME_NG.some(w=>hira(u).includes(w)))return null;
  return u;
}
// 結果の種類（景色）。ゲームの ZKEYS と同じ並び。プレビューの画像は og/v1/<キー>.jpg（作り直したら v2 に変える。X が古い絵を覚えているため）
const KINDS={stadium:'競技場の中',city:'競技場を飛び出した',farm:'田園を越えた',sea:'海を渡った',desert:'砂漠の向こうへ',snow:'雪山を越えた伝説',horizon:'地平線の彼方へ（全PERFECT級）'};
const OG_VER='v1',DESC='ホップ・ステップ×28・ジャンプ。着地のたびにタップして、30段跳びでどこまで飛べるか。';
const isCount=x=>Number.isInteger(x)&&x>=0&&x<=JUMPS;
function valid(b){
  if(!b||typeof b!=='object')return null;
  const u=validUser(b.u),s=b.s;
  if(u===null)return null;
  if(typeof s!=='number'||!isFinite(s)||s<=0||s>S_MAX)return null;
  if(Math.round(s*10)!==+(s*10).toFixed(6))return null;   // 記録は小数1桁まで
  if(!isCount(b.p)||!isCount(b.j)||b.j>b.p)return null;   // JUST は PERFECT の中のさらにぴったり
  return {s,u,p:b.p,j:b.j,k:Object.hasOwn(KINDS,b.k)?b.k:''};
}
// 調整用の記録（1回の遊びで1行）。決まった語と範囲の数だけを通す
const LOG_KEEP=200000;   // 新しい20万件だけ残す
const LOG_COLS=['eid','t','ver','first','why','dist','perf','just','combo','n','secs'];
const WHYS=['done','quit'];
function cleanLog(L,ver){
  if(!L||typeof L!=='object')return null;
  const num=(x,lo,hi,d)=>typeof x==='number'&&isFinite(x)?+Math.min(hi,Math.max(lo,x)).toFixed(d):null;
  return {ver:typeof ver==='string'&&/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ver)?ver:null,
    why:WHYS.includes(L.why)?L.why:null,dist:num(L.d,0,S_MAX,1),perf:num(L.p,0,JUMPS,0),just:num(L.j,0,JUMPS,0),combo:num(L.c,0,JUMPS,0),n:num(L.n,0,JUMPS,0),secs:num(L.t,0,3600,1)};
}
function json(o,status){return new Response(JSON.stringify(o),{status:status||200,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
const errText=e=>String(e&&e.message||e).slice(0,120);
// 端末の見分け（1人1件のため）。ゲームが送る端末番号 d を、ここでハッシュにして dh として持つ。dh は外へ出さない
async function devHash(d){
  if(typeof d!=='string'||!/^[0-9a-f]{16,32}$/.test(d))return '';
  const h=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('30dantobi-dev:'+d)));
  return [...h.slice(0,12)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const pub=l=>l.map(({dh,...e})=>e);
const jstDay=t=>new Date(t+9*3600e3).toISOString().slice(0,10);   // 日本時間の日付

// ランキングを持つ Durable Object（1つだけ使う）。中の処理は1件ずつ順番に動くので、同時に書いても壊れない
export class Board extends DurableObject{
  constructor(ctx,env){
    super(ctx,env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS plays_log(eid TEXT PRIMARY KEY,t INTEGER,ver TEXT,first INTEGER,why TEXT,dist REAL,perf INTEGER,just INTEGER,combo INTEGER,n INTEGER,secs REAL)`);
  }
  async lists(){
    const s=this.ctx.storage,today=jstDay(Date.now());
    const all=(await s.get('all'))||[],day=(await s.get('day'))||{d:today,l:[]};
    return {all,day:day.d===today?day.l:[],today};
  }
  async view(){
    const L=await this.lists();
    return {all:pub(L.all),day:pub(L.day),today:L.today};
  }
  async submit(v){
    const L=await this.lists();
    // その一覧に入るか。入るなら、入れ替える自分の古い記録の位置（無ければ -1）
    const plan=l=>{
      const i=l.findIndex(e=>e.dh===v.dh);
      if(i>=0)return v.s>l[i].s?{i}:null;
      return l.length<KEEP||v.s>l[l.length-1].s?{i:-1}:null;
    };
    const pA=plan(L.all),pD=v.day===false?null:plan(L.day),posOf=(l,id)=>{const i=id?l.findIndex(x=>x.id===id):-1;return i>=0?i+1:null;};
    const mine=l=>(l.find(e=>e.dh===v.dh)||{}).id;   // 入らなかったときは、今載っている自分の順位を返す
    let id=null;
    if(pA||pD){
      const e=Object.assign({id:crypto.randomUUID().slice(0,8),t:Date.now()},v);delete e.day;id=e.id;
      const add=(l,p)=>{if(p.i>=0)l.splice(p.i,1);l.push(e);l.sort((a,b)=>b.s-a.s||a.t-b.t);l.length=Math.min(l.length,KEEP);};
      const w={};
      if(pA){add(L.all,pA);w.all=L.all;}
      if(pD){add(L.day,pD);w.day={d:L.today,l:L.day};}
      await this.ctx.storage.put(w);
    }
    const out=await this.view();
    return Object.assign(out,{id,best:[pA,pD].some(p=>p&&p.i>=0),pos:posOf(L.all,pA?id:mine(L.all)),dpos:posOf(L.day,pD?id:mine(L.day))});
  }
  // 1回の遊びを数える。同じ eid の送り直しは数えない
  async play(first,eid,L){
    const d=jstDay(Date.now()),s=this.ctx.storage,row=[eid,Date.now(),L.ver,first?1:0,L.why,L.dist,L.perf,L.just,L.combo,L.n,L.secs];
    const c=s.sql.exec(`INSERT OR IGNORE INTO plays_log(${LOG_COLS.join(',')}) VALUES(${LOG_COLS.map(()=>'?').join(',')})`,...row);
    c.toArray();if(!c.rowsWritten)return {ok:true,dup:true};
    const k=['plays','plays:'+d].concat(first?['players','players:'+d]:[]),cur=await s.get(k),o={};
    for(const x of k)o[x]=(cur.get(x)||0)+1;
    await s.put(o);
    if(o.plays%500===0)s.sql.exec(`DELETE FROM plays_log WHERE rowid<=(SELECT MAX(rowid) FROM plays_log)-?`,LOG_KEEP);   // 増えすぎた古い分を消す
    return {ok:true};
  }
  async stats(days){
    const s=this.ctx.storage,now=Date.now(),ks=['plays','players'],rows=[];
    for(let i=0;i<days;i++){const d=jstDay(now-i*86400e3);rows.push(d);ks.push('plays:'+d,'players:'+d);}
    const m=await s.get(ks);
    return {plays:m.get('plays')||0,players:m.get('players')||0,days:rows.map(d=>({d,plays:m.get('plays:'+d)||0,players:m.get('players:'+d)||0}))};
  }
  // 集計（plays… と players… で始まる値）と記録を消す。ランキングは残す
  async resetStats(){
    const s=this.ctx.storage,ks=[];
    for(const p of ['plays','players'])ks.push(...(await s.list({prefix:p})).keys());
    for(let i=0;i<ks.length;i+=128)await s.delete(ks.slice(i,i+128));
    s.sql.exec('DELETE FROM plays_log');
    return ks.length;
  }
  // 調整用の分析（直近2万件。ver を渡すとその版だけ）
  analyze(ver){
    const all=this.ctx.storage.sql.exec(`SELECT ver,first,why,dist,perf,just,combo,n,secs FROM plays_log ORDER BY rowid DESC LIMIT 20000`).toArray();
    const vc={};for(const r of all){const v=r.ver||'?';vc[v]=(vc[v]||0)+1;}
    const rows=ver?all.filter(r=>(r.ver||'?')===ver):all;
    const med=a=>{if(!a.length)return null;a=a.slice().sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
    const p90=a=>{if(!a.length)return null;a=a.slice().sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor(a.length*0.9))];};
    // まとまりごとに：回数・最後まで跳んだ回の記録（中央値・上位10%・最高）・PERFECT と JUST の平均・途中でやめた割合
    const sum=list=>{
      const done=list.filter(r=>r.why==='done'),d=done.map(r=>r.dist||0),avg=k=>done.length?done.reduce((a,r)=>a+(r[k]||0),0)/done.length:null;
      return {n:list.length,done:done.length,med:med(d),p90:p90(d),max:d.length?Math.max(...d):null,perf:avg('perf'),just:avg('just'),quit:list.filter(r=>r.why==='quit').length};
    };
    const by=f=>{const g=new Map();for(const r of rows){const k=f(r);if(k===null||k===undefined)continue;if(!g.has(k))g.set(k,[]);g.get(k).push(r);}
      return [...g.entries()].map(([k,l])=>Object.assign({k},sum(l)));};
    const pfK=r=>r.why!=='done'?null:r.perf>=30?'30（全部）':r.perf>=20?'20〜29':r.perf>=10?'10〜19':'0〜9';
    const order=(l,keys)=>keys.map(k=>l.find(x=>x.k===k)).filter(Boolean);
    // やめた回：何段目でやめたか
    const qs=[0,1,2].map(i=>({k:['1〜10段','11〜20段','21〜30段'][i],n:rows.filter(r=>r.why==='quit'&&Math.min(2,Math.floor(Math.max(0,(r.n||0)-1)/10))===i).length}));
    return {vers:Object.entries(vc).sort((a,b)=>b[0].localeCompare(a[0],undefined,{numeric:true})),n:rows.length,all:sum(rows),
      first:order(by(r=>r.first?'初めての1回':'2回目から'),['初めての1回','2回目から']),
      perf:order(by(pfK),['30（全部）','20〜29','10〜19','0〜9']),quitAt:qs};
  }
  // CSV（新しい順に最大5万件）
  csv(){
    const rows=this.ctx.storage.sql.exec(`SELECT ${LOG_COLS.slice(1).join(',')} FROM plays_log ORDER BY rowid DESC LIMIT 50000`).toArray();
    const cell=x=>x===null||x===undefined?'':(typeof x==='string'&&/[",\n]/.test(x)?'"'+x.replace(/"/g,'""')+'"':String(x));
    const head=LOG_COLS.slice(1);
    return [head.join(',')].concat(rows.map(r=>head.map(h=>h==='t'?cell(new Date(r.t+9*3600e3).toISOString().slice(0,19).replace('T',' ')):cell(r[h])).join(','))).join('\r\n');
  }
  async remove(id){
    const L=await this.lists(),a=L.all.filter(e=>e.id!==id),d=L.day.filter(e=>e.id!==id),w={};
    if(a.length!==L.all.length)w.all=a;
    if(d.length!==L.day.length)w.day={d:L.today,l:d};
    if(Object.keys(w).length)await this.ctx.storage.put(w);
    return Object.keys(w).length>0;
  }
}
const board=env=>env.BOARD.get(env.BOARD.idFromName('main'));

// 同じ端末（IP）からの連投を止める（秒）。IP は短い時間だけキャッシュに置き、保存はしない
const rateKey=(req,tag)=>new Request('https://rate.local/'+tag+'/'+encodeURIComponent(req.headers.get('cf-connecting-ip')||''));
const hasIp=req=>!!req.headers.get('cf-connecting-ip');
async function rateHas(req,tag){return hasIp(req)&&!!(await caches.default.match(rateKey(req,tag)));}
async function rateMark(req,tag,sec){if(hasIp(req))await caches.default.put(rateKey(req,tag),new Response('1',{headers:{'cache-control':'max-age='+sec}}));}
async function busy(req,tag,sec){if(await rateHas(req,tag))return true;await rateMark(req,tag,sec);return false;}

async function rank(req,env){
  if(req.method==='GET'){try{return json(await board(env).view());}catch(e){return json({error:'server',err:errText(e)},500);}}
  if(req.method!=='POST')return json({error:'method'},405);
  if(await busy(req,'rank',8))return json({error:'busy'},429);
  let b;try{b=await req.json();}catch(e){return json({error:'bad'},400);}
  const v=valid(b);if(!v)return json({error:'invalid'},400);
  const dh=await devHash(b.d);if(!dh)return json({error:'invalid'},400);   // 端末番号が無いと1端末1件にできないので受け付けない
  v.dh=dh;
  const now=Date.now(),at=typeof b.at==='number'&&isFinite(b.at)?Math.min(b.at,now):now;v.day=jstDay(at)===jstDay(now);
  try{return json(await board(env).submit(v));}catch(e){return json({error:'server',err:errText(e)},500);}
}

async function play(req,env){
  if(req.method!=='POST')return json({error:'method'},405);
  if(await busy(req,'play',2))return json({ok:false},429);   // 2秒より短い間隔の連打は数えない
  let b={};try{b=await req.json();}catch(e){}
  b=b&&typeof b==='object'?b:{};
  const eid=typeof b.e==='string'&&/^[0-9a-f]{16,32}$/.test(b.e)?b.e:'',L=cleanLog(b.l,b.v);
  if(!eid||!L||!L.why)return json({error:'invalid'},400);
  try{return json(await board(env).play(b.f===1,eid,L));}catch(e){return json({error:'server',err:errText(e)},500);}
}

// ---- 消すためのページ（合言葉が要る） ----
async function keyOk(given,env){   // 長さや一致した文字数で時間が変わらないように比べる
  const want=env.ADMIN_KEY;if(typeof want!=='string'||!want||typeof given!=='string')return false;
  const h=async x=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)));
  const a=await h(given),b=await h(want);let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0;
}
async function admin(req,env){
  if(req.method==='GET')return Response.redirect(new URL('/stats',req.url).toString(),302);   // 管理は集計ページで
  if(req.method!=='POST')return json({error:'method'},405);
  if(await busy(req,'admin',1))return json({error:'busy'},429);   // 合言葉の総当たりを遅くする
  let b;try{b=await req.json();}catch(e){return json({error:'bad'},400);}
  if(!(await keyOk(b&&b.k,env)))return json({error:'key'},403);
  if(b.a==='list')return json(await board(env).view());
  if(b.a==='del'&&typeof b.id==='string')return json({ok:await board(env).remove(b.id)});
  return json({error:'bad'},400);
}

// ---- 集計ページ（合言葉が要る）。フォームで送ってサーバーで組み立てる ----
const esc=t=>String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtM=m=>m===null||m===undefined?'-':m>=1000?(m/1000).toFixed(m>=100000?0:1)+'km':Math.round(m)+'m';
const CSS=`body{margin:0;padding:16px;background:#eaf4fb;color:#14213d;font-family:system-ui,"Hiragino Sans","Yu Gothic UI",sans-serif}h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:28px 0 8px}h3{font-size:14px;margin:16px 0 4px}
.t{display:flex;flex-wrap:wrap;gap:24px;margin-bottom:16px}.t b{display:block;font-size:28px}table{border-collapse:collapse;width:100%;max-width:720px;font-variant-numeric:tabular-nums}
td,th{border-bottom:1px solid rgba(20,33,61,.16);padding:6px 4px;text-align:right;vertical-align:middle}td:first-child,th:first-child{text-align:left}small{color:#56627e}
.m{margin:0 0 12px}.m.ng{color:#e11d48}td.l{text-align:left}td small{display:block}
form{display:flex;gap:8px;max-width:480px;margin:0}form.k{margin-top:8px}form input,form select{flex:1;min-width:0;font:inherit;padding:8px;border:1px solid rgba(20,33,61,.3);background:#fff;border-radius:0}
button{font:inherit;font-weight:700;padding:8px 14px;border:0;background:#14213d;color:#fff;border-radius:0;cursor:pointer}td button{padding:4px 10px;font-size:13px;background:#e11d48}
table.an th,table.an td{white-space:nowrap;font-size:12px;padding:5px 5px}.sc{overflow-x:auto}`;
const page=body=>new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>集計｜30段跳び</title><style>${CSS}</style></head><body>
<h1>30段跳び 集計</h1>${body}</body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer','x-robots-tag':'noindex'}});
const MSG={ok:'集計を0に戻しました。',del:'ランキングから1件消しました。',gone:'その記録はもうランキングにありません。',ng:'合言葉が違います。',busy:'少し待ってからもう一度入れてください。',switch:'更新の切り替え中です。1〜2分たってから、もう一度開いてください。',nokey:'合言葉（ADMIN_KEY）が Cloudflare に登録されていません。'};
const msgHtml=r=>MSG[r]?`<p class="m${['ok','del'].includes(r)?'':' ng'}">${MSG[r]}</p>`:'';
const loginPage=r=>page(`${msgHtml(r)}<form method="post" action="/stats"><input type="password" name="k" placeholder="合言葉" autocomplete="current-password" required autofocus><input type="hidden" name="a" value="view"><button>開く</button></form>`);
const pct=(a,b)=>b?Math.round(a/b*100)+'%':'-';
const f1=x=>x===null||x===undefined?'-':x.toFixed(1);
// 分析の表：まとまりごとの回数と成績
function anTable(title,list,note){
  const tr=list.map(x=>`<tr><td>${esc(x.k)}</td><td>${x.n}</td><td>${x.done}</td><td>${fmtM(x.med)}</td><td>${fmtM(x.p90)}</td><td>${fmtM(x.max)}</td><td>${f1(x.perf)}</td><td>${f1(x.just)}</td><td>${pct(x.quit,x.n)}</td></tr>`).join('');
  return `<h3>${title}</h3><div class="sc"><table class="an"><tr><th></th><th>回数</th><th>30段まで</th><th>中央値</th><th>上位10%</th><th>最高</th><th>PERFECT</th><th>JUST</th><th>やめた</th></tr>${tr||'<tr><td>まだありません</td></tr>'}</table></div>${note?`<p><small>${note}</small></p>`:''}`;
}
function analysisHtml(A,ver,hk){
  const opt=['<option value="">すべての版</option>'].concat(A.vers.map(([v,c])=>`<option value="${esc(v)}"${v===ver?' selected':''}>ver. ${esc(v)}（${c}回）</option>`)).join('');
  const qa=A.quitAt.map(x=>`<tr><td>${x.k}</td><td>${x.n}</td></tr>`).join('');
  return `<h2>分析（直近${A.n.toLocaleString()}回）</h2>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="view"><select name="ver">${opt}</select><button>絞り込む</button></form>
${anTable('全体',[Object.assign({k:'すべて'},A.all)],'記録（中央値・上位10%・最高）と PERFECT・JUST の平均は、30段まで跳んだ回だけで数える。')}
${anTable('初めてかどうか',A.first)}
${anTable('PERFECT の数別',A.perf)}
<h3>途中でやめた段</h3><div class="sc"><table class="an"><tr><th></th><th>回数</th></tr>${qa}</table></div>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="csv"><button>記録を CSV で保存（直近5万件）</button></form>`;
}
async function stats(req,env){
  if(req.method==='GET')return loginPage('');
  if(req.method!=='POST')return json({error:'method'},405);
  let f=null;try{f=await req.formData();}catch(e){}
  const k=String(f&&f.get('k')||''),a=String(f&&f.get('a')||'view'),id=String(f&&f.get('id')||'');
  const ver=/^(\d{1,3}\.\d{1,3}\.\d{1,3}|\?)$/.test(String(f&&f.get('ver')||''))?String(f.get('ver')):'';
  if(!env.ADMIN_KEY)return loginPage('nokey');
  // 合言葉の総当たりを防ぐ：間違えたら、同じ端末からは5秒待たないと次を試せない
  if(await rateHas(req,'statsng'))return loginPage('busy');
  if(!(await keyOk(k,env))){await rateMark(req,'statsng',5);return loginPage('ng');}
  if(a==='csv'){
    try{return new Response('﻿'+await board(env).csv(),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="30dantobi_plays.csv"','cache-control':'no-store'}});}
    catch(e){return loginPage('switch');}
  }
  try{return await statsBody(env,k,a,id,ver);}catch(e){return loginPage('switch');}   // 公開し直した直後は、保存先だけ古い版のことがある
}
async function statsBody(env,k,a,id,ver){
  const b=board(env);let r='';
  if(a==='reset'){await b.resetStats();r='ok';}
  else if(a==='del'&&/^[0-9a-f]{8}$/.test(id))r=(await b.remove(id))?'del':'gone';
  const st=await b.stats(30),view=await b.view(),A=await b.analyze(ver);
  const hk=`<input type="hidden" name="k" value="${esc(k)}">`;
  const tr=st.days.map(x=>`<tr><td>${x.d}</td><td>${x.plays.toLocaleString()}</td><td>${x.players.toLocaleString()}</td></tr>`).join('');
  // ランキング：全期間と今日をまとめて1件ずつ、どこに載っているかを添える
  const seen=new Map();
  for(const w of ['all','day'])view[w].forEach((e,i)=>{const x=seen.get(e.id)||{e,tags:[]};x.tags.push((w==='all'?'全期間':'今日')+' '+(i+1)+'位');seen.set(e.id,x);});
  const rows=[...seen.values()].sort((x,y)=>y.e.s-x.e.s);
  const rk=rows.map(({e,tags})=>{const d=new Date(e.t+9*3600e3);return `<tr><td class="l">${esc(e.u||'ななし')}<small>PERFECT ${e.p}　JUST ${e.j}　${d.getUTCMonth()+1}/${d.getUTCDate()}　${esc(tags.join('・'))}</small></td><td>${fmtM(e.s)}</td>
<td><form method="post" action="/stats" onsubmit="return confirm('この記録をランキングから消します。よろしいですか？')">${hk}<input type="hidden" name="a" value="del"><input type="hidden" name="id" value="${esc(e.id)}"><button>消す</button></form></td></tr>`;}).join('');
  return page(`${msgHtml(r)}
<div class="t"><div>プレイ回数<b>${st.plays.toLocaleString()}</b></div><div>プレイした人<b>${st.players.toLocaleString()}</b></div><div>ランキングの人<b>${rows.length.toLocaleString()}</b></div></div>
<table><tr><th>日付（日本時間）</th><th>回数</th><th>新しい人</th></tr>${tr}</table>
<p><small>回数は、遊び終わった回（途中でやめた回も入る）。人数は「その端末で初めて遊んだ回」を数えたもの。ブラウザの記録を消すと、同じ人でも新しい人として数え直されます。</small></p>
<form class="k" method="post" action="/stats" onsubmit="return confirm('プレイ回数・人数・記録を0に戻します（ランキングは消えません）。よろしいですか？')">${hk}<input type="hidden" name="a" value="reset"><button>集計をリセット</button></form>
${analysisHtml(A,ver,hk)}
<h2>ランキングの記録（${rows.length}件）</h2>
<p><small>同じ人が別のブラウザ（X アプリの中など）から登録すると別人に見えます。重なっていたら古い方を消してください。</small></p>
<table>${rk||'<tr><td>まだ記録がありません</td></tr>'}</table>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="view"><button>最新にする</button></form>`);
}

// 結果の種類ごとのプレビューのページ（中身なし。OGP とタイトルだけ持ち、すぐゲームのトップへ移る）
function kindPage(origin,key){
  const t=KINDS[key]+'｜30だんとび',img=`${origin}/og/${OG_VER}/${key}.jpg`;
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${t}</title>
<meta property="og:type" content="website"><meta property="og:title" content="${t}"><meta property="og:description" content="${DESC}">
<meta property="og:url" content="${origin}/k/${key}"><meta property="og:image" content="${img}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><script>location.replace('/')</script></head><body><a href="/">30だんとび</a></body></html>`,
    {headers:{'content-type':'text/html; charset=utf-8','cache-control':'public, max-age=3600','x-robots-tag':'noindex'}});
}
// トップ：index.html の %ORIGIN% を公開先に置き換える（wrangler.jsonc の run_worker_first で、/ もここを通る）
async function top(req,env,origin){
  const r=await env.ASSETS.fetch(new Request(origin+'/',req));   // /index.html を頼むと / へ転送されるので / を読む
  if(!r.ok||!(r.headers.get('content-type')||'').includes('text/html'))return r;
  const h=new Headers(r.headers);h.delete('content-length');h.delete('etag');
  return new Response((await r.text()).replaceAll('%ORIGIN%',origin),{status:r.status,headers:h});
}

export default {
  async fetch(req,env){
    const url=new URL(req.url),p=url.pathname;
    if(p==='/api/rank')return rank(req,env);
    if(p==='/api/play')return play(req,env);
    if(p==='/stats')return stats(req,env);
    if(p==='/admin')return admin(req,env);
    const km=/^\/k\/([a-z]+)\/?$/.exec(p);
    if(km)return Object.hasOwn(KINDS,km[1])?kindPage(url.origin,km[1]):Response.redirect(url.origin+'/',302);
    if(p==='/')return top(req,env,url.origin);
    return env.ASSETS.fetch(req);
  }
};
