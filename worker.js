const CLIENT_PREFIX = "client:";
const GLOBAL_MARKET_KEY = "global:market";
const KRAKEN_TICKER = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";
const KRAKEN_OHLC = "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=";
const DEFAULT_TFS = [5,15,60];

function json(data,status=200,headers={}){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"Content-Type":"application/json; charset=utf-8",...headers}
  });
}
function cors(env,req){
  const origin=req.headers.get("Origin")||"";
  const allowed=env.APP_ORIGIN||"https://rdwzfcckn5-hash.github.io";
  return {
    "Access-Control-Allow-Origin": origin===allowed?origin:allowed,
    "Vary":"Origin",
    "Access-Control-Allow-Headers":"Content-Type",
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS"
  };
}
function validClientId(v){
  return typeof v==="string" && /^[A-Za-z0-9._:-]{8,160}$/.test(v);
}
function n(v,fallback=0){
  const x=Number(v);return Number.isFinite(x)?x:fallback;
}
function alertBand(pct){
  if(!Number.isFinite(pct))return 0;
  return pct>=0?Math.floor(pct):Math.ceil(pct);
}
function fmt(v){
  return n(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function tfLabel(tf){ return Number(tf)===60?"1h":Number(tf)+"m"; }

function rma(values,p){
  const out=new Array(values.length).fill(null);
  let sum=0;
  for(let i=0;i<values.length;i++){
    sum+=values[i];
    if(i===p-1)out[i]=sum/p;
    else if(i>=p)out[i]=(out[i-1]*(p-1)+values[i])/p;
  }
  return out;
}
function trueRange(cs){
  return cs.map((c,i)=>{
    const prev=i?cs[i-1].close:c.open;
    return Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));
  });
}
function supertrendArrays(cs,p=10,mult=3){
  const atr=rma(trueRange(cs),p);
  const st=new Array(cs.length).fill(null),dir=new Array(cs.length).fill(0),fu=[],fl=[];
  for(let i=0;i<cs.length;i++){
    if(atr[i]===null){fu[i]=null;fl[i]=null;continue}
    const hl=(cs[i].high+cs[i].low)/2,bu=hl+mult*atr[i],bl=hl-mult*atr[i];
    if(i===0||fu[i-1]===null){
      fu[i]=bu;fl[i]=bl;st[i]=bu;dir[i]=-1;continue;
    }
    fu[i]=(bu<fu[i-1]||cs[i-1].close>fu[i-1])?bu:fu[i-1];
    fl[i]=(bl>fl[i-1]||cs[i-1].close<fl[i-1])?bl:fl[i-1];
    if(st[i-1]===fu[i-1]){
      if(cs[i].close>fu[i]){st[i]=fl[i];dir[i]=1}
      else{st[i]=fu[i];dir[i]=-1}
    }else{
      if(cs[i].close<fl[i]){st[i]=fu[i];dir[i]=-1}
      else{st[i]=fl[i];dir[i]=1}
    }
  }
  return {st,dir};
}

async function krakenTicker(){
  const r=await fetch(KRAKEN_TICKER,{cf:{cacheTtl:0}});
  if(!r.ok)throw new Error("Kraken ticker HTTP "+r.status);
  const j=await r.json();
  if(j.error?.length)throw new Error(j.error.join(", "));
  const key=Object.keys(j.result||{})[0];
  const obj=j.result?.[key];
  const price=n(obj?.c?.[0],NaN);
  if(!Number.isFinite(price))throw new Error("Kraken ticker price missing");
  return price;
}
async function krakenOhlc(tf){
  const r=await fetch(KRAKEN_OHLC+encodeURIComponent(tf),{cf:{cacheTtl:0}});
  if(!r.ok)throw new Error("Kraken OHLC HTTP "+r.status);
  const j=await r.json();
  if(j.error?.length)throw new Error(j.error.join(", "));
  const key=Object.keys(j.result||{}).find(k=>k!=="last");
  const rows=j.result?.[key]||[];
  return rows.map(x=>({
    time:n(x[0]),open:n(x[1]),high:n(x[2]),low:n(x[3]),close:n(x[4]),volume:n(x[6])
  })).filter(c=>c.time&&Number.isFinite(c.close));
}
function closedSupertrend(cs){
  if(!Array.isArray(cs)||cs.length<15)return null;
  const st=supertrendArrays(cs,10,3);
  const i=cs.length-2; // Kraken utolsó sora az aktuális, nyitott gyertya
  if(i<11)return null;
  const dir=n(st.dir[i]),prev=n(st.dir[i-1]);
  return {
    candleTime:n(cs[i].time),
    close:n(cs[i].close),
    dir,
    prev,
    changed:!!dir&&!!prev&&dir!==prev
  };
}
function positionGross(p,price){
  if(!p)return 0;
  const diff=p.side==="long"?price-n(p.entry):n(p.entry)-price;
  return diff*n(p.qty);
}
function getBarsAfterEntry(oneMin,entryTime){
  if(!Array.isArray(oneMin)||!oneMin.length)return [];
  const entryBucket=Math.floor(n(entryTime)/60000)*60000;
  return oneMin.slice(-4).filter(b=>b.time*1000>entryBucket);
}
function touchedPosition(p,price,oneMin){
  if(!p)return null;
  const safeBars=getBarsAfterEntry(oneMin,p.entryTime);
  const highs=safeBars.map(b=>b.high),lows=safeBars.map(b=>b.low);
  let tp=false,sl=false;
  if(p.side==="long"){
    tp=price>=n(p.tp)||highs.some(v=>v>=n(p.tp));
    sl=price<=n(p.sl)||lows.some(v=>v<=n(p.sl));
  }else{
    tp=price<=n(p.tp)||lows.some(v=>v<=n(p.tp));
    sl=price>=n(p.sl)||highs.some(v=>v>=n(p.sl));
  }
  if(tp&&sl)return "AMBIGUOUS";
  if(tp)return "TP";
  if(sl)return "SL";
  return null;
}
async function sendPush(env,externalId,title,body,data={}){
  if(!env.ONESIGNAL_APP_ID||!env.ONESIGNAL_API_KEY)return {ok:false,skipped:"OneSignal env missing"};
  const payload={
    app_id:env.ONESIGNAL_APP_ID,
    target_channel:"push",
    include_aliases:{external_id:[externalId]},
    headings:{en:title},
    contents:{en:body},
    custom_data:data
  };
  const r=await fetch("https://api.onesignal.com/notifications?c=push",{
    method:"POST",
    headers:{
      "Authorization":"Key "+env.ONESIGNAL_API_KEY,
      "Content-Type":"application/json"
    },
    body:JSON.stringify(payload)
  });
  const text=await r.text();
  if(!r.ok)throw new Error("OneSignal "+r.status+" "+text);
  return {ok:true,response:text};
}
async function maybePush(env,client,title,body,type,meta={}){
  await sendPush(env,client.clientId,title,body,{type,...meta});
}

async function loadClients(env){
  const all=[];
  let cursor=undefined;
  do{
    const page=await env.BOTI_STATE.list({prefix:CLIENT_PREFIX,cursor,limit:1000});
    for(const k of page.keys){
      const v=await env.BOTI_STATE.get(k.name,"json");
      if(v)all.push(v);
    }
    cursor=page.list_complete?undefined:page.cursor;
  }while(cursor);
  return all;
}

async function monitor(env){
  const clients=await loadClients(env);
  if(!clients.length)return {clients:0,pushes:0};

  const tfSet=new Set([1]);
  for(const c of clients){
    const a=c.alerts||{};
    if(a.supertrend){
      const tfs=Array.isArray(a.supertrendTFs)&&a.supertrendTFs.length?a.supertrendTFs:DEFAULT_TFS;
      tfs.forEach(tf=>[1,5,15,60].includes(Number(tf))&&tfSet.add(Number(tf)));
    }
  }

  const tfs=[...tfSet].sort((a,b)=>a-b);
  const [price,...ohlcResults]=await Promise.all([
    krakenTicker(),
    ...tfs.map(tf=>krakenOhlc(tf))
  ]);
  const ohlc={};
  tfs.forEach((tf,i)=>ohlc[tf]=ohlcResults[i]);
  const st={};
  for(const tf of tfs)st[tf]=closedSupertrend(ohlc[tf]);

  let pushes=0;
  for(const client of clients){
    try{
      if(Date.now()-n(client.updatedAt)>14*86400000)continue;
      client.monitor=client.monitor||{};
      client.monitor.stSeen=client.monitor.stSeen||{};
      const a=client.alerts||{};
      const state=client.state||{};
      const p=state.position||null;

      // Supertrend: only confirmed closed candles; first pass primes baseline.
      if(a.supertrend){
        const wanted=Array.isArray(a.supertrendTFs)&&a.supertrendTFs.length?a.supertrendTFs:DEFAULT_TFS;
        for(const rawTf of wanted){
          const tf=Number(rawTf),sig=st[tf];
          if(!sig)continue;
          const seen=n(client.monitor.stSeen[String(tf)]);
          if(!seen){
            client.monitor.stSeen[String(tf)]=sig.candleTime;
          }else if(sig.candleTime>seen){
            client.monitor.stSeen[String(tf)]=sig.candleTime;
            if(sig.changed){
              const bull=sig.dir>0;
              await maybePush(
                env,client,
                bull?"SUPERTREND BULLISH":"SUPERTREND BEARISH",
                `BTC/USD · ${tfLabel(tf)} · lezárt gyertya $${fmt(sig.close)} · ST 10/3`,
                "supertrend",{tf,dir:sig.dir,price:sig.close,candleTime:sig.candleTime}
              );
              pushes++;
            }
          }
        }
      }

      // TP / SL: server-side monitoring while the PWA is suspended/closed.
      if(p){
        const touch=touchedPosition(p,price,ohlc[1]);
        if(touch && !client.monitor.positionAlertSent){
          if(touch==="TP" && a.tp){
            await maybePush(env,client,"TP ELÉRVE",
              `${String(p.side).toUpperCase()} · BTC/USD · TP $${fmt(p.tp)} · current $${fmt(price)}`,
              "tp",{price,tp:n(p.tp)});
            pushes++;
            client.monitor.positionAlertSent="TP";
          }else if(touch==="SL" && a.sl){
            await maybePush(env,client,"SL ELÉRVE",
              `${String(p.side).toUpperCase()} · BTC/USD · SL $${fmt(p.sl)} · current $${fmt(price)}`,
              "sl",{price,sl:n(p.sl)});
            pushes++;
            client.monitor.positionAlertSent="SL";
          }else if(touch==="AMBIGUOUS" && (a.tp||a.sl)){
            await maybePush(env,client,"TP / SL ÉRINTÉS",
              `Ugyanabban az 1m gyertyában mindkét szint érintett lehetett. BTC $${fmt(price)} · appban ellenőrizd.`,
              "tp_sl_ambiguous",{price});
            pushes++;
            client.monitor.positionAlertSent="AMBIGUOUS";
          }
        }
      }else{
        client.monitor.positionAlertSent=null;
      }

      // Live equity / daily thresholds. Open fee is already reflected in app equity/daily.
      const gross=p?positionGross(p,price):0;
      const funding=p?n(p.fundingAccrued):0;
      const startEq=n(state.startEquity);
      if(startEq>0){
        const liveEq=n(state.equity)+gross+funding;
        const liveDaily=n(state.daily)+gross+funding;
        const eqBand=alertBand((liveEq-startEq)/startEq*100);
        const dayBand=alertBand(liveDaily/startEq*100);

        if(client.monitor.eqBand===undefined)client.monitor.eqBand=eqBand;
        if(client.monitor.dayBand===undefined)client.monitor.dayBand=dayBand;

        if(a.equity && Math.abs(eqBand)>=1 && eqBand!==client.monitor.eqBand){
          await maybePush(env,client,
            `TOTAL EQUITY ${eqBand>0?"+":""}${eqBand}%`,
            `$${fmt(liveEq)} · ${fmt(startEq)} profil`,
            "equity",{band:eqBand,equity:liveEq});
          pushes++;
        }
        if(a.daily && Math.abs(dayBand)>=1 && dayBand!==client.monitor.dayBand){
          await maybePush(env,client,
            `DAILY PNL ${dayBand>0?"+":""}${dayBand}%`,
            `${liveDaily>=0?"+":"-"}$${fmt(Math.abs(liveDaily))} · daily loss limit -3%`,
            "daily",{band:dayBand,daily:liveDaily});
          pushes++;
        }
        client.monitor.eqBand=eqBand;
        client.monitor.dayBand=dayBand;
      }

      client.monitor.lastPrice=price;
      client.monitor.lastRun=Date.now();
      await env.BOTI_STATE.put(CLIENT_PREFIX+client.clientId,JSON.stringify(client));
    }catch(err){
      console.error("client monitor",client?.clientId,err);
    }
  }

  await env.BOTI_STATE.put(GLOBAL_MARKET_KEY,JSON.stringify({
    price,tfs,updatedAt:Date.now()
  }),{expirationTtl:86400});

  return {clients:clients.length,pushes,price,tfs};
}

async function handleFetch(req,env){
  const url=new URL(req.url);
  const headers=cors(env,req);
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers});

  if(url.pathname==="/health"){
    const market=await env.BOTI_STATE.get(GLOBAL_MARKET_KEY,"json");
    return json({ok:true,service:"boti-trader-push",market,now:Date.now()},200,headers);
  }

  if(url.pathname==="/sync" && req.method==="POST"){
    const body=await req.json();
    if(!validClientId(body.clientId))return json({ok:false,error:"invalid clientId"},400,headers);
    const state=body.state||{},alerts=body.alerts||{};
    if(![5000,10000,25000,50000,100000,200000].includes(n(state.startEquity))){
      return json({ok:false,error:"invalid profile"},400,headers);
    }
    const key=CLIENT_PREFIX+body.clientId;
    const old=await env.BOTI_STATE.get(key,"json");
    const client={
      clientId:body.clientId,
      appVersion:String(body.appVersion||""),
      state,
      alerts:{
        supertrend:alerts.supertrend!==false,
        supertrendTFs:Array.isArray(alerts.supertrendTFs)?alerts.supertrendTFs.filter(x=>[1,5,15,60].includes(Number(x))).map(Number):DEFAULT_TFS,
        tp:alerts.tp!==false,
        sl:alerts.sl!==false,
        equity:alerts.equity!==false,
        daily:alerts.daily!==false
      },
      monitor:old?.monitor||{},
      updatedAt:Date.now()
    };
    // New position resets one-shot TP/SL monitor.
    const oldEntry=n(old?.state?.position?.entryTime);
    const newEntry=n(state?.position?.entryTime);
    if(newEntry && newEntry!==oldEntry)client.monitor.positionAlertSent=null;
    if(!state.position)client.monitor.positionAlertSent=null;

    await env.BOTI_STATE.put(key,JSON.stringify(client));
    return json({ok:true,serverTime:Date.now(),clientId:body.clientId},200,headers);
  }

  if(url.pathname==="/test-push" && req.method==="POST"){
    const body=await req.json();
    if(!validClientId(body.clientId))return json({ok:false,error:"invalid clientId"},400,headers);
    const key=CLIENT_PREFIX+body.clientId;
    const client=await env.BOTI_STATE.get(key,"json");
    if(!client)return json({ok:false,error:"client not synced"},404,headers);
    const now=Date.now();
    if(now-n(client.monitor?.lastTestPush)<30000)return json({ok:false,error:"test push rate limited"},429,headers);
    client.monitor=client.monitor||{};
    client.monitor.lastTestPush=now;
    await env.BOTI_STATE.put(key,JSON.stringify(client));
    await sendPush(env,body.clientId,"Boti Trader PUSH teszt","A háttér PUSH kapcsolat működik. ✅",{type:"test"});
    return json({ok:true,serverTime:now},200,headers);
  }

  if(url.pathname==="/run-now" && req.method==="POST"){
    // Dashboard/debug route. Protect it with RUN_TOKEN.
    if(!env.RUN_TOKEN || req.headers.get("Authorization")!=="Bearer "+env.RUN_TOKEN){
      return json({ok:false,error:"unauthorized"},401,headers);
    }
    const result=await monitor(env);
    return json({ok:true,...result},200,headers);
  }

  return json({ok:false,error:"not found"},404,headers);
}

export default {
  async fetch(req,env,ctx){
    try{return await handleFetch(req,env)}
    catch(err){
      console.error(err);
      return json({ok:false,error:String(err&&err.message||err)},500,cors(env,req));
    }
  },
  async scheduled(controller,env,ctx){
    ctx.waitUntil(monitor(env));
  }
};
