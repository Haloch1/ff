(function(){
'use strict';

var KEY='chartcraft-live-market-v1';
var CACHE_KEY='chartcraft-market-cache-v1';
var DEFAULT_BALANCE=10000;
var AUTO_MS=30000;
var QUOTE_TTL=12000;
var MANUAL_COOLDOWN=5000;
var REQUEST_TIMEOUT=5500;

var ASSETS={
 BTC:{name:'Bitcoin',coinbase:'BTC-USD',kraken:'XBTUSD',binance:'BTCUSDT'},
 ETH:{name:'Ethereum',coinbase:'ETH-USD',kraken:'ETHUSD',binance:'ETHUSDT'},
 SOL:{name:'Solana',coinbase:'SOL-USD',kraken:'SOLUSD',binance:'SOLUSDT'},
 DOGE:{name:'Dogecoin',coinbase:'DOGE-USD',kraken:'XDGUSD',binance:'DOGEUSDT'},
 XRP:{name:'XRP',coinbase:'XRP-USD',kraken:'XRPUSD',binance:'XRPUSDT'},
 ADA:{name:'Cardano',coinbase:'ADA-USD',kraken:'ADAUSD',binance:'ADAUSDT'},
 AVAX:{name:'Avalanche',coinbase:'AVAX-USD',kraken:'AVAXUSD',binance:'AVAXUSDT'},
 LINK:{name:'Chainlink',coinbase:'LINK-USD',kraken:'LINKUSD',binance:'LINKUSDT'},
 LTC:{name:'Litecoin',coinbase:'LTC-USD',kraken:'LTCUSD',binance:'LTCUSDT'},
 BCH:{name:'Bitcoin Cash',coinbase:'BCH-USD',kraken:'BCHUSD',binance:'BCHUSDT'}
};

var PROVIDERS=[
 {id:'coinbase',name:'Coinbase Exchange'},
 {id:'kraken',name:'Kraken'},
 {id:'binance',name:'Binance public data'},
 {id:'coinlore',name:'CoinLore'}
];

var state=load();
var quoteCache={};
var candleCache={};
var providerHealth={};
var autoTimer=null;
var lastManual=0;
var activeSymbol=state.symbol||'BTC';

function now(){return Date.now();}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function money(n,d){d=d==null?2:d;return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:d,maximumFractionDigits:d}).format(Number(n)||0);}
function num(n,d){d=d==null?6:d;return Number(n||0).toLocaleString('en-US',{maximumFractionDigits:d});}
function uid(){return Math.random().toString(36).slice(2,9)+Date.now().toString(36);}
function load(){
 try{
  var x=JSON.parse(localStorage.getItem(KEY)||'null');
  if(x&&typeof x==='object')return normalize(x);
 }catch(e){}
 return normalize({});
}
function normalize(x){
 var out={
  initial:Number(x.initial)>0?Number(x.initial):DEFAULT_BALANCE,
  cash:Number.isFinite(Number(x.cash))?Number(x.cash):DEFAULT_BALANCE,
  symbol:ASSETS[x.symbol]?x.symbol:'BTC',
  holdings:x.holdings&&typeof x.holdings==='object'?x.holdings:{},
  trades:Array.isArray(x.trades)?x.trades:[],
  watch:Array.isArray(x.watch)?x.watch.filter(function(s){return ASSETS[s];}):['BTC','ETH','SOL','DOGE','XRP'],
  settings:{
   feeBps:x.settings&&Number.isFinite(Number(x.settings.feeBps))?Math.max(0,Math.min(100,Number(x.settings.feeBps))):10,
   slipBps:x.settings&&Number.isFinite(Number(x.settings.slipBps))?Math.max(0,Math.min(100,Number(x.settings.slipBps))):5
  },
  edited:!!x.edited
 };
 Object.keys(ASSETS).forEach(function(s){
  var h=x.holdings&&x.holdings[s]||{};
  out.holdings[s]={qty:Math.max(0,Number(h.qty)||0),cost:Math.max(0,Number(h.cost)||0)};
 });
 return out;
}
function save(){
 state.symbol=activeSymbol;
 try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){}
}
function providerStatus(id){
 if(!providerHealth[id])providerHealth[id]={fail:0,cooldown:0,lastError:''};
 return providerHealth[id];
}
function timeoutFetch(url,opts){
 var ctl=new AbortController(),timer=setTimeout(function(){ctl.abort();},REQUEST_TIMEOUT);
 var o=Object.assign({},opts||{},{signal:ctl.signal,cache:'no-store'});
 return fetch(url,o).then(function(r){
  clearTimeout(timer);
  if(!r.ok){var err=new Error('HTTP '+r.status);err.status=r.status;throw err;}
  return r.json();
 }).catch(function(e){clearTimeout(timer);throw e;});
}
function markSuccess(id){var h=providerStatus(id);h.fail=0;h.cooldown=0;h.lastError='';}
function markFail(id,e){
 var h=providerStatus(id);h.fail++;
 h.lastError=(e&&e.message)||'Request failed';
 var wait=(e&&e.status===429)?120000:Math.min(90000,15000*h.fail);
 h.cooldown=now()+wait;
}
function providerOrder(){
 var shift=Math.floor(now()/60000)%PROVIDERS.length;
 return PROVIDERS.slice(shift).concat(PROVIDERS.slice(0,shift));
}
function validPrice(p){p=Number(p);return Number.isFinite(p)&&p>0?p:null;}

function qCoinbase(s){
 var a=ASSETS[s];
 return timeoutFetch('https://api.exchange.coinbase.com/products/'+a.coinbase+'/ticker').then(function(j){
  var p=validPrice(j.price);if(!p)throw Error('No Coinbase price');
  return {price:p,bid:validPrice(j.bid),ask:validPrice(j.ask),source:'coinbase',sourceName:'Coinbase Exchange',time:now(),change24:null};
 });
}
function qKraken(s){
 var a=ASSETS[s];
 return timeoutFetch('https://api.kraken.com/0/public/Ticker?pair='+encodeURIComponent(a.kraken)).then(function(j){
  if(j.error&&j.error.length)throw Error(j.error.join(', '));
  var k=Object.keys(j.result||{})[0],v=k&&j.result[k];
  var p=v&&validPrice(v.c&&v.c[0]);if(!p)throw Error('No Kraken price');
  var open=v&&validPrice(v.o),chg=open?((p-open)/open*100):null;
  return {price:p,bid:validPrice(v.b&&v.b[0]),ask:validPrice(v.a&&v.a[0]),source:'kraken',sourceName:'Kraken',time:now(),change24:chg};
 });
}
function qBinance(s){
 var a=ASSETS[s];
 return timeoutFetch('https://data-api.binance.vision/api/v3/ticker/24hr?symbol='+encodeURIComponent(a.binance)).then(function(j){
  var p=validPrice(j.lastPrice);if(!p)throw Error('No Binance price');
  return {price:p,bid:validPrice(j.bidPrice),ask:validPrice(j.askPrice),source:'binance',sourceName:'Binance public data',time:now(),change24:Number.isFinite(Number(j.priceChangePercent))?Number(j.priceChangePercent):null,note:'USDT quote used as USD proxy'};
 });
}
function qCoinLore(s){
 return timeoutFetch('https://api.coinlore.net/api/tickers/?start=0&limit=100').then(function(j){
  var row=(j.data||[]).find(function(x){return String(x.symbol).toUpperCase()===s;});
  var p=row&&validPrice(row.price_usd);if(!p)throw Error('Asset not in CoinLore top 100');
  return {price:p,bid:null,ask:null,source:'coinlore',sourceName:'CoinLore',time:now(),change24:Number.isFinite(Number(row.percent_change_24h))?Number(row.percent_change_24h):null};
 });
}
function providerQuote(id,s){
 if(id==='coinbase')return qCoinbase(s);
 if(id==='kraken')return qKraken(s);
 if(id==='binance')return qBinance(s);
 return qCoinLore(s);
}
function getQuote(s,force){
 var c=quoteCache[s];
 if(!force&&c&&now()-c.time<QUOTE_TTL)return Promise.resolve(c);
 var list=providerOrder(),idx=0,errors=[];
 function next(){
  if(idx>=list.length){
   if(c){var stale=Object.assign({},c,{stale:true,errors:errors});return Promise.resolve(stale);}
   return Promise.reject(Error('Every live-price provider failed. '+errors.join(' · ')));
  }
  var p=list[idx++],h=providerStatus(p.id);
  if(h.cooldown>now()){errors.push(p.name+' cooling down');return next();}
  return providerQuote(p.id,s).then(function(q){
   markSuccess(p.id);q.stale=false;quoteCache[s]=q;cacheSnapshot(s,q);return q;
  }).catch(function(e){markFail(p.id,e);errors.push(p.name+': '+e.message);return next();});
 }
 return next();
}
function cacheSnapshot(s,q){
 try{
  var all=JSON.parse(localStorage.getItem(CACHE_KEY)||'{}');
  if(!Array.isArray(all[s]))all[s]=[];
  all[s].push({t:q.time,p:q.price});
  all[s]=all[s].slice(-180);
  localStorage.setItem(CACHE_KEY,JSON.stringify(all));
 }catch(e){}
}

function cCoinbase(s){
 var a=ASSETS[s],end=new Date(),start=new Date(end.getTime()-5*60*1000*120);
 var u='https://api.exchange.coinbase.com/products/'+a.coinbase+'/candles?granularity=300&start='+encodeURIComponent(start.toISOString())+'&end='+encodeURIComponent(end.toISOString());
 return timeoutFetch(u).then(function(j){
  if(!Array.isArray(j)||!j.length)throw Error('No Coinbase candles');
  return {sourceName:'Coinbase Exchange',bars:j.map(function(x){return {t:x[0]*1000,l:+x[1],h:+x[2],o:+x[3],c:+x[4],v:+x[5]};}).sort(function(a,b){return a.t-b.t;})};
 });
}
function cKraken(s){
 var a=ASSETS[s];
 return timeoutFetch('https://api.kraken.com/0/public/OHLC?pair='+encodeURIComponent(a.kraken)+'&interval=5').then(function(j){
  if(j.error&&j.error.length)throw Error(j.error.join(', '));
  var k=Object.keys(j.result||{}).find(function(x){return x!=='last';}),rows=k&&j.result[k];
  if(!rows||!rows.length)throw Error('No Kraken candles');
  return {sourceName:'Kraken',bars:rows.slice(-120).map(function(x){return {t:+x[0]*1000,o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[6]};})};
 });
}
function cBinance(s){
 var a=ASSETS[s];
 return timeoutFetch('https://data-api.binance.vision/api/v3/klines?symbol='+encodeURIComponent(a.binance)+'&interval=5m&limit=120').then(function(j){
  if(!Array.isArray(j)||!j.length)throw Error('No Binance candles');
  return {sourceName:'Binance public data',bars:j.map(function(x){return {t:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]};})};
 });
}
function getCandles(s,force){
 var c=candleCache[s];
 if(!force&&c&&now()-c.time<60000)return Promise.resolve(c);
 var ids=['coinbase','kraken','binance'],shift=Math.floor(now()/60000)%ids.length,order=ids.slice(shift).concat(ids.slice(0,shift)),idx=0;
 function next(){
  if(idx>=order.length){
   if(c)return Promise.resolve(c);
   return Promise.reject(Error('Live candles are temporarily unavailable.'));
  }
  var id=order[idx++],h=providerStatus(id);
  if(h.cooldown>now())return next();
  var fn=id==='coinbase'?cCoinbase:id==='kraken'?cKraken:cBinance;
  return fn(s).then(function(x){markSuccess(id);x.time=now();candleCache[s]=x;return x;}).catch(function(e){markFail(id,e);return next();});
 }
 return next();
}

function fee(amount){return amount*state.settings.feeBps/10000;}
function holding(s){return state.holdings[s]||{qty:0,cost:0};}
function totalCostBasis(h){return h.cost||0;}
function portfolioValue(prices){
 var v=state.cash;
 Object.keys(ASSETS).forEach(function(s){var h=holding(s);if(h.qty&&prices[s])v+=h.qty*prices[s];});
 return v;
}
function trade(side,s,qty,q){
 qty=Number(qty);
 if(!Number.isFinite(qty)||qty<=0)throw Error('Enter a quantity above zero.');
 var px=q.price*(1+(side==='buy'?1:-1)*state.settings.slipBps/10000);
 var amount=qty*px,f=fee(amount),h=holding(s);
 if(side==='buy'){
  if(amount+f>state.cash+1e-9)throw Error('Not enough virtual cash.');
  state.cash-=amount+f;h.qty+=qty;h.cost+=amount+f;
 }else{
  if(qty>h.qty+1e-10)throw Error('You cannot sell more than you own.');
  var ratio=qty/h.qty,costRemoved=h.cost*ratio;
  state.cash+=amount-f;h.qty-=qty;h.cost-=costRemoved;
  if(h.qty<1e-10){h.qty=0;h.cost=0;}
 }
 state.holdings[s]=h;
 state.trades.push({id:uid(),side:side,symbol:s,qty:qty,price:px,fee:f,time:now(),provider:q.sourceName,voided:false});
 save();
}
function rebuildWithout(id){
 var trades=state.trades.map(function(t){return Object.assign({},t,{voided:t.id===id?true:!!t.voided});});
 var cash=state.initial,hold={};Object.keys(ASSETS).forEach(function(s){hold[s]={qty:0,cost:0};});
 for(var i=0;i<trades.length;i++){
  var t=trades[i];if(t.voided)continue;
  var h=hold[t.symbol],amount=t.qty*t.price;
  if(t.side==='buy'){if(amount+t.fee>cash+1e-6)throw Error('Deleting that fill would make a later buy impossible.');cash-=amount+t.fee;h.qty+=t.qty;h.cost+=amount+t.fee;}
  else{if(t.qty>h.qty+1e-8)throw Error('Deleting that fill would make a later sale exceed holdings.');var r=t.qty/h.qty,removed=h.cost*r;cash+=amount-t.fee;h.qty-=t.qty;h.cost-=removed;if(h.qty<1e-10){h.qty=0;h.cost=0;}}
 }
 state.cash=cash;state.holdings=hold;state.trades=trades;state.edited=true;save();
}
function reset(){
 state=normalize({initial:DEFAULT_BALANCE,cash:DEFAULT_BALANCE,symbol:activeSymbol,watch:state.watch,settings:state.settings});
 save();
}

function style(){
 if(document.getElementById('market-style'))return;
 var s=document.createElement('style');s.id='market-style';
 s.textContent=
 '.market-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,.75fr);gap:18px;align-items:start}'+
 '.market-tape{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:16px 0 22px}'+
 '.market-coin{border:1px solid var(--line);background:var(--panel);border-radius:14px;padding:13px;text-align:left;color:var(--text);min-width:0}'+
 '.market-coin.active{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}'+
 '.market-coin b,.market-coin span{display:block}.market-coin span{font-size:11px;color:var(--muted)}'+
 '.market-chart{width:100%;height:370px;display:block;border-radius:14px;background:var(--bg)}'+
 '.market-status{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}'+
 '.market-provider-list{display:grid;gap:8px}.market-provider{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12px}'+
 '.market-ticket{position:sticky;top:95px}.market-ticket .field{margin:13px 0}'+
 '.market-table{width:100%;border-collapse:collapse;font-size:12px}.market-table th,.market-table td{padding:11px 8px;border-bottom:1px solid var(--line);text-align:right}.market-table th:first-child,.market-table td:first-child{text-align:left}'+
 '.market-ledger{overflow:auto}.market-live-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block;margin-right:6px;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent)}'+
 '@media(max-width:900px){.market-grid{grid-template-columns:1fr}.market-ticket{position:static}.market-tape{grid-template-columns:repeat(3,minmax(0,1fr))}}'+
 '@media(max-width:600px){.market-tape{grid-template-columns:repeat(2,minmax(0,1fr))}.market-chart{height:285px}.market-table{min-width:650px}}';
 document.head.appendChild(s);
}

function view(){
 return '<div id="market-root">'+
  '<div class="page-head"><div><div class="eyebrow">CHARTCRAFT / LIVE MARKET LAB</div><h1>Real prices. Virtual money.</h1><p class="sub">Paper-trade spot crypto against public market data. Your cash is fictional; the quotes and candles come from outside providers.</p></div><span class="badge green"><span class="market-live-dot"></span> MARKET DATA</span></div>'+
  '<div class="callout warn"><strong>This does not place real orders.</strong> It never connects to a wallet, exchange account, bank, or brokerage. Public feeds can be delayed, stale, unavailable, or disagree with each other. Do not use this simulator as an execution price or a promise of profit.</div>'+
  '<div id="market-body"><div class="card"><p class="muted">Loading the live-market workspace…</p></div></div>'+
 '</div>';
}

function tapeHTML(){
 return '<div class="market-tape">'+state.watch.map(function(s){
  var q=quoteCache[s],p=q?money(q.price,q.price<1?4:2):'—',chg=q&&q.change24!=null?((q.change24>=0?'+':'')+q.change24.toFixed(2)+'%'):'';
  return '<button class="market-coin '+(s===activeSymbol?'active':'')+'" data-market-symbol="'+s+'"><span>'+s+' · '+esc(ASSETS[s].name)+'</span><b>'+p+'</b><small class="'+(q&&q.change24<0?'negative':'positive')+'">'+chg+'</small></button>';
 }).join('')+'</div>';
}
function providersHTML(){
 return PROVIDERS.map(function(p){
  var h=providerStatus(p.id),cool=h.cooldown>now(),txt=cool?'Cooling down':h.fail?'Fallback ready':'Ready';
  return '<div class="market-provider"><span>'+esc(p.name)+'</span><span class="'+(cool?'negative':'muted')+'">'+txt+'</span></div>';
 }).join('');
}
function positionRows(){
 var rows=Object.keys(ASSETS).filter(function(s){return holding(s).qty>0;}).map(function(s){
  var h=holding(s),q=quoteCache[s],mv=q?h.qty*q.price:null,avg=h.qty?h.cost/h.qty:0,pnlv=mv==null?null:mv-h.cost;
  return '<tr><td><strong>'+s+'</strong><br><span class="muted">'+esc(ASSETS[s].name)+'</span></td><td>'+num(h.qty,8)+'</td><td>'+money(avg,4)+'</td><td>'+(mv==null?'—':money(mv))+'</td><td class="'+(pnlv!=null&&pnlv<0?'negative':'positive')+'">'+(pnlv==null?'—':money(pnlv))+'</td></tr>';
 }).join('');
 return rows||'<tr><td colspan="5" class="muted">No live-market paper positions yet.</td></tr>';
}
function historyRows(){
 var rows=state.trades.slice().reverse().map(function(t){
  return '<tr style="'+(t.voided?'opacity:.45;text-decoration:line-through':'')+'"><td>'+new Date(t.time).toLocaleString()+'</td><td>'+t.side.toUpperCase()+' '+t.symbol+'</td><td>'+num(t.qty,8)+'</td><td>'+money(t.price,4)+'</td><td>'+money(t.fee,4)+'</td><td>'+esc(t.provider||'')+'</td><td>'+(t.voided?'Voided':'<button class="btn compact danger" data-market-void="'+t.id+'">Void</button>')+'</td></tr>';
 }).join('');
 return rows||'<tr><td colspan="7" class="muted">No fills yet.</td></tr>';
}
function bodyHTML(q){
 var openValue=0;Object.keys(ASSETS).forEach(function(s){var h=holding(s);if(h.qty&&quoteCache[s])openValue+=h.qty*quoteCache[s].price;});
 var equity=state.cash+openValue,h=holding(activeSymbol),age=q?Math.max(0,Math.floor((now()-q.time)/1000)):null;
 return tapeHTML()+
 '<div class="stats"><div class="stat"><span>Virtual equity</span><strong>'+money(equity)+'</strong><div class="stat-note">'+(state.edited?'Edited history':'Live-price paper account')+'</div></div><div class="stat"><span>Cash</span><strong>'+money(state.cash)+'</strong><div class="stat-note">Never leaves this browser</div></div><div class="stat"><span>'+activeSymbol+' held</span><strong>'+num(h.qty,8)+'</strong><div class="stat-note">Long-only · no leverage</div></div><div class="stat"><span>Current quote</span><strong>'+(q?money(q.price,q.price<1?4:2):'—')+'</strong><div class="stat-note">'+(q?esc(q.sourceName)+' · '+age+'s old':'Waiting for feed')+'</div></div></div>'+
 '<div class="market-grid topgap"><div>'+
  '<div class="card"><div class="spread"><div><span class="eyebrow">'+activeSymbol+' / USD · 5 MINUTE</span><h2 id="market-price">'+(q?money(q.price,q.price<1?4:2):'Loading…')+'</h2></div><div class="actions"><span id="market-source" class="badge">'+(q?esc(q.sourceName):'Connecting…')+'</span><button class="btn compact" id="market-refresh">Refresh</button></div></div>'+
  '<div class="market-status"><span class="badge">'+(q&&q.bid?'Bid '+money(q.bid,4):'Bid unavailable')+'</span><span class="badge">'+(q&&q.ask?'Ask '+money(q.ask,4):'Ask unavailable')+'</span>'+(q&&q.note?'<span class="badge warn">'+esc(q.note)+'</span>':'')+'</div>'+
  '<canvas id="market-chart" class="market-chart" aria-label="Live five-minute candlestick chart"></canvas><div id="market-chart-note" class="muted small">Loading live candles…</div>'+
  '</div>'+
  '<div class="section-title"><h2>Positions</h2><span class="muted">Marked to the latest fetched quote</span></div><div class="card market-ledger"><table class="market-table"><thead><tr><th>Asset</th><th>Qty</th><th>Avg cost</th><th>Market value</th><th>Unrealized</th></tr></thead><tbody>'+positionRows()+'</tbody></table></div>'+
 '</div>'+
 '<aside class="market-ticket"><div class="card"><span class="eyebrow">LIVE-PRICE PAPER TICKET</span><h2>'+activeSymbol+'</h2><p class="muted">Market orders are simulated at the latest fetched reference price plus your paper slippage assumption.</p><label class="field"><span>Side</span><select id="market-side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label><label class="field"><span>Quantity</span><input id="market-qty" type="number" inputmode="decimal" min="0.00000001" step="any" value="0.01"></label><div id="market-preview" class="callout">Enter a quantity to preview the virtual fill.</div><button id="market-submit" class="btn primary wide">Place virtual market order</button><div class="rule"></div><label class="field"><span>Paper fee (basis points)</span><input id="market-fee" type="number" min="0" max="100" step="1" value="'+state.settings.feeBps+'"></label><label class="field"><span>Paper slippage (basis points)</span><input id="market-slip" type="number" min="0" max="100" step="1" value="'+state.settings.slipBps+'"></label><p class="muted small">1 bp = 0.01%. These are simulation assumptions, not the fee schedule of any exchange.</p></div>'+
  '<div class="card topgap"><span class="eyebrow">DATA FALLBACK</span><h3>Multiple public feeds</h3><div class="market-provider-list">'+providersHTML()+'</div><p class="muted small topgap">The app caches quotes, rotates providers, and temporarily cools down a provider after errors or rate limits.</p></div>'+
 '</aside></div>'+
 '<div class="section-title"><h2>Live-price paper history</h2><div class="actions"><button class="btn compact" id="market-reset">Reset account</button></div></div><div class="card market-ledger"><table class="market-table"><thead><tr><th>Time</th><th>Fill</th><th>Qty</th><th>Price</th><th>Fee</th><th>Feed</th><th>Edit</th></tr></thead><tbody>'+historyRows()+'</tbody></table></div>'+
 '<div class="callout topgap"><strong>Why crypto only here?</strong> This browser-only version uses public, signup-free endpoints that can be called without storing an API secret. Reliable broad US-stock intraday feeds generally require a licensed/keyed data service, so Chartcraft does not quietly scrape an unofficial stock endpoint and call it dependable.</div>';
}

function drawCandles(bars){
 var canvas=document.getElementById('market-chart');if(!canvas||!bars||!bars.length)return;
 var r=canvas.getBoundingClientRect(),ratio=Math.min(3,window.devicePixelRatio||1);canvas.width=Math.max(1,Math.round(r.width*ratio));canvas.height=Math.max(1,Math.round(r.height*ratio));
 var ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);var w=r.width,h=r.height;
 var css=getComputedStyle(document.documentElement),panel=css.getPropertyValue('--bg').trim(),line=css.getPropertyValue('--line').trim(),text=css.getPropertyValue('--muted').trim(),up=css.getPropertyValue('--accent').trim(),down=css.getPropertyValue('--red').trim();
 var v=bars.slice(-70),left=10,right=58,top=18,bottom=28,volH=55,pb=h-bottom-volH-8,pw=w-left-right,ph=pb-top,step=pw/v.length;
 var lo=Math.min.apply(null,v.map(function(b){return b.l;})),hi=Math.max.apply(null,v.map(function(b){return b.h;})),pad=(hi-lo)*.08||hi*.002;lo-=pad;hi+=pad;
 var y=function(n){return pb-(n-lo)/(hi-lo)*ph;},x=function(i){return left+(i+.5)*step;};
 ctx.fillStyle=panel;ctx.fillRect(0,0,w,h);ctx.font='10px -apple-system,Arial';
 for(var i=0;i<5;i++){var yy=top+i*ph/4;ctx.strokeStyle=line;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right,yy);ctx.stroke();ctx.fillStyle=text;ctx.fillText((hi-(hi-lo)*i/4).toFixed(hi<10?3:2),w-right+5,yy+3);}
 var mv=Math.max.apply(null,v.map(function(b){return b.v||0;}))||1;
 v.forEach(function(b,i){var xx=x(i),green=b.c>=b.o,bw=Math.max(2,Math.min(12,step*.62)),col=green?up:down;ctx.strokeStyle=col;ctx.fillStyle=green?panel:col;ctx.beginPath();ctx.moveTo(xx,y(b.h));ctx.lineTo(xx,y(b.l));ctx.stroke();var yy=Math.min(y(b.o),y(b.c)),hh=Math.max(1.4,Math.abs(y(b.o)-y(b.c)));ctx.fillRect(xx-bw/2,yy,bw,hh);ctx.strokeRect(xx-bw/2,yy,bw,hh);ctx.globalAlpha=.25;ctx.fillStyle=col;var vh=(b.v||0)/mv*(volH-8);ctx.fillRect(xx-bw/2,h-bottom-vh,bw,vh);ctx.globalAlpha=1;});
 var last=v[v.length-1],ly=y(last.c);ctx.fillStyle=up;ctx.fillRect(w-right+1,ly-8,right-2,16);ctx.fillStyle='#102018';ctx.font='bold 10px -apple-system,Arial';ctx.fillText(last.c.toFixed(last.c<10?3:2),w-right+5,ly+3);
 ctx.fillStyle=text;ctx.font='10px -apple-system,Arial';ctx.textAlign='center';[0,Math.floor(v.length/2),v.length-1].forEach(function(i){ctx.fillText(new Date(v[i].t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),x(i),h-5);});
}
function updatePreview(){
 var q=quoteCache[activeSymbol],el=document.getElementById('market-preview');if(!el||!q)return;
 var side=(document.getElementById('market-side')||{}).value||'buy',qty=Number((document.getElementById('market-qty')||{}).value),px=q.price*(1+(side==='buy'?1:-1)*state.settings.slipBps/10000);
 if(!Number.isFinite(qty)||qty<=0){el.textContent='Enter a quantity above zero.';return;}
 var amount=qty*px,f=fee(amount);
 el.innerHTML='<div class="spread"><span>Simulated fill</span><strong>'+money(px,4)+'</strong></div><div class="spread"><span>Notional</span><span>'+money(amount)+'</span></div><div class="spread"><span>Paper fee</span><span>'+money(f,4)+'</span></div>';
}
function refresh(force){
 return getQuote(activeSymbol,!!force).then(function(q){
  var body=document.getElementById('market-body');if(body)body.innerHTML=bodyHTML(q);
  bind();
  return Promise.all([getCandles(activeSymbol,!!force).then(function(c){drawCandles(c.bars);var n=document.getElementById('market-chart-note');if(n)n.textContent='Candles: '+c.sourceName+' · refreshed '+new Date(c.time).toLocaleTimeString();}).catch(function(e){var n=document.getElementById('market-chart-note');if(n)n.textContent=e.message;}),warmWatch()]);
 }).catch(function(e){
  var body=document.getElementById('market-body');if(body)body.innerHTML='<div class="card"><h2>Live data is temporarily unavailable.</h2><p class="muted">'+esc(e.message)+'</p><button id="market-refresh" class="btn">Try again</button></div>';
  bind();
 });
}
function warmWatch(){
 var rest=state.watch.filter(function(s){return s!==activeSymbol;});
 return Promise.all(rest.map(function(s){return getQuote(s,false).catch(function(){return null;});})).then(function(){
  var tape=document.querySelector('.market-tape');if(tape)tape.outerHTML=tapeHTML();
  bindSymbolButtons();
 });
}
function bindSymbolButtons(){
 Array.prototype.forEach.call(document.querySelectorAll('[data-market-symbol]'),function(b){b.onclick=function(){activeSymbol=b.getAttribute('data-market-symbol');state.symbol=activeSymbol;save();refresh(false);};});
}
function bind(){
 bindSymbolButtons();
 var r=document.getElementById('market-refresh');if(r)r.onclick=function(){if(now()-lastManual<MANUAL_COOLDOWN)return;lastManual=now();r.disabled=true;r.textContent='Refreshing…';refresh(true).finally(function(){if(document.getElementById('market-refresh'))document.getElementById('market-refresh').disabled=false;});};
 ['market-side','market-qty'].forEach(function(id){var e=document.getElementById(id);if(e)e.oninput=updatePreview;});
 var feeEl=document.getElementById('market-fee'),slipEl=document.getElementById('market-slip');
 if(feeEl)feeEl.onchange=function(){state.settings.feeBps=Math.max(0,Math.min(100,Number(feeEl.value)||0));save();updatePreview();};
 if(slipEl)slipEl.onchange=function(){state.settings.slipBps=Math.max(0,Math.min(100,Number(slipEl.value)||0));save();updatePreview();};
 var sub=document.getElementById('market-submit');if(sub)sub.onclick=function(){
  var q=quoteCache[activeSymbol],side=document.getElementById('market-side').value,qty=Number(document.getElementById('market-qty').value);
  if(!q){alert('No live quote is available yet.');return;}
  if(now()-q.time>60000&&!q.stale){alert('Refresh the quote before placing a paper fill.');return;}
  try{trade(side,activeSymbol,qty,q);refresh(false);}catch(e){alert(e.message);}
 };
 Array.prototype.forEach.call(document.querySelectorAll('[data-market-void]'),function(b){b.onclick=function(){if(!confirm('Void this paper fill and rebuild the live-price paper ledger? The history will be marked edited.'))return;try{rebuildWithout(b.getAttribute('data-market-void'));refresh(false);}catch(e){alert(e.message);}};});
 var resetEl=document.getElementById('market-reset');if(resetEl)resetEl.onclick=function(){if(confirm('Reset the live-price paper account to $10,000? This only clears this market-lab ledger.')){reset();refresh(false);}};
 updatePreview();
}
function mount(){
 style();activeSymbol=state.symbol||activeSymbol;
 clearInterval(autoTimer);refresh(false);
 autoTimer=setInterval(function(){if(location.hash.indexOf('#market')===0)refresh(false);else clearInterval(autoTimer);},AUTO_MS);
 window.addEventListener('resize',function(){var c=candleCache[activeSymbol];if(location.hash.indexOf('#market')===0&&c)drawCandles(c.bars);},{once:true});
}
window.ChartcraftMarket={view:view,mount:mount,refresh:refresh,get state(){return state;}};
})();