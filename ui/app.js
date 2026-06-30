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
const progressTries = document.getElementById('progress-tries');
const progressRate = document.getElementById('progress-rate');
const progressEta = document.getElementById('progress-eta');
const resultBox = document.getElementById('result-box');
const resultAddress = document.getElementById('result-address');
const copyKeyBtn = document.getElementById('copy-key-btn');
const saveJsonBtn = document.getElementById('save-json-btn');

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

caseSensitiveBox.addEventListener('change', updateEstimate);

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
  progressTries.textContent = '0 TRIES';
  progressRate.textContent = '0/s';
  progressEta.textContent = 'ETA —';

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

  const remaining = Math.max(0, expected - totalTries);
  const etaSec = (remaining / rate) * ESTIMATE_BUFFER;
  progressEta.textContent = `ETA ${formatDuration(etaSec)} left`;
}

async function stopGrind(userInitiated) {
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
