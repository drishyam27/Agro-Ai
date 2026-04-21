// ══════════════════════════════════════════════════════
//  ZENTRIX Dashboard — Core Logic
//  Single source of truth: sensorState (raw from ESP32)
//  Null contract: null = sensor disconnected, never 0 fallback
// ══════════════════════════════════════════════════════

// ── DOM shorthand ──
function el(id){ return document.getElementById(id); }
function nowTime(){ return new Date().toLocaleTimeString('en-IN',{hour12:false}); }
function fmt(n,d=1){ return typeof n==='number'?n.toFixed(d):'--'; }

// ── Null-safe value parser — SINGLE function used everywhere ──
// Returns null if ESP32 sent null/undefined, otherwise converts via fn.
// This is the fix for phantom readings: we never coerce null → 0.
function pv(raw, fn){ return (raw!=null)?fn(raw):null; }

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let sensorState   = {};   // raw JSON from ESP32 — never mutate this

// Pump state machine — 3 mutually exclusive states:
//   'idle'   : no lock, WS sync allowed
//   'locked' : manual click in flight, WS sync blocked
//   'confirm': ESP32 confirmed, brief hold before releasing
let pumpOn        = false;
let _pumpLock     = false;  // true = block WS sync
let _pumpLockTimer= null;
let manualOverrideUntil = 0; // timestamp — auto mode won't interfere until this expires
let autoMode      = false;
let autoScarecrow = false;
let autoValve     = false;

// Counters
let pumpRuntime   = 0;    // seconds pump has been ON this session
let waterUsed     = 0;    // litres
let pumpCycles    = 0;
let pumpWasOn     = false;
const PUMP_FLOW_LPS = 0.02222; // 1L per 45s

// Moisture threshold for auto-mode
let moistureThreshold = 40;

// Tank height (settable in config)
let TANK_HEIGHT_CM = parseInt(localStorage.getItem('zentrix_tank_h')||'40');

// Daily stat trackers
let minTemp=999,maxTemp=-999,minMoist=999,maxMoist=-999,minHum=999,maxHum=-999;
let motionCount=0, manualWaterEstimate=0, sunHoursCount=0;
let lastMotionAlert=0;
const MOTION_COOLDOWN=15000;
let _scarecrowActive=false; // true while scarecrow is physically triggered — blocks updateField overwrite
let lastFrostAlert=0;       // cooldown: frost alert max once per 5 minutes
let lastFireAlert=0;        // cooldown: fire alert max once per 30 seconds
const FROST_ALERT_COOLDOWN=300000; // 5 minutes
const FIRE_ALERT_COOLDOWN=30000;   // 30 seconds

// Prediction buffers
let moistHistory=[], tankHistory=[];

// Tick counter
let tick=0;
let startTime=Date.now();

// ─────────────────────────────────────────────
//  PUMP LOCK — simple boolean, not timestamp
//  Lock duration: 10s — safely outlasts WS cycles
//  and any ESP32 response delay.
// ─────────────────────────────────────────────
function _lockPump(ms){
  _pumpLock=true;
  if(_pumpLockTimer) clearTimeout(_pumpLockTimer);
  _pumpLockTimer=setTimeout(()=>{
    _pumpLock=false;
    _pumpLockTimer=null;
  }, ms);
}
function _unlockPump(){
  _pumpLock=false;
  if(_pumpLockTimer){ clearTimeout(_pumpLockTimer); _pumpLockTimer=null; }
}
// Single clean declaration — re-enables pump button if ever disabled
function _enablePumpBtn(){
  const btn=el('pump-btn');
  if(btn){ btn.disabled=false; btn.style.opacity=''; btn.style.cursor=''; }
}

// ─────────────────────────────────────────────
//  ALERT BANNER
// ─────────────────────────────────────────────
function showAlert(msg, type='orange'){
  const bar=el('alert-bar');
  bar.style.background = type==='red'?'#FFEBEE':'#FFF3E0';
  bar.style.borderColor= type==='red'?'#EF5350':'#FF9800';
  el('alert-msg').textContent=msg;
  bar.classList.add('show');
  setTimeout(()=>bar.classList.remove('show'),8000);
}

// ─────────────────────────────────────────────
//  PUMP CONTROL
// ─────────────────────────────────────────────
function togglePump(){
  // ── MANUAL CONTROL (HACKATHON-READY) ────────────────────────
  // • Manual press works INSTANTLY — no waiting, no blocking
  // • Press ON → OFF → ON as fast as you want — always responds
  // • Does NOT kill autoMode — if auto is ON, it stays ON and
  //   will resume managing the pump after this manual press
  // • 2s lock ONLY to absorb the ESP32 WS echo so UI doesn't flicker
  // ────────────────────────────────────────────────────────────

  const intended = !pumpOn;
  pumpOn = intended;

  // 2s lock — just enough to ignore the immediate WS echo from ESP32
  // Does NOT block the next button press (lock resets on each press)
  _lockPump(2000);

  // Manual override — suspend auto irrigation for 15s so auto doesn't
  // fight back and undo what the user just did manually
  manualOverrideUntil = Date.now() + 15000;
  updateOverrideUI();

  updatePumpUI();

  const modeLabel = autoMode ? 'Auto resumes in 15s' : 'Manual mode';
  showAlert(intended ? '💧 Pump TURNED ON — ' + modeLabel : '⏹ Pump TURNED OFF — ' + modeLabel, 'orange');

  // Primary: WebSocket — instant, fire-and-forget
  const cmd = JSON.stringify({cmd:'pump', state: intended ? 'on' : 'off'});
  let sent = false;
  if(ws && ws.readyState === WebSocket.OPEN){
    try{ ws.send(cmd); sent = true; }catch(e){ sent = false; }
  }

  // Fallback: HTTP (only when WebSocket is down)
  if(!sent){
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    fetch(getESP32Base() + '/pump?state=' + (intended ? 'on' : 'off'), {signal: ctrl.signal})
      .then(r => { clearTimeout(t); if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(d => {
        pumpOn = (d.pump === true || d.pump === 'true');
        _unlockPump();
        updatePumpUI();
      })
      .catch(err => {
        clearTimeout(t);
        pumpOn = !intended; // revert UI on failure
        _unlockPump();
        updatePumpUI();
        showAlert('❌ Pump command failed — ' + err.message, 'red');
      });
  }
}

function updatePumpUI(){
  const btn=el('pump-btn'), dot=el('pump-dot'), txt=el('pump-status-text');
  if(pumpOn){
    btn.textContent='⏹ TURN PUMP OFF'; btn.className='pump-btn off';
    dot.style.background='#4CAF50';
    txt.textContent='ON'; txt.style.color='var(--green)';
  } else {
    btn.textContent='▶ TURN PUMP ON'; btn.className='pump-btn on';
    dot.style.background='#EF5350';
    txt.textContent='OFF'; txt.style.color='var(--red)';
  }
}

function toggleAuto(){
  autoMode=el('auto-toggle').checked;
  // Clear any manual override when user explicitly turns auto ON
  if(autoMode) { manualOverrideUntil=0; updateOverrideUI(); }
  el('pump-auto-msg').textContent=autoMode
    ? '⚙️ Auto: ON when moisture < '+moistureThreshold+'%, OFF when ≥ '+moistureThreshold+'%'
    : 'Manual mode active';
}

function updateOverrideUI(){
  const el2=el('manual-override-msg');
  if(!el2) return;
  if(manualOverrideUntil > Date.now()){
    el2.style.display='block';
    el('override-countdown').textContent=Math.ceil((manualOverrideUntil-Date.now())/1000);
  } else {
    el2.style.display='none';
  }
}
function toggleScarecrow(){
  autoScarecrow=el('scarecrow-toggle').checked;
  el('gh-servo').textContent=autoScarecrow?'AUTO ✅':'MANUAL';
  el('gh-servo').style.color=autoScarecrow?'var(--green)':'var(--text3)';
}
function toggleValve(){
  autoValve=el('valve-toggle').checked;
  showAlert(autoValve?'💧 Auto water valve enabled':'🔒 Water valve set to manual','orange');
}

function getESP32Base(){
  const saved=localStorage.getItem('zentrix_esp32')||'';
  if(saved){ const h=saved.replace(/^https?:\/\//,'').replace(/\/$/,''); return 'http://'+h; }
  return '';
}

// ─────────────────────────────────────────────
//  LOG HELPERS
// ─────────────────────────────────────────────
function addMotionLog(msg,type='clear'){
  const log=el('motion-log');
  const d=document.createElement('div');
  d.className='log-entry';
  d.innerHTML=`<span class="${type==='alert'?'alert-tag':'clear-tag'}">${type==='alert'?'ALERT':'CLEAR'}</span> — ${msg} <span style="color:#aaa">${nowTime()}</span>`;
  log.prepend(d);
  if(log.children.length>8) log.removeChild(log.lastChild);
}
function addHistoryRow(m,t,h,pump){
  const tb=el('hist-body');
  const tr=document.createElement('tr');
  tr.innerHTML=`<td style="font-family:'Courier New',monospace;font-size:11px">${nowTime()}</td>
    <td><b style="color:var(--blue)">${m!=null?Math.round(m)+'%':'--'}</b></td>
    <td><b style="color:var(--orange)">${t!=null?fmt(t)+'°C':'--'}</b></td>
    <td>${h!=null?Math.round(h)+'%':'--'}</td>
    <td><span class="badge ${pump?'badge-green':'badge-red'}">${pump?'ON':'OFF'}</span></td>`;
  tb.prepend(tr);
  if(tb.children.length>12) tb.removeChild(tb.lastChild);
}

// ─────────────────────────────────────────────
//  CHART
// ─────────────────────────────────────────────
const labels=[],mData=[],tData=[];
const ctx=el('chart1').getContext('2d');
const chart=(typeof Chart!=='undefined')?new Chart(ctx,{
  type:'line',
  data:{labels,datasets:[
    {label:'Moisture %',data:mData,borderColor:'#1565C0',backgroundColor:'rgba(21,101,192,.08)',tension:0,pointRadius:3,borderWidth:2,yAxisID:'y',spanGaps:true},
    {label:'Temperature °C',data:tData,borderColor:'#E65100',backgroundColor:'rgba(230,81,0,.06)',tension:0,pointRadius:3,borderWidth:2,yAxisID:'y1',spanGaps:true}
  ]},
  options:{
    animation:false,responsive:true,
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{position:'bottom',labels:{font:{size:11,family:'system-ui'},boxWidth:12}}},
    scales:{
      x:{ticks:{font:{size:10},maxTicksLimit:8}},
      y:{position:'left',title:{display:true,text:'Moisture %',font:{size:10}},min:0,max:100},
      y1:{position:'right',title:{display:true,text:'Temp °C',font:{size:10}},grid:{drawOnChartArea:false},min:10,max:50}
    }
  }
}):{update:()=>{},data:{labels,datasets:[{data:mData},{data:tData}]}};

// ─────────────────────────────────────────────
//  WebSocket
// ─────────────────────────────────────────────
let ws, wsRetry=null;
let wsConnectedAt=0; // timestamp when WS connected — gas alerts suppressed for 60s (MQ sensor warmup)

function connectWS(){
  const savedIP=localStorage.getItem('zentrix_esp32')||'';
  const host=savedIP?savedIP.replace(/^https?:\/\//,''):location.host;
  ws=new WebSocket('ws://'+host+'/ws');

  ws.onopen=()=>{
    el('live-dot').style.background='#69F0AE';
    el('last-sync').textContent='Connected via WebSocket';
    wsConnectedAt=Date.now(); // start warmup timer for MQ gas sensors
    if(wsRetry){ clearTimeout(wsRetry); wsRetry=null; }
    // ★ FIX: On reconnect, do NOT touch pumpLock if a manual operation is in flight.
    // The old code always set a 2s reconnect lock which would overwrite and prematurely
    // expire an active 10s manual lock, causing WS to revert pump state.
    if(!_pumpLock) _lockPump(2000); // brief reconnect hold only if no manual lock active
    if(ws._ping) clearInterval(ws._ping);
    ws._ping=setInterval(()=>{ if(ws&&ws.readyState===WebSocket.OPEN) ws.send('ping'); },25000);
  };

  ws.onmessage=e=>{
    try{
      const d=JSON.parse(e.data);
      sensorState=d;
      updateAll(d);
      el('last-sync').textContent=nowTime();
    }catch(err){ console.warn('WS parse error:',err); }
  };

ws.onclose=()=>{
  if(ws._ping){ clearInterval(ws._ping); ws._ping=null; }
  el('live-dot').style.background='#EF5350';
  el('last-sync').textContent='Reconnecting...';
  if(wsRetry){ clearTimeout(wsRetry); wsRetry=null; }
  wsRetry=setTimeout(connectWS,3000);
};

  ws.onerror=()=>ws.close();
}

// ─────────────────────────────────────────────
//  updateAll — parse once, dispatch to sub-fns
//  ★ All values are null (not 0) when sensor absent
// ─────────────────────────────────────────────
function updateAll(d){
  tick++;
  if(tick>86400) tick=1;

  // Parse all values once with strict null handling
  const m    = pv(d.moisture,  parseFloat);
  const m2   = pv(d.moisture2, parseFloat);
  const tmp  = pv(d.temp,      parseFloat);
  const hum  = pv(d.humidity,  parseFloat);
  const stmp = pv(d.soilTemp,  parseFloat);
  const dist = pv(d.tankDist,  parseFloat);
  const tank = dist!=null ? Math.round(Math.max(0,Math.min(100,(1-dist/TANK_HEIGHT_CM)*100))) : null;
  const co2  = pv(d.co2,  v=>parseInt(v,10));
  const ch4  = pv(d.ch4,  v=>parseInt(v,10));
  const co   = pv(d.co,   parseFloat);
  const aqi  = pv(d.aqi,  v=>parseInt(v,10));
  const aqiStatus = d.aqiStatus||null;
  const motion= d.motion===true||d.motion==='true';
  const pH   = pv(d.ph,  parseFloat);
  const tds  = pv(d.tds, v=>parseInt(v,10));
  const solarMw  = pv(d.solarMw, v=>parseInt(v,10));
  const battPct  = pv(d.battPct, v=>parseInt(v,10));
  const rain = d.rain===true||d.rain==='true';
  const light= pv(d.light, v=>parseInt(v,10));
  const pres = pv(d.pressure, parseFloat);

  // ★ Pump sync — only when NOT locked AND not in manual override window
  // _pumpLock (2s): blocks immediate WS echo after button press
  // manualOverrideUntil (15s): blocks ESP32 state from reverting manual UI
  if(d.pump!==undefined && !_pumpLock && Date.now() > manualOverrideUntil){
    const espPump=(d.pump===true||d.pump==='true');
    if(espPump!==pumpOn){ pumpOn=espPump; updatePumpUI(); }
  }

  // Dispatch
  updateSoil(m, m2, stmp);
  updateTank(dist, tank);
  // Zone 2 preferred (firmware: sensor 1 disabled); falls back to zone 1
  const mActive = m2!=null?m2:m;
  updatePump(mActive, rain);
  updateGas(co2, ch4, co, aqi, aqiStatus);
  updateSecurity(motion, light);
  updateField(tmp, hum, light);
  updateSoilHealth(pH, tds);
  updatePower(solarMw, battPct);
  updateWeather(tmp, rain, light, pres);
  updateDailyStats(tmp, mActive, hum, motion);
  updatePredictions(mActive, tank);
  updateChartHistory(mActive, tmp, hum);
  if(typeof syncStrip==='function') syncStrip();
}

// ─────────────────────────────────────────────
//  1. SOIL MOISTURE
// ─────────────────────────────────────────────
function updateSoil(m, m2, stmp){
  // Combined field health score: average if both present, else whichever exists
  const fhs = (m!=null&&m2!=null) ? Math.round((m+m2)/2) : m2!=null ? Math.round(m2) : m!=null ? Math.round(m) : null;

  if(fhs!=null){
    el('moisture-val').innerHTML=fhs+'<span class="card-unit">%</span>';
    el('moisture-bar').style.width=fhs+'%';
    const dry=fhs<35, wet=fhs>80;
    el('moisture-status').textContent=dry?'🔴 Dry — Needs irrigation':wet?'🔵 Wet — No irrigation needed':'🟢 Optimal moisture level';
    const fb=el('fhs-badge');
    if(dry)       { fb.className='badge badge-red';    fb.textContent='🔴 Dry — Irrigate Now';  el('moisture-bar').style.background='var(--red-l)'; }
    else if(fhs<60){ fb.className='badge badge-orange'; fb.textContent='🟡 Monitor Closely';     el('moisture-bar').style.background='var(--orange-l)'; }
    else           { fb.className='badge badge-green';  fb.textContent='🟢 Field Healthy';       el('moisture-bar').style.background='var(--blue-l)'; }
  } else {
    el('moisture-val').innerHTML='--<span class="card-unit">%</span>';
    el('moisture-status').textContent='Sensor not connected';
    el('fhs-badge').className='badge badge-blue'; el('fhs-badge').textContent='⚡ Awaiting sensor';
    el('moisture-bar').style.width='0%';
  }

  // Zone bars
  el('zone1-val').textContent  = m!=null  ? Math.round(m)+'%'  : '--';
  el('zone1-bar').style.width  = m!=null  ? m+'%'  : '0%';
  el('zone1-val').style.color  = m!=null  ? 'var(--blue)' : 'var(--text3)';
  el('zone1-label').textContent = 'Zone 1'+(m!=null?'':' — no data');

  el('zone2-val').textContent  = m2!=null ? Math.round(m2)+'%' : '--';
  el('zone2-bar').style.width  = m2!=null ? m2+'%' : '0%';
  el('zone2-val').style.color  = m2!=null ? 'var(--blue)' : 'var(--text3)';
  el('zone2-label').textContent = 'Zone 2'+(m2!=null?'':' — no data');

  // Soil temp
  if(stmp!=null){
    el('soil-temp-val').innerHTML=fmt(stmp)+'<span class="card-unit">°C</span>';
    el('soil-temp-bar').style.width=Math.min(100,Math.max(0,((stmp-15)/30*100)))+'%';
    el('soil-temp-status').textContent=stmp>34?'⚠️ Soil too warm for roots':'🟢 Root zone healthy';
    if(stmp<10){
      el('frost-alert').style.display='block';
      const now=Date.now();
      if(now-lastFrostAlert>FROST_ALERT_COOLDOWN){ lastFrostAlert=now; showAlert('🧊 Frost risk! Soil temp '+fmt(stmp)+'°C — protect crops!','red'); }
    } else el('frost-alert').style.display='none';
  } else {
    el('soil-temp-val').innerHTML='--<span class="card-unit">°C</span>';
    el('soil-temp-status').textContent='DS18B20 not connected';
    el('frost-alert').style.display='none';
  }
}

// ─────────────────────────────────────────────
//  2. WATER TANK
// ─────────────────────────────────────────────
function updateTank(dist, tank){
  if(tank!=null){
    el('tank-pct').textContent   = tank+'%';
    el('tank-fill').style.height = tank+'%';
    el('tank-dist').textContent  = Math.round(dist)+' cm';
    const tb=el('tank-badge');
    if(tank<20)      { tb.className='badge badge-red';    tb.textContent='⚠️ LOW'; }
    else if(tank<50) { tb.className='badge badge-orange'; tb.textContent='Medium'; }
    else             { tb.className='badge badge-green';  tb.textContent='Good Level'; }
    el('tank-msg').textContent=tank<20?'⚠️ Refill water tank soon!':tank<50?'Tank at medium level':'Sufficient water available';
  } else {
    el('tank-pct').textContent='--'; el('tank-fill').style.height='0%'; el('tank-dist').textContent='-- cm';
    el('tank-badge').className='badge badge-blue'; el('tank-badge').textContent='Not connected';
    el('tank-msg').textContent='HC-SR04 not connected';
  }
}

// ─────────────────────────────────────────────
//  3. PUMP AUTO-LOGIC
//  ★ Only acts if !_pumpLock AND mActive!=null
//  Previously automode could trigger on null moisture
//  (which compared as NaN < threshold → true → phantom pump ON)
// ─────────────────────────────────────────────
function updatePump(mActive, rain){
  // Rain auto-pause
  const rpEl=el('rain-pause-msg');
  if(rain && autoMode){
    rpEl.style.display='block';
    if(pumpOn && !_pumpLock){
      pumpOn=false; updatePumpUI(); _lockPump(2000);
      const rainCmd=JSON.stringify({cmd:'pump',state:'off'});
      let rainSent=false;
      if(ws && ws.readyState===WebSocket.OPEN){ try{ ws.send(rainCmd); rainSent=true; }catch(e){ rainSent=false; } }
      if(!rainSent) fetch(getESP32Base()+'/pump?state=off').catch(()=>{});
    }
  } else {
    rpEl.style.display='none';
  }

  // ── AUTO IRRIGATION LOGIC ────────────────────────────────────
  // Pump ON  : moisture BELOW threshold (e.g. 38% < 40% → ON)
  // Pump OFF : moisture AT or ABOVE threshold (e.g. 40% ≥ 40% → OFF)
  // Clean boundary — no hysteresis offset, exactly as threshold is set
  // Only acts when: autoMode ON + sensor live + not in lock window
  // ─────────────────────────────────────────────────────────────
  if(autoMode && !rain && mActive!=null && !_pumpLock && Date.now() > manualOverrideUntil){
    if(mActive < moistureThreshold && !pumpOn){
      pumpOn=true; updatePumpUI(); _lockPump(2000);
      showAlert('💧 Auto ON — moisture '+Math.round(mActive)+'% < threshold '+moistureThreshold+'%');
      const cmdOn=JSON.stringify({cmd:'pump',state:'on'});
      let sentOn=false;
      if(ws && ws.readyState===WebSocket.OPEN){ try{ ws.send(cmdOn); sentOn=true; _unlockPump(); }catch(e){ sentOn=false; } }
      if(!sentOn) fetch(getESP32Base()+'/pump?state=on').then(()=>_unlockPump()).catch(()=>_unlockPump());
    }
    if(mActive >= moistureThreshold && pumpOn){
      pumpOn=false; updatePumpUI(); _lockPump(2000);
      showAlert('✅ Auto OFF — moisture '+Math.round(mActive)+'% reached threshold '+moistureThreshold+'%');
      const cmdOff=JSON.stringify({cmd:'pump',state:'off'});
      let sentOff=false;
      if(ws && ws.readyState===WebSocket.OPEN){ try{ ws.send(cmdOff); sentOff=true; _unlockPump(); }catch(e){ sentOff=false; } }
      if(!sentOff) fetch(getESP32Base()+'/pump?state=off').then(()=>_unlockPump()).catch(()=>_unlockPump());
    }
  }

  // Counters
  if(pumpOn) { pumpRuntime+=2; waterUsed+=PUMP_FLOW_LPS*2; }
  if(pumpOn && !pumpWasOn) pumpCycles++;
  pumpWasOn=pumpOn;

  const rMin=Math.floor(pumpRuntime/60), rSec=pumpRuntime%60;
  const avg=pumpCycles>0?(waterUsed/pumpCycles):0;
  el('pump-runtime-val').textContent=rMin+'m '+rSec+'s';
  el('water-used-val').textContent=waterUsed.toFixed(1)+' L';
  el('pump-cycles-val').textContent=pumpCycles;
  el('avg-per-cycle').textContent=avg.toFixed(1)+' L';
  if(autoMode) el('pump-auto-msg').textContent='⚙️ Auto: ON when moisture < '+moistureThreshold+'%, OFF when ≥ '+moistureThreshold+'%';
}
// ─────────────────────────────────────────────
//  4. GAS SENSORS
// ─────────────────────────────────────────────
function gasColor(val,warn,danger){
  if(val==null) return 'var(--text3)';
  if(val>=danger) return 'var(--red)';
  if(val>=warn)   return 'var(--orange)';
  return 'var(--green)';
}

function updateGas(co2, ch4, co, aqi, aqiStatus){
  const allNull = co2==null && ch4==null && co==null;
  const gb=el('gas-overall-badge');

  // Bars (scaled)
  el('co2-bar').style.width = co2!=null ? Math.min(100,co2/30)+'%' : '0%';
  el('ch4-bar').style.width = ch4!=null ? Math.min(100,ch4/20)+'%' : '0%';
  el('co-bar').style.width  = co!=null  ? Math.min(100,co/3)+'%'   : '0%';
  el('aq-bar').style.width  = aqi!=null ? Math.min(100,aqi/4)+'%'  : '0%';

  if(allNull){
    ['co2-val','ch4-val','co-val','aq-val'].forEach(id=>{ el(id).textContent='--'; el(id).style.color='var(--text3)'; });
    ['co2-arrow','ch4-arrow','co-arrow','aq-arrow'].forEach(id=>el(id).textContent='');
    gb.style.background='var(--blue-bg)'; gb.style.color='var(--blue)';
    gb.textContent='⚙️ Gas sensors not connected'; return;
  }

  // Values + arrows + bar colours
  const co2c=gasColor(co2,1000,2000), ch4c=gasColor(ch4,500,1000), coc=gasColor(co,35,200);

  el('co2-val').textContent=co2!=null?co2+' ppm':'--'; el('co2-val').style.color=co2c; el('co2-arrow').textContent=co2!=null?'→':'';
  el('ch4-val').textContent=ch4!=null?ch4+' ppm':'--'; el('ch4-val').style.color=ch4c; el('ch4-arrow').textContent=ch4!=null?'→':'';
  el('co-val').textContent =co!=null?co.toFixed(1)+' ppm':'--'; el('co-val').style.color=coc; el('co-arrow').textContent=co!=null?'→':'';
  el('aq-val').textContent =aqi!=null?aqi+' AQI':'--'; el('aq-val').style.color=gasColor(aqi,100,200);

  el('co2-bar').style.background=co2c==='var(--red)'?'var(--red-l)':co2c==='var(--orange)'?'var(--orange-l)':'var(--blue-l)';
  el('ch4-bar').style.background=ch4c==='var(--red)'?'var(--red-l)':'var(--orange-l)';
  el('co-bar').style.background =coc==='var(--red)'?'var(--red-l)':coc==='var(--orange)'?'var(--orange-l)':'var(--red-l)';
  el('aq-bar').style.background =(gasColor(aqi,100,200)==='var(--red)')?'var(--red-l)':(gasColor(aqi,100,200)==='var(--orange)')?'var(--orange-l)':'var(--green-l)';

  const fireRisk=(co!=null&&co>50)&&(ch4!=null&&ch4>500);
  const crit=(co2!=null&&co2>2000)||(ch4!=null&&ch4>1000)||(co!=null&&co>200)||fireRisk;
  const warn=(co2!=null&&co2>1000)||(ch4!=null&&ch4>500)||(co!=null&&co>35);

  const now=Date.now();
  const gasWarmedUp=(wsConnectedAt>0 && now-wsConnectedAt>60000); // 60s MQ warmup guard

  if(!gasWarmedUp){
    // Sensors still warming up — suppress ALL alerts and badges to prevent false positives
    gb.style.background='var(--blue-bg)'; gb.style.color='var(--blue)';
    const remaining=Math.max(0,Math.ceil((60000-(now-wsConnectedAt))/1000));
    gb.textContent='⏳ Sensors warming up… '+remaining+'s';
  } else if(fireRisk){
    gb.style.background='var(--red-bg)'; gb.style.color='var(--red)'; gb.textContent='🔥 FIRE RISK — Evacuate!';
    if(now-lastFireAlert>FIRE_ALERT_COOLDOWN){ lastFireAlert=now; showAlert('🔥 FIRE RISK! CO '+co+'ppm + Methane '+ch4+'ppm — possible combustion!','red'); }
  } else if(crit){
    gb.style.background='var(--red-bg)'; gb.style.color='var(--red)'; gb.textContent='🔴 Critical Gas Level!';
  } else if(warn){
    gb.style.background='var(--orange-bg)'; gb.style.color='var(--orange)'; gb.textContent='⚠️ Gas Warning — Monitor';
  } else {
    gb.style.background='var(--green-bg)'; gb.style.color='var(--green)';
    gb.textContent=aqiStatus?'✅ '+aqiStatus:'✅ All Gas Levels Safe';
  }
}

// ─────────────────────────────────────────────
//  5. SECURITY / PIR
// ─────────────────────────────────────────────
function updateSecurity(motion, light){
  const t=nowTime();
  if(motion){
    el('pir-status').textContent='⚠️ MOTION!'; el('pir-status').style.color='var(--red)';
    el('pir-last').textContent='Motion at '+t;
    addMotionLog('Motion detected near farm','alert');
    const now=Date.now();
    if(now-lastMotionAlert>MOTION_COOLDOWN){
      lastMotionAlert=now;
      showAlert('🚨 Security alert! Motion detected at '+t,'red');
      if(typeof crisisRegister==='function') crisisRegister('🚨 Motion detected near farm at '+t);
    }
    if(autoScarecrow){
      _scarecrowActive=true;
      el('gh-servo').textContent='ACTIVE 🔄'; el('gh-servo').style.color='var(--orange)';
    fetch(getESP32Base()+'/scarecrow?state=on').catch(()=>{});
      setTimeout(()=>{ _scarecrowActive=false; el('gh-servo').textContent='RESTING'; el('gh-servo').style.color='var(--green)'; fetch(getESP32Base()+'/scarecrow?state=off').catch(()=>{}); },4000);
    }
    setTimeout(()=>{ el('pir-status').textContent='CLEAR'; el('pir-status').style.color='var(--green)'; el('pir-last').textContent='Last motion: '+t; addMotionLog('Area clear again','clear'); },5000);
  }
  // Day/Night badge
  el('daynight-badge').textContent = light==null?'☀️ Day':light<200?'🌙 Night':light<600?'🌤️ Cloudy':'☀️ Day';
}

// ─────────────────────────────────────────────
//  6. OPEN FIELD (DHT22: temp + humidity)
// ─────────────────────────────────────────────
function updateField(tmp, hum, light){
  if(tmp!=null){
    el('temp-val').innerHTML=fmt(tmp)+'<span class="card-unit">°C</span>';
    el('temp-bar').style.width=Math.min(100,Math.max(0,(tmp-10)/40*100))+'%';
    el('temp-status').textContent=tmp>38?'🔴 Too hot for crops':tmp<22?'🔵 Cool conditions':'🟢 Good temperature';
    el('gh-temp').textContent=fmt(tmp)+' °C';
    el('weather-temp').textContent=fmt(tmp)+'°C';
  } else {
    el('temp-val').innerHTML='--<span class="card-unit">°C</span>';
    el('temp-status').textContent='DHT22 not connected';
    el('gh-temp').textContent='--'; el('weather-temp').textContent='--°C';
  }
  if(hum!=null){
    el('hum-val').innerHTML=Math.round(hum)+'<span class="card-unit">%</span>';
    el('hum-bar').style.width=hum+'%';
    el('hum-status').textContent=hum>85?'⚠️ High — Risk of fungal disease':'🟢 Humidity normal';
    el('gh-hum').textContent=Math.round(hum)+' %';
  } else {
    el('hum-val').innerHTML='--<span class="card-unit">%</span>';
    el('hum-status').textContent='DHT22 not connected';
    el('gh-hum').textContent='--';
  }
  if(light!=null){
    const uvIdx=parseFloat(Math.min(11,light/100).toFixed(1));
    el('gh-uv').textContent=uvIdx+(uvIdx<3?' 🟢 Low':uvIdx<6?' 🟡 Moderate':' 🔴 High');
    if(light>200) sunHoursCount+=(2/3600); // 2s tick
    el('gh-sun').textContent=sunHoursCount.toFixed(1)+' hrs';
  } else {
    el('gh-uv').textContent='--'; el('gh-sun').textContent='--';
  }
  // Only update scarecrow display if it's not actively triggered by motion
  if(!_scarecrowActive){
    if(!autoScarecrow){ el('gh-servo').textContent='MANUAL'; el('gh-servo').style.color='var(--text3)'; }
  }
}

// ─────────────────────────────────────────────
//  7. SOIL HEALTH (pH + TDS)
// ─────────────────────────────────────────────
function updateSoilHealth(pH, tds){
  el('ph-val').textContent  = pH!=null  ? pH  : '--';
  el('tds-val').textContent = tds!=null ? tds+' ppm' : '--';
  el('ph-bar').style.width  = pH!=null  ? (pH/14*100)+'%' : '0%';
  el('tds-bar').style.width = tds!=null ? Math.min(100,tds/6)+'%' : '0%';
  el('crop-rec').textContent = pH!=null
    ? (pH>=5.5&&pH<=7?'🌾 Good for Paddy & Wheat':pH<5.5?'⚠️ Too acidic — add lime':'⚠️ Too alkaline — add sulfur')
    : '⚡ pH sensor not connected';
}

// ─────────────────────────────────────────────
//  8. SOLAR / BATTERY
// ─────────────────────────────────────────────
function updatePower(solarMw, battPct){
  if(battPct!=null){
    const rh=parseFloat((battPct*0.18).toFixed(1));
    el('batt-val').textContent=battPct+' %';
    el('batt-bar').style.width=battPct+'%';
    el('batt-bar').style.background=battPct>60?'#FFD600':battPct>30?'#FF9800':'#EF5350';
    el('runtime-est').textContent=rh+' hrs';
  } else {
    el('batt-val').textContent='--'; el('batt-bar').style.width='0%'; el('runtime-est').textContent='--';
  }
  el('solar-w').textContent=solarMw!=null?solarMw+' mW':'--';
}

// ─────────────────────────────────────────────
//  9. WEATHER CARD
// ─────────────────────────────────────────────
function updateWeather(tmp, rain, light, pres){
  el('weather-desc').textContent=rain?'🌧️ Rain detected':tmp!=null&&tmp>35?'☀️ Sunny & hot':tmp!=null?'⛅ Partly cloudy':'Awaiting sensors...';
  el('rain-val').textContent=rain?'🌧️ Yes':'☀️ None';
  el('light-val').textContent=light!=null?light+' lux':'--';
  el('pressure-val').textContent=pres!=null?pres+' hPa':'--';
  el('weather-top').textContent=tmp!=null?fmt(tmp)+'°C · '+(rain?'Raining':'Clear'):'-- · --';
}

// ─────────────────────────────────────────────
//  10. DAILY STATS
// ─────────────────────────────────────────────
function updateDailyStats(tmp, m, hum, motion){
  if(tmp!=null){ if(tmp<minTemp) minTemp=parseFloat(fmt(tmp)); if(tmp>maxTemp) maxTemp=parseFloat(fmt(tmp)); }
  if(m!=null)  { if(m<minMoist)  minMoist=Math.round(m);       if(m>maxMoist)  maxMoist=Math.round(m); }
  if(hum!=null){ if(hum<minHum)  minHum=Math.round(hum);       if(hum>maxHum)  maxHum=Math.round(hum); }
  if(motion) motionCount++;
  manualWaterEstimate+=(2*0.014); // 2s tick × fixed schedule rate
  const saved=Math.max(0,manualWaterEstimate-waterUsed);
  el('stat-temp').textContent  =minTemp<999 ?minTemp+'/'+maxTemp+'°C':'--/--°C';
  el('stat-moist').textContent =minMoist<999?minMoist+'/'+maxMoist+'%':'--/--%';
  el('stat-hum').textContent   =minHum<999  ?minHum+'/'+maxHum+'%':'--/--%';
  el('stat-motion').textContent=motionCount;
  el('stat-saved').textContent ='~'+saved.toFixed(1)+' L';
}

// ─────────────────────────────────────────────
//  11. PREDICTIONS
// ─────────────────────────────────────────────
function updatePredictions(m, tank){
  if(m!=null){ moistHistory.push(Math.round(m)); if(moistHistory.length>6) moistHistory.shift(); }

  const irrEl=el('irr-predict');
  if(pumpOn){
    irrEl.style.background='var(--green-bg)'; irrEl.style.color='var(--green)'; irrEl.textContent='💧 Irrigation running now...';
  } else if(m!=null && moistHistory.length>=3){
    const drop=(moistHistory[0]-moistHistory[moistHistory.length-1])/moistHistory.length;
    if(drop>0.1){
      const mins=Math.max(0,Math.floor((m-moistureThreshold)/drop*5/60));
      const hrs=Math.floor(mins/60);
      irrEl.style.background=mins<10?'var(--red-bg)':'var(--green-bg)';
      irrEl.style.color=mins<10?'var(--red)':'var(--green)';
      irrEl.textContent='⏱️ Next irrigation in ~'+(hrs>0?hrs+'h '+(mins%60)+'m':mins+' min');
    } else {
      irrEl.style.background='var(--green-bg)'; irrEl.style.color='var(--green)'; irrEl.textContent='✅ Moisture stable — no irrigation soon';
    }
  } else if(m==null){
    irrEl.style.background='var(--blue-bg)'; irrEl.style.color='var(--blue)'; irrEl.textContent='⚡ Awaiting soil moisture sensor';
  }

  if(tank!=null){ tankHistory.push(tank); if(tankHistory.length>6) tankHistory.shift(); }
  const te=el('tank-empty-est');
  if(tank==null){
    te.style.color='var(--blue)'; te.style.background='var(--blue-bg)'; te.textContent='⚡ Awaiting tank sensor';
  } else if(tankHistory.length>=3 && pumpOn){
    const drop=(tankHistory[0]-tankHistory[tankHistory.length-1])/tankHistory.length;
    if(drop>0.05){
      const mins=Math.round(tank/drop*5/60), hrs=Math.floor(mins/60);
      te.style.color=mins<30?'var(--red)':'var(--yellow)';
      te.style.background=mins<30?'var(--red-bg)':'var(--yellow-bg)';
      te.textContent='⏳ Tank empty in ~'+(hrs>0?hrs+'h '+(mins%60)+'m':mins+' min')+' at current rate';
    } else { te.style.color='var(--green)'; te.style.background='var(--green-bg)'; te.textContent='✅ Tank level stable'; }
  } else if(!pumpOn){
    te.style.color='var(--green)'; te.style.background='var(--green-bg)'; te.textContent='✅ Pump off — tank not draining';
  }
}

// ─────────────────────────────────────────────
//  12. CHART + HISTORY TABLE
// ─────────────────────────────────────────────
function updateChartHistory(m, tmp, hum){
  if(labels.length>=10){ labels.shift(); mData.shift(); tData.shift(); }
  labels.push(nowTime());
  mData.push(m!=null   ? Math.round(m)          : null);
  tData.push(tmp!=null ? parseFloat(fmt(tmp))   : null);
  chart.update('none');
  if(tick%3===0) addHistoryRow(m, tmp, hum, pumpOn);
}

// ─────────────────────────────────────────────
//  CLOCK
// ─────────────────────────────────────────────
function resetDailyStats(){
  minTemp=999; maxTemp=-999;
  minMoist=999; maxMoist=-999;
  minHum=999; maxHum=-999;
  motionCount=0; sunHoursCount=0;
  manualWaterEstimate=0;
} 

function updateClock(){
  const now=new Date();
  el('clock').textContent=now.toLocaleTimeString('en-IN',{hour12:false});
  if(now.getHours()===0 && now.getMinutes()===0 && now.getSeconds()===0) resetDailyStats();
  const up=Math.round((Date.now()-startTime)/1000);
  const h=Math.floor(up/3600), m=Math.floor((up%3600)/60), s=up%60;
  el('uptime').textContent=(h>0?h+'h ':'')+( m>0?m+'m ':'')+s+'s';
  // Tick the manual override countdown every second
  updateOverrideUI();
}

// ── START ──
connectWS();
setInterval(updateClock,1000);
updateClock();
// ══════════════════════════════════════════════════════
//  ZENTRIX AI — API + Navigation + Tools
// ══════════════════════════════════════════════════════

// Keys loaded from localStorage
let GROQ_KEY       = localStorage.getItem('zentrix_groq_key')    || 'YOUR_GROQ_API_KEY_HERE';
let GEMINI_KEY     = localStorage.getItem('zentrix_gemini_key')  || 'YOUR_GEMINI_API_KEY_HERE';
let OPENROUTER_KEY = localStorage.getItem('zentrix_or_key')      || 'YOUR_OPENROUTER_API_KEY_HERE';

const GROQ_URL         = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL       = 'llama-3.3-70b-versatile';
const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'openrouter/auto';
const GEMINI_BASE      = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=';

// Farm location — loaded from settings, used by all AI tools and weather
let userLocation = localStorage.getItem('zentrix_district') || 'West Bengal';

// AI state
let _b64='', _crOn=true, _aBuf=[], _hist=[], _mic=null, _isL=false, _waT='';

// ── Navigation ──
function showAI(){
  el('wrap').style.display='none'; el('topbar').style.display='none';
  el('ai-page').style.display='block'; syncStrip();
}
function showDash(){
  el('wrap').style.display='block'; el('topbar').style.display='flex';
  el('ai-page').style.display='none';
}

// ── Read live sensors — null = disconnected, never coerce to 0 ──
function sens(){
  const d=sensorState;
  const raw=(key,fn)=>d[key]!=null?fn(d[key]):null;
  const m=raw('moisture',parseFloat), m2=raw('moisture2',parseFloat);
  const moisture=(m!=null&&m2!=null)?Math.round((m+m2)/2):(m2!=null)?Math.round(m2):(m!=null)?Math.round(m):null;
  const distRaw=raw('tankDist',parseFloat);
  const tank=distRaw!=null?Math.round(Math.max(0,Math.min(100,(1-distRaw/TANK_HEIGHT_CM)*100))):null;
  return {
    moisture,
    temp    :raw('temp',parseFloat),
    humidity:raw('humidity',v=>parseInt(v,10)),
    soilTemp:raw('soilTemp',parseFloat),
    ph      :raw('ph',parseFloat),
    tds     :raw('tds',v=>parseInt(v,10)),
    co2     :raw('co2',v=>parseInt(v,10)),
    ch4     :raw('ch4',v=>parseInt(v,10)),
    co      :raw('co',parseFloat),
    aqi     :raw('aqi',v=>parseInt(v,10)),
    tank,           // computed from sensorState.tankDist above
    battery:raw('battPct',v=>parseInt(v,10)), // sensorState.battPct → s.battery
    solar:raw('solarMw',v=>parseInt(v,10)),   // sensorState.solarMw → s.solar
    pump:pumpOn, water:parseFloat(waterUsed.toFixed(1)),
    pumpMins:Math.floor(pumpRuntime/60), motions:motionCount
  };
}
function sv(val,unit='',fallback='N/A'){ return val!=null?val+unit:fallback; }

function syncStrip(){
  const s=sens(), v=(val,u)=>val!=null?val+u:'--';
  el('s-m').textContent =v(s.moisture,'%');
  el('s-t').textContent =v(s.temp,'°C');
  el('s-h').textContent =v(s.humidity,'%');
  el('s-p').textContent =s.ph??'--';
  el('s-td').textContent=v(s.tds,'ppm');
  el('s-c').textContent =v(s.co2,'ppm');
  el('s-tk').textContent=v(s.tank,'%');
  el('s-b').textContent =v(s.battery,'%');
}
setInterval(()=>{ if(el('ai-page').style.display!=='none') syncStrip(); },5000);

// ── API key guard — called at top of every AI tool ──
function checkApiKey(){
  if(GROQ_KEY==='YOUR_GROQ_API_KEY_HERE'){
    // Show inline error without opening the full modal spinner
    const hint='🔑 Groq API key not set — open ⚙️ Settings and add your free key from console.groq.com';
    showAlert(hint,'red');
    // Also show in whatever panel is open
    document.querySelectorAll('.ai-out').forEach(e=>{
      if(e.style.display!=='none'){ e.className='ai-out err'; e.textContent=hint; }
    });
    return false;
  }
  return true;
}

// ── Groq text API ──
async function gemini(prompt, sys='', forceJson=true){
  if(GROQ_KEY==='YOUR_GROQ_API_KEY_HERE') throw new Error('Groq API key not set — open ⚙️ Settings and add your key');
  const messages=[];
  if(sys) messages.push({role:'system',content:sys});
  messages.push({role:'user',content:prompt});
  const r=await fetch(GROQ_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_KEY},
    body:JSON.stringify({model:GROQ_MODEL,messages,temperature:0.1,max_tokens:1000,response_format:forceJson?{type:'json_object'}:{type:'text'}})});
  if(!r.ok){ const e=await r.json().catch(()=>({})); const m=e.error?.message||'Groq error '+r.status; if(r.status===429) throw new Error('Groq quota exceeded — wait a minute and try again.'); throw new Error(m); }
  const d=await r.json(); return d.choices?.[0]?.message?.content||'';
}

// ── Gemini Vision (primary) + OpenRouter fallback ──
async function geminiVision(prompt, b64, sys=''){
  if(GEMINI_KEY!=='YOUR_GEMINI_API_KEY_HERE'){
    try{
      const parts=[]; if(sys) parts.push({text:sys+'\n\n'});
      parts.push({inline_data:{mime_type:'image/jpeg',data:b64}});
      parts.push({text:prompt});
      const r=await fetch(GEMINI_BASE+GEMINI_KEY,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({contents:[{parts}],generationConfig:{
          maxOutputTokens:4096,
          temperature:0.1,
          response_mime_type:'application/json'
        }})});
      const d=await r.json();
      if(r.ok){
        const candidate=d.candidates?.[0];
        const finishReason=candidate?.finishReason||'';
        if(finishReason==='MAX_TOKENS'){
          console.warn('[CropDoc] Gemini truncated (MAX_TOKENS) — trying OpenRouter');
          throw new Error('TRUNCATED');
        }
        return candidate?.content?.parts?.[0]?.text||'';
      }
      const msg=d.error?.message||'';
      if(!msg.includes('quota')&&!msg.includes('RESOURCE_EXHAUSTED')&&r.status!==429) throw new Error(msg||'Gemini Vision error '+r.status);
    }catch(e){
      if(e.message==='TRUNCATED'){/* fall through to OpenRouter */}
      else if(!e.message.includes('quota')&&!e.message.includes('RESOURCE_EXHAUSTED')) throw e;
    }
  }
  if(OPENROUTER_KEY==='YOUR_OPENROUTER_API_KEY_HERE') throw new Error('Gemini quota exceeded and OpenRouter key not set. Add your OpenRouter key in ⚙️ Settings.');
  const messages=[]; if(sys) messages.push({role:'system',content:sys});
  messages.push({role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+b64}}]});
  const r=await fetch(OPENROUTER_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+OPENROUTER_KEY,'HTTP-Referer':'https://zentrix-agro.local','X-Title':'Zentrix AgroEcosystem'},
    body:JSON.stringify({model:OPENROUTER_MODEL,messages,temperature:0.1,max_tokens:3000})});
  if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error?.message||'OpenRouter Vision error '+r.status); }
  const d=await r.json(); return d.choices?.[0]?.message?.content||'';
}

// ── JSON parser ──
function parseJ(raw){
  if(!raw||!raw.trim()) throw new Error('Empty AI response — check API key and try again.');
  let s=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  try{ return JSON.parse(s); }catch(e1){
    const st=s.indexOf('{'), en=s.lastIndexOf('}');
    if(st!==-1&&en!==-1&&en>st){
      const block=s.slice(st,en+1);
      try{ return JSON.parse(block); }catch(e2){
        const fixed=block.replace(/,\s*([\]}])/g,'$1');
        try{ return JSON.parse(fixed); }catch(e3){
          try{
            let p=fixed; let br=0,bk=0,inS=false,esc=false;
            for(let c of p){ if(esc){esc=false;continue;} if(c==='\\'){ esc=true;continue;} if(c==='"'){inS=!inS;continue;} if(inS) continue; if(c==='{') br++; else if(c==='}') br--; if(c==='[') bk++; else if(c===']') bk--; }
            p=p.replace(/,\s*"[^"]*$/,'').replace(/,\s*$/,'');
            p+=']'.repeat(Math.max(0,bk))+'}'. repeat(Math.max(0,br));
            return JSON.parse(p);
          }catch(e4){ throw new Error('Format error. Raw: '+block.substring(0,300).replace(/</g,'&lt;')); }
        }
      }
    }
    throw new Error('No JSON found. Raw: '+s.substring(0,200).replace(/</g,'&lt;'));
  }
}

// ── Modal system ──
function openModal(title,subtitle,poweredBy){
  el('ai-modal-title').innerHTML=title;
  el('ai-modal-subtitle').textContent=subtitle||'Zentrix AI Analysis';
  el('modal-powered-by').textContent=poweredBy||'Groq · Llama 3.3 70B · Live sensor data';
  el('ai-modal-loading').style.display='flex';
  el('ai-modal-content').style.display='none';
  el('ai-modal-content').innerHTML='';
  el('ai-modal-overlay').classList.add('show');
  el('ai-modal').classList.add('show');
  document.body.style.overflow='hidden';
}
function showModalLoading(msg){ el('modal-loading-msg').textContent=msg||'AI is thinking...'; el('ai-modal-loading').style.display='flex'; el('ai-modal-content').style.display='none'; }
function showModalResult(html){ el('ai-modal-loading').style.display='none'; const c=el('ai-modal-content'); c.style.display='block'; c.innerHTML=html; el('ai-modal-body').scrollTop=0; }
function showModalError(msg){ el('ai-modal-loading').style.display='none'; const c=el('ai-modal-content'); c.style.display='block'; c.innerHTML=`<div style="padding:20px;background:var(--red-bg);border-radius:10px;color:var(--red);font-size:13px;font-weight:600;">❌ ${msg}</div>`; }
function closeModal(){ el('ai-modal-overlay').classList.remove('show'); el('ai-modal').classList.remove('show'); document.body.style.overflow=''; }
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeModal(); });

function out(id,html,cls=''){ const e=el(id); e.className='ai-out'+(cls?' '+cls:''); e.innerHTML=html; e.style.display='block'; }

function tog(id){
  const panel=el('p-'+id),btn=el('ob-'+id),card=el('c-'+id);
  const isOpen=panel.classList.contains('show');
  document.querySelectorAll('.ai-panel').forEach(p=>p.classList.remove('show'));
  document.querySelectorAll('.ai-open-btn').forEach(b=>{ b.classList.remove('on'); b.textContent=b.textContent.replace('▼','▶'); });
  document.querySelectorAll('.ai-card').forEach(c=>c.classList.remove('open'));
  if(!isOpen){ panel.classList.add('show'); btn.classList.add('on'); btn.textContent=btn.textContent.replace('▶','▼'); card.classList.add('open'); syncStrip(); card.scrollIntoView({behavior:'smooth',block:'nearest'}); }
}

// ═══════════ TOOL 1 — CropDoc ═══════════
function prevCrop(inp){
  const f=inp.files[0]; if(!f) return;
  const rd=new FileReader();
  rd.onload=e=>{ _b64=e.target.result.split(',')[1]; const img=el('crop-img'); img.src=e.target.result; img.style.display='block'; el('crop-placeholder').style.display='none'; out('o-cropdoc','📷 Photo ready — tap Diagnose.','idle'); };
  rd.readAsDataURL(f);
}
function clrCrop(){ _b64=''; el('crop-img').style.display='none'; el('crop-img').src=''; el('crop-placeholder').style.display='block'; el('crop-file').value=''; out('o-cropdoc','Upload or capture a photo and tap Diagnose.','idle'); }

let _camStream=null, _camFacing='environment';
function handleCameraBtn(){ if(/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) el('crop-camera').click(); else openCamera(); }
async function openCamera(){
  try{
    _camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:_camFacing,width:{ideal:1280},height:{ideal:960}},audio:false});
    el('camera-preview').srcObject=_camStream;
    el('camera-modal-overlay').classList.add('show'); el('camera-modal').classList.add('show'); document.body.style.overflow='hidden';
  }catch(e){
    closeCamera();
    const isFile=location.protocol==='file:'||location.protocol==='content:';
    const msgs={local_file:{icon:'📁',title:'Camera blocked by browser',body:`Camera access is blocked when opening HTML files directly.<br><br><strong>Solution 1:</strong> Tap <strong>"Gallery"</strong> — Android lets you choose Camera from there.<br><strong>Solution 2:</strong> Open via ESP32 at <code>http://192.168.x.x</code>`},
      permission_denied:{icon:'🔒',title:'Camera permission denied',body:'Tap the 🔒 lock icon in address bar → Camera → Allow → Refresh. Or use Gallery.'},
      no_camera:{icon:'📷',title:'No camera found',body:'No camera detected. Please use Gallery instead.'},
      error:{icon:'⚠️',title:'Camera error',body:e.message||'Unknown error. Use Gallery instead.'}};
    const k=isFile?'local_file':e.name==='NotAllowedError'?'permission_denied':e.name==='NotFoundError'?'no_camera':'error';
    const m=msgs[k];
    openModal('📸 Camera Access','Camera setup help','');
    showModalResult(`<div style="text-align:center;padding:10px 0 20px;"><div style="font-size:52px;margin-bottom:12px;">${m.icon}</div><div style="font-size:17px;font-weight:700;color:var(--text);margin-bottom:12px;">${m.title}</div><div style="font-size:13px;color:var(--text2);line-height:1.8;text-align:left;background:var(--bg);padding:14px;border-radius:10px;">${m.body}</div></div><button onclick="el('crop-file').click();closeModal();" style="width:100%;padding:13px;background:var(--green);color:#fff;border:none;border-radius:10px;font-family:system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer;margin-top:10px;">📁 Use Gallery Instead</button>`);
  }
}
function closeCamera(){ if(_camStream){ _camStream.getTracks().forEach(t=>t.stop()); _camStream=null; } el('camera-modal-overlay').classList.remove('show'); el('camera-modal').classList.remove('show'); document.body.style.overflow=''; }
async function switchCamera(){ _camFacing=_camFacing==='environment'?'user':'environment'; closeCamera(); await openCamera(); }
function capturePhoto(){
  const v=el('camera-preview'), c=el('camera-canvas');
  c.width=v.videoWidth; c.height=v.videoHeight;
  c.getContext('2d').drawImage(v,0,0);
  const dataUrl=c.toDataURL('image/jpeg',0.85);
  _b64=dataUrl.split(',')[1];
  el('crop-img').src=dataUrl; el('crop-img').style.display='block'; el('crop-placeholder').style.display='none';
  out('o-cropdoc','📷 Photo captured — tap Diagnose.','idle');
  setTimeout(closeCamera,300);
}

async function runCropDoc(){
  if(!_b64){ out('o-cropdoc','⚠️ Please upload a photo first.','err'); return; }
  if(!checkApiKey()) return;
  openModal('🔬 CropDoc — Advanced Diagnosis','Deep pathology scan · ICAR · BCKV Protocols','Gemini 2.0 Flash Vision · ICAR · BCKV · PPQ West Bengal');
  showModalLoading('🔬 Running deep pathology scan — analysing lesion patterns, colour, texture...');
  const s=sens();

  // Sensor context fed to AI for refined diagnosis
  const sensorCtx=[
    s.temp!=null?`Air temp:${s.temp}°C (${s.temp>35?'heat stress — worsens viral/bacterial':s.temp<20?'cool — Botrytis/late blight risk':'normal'})`:null,
    s.humidity!=null?`Humidity:${s.humidity}% (${s.humidity>80?'HIGH — strong fungal/bacterial risk':s.humidity>60?'moderate fungal risk':'low risk'})`:null,
    s.moisture!=null?`Soil moisture:${s.moisture}% (${s.moisture<30?'drought stress — nutrient uptake blocked':s.moisture>75?'waterlogged — Pythium/Phytophthora risk':'normal'})`:null,
    s.ph!=null?`pH:${s.ph} (${s.ph<5.5?'acidic — Mn/Al toxicity, P locked out':s.ph>7.5?'alkaline — Fe/Zn/Mn deficiency likely':'optimal'})`:null,
    s.tds!=null?`TDS:${s.tds}ppm (${s.tds>600?'high salinity — tip burn/scorch likely':s.tds<100?'very low nutrients':'normal'})`:null,
    s.soilTemp!=null?`Soil temp:${s.soilTemp}°C (${s.soilTemp>32?'warm — Pythium risk up':s.soilTemp<15?'cool — uptake inhibited':'normal'})`:null,
  ].filter(Boolean).join('; ')||'No sensor data available';

  const sys=`You are Dr. CropDoc, a senior plant pathologist, virologist and entomologist with 30 years field experience in West Bengal, Bihar and Bangladesh. You have deep expertise in:
FUNGAL: Pyricularia oryzae (rice blast), Helminthosporium oryzae (brown spot), Alternaria spp., Fusarium spp., Sclerotinia sclerotiorum, Phytophthora infestans (late blight), Colletotrichum (anthracnose), Puccinia spp. (rusts), Botrytis cinerea, Cercospora spp., Septoria spp., Erysiphe spp. (powdery mildew), Plasmopara (downy mildew).
BACTERIAL: Xanthomonas oryzae pv. oryzae (BLB), Xanthomonas campestris, Pseudomonas syringae, Erwinia carotovora (soft rot), Ralstonia solanacearum (wilt).
VIRAL: TYLCV, CMV, TMV, tungro, yellow vein mosaic, PLRV, BYDV — identify by symptom pattern.
NUTRIENT DISORDERS: N deficiency (uniform pale yellow, older leaves first), Fe deficiency (interveinal chlorosis young leaves), Zn deficiency (khaira disease, white/brown streaks on rice), Mg deficiency (interveinal older leaves), Ca deficiency (tip burn, blossom end rot), K deficiency (marginal scorch).
PESTS: Spider mites (stippling + webbing), thrips (silvery streaks, leaf curl), aphids (honeydew, sooty mould), stem borers (dead heart/white ear), leaf miners (serpentine mines), whiteflies (yellowing + sticky honeydew), BPH (hopper burn), armyworms.
PRODUCTS in WB markets: Saaf 75WP (Carbendazim+Mancozeb), Bavistin 50WP (Carbendazim), Ridomil Gold MZ 68WP (Metalaxyl+Mancozeb), Indofil M-45 (Mancozeb), Score 250EC (Difenoconazole), Amistar Top 325SC (Azoxystrobin+Difenoconazole), Contaf Plus 5EC (Hexaconazole), Conika 5EC (Tebuconazole), Topsin-M 70WP (Thiophanate-methyl), Blitox 50WP (Copper oxychloride), Kavach 75WG (Chlorothalonil), Folicur 250EW (Tebuconazole), Melody Duo 66.8WP (Iprovalicarb+Propineb), Confidor 200SL (Imidacloprid), Regent 50SC (Fipronil), Coragen 20SC (Chlorantraniliprole), Larvin 75WG (Thiodicarb), Monocil 36SL (Monocrotophos), Phoskill 50EC (Quinalphos), Nuvan 76EC (Dichlorvos).
ORGANIC/BIOCONTROL: Trichoderma viride @4g/L, Trichoderma harzianum @4g/L (NOT generic neem oil), Pseudomonas fluorescens @10ml/L, Beauveria bassiana @5g/L, Bacillus subtilis @2g/L, NSKE 5% (Neem Seed Kernel Extract — far more effective than neem oil), Bordeaux mixture 1% (100g copper sulphate+100g lime/10L), copper oxychloride 50WP @3g/L, panchagavya 3%, jeevamrut 10%, karanja cake extract 5%.
USE SENSOR DATA to refine diagnosis: humidity>80% confirms fungal/bacterial; pH<5.5 → nutrient lockout not disease; waterlogged soil → Phytophthora not Alternaria; drought+high temp → spider mites/powdery mildew not bacterial.
Farmer location: ${userLocation}. Farm sensors now: ${sensorCtx}
CRITICAL: Never give vague advice. Give SPECIFIC pathogen species, EXACT brand names, EXACT doses (ml/L or g/L), EXACT spray intervals, FRAC/IRAC resistance group codes. Tailor advice to the farmers specific district in West Bengal. Respond ONLY with raw JSON. No markdown, no backticks.`;

  const prompt=`Examine this plant image with expert pathologist precision. Study: leaf colour (uniform/patchy/marginal/interveinal/tip burn), lesion shape (circular/angular/irregular/elongated/water-soaked), lesion border (chlorotic halo/dark/raised/sunken/none), any sporulation or mycelium, tissue texture (powdery/wet rot/dry necrosis/raised scab), vein discolouration, insect frass or webbing, overall vigour.

If this is NOT a plant/crop/agricultural image, set is_plant_image to false.

Return ONLY this exact JSON (use "Not observed" not null for unknown text fields):
{"is_plant_image":true,"image_description":"precise 1-sentence description of exactly what you see in the image","plant":"exact crop common name","plant_scientific":"Latin binomial e.g. Oryza sativa","plant_part":"leaf or stem or root or fruit or whole plant","growth_stage":"seedling or vegetative or tillering or flowering or fruiting or maturity","status":"Fungal Disease or Bacterial Disease or Viral Disease or Pest Damage or Nutrient Deficiency or Abiotic Stress or Healthy","disease":"exact disease or disorder name","disease_scientific":"pathogen Latin name or deficiency name e.g. Iron deficiency chlorosis","severity":"Low or Medium or High or Critical","confidence":"e.g. 87%","cause":"specific causal agent — exact species name, pest species, or nutrient factor","sensor_correlation":"how current farm sensor readings relate to this exact diagnosis — be technically specific","symptoms":["precise visual symptom 1 with colour, shape, location","precise visual symptom 2","precise visual symptom 3","symptom 4 if visible"],"differential_diagnosis":"the one disease most likely confused with this and exactly how to tell them apart visually","affected_area":"estimated % of visible tissue affected","spread_risk":"Low or Medium or High","spread_mechanism":"exact route — wind-borne conidia / water splash / insect vector / soil-borne / seed-borne / contact","favorable_conditions":"exact temperature range, humidity %, season — with West Bengal monsoon/Kharif/Rabi context","chemical_treatment":[{"step":1,"action":"Immediate curative spray","product":"exact WB market brand name","active_ingredient":"chemical name and % e.g. Azoxystrobin 18.2% + Difenoconazole 11.4%","frac_group":"FRAC group e.g. Group 11 + Group 3","dose":"exact dose e.g. 1ml per litre","spray_volume":"e.g. 500 L per hectare","repeat_interval":"e.g. every 10 days","timing":"early morning before 8am or evening after 5pm","precaution":"resistance and safety note"},{"step":2,"action":"Follow-up — different MoA to prevent resistance","product":"different FRAC group brand","active_ingredient":"chemical name","frac_group":"different FRAC group from step 1","dose":"exact dose","spray_volume":"volume per hectare","repeat_interval":"interval","timing":"morning or evening","precaution":"coverage and safety note"},{"step":3,"action":"Preventive protection of healthy surrounding crop","product":"contact/protectant fungicide brand","active_ingredient":"chemical name","frac_group":"FRAC group","dose":"dose","spray_volume":"volume","repeat_interval":"preventive interval","timing":"morning or evening","precaution":"note"}],"organic_treatment":[{"product":"specific biocontrol name — NOT generic neem oil","active_organism":"e.g. Trichoderma viride 1x10^8 CFU/g or NSKE 5%","dose":"exact dose e.g. 4g per litre water","method":"foliar spray or soil drench or seed treatment","frequency":"how often and for how long","effectiveness":"approx efficacy vs chemical e.g. 65-70% of chemical","source":"where to get in West Bengal — nearest KVK or district agriculture input centre"},{"product":"second specific organic option e.g. Bordeaux mixture 1% or Bacillus subtilis","active_organism":"active compound or organism","dose":"exact dose","method":"application method","frequency":"frequency","effectiveness":"efficacy","source":"WB source"}],"soil_amendment":"specific soil treatment based on sensor pH/TDS — e.g. agricultural lime @2 quintal per acre if pH below 5.5 to unlock nutrients, or zinc sulphate 21% @25kg per hectare — write Not required if sensors show normal","ipm_plan":"Week-by-week IPM: Week 1 — cultural + biocontrol; Week 2 — curative chemical (FRAC group X); Week 3 — preventive different FRAC group. Be specific with product names and doses.","cultural_controls":["specific action 1 e.g. remove and destroy affected leaves immediately — burn or deep burial only","specific action 2 e.g. avoid overhead irrigation — switch to furrow or drip","specific action 3 e.g. increase row spacing to 25cm for airflow"],"resistance_management":"FRAC/IRAC rotation plan: specify which groups to alternate and why — e.g. never use Group 3 triazoles more than twice consecutively, rotate with Group 11 strobilurins or Group 7 SDHIs","urgency":"Immediate — treat within 24h or Within 3 days or This week or Monitor only","economic_loss":"realistic yield loss % range if untreated AND estimated rupee loss per acre at current West Bengal mandi prices","west_bengal_context":"specific advice for the farmers district in West Bengal — current season (Kharif/Rabi/Boro), local risk factors, nearest agro input market, nearest KVK contact","prevention_next_season":"3 specific steps: 1. resistant variety name available in West Bengal 2. seed treatment product+exact dose 3. crop rotation recommendation suited to the farmers district"}`;

  try{
    const raw=await geminiVision(prompt,_b64,sys);
    const d=parseJ(raw);
    const sc={low:'chip-low',medium:'chip-med',high:'chip-high',critical:'chip-crit'}[(d.severity||'').toLowerCase()]||'chip-low';
    const urgColor=d.urgency&&d.urgency.includes('Immediate')?'var(--red)':d.urgency&&d.urgency.includes('3 days')?'var(--orange)':'var(--green)';

    if(d.is_plant_image===false){
      showModalResult(`<div style="text-align:center;padding:30px 20px;"><div style="font-size:48px;margin-bottom:12px;">🚫</div><div style="font-size:18px;font-weight:700;color:var(--red);margin-bottom:8px;">Not a Plant Image</div><div style="font-size:13px;color:var(--text2);margin-bottom:16px;">${d.image_description||'Image does not show a plant or crop.'}</div><div style="padding:12px 16px;background:var(--yellow-bg);border-radius:10px;font-size:13px;color:var(--text2);text-align:left;"><strong>Please upload:</strong><br>📸 A clear photo of a crop leaf, stem, fruit or root<br>🌿 Close-up showing disease symptoms or pest damage<br>🌾 Agricultural field or plant showing issues</div></div>`);
      return;
    }

    // Symptoms
    const syms=(Array.isArray(d.symptoms)?d.symptoms:[]).map(s=>`<div style="padding:5px 0;border-bottom:1px solid #F0F4F0;font-size:12px;color:var(--text2);">• ${s}</div>`).join('');

    // Chemical treatment steps — rich cards
    const chemSteps=(Array.isArray(d.chemical_treatment)?d.chemical_treatment:[]).map(t=>`
      <div style="background:var(--surface);border:1.5px solid var(--border);border-radius:9px;padding:10px 12px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="font-size:12px;font-weight:700;color:var(--text);">Step ${t.step||''} — ${t.action||''}</div>
          <span style="font-size:10px;background:var(--blue-bg);color:var(--blue);padding:2px 7px;border-radius:12px;font-weight:700;">${t.frac_group||''}</span>
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--green);margin-bottom:3px;">🧪 ${t.product||''}</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">${t.active_ingredient||''}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:5px;">
          <div style="background:var(--green-bg);border-radius:5px;padding:4px 6px;font-size:11px;text-align:center;"><div style="color:var(--text3);font-size:9px;">DOSE</div><div style="font-weight:700;color:var(--green);font-family:'Courier New',monospace;">${t.dose||'—'}</div></div>
          <div style="background:var(--blue-bg);border-radius:5px;padding:4px 6px;font-size:11px;text-align:center;"><div style="color:var(--text3);font-size:9px;">REPEAT</div><div style="font-weight:700;color:var(--blue);font-family:'Courier New',monospace;">${t.repeat_interval||'—'}</div></div>
          <div style="background:var(--orange-bg);border-radius:5px;padding:4px 6px;font-size:11px;text-align:center;"><div style="color:var(--text3);font-size:9px;">TIMING</div><div style="font-weight:700;color:var(--orange);font-family:'Courier New',monospace;">${(t.timing||'—').replace('early morning before 8am','< 8am').replace('evening after 5pm','> 5pm')}</div></div>
        </div>
        ${t.precaution?`<div style="font-size:11px;color:var(--orange);background:var(--orange-bg);border-radius:5px;padding:4px 8px;">⚠️ ${t.precaution}</div>`:''}
      </div>`).join('');

    // Organic treatment — specific cards
    const orgSteps=(Array.isArray(d.organic_treatment)?d.organic_treatment:[]).map(o=>`
      <div style="background:var(--teal-bg);border:1.5px solid var(--teal);border-radius:9px;padding:10px 12px;margin-bottom:7px;">
        <div style="font-size:13px;font-weight:700;color:var(--teal);margin-bottom:3px;">🌿 ${o.product||''}</div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:4px;font-style:italic;">${o.active_organism||''}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:5px;">
          <div style="background:rgba(0,105,92,.1);border-radius:5px;padding:4px 6px;font-size:11px;"><div style="color:var(--text3);font-size:9px;">DOSE</div><div style="font-weight:700;color:var(--teal);font-family:'Courier New',monospace;">${o.dose||'—'}</div></div>
          <div style="background:rgba(0,105,92,.1);border-radius:5px;padding:4px 6px;font-size:11px;"><div style="color:var(--text3);font-size:9px;">METHOD</div><div style="font-weight:700;color:var(--teal);">${o.method||'—'}</div></div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:3px;">Efficacy: <b style="color:var(--teal);">${o.effectiveness||'—'}</b> &nbsp;·&nbsp; Frequency: ${o.frequency||'—'}</div>
        ${o.source?`<div style="font-size:11px;color:var(--teal);">📍 Get in WB: ${o.source}</div>`:''}
      </div>`).join('');

    // Cultural controls
    const cultural=(Array.isArray(d.cultural_controls)?d.cultural_controls:[]).map(c=>`<div class="dstep"><span class="dnum">✓</span><span>${c}</span></div>`).join('');

    showModalResult(`
<div style="margin-bottom:10px;padding:9px 12px;background:var(--blue-bg);border-radius:9px;font-size:12px;color:var(--blue);">
  🔍 <strong>Image:</strong> ${d.image_description||''}
</div>

<!-- HEADER CARD -->
<div class="dcard" style="margin-bottom:10px;">
  <div class="dcard-head" style="flex-wrap:wrap;gap:6px;">
    <div style="flex:1;min-width:180px;">
      <div style="font-size:17px;font-weight:700;color:var(--text);">${d.disease||'Unknown'}</div>
      <div style="font-size:11px;color:var(--text3);margin-top:2px;font-style:italic;">${d.disease_scientific||''}</div>
      <div style="font-size:12px;color:var(--text3);margin-top:3px;">${d.plant||''} <em>(${d.plant_scientific||''})</em> · ${d.plant_part||''} · ${d.growth_stage||''}</div>
      <div style="font-size:12px;color:var(--text2);margin-top:2px;">Type: <b>${d.status||''}</b></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end;">
      <span class="${sc}" style="font-size:13px;padding:4px 12px;">${d.severity||''}</span>
      <span style="font-size:11px;color:var(--text3);">Confidence: <b>${d.confidence||'—'}</b></span>
    </div>
  </div>
  <div class="dcard-body">
    <div class="rrow"><span class="rlbl">Pathogen / Cause</span><span class="rval-right" style="color:var(--red);font-weight:700;">${d.cause||'—'}</span></div>
    <div class="rrow"><span class="rlbl">Affected Area</span><span style="font-size:12px;font-weight:700;color:var(--orange);">${d.affected_area||'—'}</span></div>
    <div class="rrow"><span class="rlbl">Spread Risk</span><span style="font-size:12px;font-weight:700;color:${d.spread_risk==='High'?'var(--red)':d.spread_risk==='Medium'?'var(--orange)':'var(--green)'};">${d.spread_risk||'—'} — ${d.spread_mechanism||''}</span></div>
    <div class="rrow"><span class="rlbl">🚨 Urgency</span><span style="font-size:12px;font-weight:700;color:${urgColor};">${d.urgency||'—'}</span></div>
    <div class="rrow"><span class="rlbl">Economic Loss</span><span style="font-size:12px;color:var(--red);text-align:right;max-width:60%;">${d.economic_loss||'—'}</span></div>
  </div>
</div>

<!-- SENSOR CORRELATION -->
${d.sensor_correlation&&d.sensor_correlation!=='Not observed'?`<div style="margin-bottom:10px;padding:9px 12px;background:#E8F5E9;border:1.5px solid var(--green-l);border-radius:9px;font-size:12px;color:var(--green);">📡 <strong>Sensor Analysis:</strong> ${d.sensor_correlation}</div>`:''}

<!-- SYMPTOMS -->
<div style="margin-bottom:10px;">
  <div class="ai-lbl">🔬 Symptoms Observed</div>
  <div style="background:var(--orange-bg);border-radius:8px;padding:8px 10px;margin-top:4px;">${syms}</div>
</div>

<!-- DIFFERENTIAL DIAGNOSIS -->
${d.differential_diagnosis&&d.differential_diagnosis!=='Not observed'?`<div style="margin-bottom:10px;padding:9px 12px;background:var(--yellow-bg);border-radius:9px;font-size:12px;color:var(--yellow);">⚖️ <strong>vs Similar Disease:</strong> ${d.differential_diagnosis}</div>`:''}

<!-- CHEMICAL TREATMENT -->
<div style="margin-bottom:10px;">
  <div class="ai-lbl">🧪 Chemical Treatment Protocol</div>
  <div style="margin-top:5px;">${chemSteps}</div>
</div>

<!-- RESISTANCE MANAGEMENT -->
${d.resistance_management&&d.resistance_management!=='Not observed'?`<div style="margin-bottom:10px;padding:9px 12px;background:var(--purple-bg);border-radius:9px;font-size:12px;color:var(--purple);">🔄 <strong>Resistance Management:</strong> ${d.resistance_management}</div>`:''}

<!-- ORGANIC / BIOCONTROL -->
<div style="margin-bottom:10px;">
  <div class="ai-lbl">🌿 Organic / Biocontrol Options</div>
  <div style="margin-top:5px;">${orgSteps}</div>
</div>

<!-- SOIL AMENDMENT -->
${d.soil_amendment&&d.soil_amendment!=='Not required'&&d.soil_amendment!=='Not observed'?`<div style="margin-bottom:10px;padding:9px 12px;background:var(--teal-bg);border-radius:9px;font-size:12px;color:var(--teal);">🪨 <strong>Soil Amendment:</strong> ${d.soil_amendment}</div>`:''}

<!-- IPM PLAN -->
${d.ipm_plan&&d.ipm_plan!=='Not observed'?`<div style="margin-bottom:10px;padding:9px 12px;background:var(--green-bg);border-radius:9px;font-size:12px;color:var(--green);">📋 <strong>3-Week IPM Plan:</strong><br><span style="line-height:1.8;">${d.ipm_plan}</span></div>`:''}

<!-- CULTURAL CONTROLS -->
${cultural?`<div style="margin-bottom:10px;"><div class="ai-lbl">🌾 Cultural Controls</div><div style="margin-top:4px;">${cultural}</div></div>`:''}

<!-- FAVORABLE CONDITIONS -->
${d.favorable_conditions&&d.favorable_conditions!=='Not observed'?`<div style="margin-bottom:10px;padding:9px 12px;background:var(--blue-bg);border-radius:9px;font-size:12px;color:var(--blue);">☁️ <strong>Conditions that worsen this:</strong> ${d.favorable_conditions}</div>`:''}

<!-- WEST BENGAL CONTEXT -->
${d.west_bengal_context&&d.west_bengal_context!=='Not observed'?`<div style="margin-bottom:10px;padding:9px 12px;background:#FFF3E0;border-radius:9px;font-size:12px;color:var(--orange);">📍 <strong>West Bengal context:</strong> ${d.west_bengal_context}</div>`:''}

<!-- PREVENTION NEXT SEASON -->
${d.prevention_next_season&&d.prevention_next_season!=='Not observed'?`<div style="padding:9px 12px;background:var(--green-bg);border-radius:9px;font-size:12px;color:var(--green);">🔮 <strong>Next Season Prevention:</strong> ${d.prevention_next_season}</div>`:''}
`);
  }catch(e){ showModalError(e.message); }
}


// ═══════════ TOOL 2 — Soil Rx ═══════════
async function runSoilRx(){
  if(!checkApiKey()) return;
  const s=sens(), crop=el('rx-crop').value;
  openModal('🧪 Soil Rx — Fertilizer Prescription',crop+' · '+userLocation,'Groq · Llama 3.3 70B · ICAR + BCKV Guidelines');
  showModalLoading('🧪 Analysing soil data and generating prescription...');
  const sys=`You are Dr. Soilcare, a senior soil scientist specialising in alluvial soils of the Gangetic delta, West Bengal. Follow ICAR SoilHealth Card protocols. Respond ONLY with raw JSON.`;
  const prompt=`Fertilizer prescription for ${crop}, ${userLocation}. Soil: pH ${sv(s.ph)}, TDS ${sv(s.tds,'ppm')}, Moisture ${sv(s.moisture,'%')}. Return ONLY compact JSON:
{"soil_assessment":"1 sentence","ph_status":"Acidic/Neutral/Alkaline","ph_action":"correction dose","nitrogen_status":"Deficient/Adequate","phosphorus_status":"Deficient/Adequate","potassium_status":"Deficient/Adequate","fertilizer_1":"Urea 46%N - qty - timing - Rs cost","fertilizer_2":"DAP/SSP - qty - timing - Rs cost","fertilizer_3":"MOP - qty - timing - Rs cost","fertilizer_4":"Zinc Sulphate - qty - timing - Rs cost","organic":"FYM/vermicompost dose","avoid":"what to avoid","yield_tip":"expert tip"}`;
  try{
    const raw=await gemini(prompt,sys); const d=parseJ(raw);
    const ferts=[d.fertilizer_1,d.fertilizer_2,d.fertilizer_3,d.fertilizer_4].filter(Boolean).map(f=>`<div class="fitem"><div class="fnote">${f}</div></div>`).join('');
    const macro=`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:8px 0;"><div style="padding:6px;background:var(--green-bg);border-radius:7px;text-align:center;font-size:11px;"><div style="font-weight:700;color:var(--green);">N</div><div>${d.nitrogen_status||'—'}</div></div><div style="padding:6px;background:var(--blue-bg);border-radius:7px;text-align:center;font-size:11px;"><div style="font-weight:700;color:var(--blue);">P</div><div>${d.phosphorus_status||'—'}</div></div><div style="padding:6px;background:var(--orange-bg);border-radius:7px;text-align:center;font-size:11px;"><div style="font-weight:700;color:var(--orange);">K</div><div>${d.potassium_status||'—'}</div></div></div>`;
    showModalResult(`<div style="padding:7px 9px;background:var(--blue-bg);border-radius:7px;font-size:12px;color:var(--blue);margin-bottom:6px;">🧪 ${d.soil_assessment||''}</div><div class="rrow"><span class="rlbl">pH Status</span><span style="font-size:12px;font-weight:700;color:var(--green);">${d.ph_status||'—'}</span></div><div class="rrow"><span class="rlbl">pH Fix</span><span class="rval-right">${d.ph_action||'—'}</span></div><div class="ai-lbl" style="margin-top:8px;">NPK Status</div>${macro}<div class="ai-lbl" style="margin-top:8px;">Fertilizer Prescription</div>${ferts}<div class="tag-strip tag-strip-teal">🌿 Organic: ${d.organic||'—'}</div><div class="tag-strip tag-strip-red">⚠️ Avoid: ${d.avoid||'—'}</div><div class="tag-strip tag-strip-yellow">💡 ${d.yield_tip||'—'}</div>`);
  }catch(e){ showModalError(e.message); }
}

// ═══════════ TOOL 3 — Mandi Oracle ═══════════
async function runMandi(){
  if(!checkApiKey()) return;
  const s=sens(), crop=el('m-crop').value, mkt=el('m-mkt').value;
  openModal('📈 Mandi Oracle — Market Price Analysis',crop+' · '+mkt,'Groq · Llama 3.3 70B · APMC West Bengal Data');
  showModalLoading('📈 Fetching market prices and trend analysis...');
  const sys=`You are a commodity market analyst for Indian APMC markets in West Bengal. Respond ONLY with raw JSON starting with { and ending with }.`;
  const prompt=`Analyse APMC market for ${crop} in ${mkt}, West Bengal as of ${new Date().toLocaleDateString('en-IN')}. Return JSON:
{"price_min":"rupee amount","price_max":"rupee amount","msp":"MSP amount","trend":"Rising or Stable or Falling","trend_reason":"specific reason","best_time":"timing advice","best_mandi":"nearest APMC mandi name in that district","transport_tip":"practical transport tip for farmers in that district","advice":"2 sentences of practical advice for a small farmer in that part of West Bengal"}`;
  try{
    const raw=await gemini(prompt,sys); const d=parseJ(raw);
    const tc=d.trend==='Rising'?'var(--green)':d.trend==='Falling'?'var(--red)':'var(--orange)';
    const tb=d.trend==='Rising'?'var(--green-bg)':d.trend==='Falling'?'var(--red-bg)':'var(--orange-bg)';
    showModalResult(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;"><div style="padding:10px;background:var(--green-bg);border-radius:8px;text-align:center;"><div style="font-size:10px;font-weight:700;color:var(--green);text-transform:uppercase;">Market Price</div><div style="font-size:20px;font-weight:700;color:var(--green);margin-top:3px;">₹${d.price_min}–₹${d.price_max}</div><div style="font-size:10px;color:var(--text3);">per quintal</div></div><div style="padding:10px;background:var(--blue-bg);border-radius:8px;text-align:center;"><div style="font-size:10px;font-weight:700;color:var(--blue);text-transform:uppercase;">Govt MSP</div><div style="font-size:20px;font-weight:700;color:var(--blue);margin-top:3px;">${d.msp&&!d.msp.includes('₹')?'₹'+d.msp:d.msp}</div><div style="font-size:10px;color:var(--text3);">per quintal</div></div></div><div style="padding:7px 10px;background:${tb};border-radius:7px;margin-bottom:7px;display:flex;align-items:center;gap:8px;"><span style="font-size:13px;font-weight:700;color:${tc};">${d.trend==='Rising'?'📈':d.trend==='Falling'?'📉':'➡️'} ${d.trend}</span><span style="font-size:12px;color:var(--text2);">${d.trend_reason}</span></div><div class="rrow"><span class="rlbl">Best Time to Sell</span><span class="rval-right">${d.best_time}</span></div><div class="rrow"><span class="rlbl">Best Mandi</span><span style="font-size:12px;font-weight:700;color:var(--green);">${d.best_mandi}</span></div><div class="rrow"><span class="rlbl">Transport</span><span class="rval-right">${d.transport_tip}</span></div><div style="padding:8px 10px;background:var(--yellow-bg);border-radius:7px;font-size:12px;color:var(--text2);margin-top:8px;line-height:1.5;">💡 ${d.advice}</div>`);
  }catch(e){ showModalError(e.message); }
}

// ═══════════ TOOL 4 — Crop Calendar ═══════════
async function runCal(){
  if(!checkApiKey()) return;
  const s=sens(), crop=el('cal-crop').value;
  const mn=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const cur=mn[new Date().getMonth()];
  openModal('📅 Crop Calendar — 6-Month Season Plan',crop+' · Starting '+cur+' · '+userLocation,'Groq · Llama 3.3 70B · KVK & BCKV WB Guidelines');
  showModalLoading('📅 Building your personalised crop calendar...');
  const sys=`You are a senior KVK officer at ICAR with expertise across all of West Bengal — covering Gangetic plains (Burdwan, Nadia, Murshidabad), coastal belts (Medinipur, South 24 Parganas), red laterite zones (Bankura, Purulia, Birbhum), and northern hills (Darjeeling, Jalpaiguri). You follow BCKV Kalyani and WB State Agriculture Department crop calendars for the specific district given. Respond ONLY with raw JSON.`;
  const prompt=`6-month crop calendar for ${crop} starting from ${cur}, ${userLocation}. Soil: pH=${sv(s.ph)}, TDS=${sv(s.tds,'ppm')}, Moisture=${sv(s.moisture,'%')}. Return JSON:
{"variety_recommendation":"best variety","summary":"2-sentence overview","expected_yield":"quintal per acre","months":[{"month":"name","phase":"growth phase","tasks":["task 1","task 2"],"fertilizer":"advice","irrigation":"schedule","pest_watch":"pest to monitor","alert":"key risk"},{"month":"","phase":"","tasks":[],"fertilizer":"","irrigation":"","pest_watch":"","alert":""},{"month":"","phase":"","tasks":[],"fertilizer":"","irrigation":"","pest_watch":"","alert":""},{"month":"","phase":"","tasks":[],"fertilizer":"","irrigation":"","pest_watch":"","alert":""},{"month":"","phase":"","tasks":[],"fertilizer":"","irrigation":"","pest_watch":"","alert":""},{"month":"","phase":"","tasks":[],"fertilizer":"","irrigation":"","pest_watch":"","alert":""}],"harvest_indicator":"when to harvest","govt_scheme":"relevant WB scheme"}`;
  try{
    const raw=await gemini(prompt,sys); const d=parseJ(raw);
    const cols=(d.months||[]).map((m,i)=>`<div class="cal-mo${i===0?' hi':''}"><div class="cal-mo-name">${m.month}</div><div style="font-size:10px;font-weight:700;color:var(--green);margin-bottom:2px;">${m.phase||''}</div><div style="font-size:11px;color:var(--text2);line-height:1.5;">${(m.tasks||[]).join(' · ')}</div>${m.fertilizer?`<div style="font-size:10px;color:var(--blue);margin-top:2px;">🧪 ${m.fertilizer}</div>`:''}${m.pest_watch?`<div style="font-size:10px;color:var(--purple);margin-top:1px;">🔍 ${m.pest_watch}</div>`:''}${m.alert?`<div style="font-size:10px;color:var(--orange);margin-top:2px;">⚠️ ${m.alert}</div>`:''}</div>`).join('');
    showModalResult(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:9px;"><div style="padding:7px 9px;background:var(--green-bg);border-radius:7px;font-size:11px;color:var(--green);"><span style="font-weight:700;">🌱 Variety:</span> ${d.variety_recommendation||'—'}</div><div style="padding:7px 9px;background:var(--blue-bg);border-radius:7px;font-size:11px;color:var(--blue);"><span style="font-weight:700;">📊 Expected:</span> ${d.expected_yield||'—'}</div></div><div style="padding:6px 9px;background:var(--green-bg);border-radius:7px;font-size:12px;color:var(--green);margin-bottom:7px;">🌾 ${d.summary||''}</div><div class="cal-strip">${cols}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px;"><div style="padding:7px 9px;background:var(--yellow-bg);border-radius:7px;font-size:11px;color:var(--yellow);"><span style="font-weight:700;">🌾 Harvest:</span> ${d.harvest_indicator||'—'}</div><div style="padding:7px 9px;background:var(--purple-bg);border-radius:7px;font-size:11px;color:var(--purple);"><span style="font-weight:700;">🏛️ Scheme:</span> ${d.govt_scheme||'—'}</div></div><div style="font-size:11px;color:var(--text3);margin-top:5px;">← Scroll to see all months</div>`);
  }catch(e){ showModalError(e.message); }
}

// ═══════════ TOOL 5 — AgriWeather Intel ═══════════
// Open-Meteo API — free, no key needed
// Geocoding: Open-Meteo Geocoding API to resolve district name → lat/lon
// WMO weather code reference: 95-99 = thunderstorm, 65/67/75/77 = heavy rain/snow
// 80-82 = rain showers, 45/48 = fog, 61-67 = rain

// Kept for backward compat — showAlert hook still calls crisisRegister
// but it's now a no-op accumulator (weather intel replaced the UI)
function crisisRegister(msg){ /* no-op — sensor alerts handled by PIR/gas cards */ }

// WMO code → emoji + label + severity
function wmoInfo(code){
  const c=parseInt(code,10);
  if(c===0)  return {icon:'☀️', label:'Clear sky',       risk:'none'};
  if(c<=2)   return {icon:'⛅', label:'Partly cloudy',   risk:'none'};
  if(c===3)  return {icon:'☁️', label:'Overcast',        risk:'none'};
  if(c<=48)  return {icon:'🌫️', label:'Fog',             risk:'low'};
  if(c<=57)  return {icon:'🌧️', label:'Drizzle',         risk:'low'};
  if(c<=67)  return {icon:'🌧️', label:'Rain',            risk:'medium'};
  if(c<=77)  return {icon:'❄️', label:'Snow/sleet',      risk:'medium'};
  if(c<=82)  return {icon:'🌦️', label:'Rain showers',    risk:'medium'};
  if(c<=86)  return {icon:'🌨️', label:'Snow showers',    risk:'medium'};
  if(c<=99)  return {icon:'⛈️', label:'THUNDERSTORM',    risk:'high'};
  return     {icon:'🌡️', label:'Unknown',               risk:'none'};
}

// Day-of-week label
function dayLabel(dateStr, idx){
  if(idx===0) return 'Today';
  if(idx===1) return 'Tomorrow';
  const d=new Date(dateStr);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

async function runWeatherForecast(){
  const lang = el('weather-lang').value;
  const loc = userLocation || 'West Bengal, India';
  out('o-crisis','<span class="spin"></span> Fetching live weather for '+loc+'...','idle');

  try{
    // ── Step 1: Geocode district name → lat/lon using Open-Meteo Geocoding ──
    const geoUrl='https://geocoding-api.open-meteo.com/v1/search?name='+encodeURIComponent(loc.split(',')[0].trim())+'&count=1&language=en&format=json';
    const geoResp=await fetch(geoUrl);
    const geoData=await geoResp.json();
    let lat=22.47, lon=88.12; // fallback: Howrah
    if(geoData.results&&geoData.results.length>0){
      lat=geoData.results[0].latitude;
      lon=geoData.results[0].longitude;
    }

    // ── Step 2: Fetch real weather from Open-Meteo ──
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude='+lat+'&longitude='+lon
      + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,windspeed_10m_max,winddirection_10m_dominant'
      + '&hourly=precipitation_probability,weathercode'
      + '&current_weather=true'
      + '&timezone=Asia%2FKolkata'
      + '&forecast_days=8';

    const resp = await fetch(url);
    if(!resp.ok) throw new Error('Weather API error: '+resp.status);
    const w = await resp.json();

    const cur   = w.current_weather || {};
    const daily = w.daily           || {};
    const dates = daily.time        || [];
    const codes = daily.weathercode || [];
    const tmax  = daily.temperature_2m_max || [];
    const tmin  = daily.temperature_2m_min || [];
    const prec  = daily.precipitation_sum  || [];
    const prob  = daily.precipitation_probability_max || [];
    const wind  = daily.windspeed_10m_max  || [];

    // ── Step 3: Detect storm days ──
    const stormDays = dates.map((d,i)=>({date:d,code:codes[i],idx:i}))
      .filter(d => parseInt(d.code,10) >= 80);
    const hasThunder  = stormDays.some(d => parseInt(d.code,10) >= 95);
    const hasHeavyRain= stormDays.some(d => parseInt(d.code,10) >= 61);

    // ── Step 4: Build compact weather summary for AI ──
    const s = sens();
    const farmCtx = [
      s.moisture!=null?`Soil moisture: ${s.moisture}%`:null,
      s.temp!=null?`Field temp: ${s.temp}°C`:null,
      s.humidity!=null?`Humidity: ${s.humidity}%`:null,
    ].filter(Boolean).join(', ') || 'No sensors connected';

    const forecastText = dates.slice(0,8).map((d,i)=>{
      const info=wmoInfo(codes[i]);
      return `${dayLabel(d,i)} (${d}): ${info.icon} ${info.label}, Max:${tmax[i]}°C Min:${tmin[i]}°C, Rain:${prec[i]}mm, RainProb:${prob[i]}%, Wind:${wind[i]}km/h`;
    }).join('\n');

    // ── Step 5: AI agronomic interpretation ──
    if(!checkApiKey()){ out('o-crisis','🔑 Add Groq API key in ⚙️ Settings for AI farm advice (weather data loaded above)','err'); return; }
    out('o-crisis','<span class="spin"></span> AI analysing forecast for your farm...','idle');

    const sys = `You are a senior agronomist and weather analyst specialising in West Bengal agriculture — covering all agro-ecological zones from Gangetic alluvial plains (Burdwan, Nadia, Murshidabad) to coastal belts (Medinipur, South 24 Parganas), red laterite zones (Bankura, Purulia, Birbhum) and northern Terai-Dooars (Jalpaiguri, Cooch Behar). You combine live weather forecasts with ICAR crop management protocols to give precise, actionable daily farm advice specific to the farmers district. Always write in ${lang}. Be specific — name exact farm operations, spray timings, drainage actions, harvest windows relevant to that district. Keep each day advice to 1-2 sentences. If thunderstorm or cyclone or heavy rain is forecast, lead with a prominent WARNING. Respond ONLY with raw JSON.`;

    const prompt = `Location: ${loc} (${lat.toFixed(2)}°N ${lon.toFixed(2)}°E). Current: ${cur.temperature||'--'}°C, wind ${cur.windspeed||'--'}km/h.
Farm sensors: ${farmCtx}.

8-day forecast:
${forecastText}

Analyse this forecast from an agricultural perspective for a small farmer in ${loc}. Return ONLY this JSON:
{
  "overall_risk": "Low or Medium or High or Extreme",
  "risk_summary": "1-sentence headline about the week's main risk for farmers",
  "thunderstorm_warning": "${hasThunder ? 'YES — specify which days and exact risk to crops/equipment' : 'NO'}",
  "heavy_rain_warning": "${hasHeavyRain ? 'YES — specify days and drainage/flood risk' : 'NO'}",
  "today_summary": "today's weather impact on farm work — specific operations to do or avoid",
  "spray_advisory": "exact days safe for pesticide/fungicide spray (avoid rain + 4hrs window) vs days to avoid",
  "irrigation_advisory": "should farmer irrigate today and in coming days — based on rain forecast and sensor moisture if available",
  "harvest_advisory": "if any crops near harvest, which days are safe vs risky",
  "field_work_days": ["Day label that is safe for field work e.g. Today", "Day 2 label"],
  "avoid_days": ["Day label to avoid outdoor farm work"],
  "days": [
    {"day": "Today", "date": "${dates[0]||''}", "icon": "emoji", "condition": "short label", "temp_max": "°C", "temp_min": "°C", "rain_prob": "%", "rain_mm": "mm", "wind": "km/h", "farm_action": "1 specific farming action for this day in ${lang}"},
    {"day": "Tomorrow", "date": "${dates[1]||''}", "icon": "emoji", "condition": "label", "temp_max": "°C", "temp_min": "°C", "rain_prob": "%", "rain_mm": "mm", "wind": "km/h", "farm_action": "specific farming action in ${lang}"},
    {"day": "${dayLabel(dates[2]||'',2)}", "date": "${dates[2]||''}", "icon": "emoji", "condition": "label", "temp_max": "°C", "temp_min": "°C", "rain_prob": "%", "rain_mm": "mm", "wind": "km/h", "farm_action": "specific action in ${lang}"},
    {"day": "${dayLabel(dates[3]||'',3)}", "date": "${dates[3]||''}", "icon": "emoji", "condition": "label", "temp_max": "°C", "temp_min": "°C", "rain_prob": "%", "rain_mm": "mm", "wind": "km/h", "farm_action": "specific action in ${lang}"},
    {"day": "${dayLabel(dates[4]||'',4)}", "date": "${dates[4]||''}", "icon": "emoji", "condition": "label", "temp_max": "°C", "temp_min": "°C", "rain_prob": "%", "rain_mm": "mm", "wind": "km/h", "farm_action": "specific action in ${lang}"},
    {"day": "${dayLabel(dates[5]||'',5)}", "date": "${dates[5]||''}", "icon": "emoji", "condition": "label", "temp_max": "°C", "temp_min": "°C", "rain_prob": "%", "rain_mm": "mm", "wind": "km/h", "farm_action": "specific action in ${lang}"},
    {"day": "${dayLabel(dates[6]||'',6)}", "date": "${dates[6]||''}", "icon": "emoji", "condition": "label", "temp_max": "°C", "temp_min": "°C", "rain_prob": "%", "rain_mm": "mm", "wind": "km/h", "farm_action": "specific action in ${lang}"},
    {"day": "${dayLabel(dates[7]||'',7)}", "date": "${dates[7]||''}", "icon": "emoji", "condition": "label", "temp_max": "°C", "temp_min": "°C", "rain_prob": "%", "rain_mm": "mm", "wind": "km/h", "farm_action": "specific action in ${lang}"}
  ]
}`;

    const raw = await gemini(prompt, sys, true);
    const fc = parseJ(raw);

    // ── Step 6: Render ──
    const riskColors = {
      Low:     {bg:'var(--green-bg)',  color:'var(--green)'},
      Medium:  {bg:'var(--yellow-bg)', color:'var(--yellow)'},
      High:    {bg:'var(--orange-bg)', color:'var(--orange)'},
      Extreme: {bg:'var(--red-bg)',    color:'var(--red)'}
    };
    const rc = riskColors[fc.overall_risk] || riskColors.Medium;

    // Day cards
    const dayCards = (Array.isArray(fc.days)?fc.days:[]).map(d=>{
      const rainNum = parseFloat(d.rain_prob)||0;
      const rainColor = rainNum>=70?'var(--red)':rainNum>=40?'var(--orange)':'var(--blue)';
      return `<div style="min-width:90px;flex-shrink:0;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;padding:9px 8px;text-align:center;">
  <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;">${d.day||''}</div>
  <div style="font-size:26px;margin:4px 0;">${d.icon||'🌡️'}</div>
  <div style="font-size:10px;color:var(--text2);margin-bottom:4px;line-height:1.3;">${d.condition||''}</div>
  <div style="font-size:12px;font-weight:700;color:var(--orange);">${d.temp_max||'--'}°</div>
  <div style="font-size:10px;color:var(--text3);">${d.temp_min||'--'}°</div>
  <div style="font-size:10px;font-weight:700;color:${rainColor};margin-top:3px;">💧${d.rain_prob||'0'}%</div>
  <div style="font-size:9px;color:var(--text3);">${d.rain_mm||'0'}mm</div>
</div>`;
    }).join('');

    // Action pills per day
    const actionRows = (Array.isArray(fc.days)?fc.days:[]).map(d=>`
<div style="padding:7px 10px;border-bottom:1px solid #F0F4F0;font-size:12px;display:flex;gap:8px;align-items:flex-start;">
  <span style="font-size:15px;flex-shrink:0;">${d.icon||'🌡️'}</span>
  <div><span style="font-weight:700;color:var(--text);">${d.day}</span><span style="color:var(--text3);font-size:11px;"> · ${d.date||''}</span><br><span style="color:var(--text2);">${d.farm_action||''}</span></div>
</div>`).join('');

    const html = `
${(hasThunder)?`<div style="padding:10px 14px;background:var(--red-bg);border:2px solid var(--red-l);border-radius:10px;margin-bottom:10px;display:flex;align-items:flex-start;gap:10px;">
  <span style="font-size:24px;">⛈️</span>
  <div><div style="font-size:13px;font-weight:700;color:var(--red);">THUNDERSTORM WARNING — ${loc}</div><div style="font-size:12px;color:var(--red);margin-top:3px;">${fc.thunderstorm_warning||'Thunderstorm forecast in coming days. Secure equipment and protect crops.'}</div></div>
</div>`:''}

${(hasHeavyRain&&!hasThunder)?`<div style="padding:10px 14px;background:var(--orange-bg);border:2px solid var(--orange-l);border-radius:10px;margin-bottom:10px;display:flex;align-items:flex-start;gap:10px;">
  <span style="font-size:24px;">🌧️</span>
  <div><div style="font-size:13px;font-weight:700;color:var(--orange);">HEAVY RAIN ADVISORY</div><div style="font-size:12px;color:var(--orange);margin-top:3px;">${fc.heavy_rain_warning||'Heavy rain expected. Ensure field drainage.'}</div></div>
</div>`:''}

<div style="padding:9px 12px;background:${rc.bg};border-radius:9px;margin-bottom:10px;">
  <div style="font-size:11px;font-weight:700;color:${rc.color};text-transform:uppercase;letter-spacing:.8px;">Weekly Farm Risk: ${fc.overall_risk||'—'}</div>
  <div style="font-size:13px;color:${rc.color};margin-top:3px;">${fc.risk_summary||''}</div>
</div>

<div style="overflow-x:auto;margin-bottom:12px;">
  <div style="display:flex;gap:7px;padding:4px 0;min-width:max-content;">${dayCards}</div>
</div>

<div class="ai-lbl">📋 Daily Farm Action Plan</div>
<div style="background:var(--surface);border:1.5px solid var(--border);border-radius:9px;overflow:hidden;margin-top:5px;margin-bottom:10px;">${actionRows}</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:8px;">
  <div style="padding:8px 10px;background:var(--blue-bg);border-radius:8px;font-size:12px;color:var(--blue);">🧪 <strong>Spray days:</strong><br>${fc.spray_advisory||'—'}</div>
  <div style="padding:8px 10px;background:var(--green-bg);border-radius:8px;font-size:12px;color:var(--green);">💧 <strong>Irrigation:</strong><br>${fc.irrigation_advisory||'—'}</div>
</div>

${fc.harvest_advisory?`<div style="padding:8px 10px;background:var(--yellow-bg);border-radius:8px;font-size:12px;color:var(--yellow);margin-bottom:7px;">🌾 <strong>Harvest window:</strong> ${fc.harvest_advisory}</div>`:''}

<div style="padding:7px 10px;background:var(--green-bg);border-radius:8px;font-size:11px;color:var(--text3);">📡 Data: Open-Meteo · ${loc} (${lat.toFixed(2)}°N ${lon.toFixed(2)}°E) · AI: Groq Llama 3.3 70B · Updated: ${new Date().toLocaleTimeString('en-IN',{hour12:false})}</div>`;

    openModal('🌦️ AgriWeather Intel — '+loc,'7-Day Forecast + Farm Action Plan · '+lang,'Open-Meteo Live Data · Groq Llama 3.3 70B · ICAR Protocols');
    showModalResult(html);
    out('o-crisis','✅ Forecast loaded — tap again to refresh.','ok');

  }catch(e){
    out('o-crisis','❌ '+e.message,'err');
    showModalError('Weather fetch failed: '+e.message+'\n\nCheck your internet connection and try again.');
  }
}

// ═══════════ TOOL 7 — Bhasha Bridge (Fixed) ═══════════

// ── Parse lang selector → {locale, name, greeting} ──
function bLangParts(){
  const v=el('b-lang').value; // "bn-IN|Bengali|বাংলা"
  const p=v.split('|');
  return { locale:p[0]||'en-IN', name:p[1]||'English', script:p[2]||'English' };
}

// ── Greetings per language ──
const BHASHA_GREET={
  Bengali:'নমস্কার! আমি Zentrix কৃষি সহায়ক। আবহাওয়া, বাজার দাম, চাষ পরামর্শ — যেকোনো কৃষি প্রশ্ন করুন।',
  Hindi:'नमस्ते! मैं Zentrix कृषि सहायक हूँ। मौसम, बाज़ार भाव, खेती की सलाह — कोई भी कृषि सवाल पूछें।',
  English:'Hello! I am Zentrix Krishi Sahayak. Ask me anything — weather forecast, market prices, crop advice, pest control, government schemes, or farm sensor analysis.'
};

function togMic(){
  if(_isL){ stopMic(); return; }
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ addMsg('⚠️ Voice not supported. Please use Chrome browser.','b'); return; }
  const {locale}=bLangParts();
  _mic=new SR(); _mic.lang=locale; _mic.interimResults=false;
  _mic.onstart=()=>{ _isL=true; setBtn('⏹ Stop','var(--red)'); setVS('on','🎤 Listening...'); };
  _mic.onresult=e=>{ const t=e.results[0][0].transcript; addMsg(t,'u'); processB(t); };
  _mic.onerror=e=>{ stopMic(); addMsg('Mic error: '+e.error,'b'); };
  _mic.onend=()=>stopMic();
  _mic.start();
}
function stopMic(){ _isL=false; if(_mic){try{_mic.stop();}catch(e){}_mic=null;} setBtn('🎤 Tap to Speak','var(--orange)'); setVS('idle','● Ready to listen'); }
function setBtn(t,bg){ const b=el('mic-btn'); b.textContent=t; b.style.background=bg; }
function setVS(c,t){ const e=el('v-status'); e.className='vind '+c; e.textContent=t; }
function addMsg(t,r){ const c=el('b-chat'),d=document.createElement('div'); d.className='cmsg '+r; d.textContent=t; c.appendChild(d); c.scrollTop=c.scrollHeight; }
function clrChat(){
  const {name}=bLangParts();
  el('b-chat').innerHTML='<div class="cmsg b">'+( BHASHA_GREET[name]||BHASHA_GREET['English'])+'</div>';
  _hist=[];
}
function sendTxt(){ const i=el('b-inp'),t=i.value.trim(); if(!t) return; i.value=''; addMsg(t,'u'); processB(t); }

// ── Detect if user is asking about real-world weather ──
function _isWeatherQuery(txt){
  const w=[
    // English
    'weather','forecast','rain','rainfall','temperature outside','humidity outside',
    'will it rain','chance of rain','sunny','cloudy','storm','thunderstorm','wind',
    // Bengali
    'আবহাওয়া','বৃষ্টি','বৃষ্টিপাত','তাপমাত্রা','পূর্বাভাস','রোদ','মেঘ','ঝড়','বন্যা','আজকের আবহাওয়া','কাল বৃষ্টি','ঝড়বৃষ্টি',
    // Hindi
    'मौसम','बारिश','वर्षा','तापमान','पूर्वानुमान','धूप','बादल','आंधी','तूफान','कल का मौसम'
  ];
  const lo=txt.toLowerCase();
  return w.some(k=>lo.includes(k.toLowerCase()));
}

// ── Fetch real weather from Open-Meteo for Bhasha Bridge ──
async function _bhashaWeather(){
  const loc=userLocation||'West Bengal, India';
  const geoUrl='https://geocoding-api.open-meteo.com/v1/search?name='+encodeURIComponent(loc.split(',')[0].trim())+'&count=1&language=en&format=json';
  const geoD=await fetch(geoUrl).then(r=>r.json());
  let lat=22.47,lon=88.12;
  if(geoD.results&&geoD.results.length){ lat=geoD.results[0].latitude; lon=geoD.results[0].longitude; }
  const wUrl='https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon
    +'&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max'
    +'&timezone=Asia%2FKolkata&forecast_days=4';
  const wResp=await fetch(wUrl);
  if(!wResp.ok) throw new Error('Weather API error: '+wResp.status);
  const w=await wResp.json();
  const cur=w.current_weather||{};
  const daily=w.daily||{};
  // Null-safe array extraction
  const times = daily.time                        || [];
  const codes = daily.weathercode                 || [];
  const tmins = daily.temperature_2m_min          || [];
  const tmaxs = daily.temperature_2m_max          || [];
  const precs = daily.precipitation_sum           || [];
  const pprob = daily.precipitation_probability_max || [];
  const wmo=code=>{ const c=parseInt(code);
    if(c===0)return'☀️ Clear'; if(c<=2)return'⛅ Partly cloudy'; if(c===3)return'☁️ Overcast';
    if(c<=48)return'🌫️ Fog'; if(c<=67)return'🌧️ Rain'; if(c<=82)return'🌦️ Showers'; if(c<=99)return'⛈️ Thunderstorm'; return'🌡️';
  };
  const days=times.slice(0,4).map((d,i)=>{
    const label=i===0?'Today':i===1?'Tomorrow':new Date(d).toLocaleDateString('en-IN',{weekday:'short'});
    const tmin=tmins[i]!=null?tmins[i]:'?';
    const tmax=tmaxs[i]!=null?tmaxs[i]:'?';
    const prec=precs[i]!=null?precs[i]:'0';
    const prob=pprob[i]!=null?pprob[i]:'?';
    return `${label}: ${wmo(codes[i])} ${tmin}–${tmax}°C, Rain ${prec}mm (${prob}% chance)`;
  }).join('\n');
  const curDesc=cur.temperature!=null?`${wmo(cur.weathercode)} ${cur.temperature}°C, Wind ${cur.windspeed||'?'} km/h`:'Data unavailable';
  return `LIVE WEATHER DATA for ${loc} (Open-Meteo API):\nNow: ${curDesc}\n4-Day Forecast:\n${days}`;
}
async function speakGroq(text, locale){
  try{
    const voice = locale.startsWith('bn') ? 'Aaliyah-PlayAI'
                : locale.startsWith('hi') ? 'Aaliyah-PlayAI'
                : 'Fritz-PlayAI';
    const r=await fetch('https://api.groq.com/openai/v1/audio/speech',{
      method:'POST',
      headers:{'Authorization':'Bearer '+GROQ_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({model:'playai-tts',voice,input:text,response_format:'wav'})
    });
    if(!r.ok) throw new Error('TTS failed');
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const audio=new Audio(url);
    setVS('spk','🔊 Speaking...');
    audio.play();
    audio.onended=()=>{ setVS('idle','● Ready to listen'); URL.revokeObjectURL(url); };
  }catch(e){
    // Fallback to browser TTS if Groq TTS fails
    const u=new SpeechSynthesisUtterance(text);
    u.lang=locale; u.rate=0.92; u.pitch=1.05;
    const voices=window.speechSynthesis.getVoices();
    const best=voices.find(v=>v.lang===locale&&!v.localService)||voices.find(v=>v.lang===locale)||voices.find(v=>v.lang.startsWith(locale.split('-')[0]));
    if(best) u.voice=best;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    u.onend=()=>setVS('idle','● Ready to listen');
  }
}
async function processB(txt){
  if(!checkApiKey()){ addMsg('🔑 Groq API key not set — open ⚙️ Settings to add your free key','b'); setVS('idle','● Ready'); return; }
  setVS('spk','⏳ Thinking...');

  // ── Resolve selected language — STRICT, not auto-detected ──
  const {locale, name:langName}=bLangParts();

  const s=sens();

  // ── If weather query → fetch real forecast first, inject into context ──
  let weatherCtx='';
  if(_isWeatherQuery(txt)){
    try{
      setVS('spk','🌦️ Fetching live weather...');
      weatherCtx=await _bhashaWeather();
    }catch(e){ weatherCtx='Weather API unavailable: '+e.message; }
  }

  // ── Build STRICT system prompt ──
  const langInstruction=`CRITICAL LANGUAGE RULE: You MUST respond ONLY in ${langName}. No exceptions. Do not mix languages. The user has explicitly selected ${langName} as their preferred language. Even if the user writes in a different language, you must reply in ${langName} only.`;

  const sensorCtx=`Live farm sensors (${userLocation}): Soil Moisture=${sv(s.moisture,'%')}, Air Temp=${sv(s.temp,'°C')}, Air Humidity=${sv(s.humidity,'%')}, Soil pH=${sv(s.ph)}, TDS=${sv(s.tds,'ppm')}, CO₂=${sv(s.co2,'ppm')}, Water Tank=${sv(s.tank,'%')}, Battery=${sv(s.battery,'%')}, Solar=${sv(s.solar,'mW')}, Pump is currently ${s.pump?'ON (irrigating)':'OFF'}.`;

  const sys=`You are Zentrix Krishi Sahayak, an advanced AI agricultural assistant for farmers in ${userLocation}, West Bengal, India.

${langInstruction}

KNOWLEDGE SCOPE (answer ALL of these accurately — do NOT restrict to farm sensors only):
1. REAL WEATHER: When weather data is provided below, use it. Give actual forecast temperatures, rain probability, and farm advice based on that real data.
2. AGRICULTURE: Paddy, jute, mustard, vegetables, potato — ICAR & BCKV recommendations, sowing calendar, fertilizer schedules, irrigation timing.
3. PEST & DISEASE: Specific diagnosis with exact chemical names, doses (ml/L or g/L), spray timing. Use West Bengal market brand names.
4. MARKET PRICES: Current APMC mandi rates in West Bengal, MSP, best time to sell.
5. GOVT SCHEMES: PM-KISAN, Krishak Bandhu, WBMDFC, PM Fasal Bima, Kisan Credit Card — eligibility, how to apply.
6. SOIL HEALTH: Interpret pH, TDS, moisture sensor values with specific corrective actions.
7. ORGANIC FARMING: Trichoderma, Pseudomonas, Bacillus, NSKE, jeevamrut — specific doses.
8. FARM CONTROL: If user asks to turn pump/valve/scarecrow on or off, append ACTION:{"pump":true/false} or ACTION:{"valve":true/false} or ACTION:{"scarecrow":true/false} on a new final line.

${weatherCtx ? 'REAL-TIME WEATHER CONTEXT:\n'+weatherCtx+'\n' : ''}
${sensorCtx}

RESPONSE STYLE: Be conversational, specific, and practical. Give concrete numbers — exact doses, exact prices, exact dates. Vary your responses — do not repeat stock phrases. Keep responses concise (under 120 words) unless the user asks for detail.`;

  _hist.push({role:'user',content:txt});
  if(_hist.length>10) _hist=_hist.slice(-10);
  const messages=[{role:'system',content:sys},..._hist];

  try{
    const r=await fetch(GROQ_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_KEY},
      body:JSON.stringify({model:GROQ_MODEL,messages,temperature:0.7,max_tokens:500,response_format:{type:'text'}})});
    if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error?.message||'Groq error '+r.status); }
    const rd=await r.json(), raw=rd.choices?.[0]?.message?.content||'';
    const actM=raw.match(/ACTION:(\{[^}]+\})/);
    let display=raw.replace(/ACTION:\{[^}]+\}/,'').trim();
    if(actM){ try{
      const a=JSON.parse(actM[1]);
      if(a.pump!==undefined&&!_pumpLock){ pumpOn=a.pump; updatePumpUI(); _lockPump(3000); fetch(getESP32Base()+'/pump?state='+(a.pump?'on':'off')).then(()=>_unlockPump()).catch(()=>_unlockPump()); }
      if(a.valve!==undefined) autoValve=a.valve;
      if(a.scarecrow!==undefined) autoScarecrow=a.scarecrow;
    }catch(e){} }
    _hist.push({role:'assistant',content:display});
    addMsg(display,'b');
    // Speak in selected locale
    speakGroq(display, locale);
  }catch(e){ addMsg('❌ '+e.message,'b'); setVS('idle','● Ready'); }
}

// ═══════════ TOOL 8 — WhatsApp Report ═══════════
async function runWA(){
  if(!checkApiKey()) return;
  el('wa-res').style.display='none'; el('o-wa').style.display='block';
  const s=sens(), lang=el('wa-lang').value;
  out('o-wa','<span class="spin"></span>Generating farm report...','idle');
  const dt=new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
const sys=`You are a farm reporting assistant. Write a friendly WhatsApp-style daily farm report. Use emojis. Write ONLY in ${lang}. No JSON, just plain report text.
CRITICAL RULE: If a sensor value says "Not Connected" — write "⚠️ Sensor offline" for that item. NEVER guess or assume any status for a disconnected sensor.`;

  const ph_status    = s.ph!=null      ? (s.ph<5.5?'Too Acidic ⚠️':s.ph>7.5?'Too Alkaline ⚠️':'Optimal ✅')             : 'Not Connected ⚠️';
  const moist_status = s.moisture!=null? (s.moisture<40?'Low — irrigation needed 💧':s.moisture>80?'Too Wet ⚠️':'Good ✅') : 'Not Connected ⚠️';
  const co2_status   = s.co2!=null     ? (s.co2>1500?'High — ventilate ⚠️':'Normal ✅')                                   : 'Not Connected ⚠️';
  const temp_status  = s.temp!=null    ? (s.temp>38?'Heat stress ⚠️':s.temp<15?'Cold stress ⚠️':'Comfortable ✅')         : 'Not Connected ⚠️';
  const tds_status   = s.tds!=null     ? (s.tds>500?'High salinity ⚠️':'Normal ✅')                                       : 'Not Connected ⚠️';

  const prompt=`Write a WhatsApp daily farm report for ${dt}, Zentrix AgroEcosystem, ${userLocation}, West Bengal.
STRICT RULE: Only report sensors that have real values. If value is "Not Connected" — say sensor is offline, never fabricate a health status.
Use emojis. Write ONLY in ${lang}. Maximum 18 lines. Structure: greeting + date, sensor readings with interpretation, pump/water summary, 1 farming tip, overall verdict.

Sensor data (use EXACTLY these — do not guess):
- Soil Moisture: ${s.moisture!=null ? s.moisture+'%' : 'Not Connected'} → ${moist_status}
- Air Temp: ${s.temp!=null ? s.temp+'°C' : 'Not Connected'} → ${temp_status}
- Humidity: ${s.humidity!=null ? s.humidity+'%' : 'Not Connected'}
- Soil pH: ${s.ph!=null ? s.ph : 'Not Connected'} → ${ph_status}
- TDS/EC: ${s.tds!=null ? s.tds+'ppm' : 'Not Connected'} → ${tds_status}
- CO2: ${s.co2!=null ? s.co2+'ppm' : 'Not Connected'} → ${co2_status}
- Water Tank: ${s.tank!=null ? s.tank+'%' : 'Not Connected'}
- Pump ran: ${s.pumpMins} min | Water used: ${s.water}L
- Battery: ${s.battery!=null ? s.battery+'%' : 'Not Connected'} | Solar: ${s.solar!=null ? s.solar+'mW' : 'Not Connected'}
- Motion alerts today: ${s.motions}`;
  try{
    _waT=await gemini(prompt,sys,false);
    el('o-wa').style.display='none';
    el('wa-txt').textContent=_waT;
    const waHtml=`<div style="background:#E7FFDB;border:1px solid #C2E8AA;border-radius:12px;padding:20px;font-size:14px;line-height:1.9;color:#1B2A1B;white-space:pre-wrap;font-family:sans-serif;margin-bottom:14px;">${_waT}</div><div style="display:flex;gap:10px;flex-wrap:wrap;"><button onclick="shareWA()" style="flex:1;padding:12px;background:#25D366;color:#fff;border:none;border-radius:9px;font-family:system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer;">📤 Share on WhatsApp</button><button onclick="copyWA(this)" style="flex:1;padding:12px;background:var(--green-bg);color:var(--green);border:1.5px solid var(--green-l);border-radius:9px;font-family:system-ui,sans-serif;font-size:14px;font-weight:700;cursor:pointer;">📋 Copy Text</button></div>`;
    openModal('📲 WhatsApp Farm Report','Daily farm summary · '+lang,'Groq · Llama 3.3 70B · Live Sensor Data');
    showModalResult(waHtml);
  }catch(e){ out('o-wa','❌ '+e.message,'err'); showModalError(e.message); }
}
function shareWA(){ if(_waT) window.open('https://wa.me/?text='+encodeURIComponent(_waT),'_blank'); }
function copyWA(btn){ if(_waT) navigator.clipboard.writeText(_waT).then(()=>{ btn.textContent='✅ Copied!'; setTimeout(()=>btn.textContent='📋 Copy Text',1500); }); }
// ── Settings ──
function openSettings(){
  el('cfg-groq').value     =localStorage.getItem('zentrix_groq_key')   ||'';
  el('cfg-gemini').value   =localStorage.getItem('zentrix_gemini_key') ||'';
  el('cfg-or').value       =localStorage.getItem('zentrix_or_key')     ||'';
  el('cfg-tank').value     =localStorage.getItem('zentrix_tank_h')     ||'40';
  el('cfg-district').value =localStorage.getItem('zentrix_district')   ||'Howrah, West Bengal';
  el('settings-overlay').style.display='block'; el('settings-modal').style.display='block';
}
function closeSettings(){ el('settings-overlay').style.display='none'; el('settings-modal').style.display='none'; }
function saveSettings(){
  // ESP32 IP: always use location.host (auto when served from ESP32)
  const groq=el('cfg-groq').value.trim(), gem=el('cfg-gemini').value.trim();
  const or_=el('cfg-or').value.trim(), tank=parseInt(el('cfg-tank').value)||40;
  const district=el('cfg-district').value||'Howrah, West Bengal';
  if(groq) localStorage.setItem('zentrix_groq_key',groq); else localStorage.removeItem('zentrix_groq_key');
  if(gem)  localStorage.setItem('zentrix_gemini_key',gem);else localStorage.removeItem('zentrix_gemini_key');
  if(or_)  localStorage.setItem('zentrix_or_key',or_);    else localStorage.removeItem('zentrix_or_key');
  localStorage.setItem('zentrix_tank_h',tank);
  localStorage.setItem('zentrix_district',district);
  GROQ_KEY=groq||'YOUR_GROQ_API_KEY_HERE'; GEMINI_KEY=gem||'YOUR_GEMINI_API_KEY_HERE'; OPENROUTER_KEY=or_||'YOUR_OPENROUTER_API_KEY_HERE';
  TANK_HEIGHT_CM=tank;
  userLocation=district;
  closeSettings();
}
function clearSettings(){
  if(!confirm('Clear all saved API keys and config?')) return;
  ['zentrix_groq_key','zentrix_gemini_key','zentrix_or_key','zentrix_tank_h','zentrix_district'].forEach(k=>localStorage.removeItem(k));
  GROQ_KEY=GEMINI_KEY=OPENROUTER_KEY='';
  userLocation='West Bengal';
  ['cfg-groq','cfg-gemini','cfg-or'].forEach(id=>el(id).value='');
  el('cfg-district').value='Howrah, West Bengal';
  closeSettings(); alert('All saved keys cleared.');
}
