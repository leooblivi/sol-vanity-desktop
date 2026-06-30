const { invoke } = window.__TAURI__.tauri;
const { save } = window.__TAURI__.dialog;
const { writeBinaryFile } = window.__TAURI__.fs;
const { writeText } = window.__TAURI__.clipboard;

// ---- base58 encode (only needed here to render the copyable secret key) ----
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  let digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) leadingZeros++;
  let result = '';
  for (let i = 0; i < leadingZeros; i++) result += '1';
  for (let i = digits.length - 1; i >= 0; i--) result += B58_ALPHABET[digits[i]];
  return result;
}

// ---- DOM refs ----
const keywordInput = document.getElementById('keyword');
const keywordError = document.getElementById('keyword-error');
const positionRow = document.getElementById('position-row');
const caseSensitiveBox = document.getElementById('case-sensitive');
const estimateValue = document.getElementById('estimate-value');
const estimateDetail = document.getElementById('estimate-detail');
const grindBtn = document.getElementById('grind-btn');
const stopBtn = document.getElementById('stop-btn');
const progressBox = document.getElementById('progress-box');
const progressFill = document.getElementById('progress-fill');
const progressTries = document.getElementById('progress-tries');
const progressRate = document.getElementById('progress-rate');
const progressEta = document.getElementById('progress-eta');
const resultBox = document.getElementById('result-box');
const resultAddress = document.getElementById('result-address');
const copyKeyBtn = document.getElementById('copy-key-btn');
const saveJsonBtn = document.getElementById('save-json-btn');
const caseNote = document.getElementById('case-note');
const soundToggle = document.getElementById('sound-toggle');

// ---- arcade sound engine ----
let audioCtx = null;
let scanInterval = null;
let soundOn = localStorage.getItem('sol-vanity-sound') !== 'off';

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function beep(freq, duration, type = 'square', volume = 0.05, delay = 0) {
  if (!soundOn) return;
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = volume;
  osc.connect(gain).connect(ctx.destination);
  const start = ctx.currentTime + delay;
  osc.start(start);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.stop(start + duration);
}

function startScanSound() {
  if (scanInterval) return;
  let step = 0;
  const notes = [220, 277, 330, 277];
  scanInterval = setInterval(() => {
    beep(notes[step % notes.length], 0.08, 'square', 0.035);
    step++;
  }, 220);
}

function stopScanSound() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}

function playFoundFanfare() {
  beep(523, 0.1, 'square', 0.06, 0);
  beep(659, 0.1, 'square', 0.06, 0.1);
  beep(784, 0.1, 'square', 0.06, 0.2);
  beep(1047, 0.22, 'square', 0.07, 0.32);
}

function updateSoundToggleLabel() {
  soundToggle.textContent = soundOn ? 'SOUND: ON' : 'SOUND: OFF';
}
updateSoundToggleLabel();

soundToggle.addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('sol-vanity-sound', soundOn ? 'on' : 'off');
  updateSoundToggleLabel();
  if (!soundOn) stopScanSound();
});

const VALID_CHARS = new Set(B58_ALPHABET.split(''));

let position = 'start';
let polling = null;
let totalTries = 0;
let startTime = 0;
let measuredRate = null;
let calibratedRate = null;
let foundResult = null;
let cores = 4;

const ESTIMATE_BUFFER = 3;
const MIN_DISPLAYED_SECONDS = 5;
const FALLBACK_RATE = 20000;

invoke('cores_available').then((n) => {
  cores = n;
  calibrate();
});

async function calibrate() {
  try {
    await invoke('start_grind', { keyword: '\u0000\u0000\u0000', position: 'start', caseSensitive: true });
    await new Promise((r) => setTimeout(r, 700));
    const res = await invoke('poll_grind');
    await invoke('stop_grind');
    if (res.tries > 0) {
      calibratedRate = res.tries / 0.7;
      updateEstimate();
    }
  } catch (e) {
    console.error('calibration failed', e);
  }
}

// ---- keyword validation ----
keywordInput.addEventListener('input', () => {
  let value = keywordInput.value;
  let cleaned = '';
  let hadInvalid = false;
  for (const ch of value) {
    if (VALID_CHARS.has(ch)) cleaned += ch;
    else hadInvalid = true;
  }
  if (cleaned !== value) keywordInput.value = cleaned;

  keywordError.hidden = !hadInvalid;
  if (hadInvalid) keywordError.textContent = '0, O, I and l are not used in base58 addresses — skipped.';

  updateEstimate();
});

positionRow.addEventListener('click', (e) => {
  const btn = e.target.closest('.pos-btn');
  if (!btn) return;
  position = btn.dataset.pos;
  [...positionRow.children].forEach((b) => b.classList.toggle('active', b === btn));
  updateEstimate();
});

caseSensitiveBox.addEventListener('change', () => {
  updateCaseNote();
  updateEstimate();
});

function updateCaseNote() {
  if (caseSensitiveBox.checked) {
    caseNote.textContent = 'Solana addresses are case-sensitive — "Leo" and "leo" are different patterns. With this on, the result will match the exact uppercase/lowercase you typed.';
  } else {
    caseNote.textContent = 'Case ignored while searching (faster), so the match may come back as "Leo", "LEO", or "leo" — any casing of what you typed.';
  }
}
updateCaseNote();

function expectedTries(n, pos, caseSensitive) {
  if (n === 0) return 0;
  const alphabetSize = caseSensitive ? 58 : 33;
  const base = Math.pow(alphabetSize, n);
  if (pos === 'anywhere') {
    const addressLen = 44;
    const positions = Math.max(1, addressLen - n);
    return base / positions;
  }
  return base;
}

function formatDuration(seconds) {
  if (seconds < 60) return `~${Math.round(seconds)} sec`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `~${(seconds / 3600).toFixed(1)} hr`;
  return `~${(seconds / 86400).toFixed(1)} days`;
}

function formatNumber(n) {
  return Math.round(n).toLocaleString('en-US');
}

function currentRate() {
  return measuredRate || calibratedRate || FALLBACK_RATE;
}

function updateEstimate() {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    estimateValue.textContent = '—';
    estimateDetail.textContent = 'type a keyword to see an estimate';
    return;
  }
  const caseSensitive = caseSensitiveBox.checked;
  const tries = expectedTries(keyword.length, position, caseSensitive);
  const rate = currentRate();
  const seconds = Math.max(MIN_DISPLAYED_SECONDS, (tries / rate) * ESTIMATE_BUFFER);

  estimateValue.textContent = formatDuration(seconds);
  const basis = (measuredRate || calibratedRate) ? "based on this device's speed" : 'measuring this device\'s speed...';
  estimateDetail.textContent = `roughly ${formatNumber(tries)} addresses to check, running natively across ${cores} cores. ${basis}.`;
}

updateEstimate();

// ---- grind controls ----
grindBtn.addEventListener('click', startGrind);
stopBtn.addEventListener('click', () => stopGrind(true));

async function startGrind() {
  const keyword = keywordInput.value.trim();
  if (!keyword) return;

  foundResult = null;
  resultBox.hidden = true;
  totalTries = 0;
  measuredRate = null;
  startTime = performance.now();

  grindBtn.hidden = true;
  stopBtn.hidden = false;
  progressBox.hidden = false;
  progressFill.style.width = '0%';
  progressTries.textContent = '0 TRIES';
  progressRate.textContent = '0/s';
  progressEta.textContent = 'ETA —';

  startScanSound();

  const caseSensitive = caseSensitiveBox.checked;
  try {
    await invoke('start_grind', { keyword, position, caseSensitive });
  } catch (e) {
    estimateDetail.textContent = `Couldn't start: ${e}`;
    stopGrind(true);
    return;
  }

  const expected = expectedTries(keyword.length, position, caseSensitive);
  polling = setInterval(async () => {
    const res = await invoke('poll_grind');
    totalTries = res.tries;
    renderProgress(expected);
    if (res.found) {
      clearInterval(polling);
      polling = null;
      onFound(res.found.address, res.found.secret_key, keyword, position, caseSensitive);
    }
  }, 150);
}

function renderProgress(expected) {
  const elapsedSec = (performance.now() - startTime) / 1000;
  if (elapsedSec > 0.4) measuredRate = totalTries / elapsedSec;
  const rate = currentRate();

  progressTries.textContent = `${formatNumber(totalTries)} TRIES`;
  progressRate.textContent = `${formatNumber(rate)}/s`;

  const pct = Math.min(95, (totalTries / expected) * 100);
  progressFill.style.width = `${pct}%`;

  const remaining = Math.max(0, expected - totalTries);
  const etaSec = (remaining / rate) * ESTIMATE_BUFFER;
  progressEta.textContent = `ETA ${formatDuration(etaSec)} left`;
}

async function stopGrind(userInitiated) {
  stopScanSound();
  if (polling) {
    clearInterval(polling);
    polling = null;
  }
  await invoke('stop_grind');

  grindBtn.hidden = false;
  stopBtn.hidden = true;
  if (userInitiated) progressBox.hidden = true;
}

function onFound(address, secretKeyArray, keyword, pos, caseSensitive) {
  foundResult = { address, secretKeyArray };
  progressBox.hidden = true;
  grindBtn.hidden = false;
  stopBtn.hidden = true;
  playFoundFanfare();

  resultAddress.innerHTML = highlightMatch(address, keyword, pos, caseSensitive);
  resultBox.hidden = false;
}

function highlightMatch(address, keyword, pos, caseSensitive) {
  const haystack = caseSensitive ? address : address.toLowerCase();
  const target = caseSensitive ? keyword : keyword.toLowerCase();
  let idx = -1;
  if (pos === 'start') idx = haystack.startsWith(target) ? 0 : -1;
  else if (pos === 'end') idx = haystack.endsWith(target) ? address.length - keyword.length : -1;
  else idx = haystack.indexOf(target);

  if (idx === -1) return address;
  const before = address.slice(0, idx);
  const match = address.slice(idx, idx + keyword.length);
  const after = address.slice(idx + keyword.length);
  return `${before}<span class="hit">${match}</span>${after}`;
}

// ---- result actions ----
copyKeyBtn.addEventListener('click', async () => {
  if (!foundResult) return;
  const secretKeyB58 = base58Encode(new Uint8Array(foundResult.secretKeyArray));
  try {
    await writeText(secretKeyB58);
    flashButton(copyKeyBtn, 'COPIED');
  } catch {
    flashButton(copyKeyBtn, 'COPY FAILED');
  }
});

saveJsonBtn.addEventListener('click', async () => {
  if (!foundResult) return;
  try {
    const path = await save({
      defaultPath: `${keywordInput.value.trim() || 'vanity'}-${foundResult.address.slice(0, 6)}.json`,
      filters: [{ name: 'Solana keypair', extensions: ['json'] }],
    });
    if (!path) return;
    const bytes = new TextEncoder().encode(JSON.stringify(foundResult.secretKeyArray));
    await writeBinaryFile(path, bytes);
    flashButton(saveJsonBtn, 'SAVED');
  } catch (e) {
    console.error(e);
    flashButton(saveJsonBtn, 'SAVE FAILED');
  }
});

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = original), 1500);
}
