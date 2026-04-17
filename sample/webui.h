// Stored in flash (PROGMEM) to save RAM.
// Single-file HTML — no external dependencies, no frameworks.
// WebSocket port matches main.cpp (ws://[ip]/ws)

static const char WEBUI_HTML[] PROGMEM = R"HTMLEOF(
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TRX4 Active Suspension</title>
<style>
  :root {
    --bg:     #1a1a1a;
    --panel:  #242424;
    --border: #333;
    --accent: #0af;
    --warn:   #f80;
    --ok:     #0c8;
    --text:   #ddd;
    --muted:  #888;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: monospace;
         font-size: 14px; padding: 12px; }
  h1 { font-size: 16px; letter-spacing: 2px; color: var(--accent);
       border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; }
  h2 { font-size: 13px; color: var(--muted); text-transform: uppercase;
       letter-spacing: 1px; margin-bottom: 10px; }

  .status-bar { display: flex; gap: 20px; padding: 8px 10px;
                background: var(--panel); border: 1px solid var(--border);
                margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
  .status-bar span { font-size: 13px; }
  #connStatus { color: var(--warn); }
  #connStatus.connected { color: var(--ok); }
  #wsLoadVal.low { color: var(--ok); }
  #wsLoadVal.medium { color: var(--warn); }
  #wsLoadVal.high { color: #f66; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
          margin-bottom: 12px; }
  @media (max-width: 500px) { .grid { grid-template-columns: 1fr; } }

  .panel { background: var(--panel); border: 1px solid var(--border); padding: 12px; }
  .panel h2 { margin-bottom: 10px; }

  .row { display: flex; align-items: center; margin-bottom: 9px; gap: 8px; }
  .row label { width: 130px; flex-shrink: 0; color: var(--muted); font-size: 12px; }
  .row input[type=range] { flex: 1; accent-color: var(--accent); cursor: pointer; }
  .row input[type=number] { width: 70px; background: #111; color: var(--text);
                            border: 1px solid var(--border); padding: 3px 6px; }
  .row .val { width: 42px; text-align: right; font-size: 13px; color: var(--accent); }
  .row select { background: #111; color: var(--text); border: 1px solid var(--border);
                padding: 3px 6px; flex: 1; }
  .row input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent);
                               cursor: pointer; }

  button { background: #111; color: var(--text); border: 1px solid var(--border);
           padding: 6px 14px; cursor: pointer; font-family: monospace;
           font-size: 12px; letter-spacing: 1px; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.danger { border-color: #633; color: #f66; }
  button.danger:hover { border-color: #f44; color: #f44; }
  button.ok { border-color: #363; color: var(--ok); }
  button.ok:hover { border-color: var(--ok); }
  button.active { border-color: var(--ok); color: var(--ok); }
  button.active:hover { border-color: var(--ok); color: var(--ok); }

  .servo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
                margin-bottom: 12px; }
  @media (max-width: 500px) { .servo-grid { grid-template-columns: 1fr; } }

  .servo-panel { background: var(--panel); border: 1px solid var(--border); padding: 12px; }
  .servo-panel h2 { color: var(--accent); margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .sat-dot { width: 9px; height: 9px; border-radius: 50%; background: #444; flex-shrink: 0; transition: background 0.15s; }
  .sat-dot.active { background: #f44; box-shadow: 0 0 5px #f44; }

  .btn-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }

  #calibLog { background: #111; border: 1px solid var(--border); padding: 8px;
              font-size: 12px; height: 90px; overflow-y: auto;
              color: var(--muted); margin-top: 8px; white-space: pre-wrap; }

  .section-title { font-size: 11px; color: var(--muted); text-transform: uppercase;
                   letter-spacing: 1px; /* border-bottom: 1px solid var(--border); */
                   padding-bottom: 4px; margin: 14px 0 10px; }
  .full-width { grid-column: 1 / -1; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<h1>TRX4 ACTIVE SUSPENSION</h1>

<!-- Status bar -->
<div class="status-bar">
  <span>WS: <span id="connStatus">DISCONNECTED</span></span>
  <div><span>WS LOAD: <span id="wsLoadVal" class="low">LOW</span></span></div>
  <div><span>PITCH: <span id="pitchVal">--</span>&deg;</span>
  <span>ROLL: <span id="rollVal">--</span>&deg;</span></div>
  <div><span>LEVEL BASE: <span id="baseVal">--</span></span></div>
  <span style="margin-left:auto">
    <button id="toggleActive" onclick="toggleActive()">SUSPEND: ACTIVE</button>
  </span>
</div>

<!-- Suspension Mode -->
<div class="panel" style="margin-bottom:12px" id="suspensionModePanel">
  <h2>SUSPENSION MODE</h2>
  <div class="row">
    <label>Mode</label>
    <div style="display:flex; gap:12px; align-items:center;">
      <label style="width:auto; color:var(--text); font-size:12px; display:flex; gap:6px; align-items:center;">
        <input type="radio" name="suspMode" id="suspModeActive" value="active"
               onchange="setSuspensionMode('active', true)">
        Active
      </label>
      <label style="width:auto; color:var(--text); font-size:12px; display:flex; gap:6px; align-items:center;">
        <input type="radio" name="suspMode" id="suspModeReactive" value="reactive"
               onchange="setSuspensionMode('reactive', true)">
        Reactive
      </label>
    </div>
  </div>
</div>

<div class="panel" style="margin-bottom:12px" id="globalSettingsPanel">
  <h2>GLOBAL SETTINGS</h2>
  <div class="row">
    <label>Travel Range (&deg;)</label>
    <input type="range" id="travelDeg" min="10" max="170" step="2" value="60"
      oninput="syncVal(this,'travelDegVal')" onchange="sendCustomSetting('travelDeg',this.value)">
    <span class="val" id="travelDegVal">60</span>
  </div>
  <div class="row">
    <label>Ride Height Trim</label>
    <input type="range" id="rideHeight" min="-100" max="100" step="5" value="0"
      oninput="syncVal(this,'rideHeightVal')" onchange="sendCustomSetting('rideHeight',this.value/100)">
    <span class="val" id="rideHeightVal">0</span>
  </div>
</div>

<!-- Global Settings -->
<div class="panel" style="margin-bottom:12px" id="tuningPanel">
  <h2>TUNING</h2>
  <div class="row">
    <label>Tuning Mode</label>
    <div style="display:flex; gap:12px; align-items:center;">
      <label style="width:auto; color:var(--text); font-size:12px; display:flex; gap:6px; align-items:center;">
        <input type="radio" name="configMode" id="configModeAuto" value="auto"
               onchange="setConfigMode('auto')">
        Auto
      </label>
      <label style="width:auto; color:var(--text); font-size:12px; display:flex; gap:6px; align-items:center;">
        <input type="radio" name="configMode" id="configModeCustom" value="custom"
               onchange="setConfigMode('custom')">
        Custom
      </label>
    </div>
  </div>
  <div class="row" id="masterControlRow">
    <label>Drive Mode</label>
    <input type="range" id="masterFeel" min="0" max="100" value="50"
      oninput="updateMasterFeel(this.value, true)">
    <span class="val" id="masterFeelVal">Balanced</span>
  </div>

  <div id="customControls">
  <div class="row">
    <label>Motion Amount</label>
    <input type="range" id="range" min="10" max="400" value="100"
           oninput="syncVal(this,'rangeVal')" onchange="sendCustomSetting('range',this.value/100)">
    <span class="val" id="rangeVal">100</span>
  </div>
  <div class="row">
    <label>Bounce Speed</label>
    <input type="range" id="omegaN" min="50" max="1500" value="300"
           oninput="document.getElementById('omegaNVal').textContent=(this.value/100).toFixed(1)"
           onchange="sendCustomSetting('omegaN',this.value/100)">
    <span class="val" id="omegaNVal">3.0</span>
  </div>
  <div class="row">
    <label>Bounce Decay</label>
    <input type="range" id="zeta" min="5" max="95" value="25"
           oninput="document.getElementById('zetaVal').textContent=(this.value/100).toFixed(2)"
           onchange="sendCustomSetting('zeta',this.value/100)">
    <span class="val" id="zetaVal">0.25</span>
  </div>
  <div class="row">
    <label>Noise Guard</label>
    <input type="range" id="inputDeadband" min="0" max="100" value="30"
      oninput="document.getElementById('inputDeadbandVal').textContent=(this.value/100).toFixed(2)"
      onchange="sendCustomSetting('inputDeadband',this.value/100)">
    <span class="val" id="inputDeadbandVal">0.30</span>
  </div>
  <div class="row">
    <label>Terrain Response Rate</label>
    <input type="range" id="reactionSpeed" min="1" max="100" value="40"
      oninput="syncVal(this,'reactionSpeedVal')" onchange="sendCustomSetting('reactionSpeed',this.value/100)">
    <span class="val" id="reactionSpeedVal">40</span>
  </div>
    <div class="row">
      <label>Noise Latch</label>
      <input type="range" id="inputHyst" min="0" max="50" value="15"
        oninput="document.getElementById('inputHystVal').textContent=(this.value/100).toFixed(2)"
        onchange="sendCustomSetting('inputHyst',this.value/100)">
      <span class="val" id="inputHystVal">0.15</span>
    </div>
  </div>

  <div class="section-title">GYRO CONFIGURATION</div>
  <div class="row">
    <label>Front/Rear Bias</label>
    <input type="range" id="balance" min="-100" max="100" value="0"
      oninput="syncVal(this,'balanceVal')" onchange="sendCustomSetting('balance',this.value/100)">
    <span class="val" id="balanceVal">0</span>
  </div>
  <div class="row">
    <label>Sensor Update Rate</label>
    <select id="refreshRate" onchange="sendSetting('refreshRate',this.value)">
      <option value="10">10 Hz</option>
      <option value="25" selected>25 Hz</option>
      <option value="50">50 Hz</option>
      <option value="100">100 Hz</option>
    </select>
  </div>
  <div class="row">
    <label>Sensor Mount</label>
    <select id="mpuOri" onchange="sendSetting('mpuOri',this.value)">
      <option value="0">Z-Up  / X-Forward  (default)</option>
      <option value="1">Z-Up  / X-Rearward</option>
      <option value="2">Z-Up  / X-Left</option>
      <option value="3">Z-Up  / X-Right</option>
      <option value="4">Z-Down/ X-Forward</option>
      <option value="5">Z-Down/ X-Rearward</option>
    </select>
  </div>
</div>

<div class="panel hidden" style="margin-bottom:12px" id="activeCorneringPanel">
  <h2>ACTIVE CORNERING</h2>
  <div class="row">
    <label>Corner Assist</label>
    <input type="checkbox" id="cornerAssist"
      onchange="sendSetting('cornerAssist',this.checked?1:0)">
    <span class="val"></span>
  </div>
  <div class="row">
    <label>Corner Strength</label>
    <input type="range" id="cornerGain" min="-200" max="200" step="5" value="100"
      oninput="document.getElementById('cornerGainVal').textContent=this.value"
      onchange="sendSetting('cornerGain',this.value/100)">
    <span class="val" id="cornerGainVal">100</span>
  </div>
  <div class="row">
    <label>Corner Response</label>
    <input type="range" id="cornerResp" min="5" max="100" step="5" value="25"
      oninput="document.getElementById('cornerRespVal').textContent=this.value"
      onchange="sendSetting('cornerResp',this.value/100)">
    <span class="val" id="cornerRespVal">25</span>
  </div>
</div>

<div class="section-title">PER-SERVO SETTINGS</div>
<div class="servo-grid" id="servoGrid">
  <!-- Populated by JS from server data -->
</div>

<!-- Calibration -->
<div class="panel" style="margin-bottom:12px">
  <h2>CALIBRATION</h2>
  <div class="btn-row">
    <button class="ok" onclick="sendCmd('calibrate')">AUTO CALIBRATE (all 4)</button>
    <button onclick="sendCmd('rebaseline')">SET AS LEVEL</button>
    <button class="danger" onclick="sendCmd('center_all')">CENTER ALL SERVOS</button>
  </div>
  <div id="calibLog">Calibration log will appear here...</div>
</div>

<!-- Wiring & Default Values -->
<div class="panel" style="margin-bottom:12px">
  <h2>WIRING &amp; DEFAULT VALUES</h2>
  <div style="font-size:12px; color:var(--muted);">
    <div style="color:var(--accent); margin-bottom:6px; letter-spacing:1px;">DEFAULT VALUES</div>
    <div style="color:var(--accent); margin:8px 0 6px; letter-spacing:1px; font-size:11px;">GLOBAL / SERVO DEFAULTS</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 20px;">
      <span>Suspension Mode</span>    <span style="color:var(--text);">Reactive</span>
      <span>Global Travel</span>      <span style="color:var(--text);">60&deg;</span>
      <span>Ride Height Trim</span>   <span style="color:var(--text);">0</span>
      <span>Servo Center</span>       <span style="color:var(--text);">90&deg;</span>
      <span>Servo Min (mech)</span>   <span style="color:var(--text);">60&deg;</span>
      <span>Servo Max (mech)</span>   <span style="color:var(--text);">120&deg;</span>
      <span>Servo Trim</span>         <span style="color:var(--text);">0&deg;</span>
      <span>Pulse Range</span>        <span style="color:var(--text);">600&ndash;2400 &micro;s</span>
    </div>

    <div style="color:var(--accent); margin:10px 0 6px; letter-spacing:1px; font-size:11px;">REACTIVE TUNING DEFAULTS</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 20px;">
      <span>Motion Amount</span>      <span style="color:var(--text);">1.0</span>
      <span>Bounce Speed (&omega;n)</span> <span style="color:var(--text);">3.0 rad/s</span>
      <span>Bounce Decay (&zeta;)</span>   <span style="color:var(--text);">0.25</span>
      <span>Noise Guard</span>        <span style="color:var(--text);">0.30</span>
      <span>Noise Latch</span>        <span style="color:var(--text);">0.15</span>
      <span>Reaction Speed</span>     <span style="color:var(--text);">0.4</span>
      <span>Front/Rear Bias</span>    <span style="color:var(--text);">0</span>
      <span>Sensor Rate</span>        <span style="color:var(--text);">25 Hz</span>
      <span>Sensor Mount</span>       <span style="color:var(--text);">Z-Up / X-Forward</span>
    </div>

    <div style="color:var(--accent); margin:10px 0 6px; letter-spacing:1px; font-size:11px;">ACTIVE CORNERING DEFAULTS</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 20px;">
      <span>Corner Assist</span>      <span style="color:var(--text);">Off</span>
      <span>Corner Strength</span>    <span style="color:var(--text);">1.0 (100)</span>
      <span>Corner Response</span>    <span style="color:var(--text);">0.25 (25)</span>
    </div>
  </div>

  <hr style="border:none; border-top:1px solid var(--border); margin:14px 0;">

  <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; font-size:12px; color:var(--muted);">
    <div>
      <div style="color:var(--accent); margin-bottom:6px; letter-spacing:1px;">SERVO PINS</div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <span><span style="color:var(--text);">FL</span> → GPIO 25</span>
        <span><span style="color:var(--text);">FR</span> → GPIO 26</span>
        <span><span style="color:var(--text);">RL</span> → GPIO 17</span>
        <span><span style="color:var(--text);">RR</span> → GPIO 18</span>
      </div>
    </div>
    <div>
      <div style="color:var(--accent); margin-bottom:6px; letter-spacing:1px;">MPU6050 PINS</div>
      <div style="display:flex; flex-direction:column; gap:4px;">
        <span><span style="color:var(--text);">SDA</span> → GPIO 21</span>
        <span><span style="color:var(--text);">SCL</span> → GPIO 22</span>
      </div>
    </div>
  </div>
</div>


<script>
// ─── WebSocket ──────────────────────────────────────────────────────────────
let ws, reconnectTimer;
const DEBOUNCE_MS = 300;
let debounceTimers = {};

function connect() {
  const url = 'ws://' + location.hostname + '/ws';
  ws = new WebSocket(url);

  ws.onopen = () => {
    document.getElementById('connStatus').textContent = 'CONNECTED';
    document.getElementById('connStatus').className = 'connected';
    clearTimeout(reconnectTimer);
    // Request full state on connect
    wsSend({cmd:'getState'});
  };

  ws.onclose = () => {
    document.getElementById('connStatus').textContent = 'DISCONNECTED';
    document.getElementById('connStatus').className = '';
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch(e) { return; }
    handleMessage(msg);
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─── Debounced slider sends ─────────────────────────────────────────────────
// onchange fires only when slider is released on desktop, but on mobile
// oninput fires continuously — we debounce oninput for actual sends.
function sendSetting(key, value) {
  clearTimeout(debounceTimers[key]);
  debounceTimers[key] = setTimeout(() => {
    wsSend({cmd:'set', key:key, val:parseFloat(value)});
  }, DEBOUNCE_MS);
}

function sendCustomSetting(key, value) {
  setConfigMode('custom');
  sendSetting(key, value);
}

function sendServoSetting(idx, key, value) {
  const fullKey = 'servo_' + idx + '_' + key;
  clearTimeout(debounceTimers[fullKey]);
  debounceTimers[fullKey] = setTimeout(() => {
    wsSend({cmd:'setServo', idx:idx, key:key, val:value});
  }, DEBOUNCE_MS);
}

function sendCmd(cmd, extra) {
  wsSend(Object.assign({cmd:cmd}, extra||{}));
}

// ─── Sync slider display value ──────────────────────────────────────────────
function syncVal(el, labelId) {
  document.getElementById(labelId).textContent = el.value;
}

function updateLinkedControl(rangeId, numId, labelId, scale, decimals, fromNumber) {
  const rangeEl = document.getElementById(rangeId);
  const numEl = document.getElementById(numId);
  const labelEl = document.getElementById(labelId);
  if (!rangeEl || !numEl || !labelEl) return;

  let value = fromNumber ? parseFloat(numEl.value) : (parseFloat(rangeEl.value) / scale);
  if (Number.isNaN(value)) return;

  const minV = parseFloat(numEl.min);
  const maxV = parseFloat(numEl.max);
  value = Math.min(maxV, Math.max(minV, value));

  rangeEl.value = Math.round(value * scale);
  numEl.value = value.toFixed(decimals);
  labelEl.textContent = value.toFixed(decimals);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function masterFeelText(v) {
  if (v < 16) return 'Race';
  if (v < 33) return 'Sport';
  if (v < 50) return 'Balanced';
  if (v < 66) return 'Touring';
  if (v < 83) return 'Relaxed';
  return 'Loose';
}

let configMode = 'auto';
let suspensionMode = 'reactive';

function setSuspensionMode(mode, send = false) {
  suspensionMode = (mode === 'active') ? 'active' : 'reactive';
  const tuningPanel = document.getElementById('tuningPanel');
  const activeCorneringPanel = document.getElementById('activeCorneringPanel');
  const activeEl = document.getElementById('suspModeActive');
  const reactiveEl = document.getElementById('suspModeReactive');

  if (tuningPanel) tuningPanel.classList.toggle('hidden', suspensionMode !== 'reactive');
  if (activeCorneringPanel) activeCorneringPanel.classList.toggle('hidden', suspensionMode !== 'active');
  if (activeEl) activeEl.checked = (suspensionMode === 'active');
  if (reactiveEl) reactiveEl.checked = (suspensionMode === 'reactive');

  if (send) {
    sendSetting('suspMode', suspensionMode === 'active' ? 1 : 0);
  }
}

function setConfigMode(mode, persist = true) {
  configMode = (mode === 'custom') ? 'custom' : 'auto';
  const customPanel = document.getElementById('customControls');
  const masterRow = document.getElementById('masterControlRow');
  const autoEl = document.getElementById('configModeAuto');
  const customEl = document.getElementById('configModeCustom');
  // Keep both sections visible; tuning mode remains a saved preference/intent only.
  if (customPanel) customPanel.classList.remove('hidden');
  if (masterRow) masterRow.classList.remove('hidden');
  if (autoEl) autoEl.checked = (configMode === 'auto');
  if (customEl) customEl.checked = (configMode === 'custom');
  if (persist) {
    try { localStorage.setItem('suspensionConfigMode', configMode); } catch (e) {}
  }
}

function updateMasterFeel(rawVal, sendChanges) {
  const slider = document.getElementById('masterFeel');
  if (!slider) return;

  const v = clamp(parseFloat(rawVal), 0, 100);
  const t = v / 100;
  slider.value = Math.round(v);
  document.getElementById('masterFeelVal').textContent = masterFeelText(v);

  // Linked controls (equalizer-style)
  // Stable -> Extremely Lively mapping.
  const motionAmount = lerp(0.80, 3.40, t);  // range
  const bounceSpeed  = lerp(2.00, 9.50, t);  // omegaN
  const bounceDecay  = lerp(0.55, 0.10, t);  // zeta
  const followSpeed  = lerp(0.25, 0.95, t);  // reactionSpeed
  const noiseGuard   = lerp(0.45, 0.06, t);  // inputDeadband
  const noiseLatch   = clamp(noiseGuard * 0.50, 0.00, 0.50); // inputHyst

  // Update visible controls immediately.
  setSlider('range', Math.round(motionAmount * 100), 'rangeVal');
  setSlider('reactionSpeed', Math.round(followSpeed * 100), 'reactionSpeedVal');

  const omegaEl = document.getElementById('omegaN');
  if (omegaEl) {
    omegaEl.value = Math.round(bounceSpeed * 100);
    document.getElementById('omegaNVal').textContent = bounceSpeed.toFixed(1);
  }

  const zetaEl = document.getElementById('zeta');
  if (zetaEl) {
    zetaEl.value = Math.round(bounceDecay * 100);
    document.getElementById('zetaVal').textContent = bounceDecay.toFixed(2);
  }

  const dbEl = document.getElementById('inputDeadband');
  if (dbEl) {
    dbEl.value = Math.round(noiseGuard * 100);
    document.getElementById('inputDeadbandVal').textContent = noiseGuard.toFixed(2);
  }

  const hyEl = document.getElementById('inputHyst');
  if (hyEl) {
    hyEl.value = Math.round(noiseLatch * 100);
    document.getElementById('inputHystVal').textContent = noiseLatch.toFixed(2);
  }

  if (!sendChanges) return;

  // Drive Mode interaction means we're back in Auto tuning intent.
  setConfigMode('auto');

  // Push linked settings to firmware.
  sendSetting('range', motionAmount);
  sendSetting('omegaN', bounceSpeed);
  sendSetting('zeta', bounceDecay);
  sendSetting('reactionSpeed', followSpeed);
  sendSetting('inputDeadband', noiseGuard);
  sendSetting('inputHyst', noiseLatch);
}

function syncMasterFeelFromCurrent() {
  const zetaEl = document.getElementById('zeta');
  const masterEl = document.getElementById('masterFeel');
  if (!zetaEl || !masterEl) return;
  const z = parseFloat(zetaEl.value) / 100.0;
  const t = clamp((0.55 - z) / (0.55 - 0.14), 0, 1);
  const v = Math.round(t * 100);
  masterEl.value = v;
  document.getElementById('masterFeelVal').textContent = masterFeelText(v);
}

function setWsLoad(level, clients, blocked, full, maxQ) {
  const el = document.getElementById('wsLoadVal');
  if (!el) return;

  const labels = ['LOW', 'MEDIUM', 'HIGH'];
  const classes = ['low', 'medium', 'high'];
  const idx = Math.max(0, Math.min(2, parseInt(level ?? 0, 10) || 0));

  el.textContent = `${labels[idx]} (${clients ?? 0}c/${maxQ ?? 0}q)`;
  el.className = classes[idx];
  el.title = `clients=${clients ?? 0}, blocked=${blocked ?? 0}, full=${full ?? 0}, maxQ=${maxQ ?? 0}`;
}

// ─── Toggle active suspension ────────────────────────────────────────────────
let suspendActive = true;
function applyActiveButtonState() {
  const btn = document.getElementById('toggleActive');
  if (!btn) return;
  btn.textContent = 'SUSPEND: ' + (suspendActive ? 'ACTIVE' : 'INACTIVE');
  btn.classList.toggle('active', suspendActive);
}

function toggleActive() {
  suspendActive = !suspendActive;
  applyActiveButtonState();
  wsSend({cmd:'set', key:'active', val: suspendActive ? 1 : 0});
}

// ─── Build servo panels ──────────────────────────────────────────────────────
const SERVO_NAMES = ['FL', 'FR', 'RL', 'RR'];

function buildServoGrid(servos) {
  const grid = document.getElementById('servoGrid');
  grid.innerHTML = '';
  servos.forEach((s, i) => {
    const trimVal = Number.isFinite(Number(s.trimDeg)) ? Number(s.trimDeg) : 0;
    const minVal = Number.isFinite(Number(s.minDeg)) ? Number(s.minDeg) : 60;
    const maxVal = Number.isFinite(Number(s.maxDeg)) ? Number(s.maxDeg) : 120;
    const div = document.createElement('div');
    div.className = 'servo-panel';
    div.innerHTML = `
      <h2>SERVO ${s.name} <span class="sat-dot" id="sat_${i}" title="Saturated"></span></h2>
      <div class="row">
        <label>Invert</label>
        <input type="checkbox" id="inv_${i}" ${s.inverted?'checked':''}
               onchange="sendServoSetting(${i},'inv',this.checked?1:0)">
      </div>
      <div class="row">
        <label>Trim (&deg;)</label>
         <input type="range" id="trim_${i}" min="-30" max="30" step="2" value="${Math.round(trimVal)}"
           oninput="document.getElementById('trimVal_${i}').textContent=Math.round(parseFloat(this.value))"
               onchange="sendServoSetting(${i},'trim',parseFloat(this.value))">
         <span class="val" id="trimVal_${i}">${Math.round(trimVal)}</span>
      </div>
      <div class="row">
        <label>Min (&deg;)</label>
         <input type="range" id="min_${i}" min="0" max="180" step="2" value="${Math.round(minVal)}"
           oninput="document.getElementById('minVal_${i}').textContent=Math.round(parseFloat(this.value))"
               onchange="sendServoSetting(${i},'min',parseFloat(this.value))">
         <span class="val" id="minVal_${i}">${Math.round(minVal)}</span>
      </div>
      <div class="row">
        <label>Max (&deg;)</label>
         <input type="range" id="max_${i}" min="0" max="180" step="2" value="${Math.round(maxVal)}"
           oninput="document.getElementById('maxVal_${i}').textContent=Math.round(parseFloat(this.value))"
               onchange="sendServoSetting(${i},'max',parseFloat(this.value))">
         <span class="val" id="maxVal_${i}">${Math.round(maxVal)}</span>
      </div>
      <div class="btn-row">
        <button onclick="sendCmd('testServo',{idx:${i},dir:1})">TEST +</button>
        <button onclick="sendCmd('testServo',{idx:${i},dir:-1})">TEST -</button>
        <button onclick="sendCmd('testServo',{idx:${i},dir:0})">CENTER</button>
        <button onclick="sendCmd('calibServo',{idx:${i}})">CALIBRATE</button>
      </div>`;
    grid.appendChild(div);
  });
}

// ─── Handle incoming messages ────────────────────────────────────────────────
function handleMessage(msg) {
  if (msg.type === 'state') {
    // Full state update on connect
    applyGlobalSettings(msg.cfg);
    buildServoGrid(msg.servos);
    suspendActive = msg.cfg.active;
    applyActiveButtonState();
    setWsLoad(msg.cfg.wsPressure, msg.cfg.wsClients, msg.cfg.wsBlocked, msg.cfg.wsFull, msg.cfg.wsMaxQ);
  }
  else if (msg.type === 'telemetry') {
    document.getElementById('pitchVal').textContent = msg.pitch.toFixed(2);
    document.getElementById('rollVal').textContent  = msg.roll.toFixed(2);
    document.getElementById('baseVal').textContent  =
      'P:' + msg.basePitch.toFixed(2) + ' R:' + msg.baseRoll.toFixed(2);
    setWsLoad(msg.wsPressure, msg.wsClients, msg.wsBlocked, msg.wsFull, msg.wsMaxQ);
    // Update saturation indicator dots
    const satFlags = [msg.satFL, msg.satFR, msg.satRL, msg.satRR];
    satFlags.forEach((sat, i) => {
      const dot = document.getElementById('sat_' + i);
      if (dot) dot.className = 'sat-dot' + (sat ? ' active' : '');
    });
  }
  else if (msg.type === 'calibLog') {
    const log = document.getElementById('calibLog');
    log.textContent += msg.text + '\n';
    log.scrollTop = log.scrollHeight;
  }
  else if (msg.type === 'servoUpdate') {
    // Partial servo update — refresh just that channel
    const s = msg.servo;
    const i = msg.idx;
    const inv = document.getElementById('inv_' + i);
    if (inv) inv.checked = s.inverted;
    const trim = document.getElementById('trim_' + i);
    if (trim && Number.isFinite(Number(s.trimDeg))) {
      trim.value = Math.round(Number(s.trimDeg));
      const trimVal = document.getElementById('trimVal_' + i);
      if (trimVal) trimVal.textContent = Math.round(Number(s.trimDeg));
    }
    const minEl = document.getElementById('min_' + i);
    if (minEl && Number.isFinite(Number(s.minDeg))) {
      minEl.value = Math.round(Number(s.minDeg));
      const minVal = document.getElementById('minVal_' + i);
      if (minVal) minVal.textContent = Math.round(Number(s.minDeg));
    }
    const maxEl = document.getElementById('max_' + i);
    if (maxEl && Number.isFinite(Number(s.maxDeg))) {
      maxEl.value = Math.round(Number(s.maxDeg));
      const maxVal = document.getElementById('maxVal_' + i);
      if (maxVal) maxVal.textContent = Math.round(Number(s.maxDeg));
    }
  }
}

function applyGlobalSettings(cfg) {
  setSuspensionMode(Number(cfg.suspMode) === 1 ? 'active' : 'reactive', false);
  setSlider('rideHeight',    Math.round(cfg.rideHeight   * 100), 'rideHeightVal');
  if (Number.isFinite(Number(cfg.travelDeg))) {
    setSlider('travelDeg', Math.round(cfg.travelDeg), 'travelDegVal');
  }
  const cornerAssistEl = document.getElementById('cornerAssist');
  if (cornerAssistEl) cornerAssistEl.checked = !!cfg.cornerAssist;
  if (Number.isFinite(Number(cfg.cornerGain))) {
    setSlider('cornerGain', Math.round(cfg.cornerGain * 100), 'cornerGainVal');
  }
  if (Number.isFinite(Number(cfg.cornerResp))) {
    setSlider('cornerResp', Math.round(cfg.cornerResp * 100), 'cornerRespVal');
  }
  setSlider('reactionSpeed', Math.round(cfg.reactionSpeed* 100), 'reactionSpeedVal');
  setSlider('range',         Math.round(cfg.range        * 100), 'rangeVal');
  setSlider('balance',       Math.round(cfg.balance      * 100), 'balanceVal');
  const dbEl = document.getElementById('inputDeadband');
  if (dbEl) {
    dbEl.value = Math.round(cfg.inputDeadband * 100);
    document.getElementById('inputDeadbandVal').textContent = cfg.inputDeadband.toFixed(2);
  }
  const hyEl = document.getElementById('inputHyst');
  if (hyEl) {
    hyEl.value = Math.round(cfg.inputHyst * 100);
    document.getElementById('inputHystVal').textContent = cfg.inputHyst.toFixed(2);
  }
  // omegaN and zeta use decimal display — update separately
  const onEl = document.getElementById('omegaN');
  if (onEl) { onEl.value = Math.round(cfg.omegaN * 100); document.getElementById('omegaNVal').textContent = cfg.omegaN.toFixed(1); }
  const zetaEl = document.getElementById('zeta');
  if (zetaEl) { zetaEl.value = Math.round(cfg.zeta * 100); document.getElementById('zetaVal').textContent = cfg.zeta.toFixed(2); }
  setSelect('refreshRate',   cfg.refreshRate);
  setSelect('mpuOri',        cfg.mpuOri);
  syncMasterFeelFromCurrent();
  setConfigMode(configMode, false);
}

function setSlider(id, val, labelId) {
  const el = document.getElementById(id);
  if (el) { el.value = val; document.getElementById(labelId).textContent = val; }
}
function setSelect(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}



// ─── Boot ────────────────────────────────────────────────────────────────────
try {
  const savedMode = localStorage.getItem('suspensionConfigMode');
  if (savedMode === 'auto' || savedMode === 'custom') {
    configMode = savedMode;
  }
} catch (e) {}
setConfigMode(configMode, false);
setSuspensionMode(suspensionMode, false);
connect();
</script>
</body>
</html>
)HTMLEOF";