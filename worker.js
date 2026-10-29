// Higher Place Church Volunteer Tool: shared events, RSVPs, reminders, cloud backup. Cloudflare Workers + D1.
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json'}});
let ready;
const init=db=>ready||(ready=db.batch([
 'CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL,img TEXT,status TEXT,updated INTEGER)',
 'CREATE TABLE IF NOT EXISTS rsvps(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,name TEXT NOT NULL COLLATE NOCASE,resp TEXT NOT NULL,comment TEXT,act TEXT,t INTEGER,UNIQUE(event_id,name))',
 'CREATE TABLE IF NOT EXISTS notify(event_id TEXT PRIMARY KEY,emails TEXT)',
 'CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,owner TEXT NOT NULL,send_at INTEGER,subject TEXT,body TEXT,rcpt TEXT,ev TEXT,mode TEXT,sent INTEGER DEFAULT 0)',
 'CREATE TABLE IF NOT EXISTS vault(owner TEXT PRIMARY KEY,blob TEXT,updated INTEGER)',
 'CREATE TABLE IF NOT EXISTS hits(k TEXT PRIMARY KEY,n INTEGER)'].map(q=>db.prepare(q))));
const sha=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const clip=(v,n)=>String(v==null?'':v).slice(0,n);
const mailOn=e=>!!(e.BREVO_KEY&&e.MAIL_FROM);
async function mail(env,to,subject,text){if(!mailOn(env)||!to)return false;try{const r=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':env.BREVO_KEY,'content-type':'application/json'},body:JSON.stringify({sender:{email:env.MAIL_FROM,name:'Higher Place Church Volunteer Tool'},to:[{email:to}],subject:clip(subject,150),textContent:clip(text,4000)})});return r.ok}catch(e){return false}}
const pub=d=>({n:clip(d.n,120),d:clip(d.d,20),v:clip(d.v,160),ds:clip(d.ds,2000),rc:clip(d.rc,30),c:['event','project','activity'].includes(d.c)?d.c:'event',w:clip(d.w,25),st:['draft','published','cancelled','completed'].includes(d.st)?d.st:'draft',
 a:(Array.isArray(d.a)?d.a:[]).slice(0,60).map(a=>[clip(a[0],40),clip(a[1],120),clip(a[2],5),clip(a[3],5),clip(a[4],400),Math.max(0,Math.min(500,+a[5]||0)),clip(a[6],80),(Array.isArray(a[7])?a[7]:[]).slice(0,12).map(r=>[clip(r[0],20),clip(r[1],80),Math.max(1,Math.min(500,+r[2]||1))])])});
async function counts(db,ids){const o={};if(!ids.length)return o;const q=await db.prepare(`SELECT event_id e,act a,COUNT(*) c FROM rsvps WHERE resp='yes' AND event_id IN (${ids.map(()=>'?').join(',')}) GROUP BY event_id,act`).bind(...ids).all();q.results.forEach(r=>{(o[r.e]=o[r.e]||{})[r.a]=r.c});return o}
async function owner(req,db,id){const k=req.headers.get('x-key')||'';if(k.length<16)return false;const o=await db.prepare('SELECT owner FROM events WHERE id=?').bind(id).first();return !!o&&o.owner===await sha(k)}
async function runReminders(env){await init(env.DB);const db=env.DB,due=await db.prepare('SELECT * FROM reminders WHERE sent=0 AND send_at<=? LIMIT 10').bind(Date.now()).all();
 for(const r of due.results){let to=JSON.parse(r.rcpt||'[]');if(r.mode==='pending'&&r.ev){const d=await db.prepare('SELECT name FROM rsvps WHERE event_id=?').bind(r.ev).all(),s=new Set(d.results.map(x=>x.name.toLowerCase()));to=to.filter(p=>!s.has(String(p.n).toLowerCase()))}
  let ok=0;for(const p of to.slice(0,60)){if(await mail(env,p.e,r.subject,'Hi '+clip(p.n,40).split(' ')[0]+',\n\n'+r.body))ok++}
  if(ok||!to.length)await db.prepare('UPDATE reminders SET sent=1 WHERE id=?').bind(r.id).run()}}
export default{
 async scheduled(ev,env,ctx){ctx.waitUntil(runReminders(env))},
 async fetch(req,env,ctx){
 const u=new URL(req.url),p=u.pathname;
 if(!p.startsWith('/api/'))return env.ASSETS.fetch(req);
 if(!env.DB)return J({error:'no-db'},503);
 try{await init(env.DB);const db=env.DB,m=req.method,key=req.headers.get('x-key')||'';let x;
  if(p==='/api/status')return J({db:true,mail:mailOn(env)});
  if(p==='/api/events'&&m==='GET'){const r=await db.prepare("SELECT id,data,(img IS NOT NULL AND img!='') hi FROM events WHERE status IN ('published','completed') ORDER BY updated DESC LIMIT 100").all();const y=await counts(db,r.results.map(e=>e.id));return J(r.results.map(e=>({id:e.id,data:JSON.parse(e.data),hi:e.hi,y:y[e.id]||{}})))}
  if(p==='/api/events'&&m==='POST'){const b=await req.json();if(String(b.key||'').length<16||!b.data)return J({error:'bad'},400);const d=pub(b.data),k=await sha(b.key),now=Date.now(),hasImg=typeof b.img==='string'&&b.img.startsWith('data:image/jpeg;base64,')&&b.img.length<400000,em=(Array.isArray(b.notify)?b.notify:[]).filter(e=>/^\S+@\S+\.\S+$/.test(e)).slice(0,5);
   let id=b.id&&/^\w+$/.test(b.id)?b.id:'';if(id){const o=await db.prepare('SELECT owner FROM events WHERE id=?').bind(id).first();if(o&&o.owner!==k)return J({error:'forbidden'},403);if(o){await db.prepare('UPDATE events SET data=?,status=?,updated=? WHERE id=?').bind(JSON.stringify(d),d.st,now,id).run();if(hasImg||b.img==='')await db.prepare('UPDATE events SET img=? WHERE id=?').bind(hasImg?b.img:'',id).run()}else id=''}
   if(!id){id=crypto.randomUUID().replace(/-/g,'').slice(0,10);await db.prepare('INSERT INTO events(id,owner,data,img,status,updated) VALUES(?,?,?,?,?,?)').bind(id,k,JSON.stringify(d),hasImg?b.img:'',d.st,now).run()}
   await db.prepare('INSERT INTO notify(event_id,emails) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET emails=excluded.emails').bind(id,JSON.stringify(em)).run();return J({id})}
  if(p==='/api/mine'&&m==='GET'){const r=await db.prepare("SELECT id,(img IS NOT NULL AND img!='') hi FROM events WHERE owner=?").bind(await sha(key)).all();return J(r.results)}
  if(p==='/api/vault'&&key.length>=16){const k=await sha(key);if(m==='GET'){const r=await db.prepare('SELECT blob FROM vault WHERE owner=?').bind(k).first();return r?new Response(r.blob,{headers:{'content-type':'application/json'}}):J({error:'notfound'},404)}
   if(m==='PUT'){const t=await req.text();if(t.length>1500000)return J({error:'toobig'},413);await db.prepare('INSERT INTO vault(owner,blob,updated) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET blob=excluded.blob,updated=excluded.updated').bind(k,t,Date.now()).run();return J({ok:true})}}
  if(p==='/api/reminders'&&key.length>=16){const k=await sha(key);
   if(m==='GET'){const r=await db.prepare('SELECT id,sent FROM reminders WHERE owner=?').bind(k).all();return J(r.results)}
   if(m==='POST'){const b=await req.json(),id=clip(b.id,40);if(!/^\w+$/.test(id))return J({error:'bad'},400);const o=await db.prepare('SELECT owner FROM reminders WHERE id=?').bind(id).first();if(o&&o.owner!==k)return J({error:'forbidden'},403);
    if(b.del){await db.prepare('DELETE FROM reminders WHERE id=?').bind(id).run();return J({ok:true})}
    const at=Date.parse(b.at);if(!at)return J({error:'bad'},400);const rc=(Array.isArray(b.rcpt)?b.rcpt:[]).filter(e=>/^\S+@\S+\.\S+$/.test(e.e)).slice(0,100).map(e=>({n:clip(e.n,60),e:clip(e.e,120)}));
    await db.prepare('INSERT INTO reminders(id,owner,send_at,subject,body,rcpt,ev,mode,sent) VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET send_at=excluded.send_at,subject=excluded.subject,body=excluded.body,rcpt=excluded.rcpt,ev=excluded.ev,mode=excluded.mode').bind(id,k,at,clip(b.subject,150),clip(b.body,1500),JSON.stringify(rc),clip(b.ev,20),b.mode==='pending'?'pending':'all').run();return J({ok:true})}}
  if(x=p.match(/^\/api\/img\/(\w+)$/)){const r=await db.prepare('SELECT img FROM events WHERE id=?').bind(x[1]).first();if(!r||!r.img)return new Response('',{status:404});return new Response(Uint8Array.from(atob(r.img.split(',')[1]),c=>c.charCodeAt(0)),{headers:{'content-type':'image/jpeg','cache-control':'public,max-age=300'}})}
  if(x=p.match(/^\/api\/events\/(\w+)$/)){if(m!=='GET')return J({error:'method'},405);const r=await db.prepare("SELECT id,data,(img IS NOT NULL AND img!='') hi FROM events WHERE id=? AND status!='draft'").bind(x[1]).first();if(!r)return J({error:'notfound'},404);const y=await counts(db,[r.id]);return J({id:r.id,data:JSON.parse(r.data),hi:r.hi,y:y[r.id]||{}})}
  if(x=p.match(/^\/api\/events\/(\w+)\/rsvp$/)&&m==='POST'){const id=x[1],b=await req.json(),e=await db.prepare('SELECT data,status FROM events WHERE id=?').bind(id).first();
   if(!e||e.status!=='published')return J({error:'closed'},403);const d=JSON.parse(e.data);if(d.rc&&Date.now()>Date.parse(d.rc))return J({error:'deadline'},403);
   const n=clip(b.n,80).trim(),r=b.r==='yes'?'yes':b.r==='no'?'no':'';if(!n||!r)return J({error:'bad'},400);
   const hk=await sha((req.headers.get('cf-connecting-ip')||'')+Math.floor(Date.now()/3600000)),h=await db.prepare('INSERT INTO hits(k,n) VALUES(?,1) ON CONFLICT(k) DO UPDATE SET n=n+1 RETURNING n').bind(hk).first();if(h&&h.n>40)return J({error:'slow-down'},429);
   const c=await db.prepare('SELECT COUNT(*) c FROM rsvps WHERE event_id=?').bind(id).first();if(c.c>=1500)return J({error:'full'},429);const cm=clip(b.c,500);
   await db.prepare('INSERT INTO rsvps(event_id,name,resp,comment,act,t) VALUES(?,?,?,?,?,?) ON CONFLICT(event_id,name) DO UPDATE SET resp=excluded.resp,comment=excluded.comment,act=excluded.act,t=excluded.t').bind(id,n,r,cm,clip(b.a,40),Date.now()).run();
   const nt=await db.prepare('SELECT emails FROM notify WHERE event_id=?').bind(id).first();if(nt)ctx.waitUntil(Promise.all(JSON.parse(nt.emails).map(a=>mail(env,a,'RSVP: '+n+' says '+r.toUpperCase()+' for '+d.n,n+' says '+r.toUpperCase()+' for '+d.n+(cm?'\nComment: '+cm:'')))));return J({ok:true})}
  if(x=p.match(/^\/api\/events\/(\w+)\/rsvps$/)&&m==='GET'){if(!await owner(req,db,x[1]))return J({error:'forbidden'},403);const r=await db.prepare('SELECT id,name n,resp r,comment c,act a,t FROM rsvps WHERE event_id=? ORDER BY id').bind(x[1]).all();return J(r.results)}
  return J({error:'notfound'},404)
 }catch(e){return J({error:'server'},500)}}};
