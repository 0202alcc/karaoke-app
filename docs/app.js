const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const HISTORY_PX_PER_SEC = 160;
const BAR_LENGTH = 18;
const HARMONIC_COUNT = 8;
const SUBHARMONIC_COUNT = 2;
const DEFAULT_CENTER_FREQ = 440;
const DEFAULT_OCTAVE_SPAN = 3;

const canvas = document.getElementById("viz");
const ctx = canvas.getContext("2d");
const micButton = document.getElementById("mic");
const micViz = document.getElementById("mic-viz");
const micCtx = micViz.getContext("2d");
const unitToggle = document.getElementById("unit-toggle");
const noteEl = document.getElementById("note");
const freqEl = document.getElementById("freq");

const historyCanvas = document.createElement("canvas");
const historyCtx = historyCanvas.getContext("2d");
const historyEvents = [];

let showHz = true;
let audioContext;
let analyser;
let isStreaming = false;
let timeData;
let freqData;
let sourceNode;
let rafId;
let viewWidth = 0;
let viewHeight = 0;
let pixelRatio = 1;
let mediaStream;
let centerFreq = DEFAULT_CENTER_FREQ;
let octaveSpan = DEFAULT_OCTAVE_SPAN;
let isDragging = false;
let lastDragY = 0;
let lastFrameTime = 0;
let lastTimestamp = 0;
let isAnimating = false;

function resize() {
  pixelRatio = window.devicePixelRatio || 1;
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;

  canvas.width = Math.floor(viewWidth * pixelRatio);
  canvas.height = Math.floor(viewHeight * pixelRatio);
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  historyCanvas.width = viewWidth;
  historyCanvas.height = viewHeight;

  micViz.width = micViz.clientWidth * pixelRatio;
  micViz.height = micViz.clientHeight * pixelRatio;
  micCtx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function freqToY(freq) {
  const logMin = Math.log2(MIN_FREQ);
  const logMax = Math.log2(MAX_FREQ);
  const safeCenter = Math.max(MIN_FREQ, Math.min(centerFreq, MAX_FREQ));
  const center = Math.log2(safeCenter);
  const span = octaveSpan / 2;
  const min = Math.max(logMin, center - span);
  const max = Math.min(logMax, center + span);
  const logFreq = Math.log2(Math.max(MIN_FREQ, Math.min(freq, MAX_FREQ)));
  const t = (logFreq - min) / (max - min);
  return (1 - t) * viewHeight;
}

function yToFreq(y) {
  const logMin = Math.log2(MIN_FREQ);
  const logMax = Math.log2(MAX_FREQ);
  const safeCenter = Math.max(MIN_FREQ, Math.min(centerFreq, MAX_FREQ));
  const center = Math.log2(safeCenter);
  const span = octaveSpan / 2;
  const min = Math.max(logMin, center - span);
  const max = Math.min(logMax, center + span);
  const t = 1 - y / viewHeight;
  return Math.pow(2, min + t * (max - min));
}

function frequencyToMidi(freq) {
  return Math.round(12 * Math.log2(freq / 440) + 69);
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToLabel(midi) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const note = names[(midi + 1200) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

function drawGrid() {
  ctx.clearRect(0, 0, viewWidth, viewHeight);
  ctx.fillStyle = "#0b0d11";
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  const width = viewWidth;
  ctx.lineWidth = 1;
  ctx.font = "12px 'Space Grotesk', sans-serif";
  ctx.textBaseline = "middle";

  const minMidi = frequencyToMidi(yToFreq(viewHeight));
  const maxMidi = frequencyToMidi(yToFreq(0));

  for (let midi = minMidi; midi <= maxMidi; midi++) {
    const freq = midiToFrequency(midi);
    if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
    const y = freqToY(freq);
    const isOctave = midi % 12 === 0;
    ctx.strokeStyle = isOctave ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawLabels() {
  const width = viewWidth;
  ctx.font = "12px 'Space Grotesk', sans-serif";
  ctx.textBaseline = "middle";
  const minMidi = frequencyToMidi(yToFreq(viewHeight));
  const maxMidi = frequencyToMidi(yToFreq(0));

  for (let midi = minMidi; midi <= maxMidi; midi++) {
    const freq = midiToFrequency(midi);
    if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
    if (showHz && midi % 12 !== 0) continue;
    const y = freqToY(freq);
    const label = showHz
      ? `${Math.round(freq)} Hz`
      : `${midiToLabel(midi)}`;
    ctx.fillStyle = showHz ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.75)";
    ctx.fillText(label, 12, Math.max(10, y - 8));
  }

  if (showHz) {
    const decades = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    ctx.fillStyle = "rgba(63,216,200,0.6)";
    decades.forEach((freq) => {
      const y = freqToY(freq);
      ctx.fillText(`${freq >= 1000 ? freq / 1000 + "k" : freq}`, width - 52, y);
    });
  }
}

function drawHistory() {
  ctx.drawImage(historyCanvas, 0, 0, viewWidth, viewHeight);
}

function renderHistory(nowSec) {
  const windowSec = viewWidth / HISTORY_PX_PER_SEC;
  historyCtx.clearRect(0, 0, historyCanvas.width, historyCanvas.height);

  const startLine = Math.floor(nowSec - windowSec);
  const endLine = Math.ceil(nowSec);
  historyCtx.strokeStyle = "rgba(255,255,255,0.14)";
  historyCtx.lineWidth = 1;
  for (let t = startLine; t <= endLine; t++) {
    const x = viewWidth - (nowSec - t) * HISTORY_PX_PER_SEC;
    if (x < 0 || x > viewWidth) continue;
    historyCtx.beginPath();
    historyCtx.moveTo(x, 0);
    historyCtx.lineTo(x, viewHeight);
    historyCtx.stroke();
  }

  const nextEvents = [];
  for (const event of historyEvents) {
    const age = nowSec - event.t;
    if (age > windowSec) continue;
    const x = viewWidth - age * HISTORY_PX_PER_SEC;
    const y = freqToY(event.freq);
    const fade = Math.max(0.1, 1 - age / windowSec);
    historyCtx.strokeStyle = `rgba(63,216,200,${event.alpha * fade})`;
    historyCtx.lineWidth = event.width;
    historyCtx.beginPath();
    historyCtx.moveTo(x - BAR_LENGTH, y);
    historyCtx.lineTo(x, y);
    historyCtx.stroke();
    nextEvents.push(event);
  }
  historyEvents.length = 0;
  historyEvents.push(...nextEvents);
}

function addPitchBars(pitch, nowSec) {
  if (!pitch) return;

  historyEvents.push({ freq: pitch, alpha: 0.95, width: 4, t: nowSec });

  for (let i = 2; i <= HARMONIC_COUNT; i++) {
    const freq = pitch * i;
    if (freq > MAX_FREQ) break;
    historyEvents.push({ freq, alpha: 0.45, width: 2, t: nowSec });
  }

  for (let i = 2; i <= SUBHARMONIC_COUNT; i++) {
    const freq = pitch / i;
    if (freq < MIN_FREQ) continue;
    historyEvents.push({ freq, alpha: 0.25, width: 2, t: nowSec });
  }
}

function drawSpectrumShape() {
  if (!freqData) return;

  const w = micViz.clientWidth;
  const h = micViz.clientHeight;
  micCtx.clearRect(0, 0, w, h);
  micCtx.save();
  const radius = Math.min(w, h) / 2;
  const pad = radius * 0.18;
  micCtx.beginPath();
  micCtx.arc(w / 2, h / 2, radius - pad, 0, Math.PI * 2);
  micCtx.clip();
  micCtx.strokeStyle = "rgba(11,13,17,0.75)";
  micCtx.lineWidth = 2;
  micCtx.beginPath();

  const len = freqData.length;
  let peakIndex = 0;
  let peakVal = -Infinity;
  for (let i = 0; i < len; i++) {
    if (freqData[i] > peakVal) {
      peakVal = freqData[i];
      peakIndex = i;
    }
  }
  const shift = Math.floor(len / 2) - peakIndex;

  for (let i = 0; i < len; i++) {
    const shiftedIndex = (i + shift + len) % len;
    const x = (i / (len - 1)) * (w - pad * 2) + pad;
    const magnitude = Math.max(-100, freqData[shiftedIndex]);
    const norm = (magnitude + 100) / 100;
    const yOffset = Math.max(4, h * 0.05);
    const y = h - (norm * (h - pad * 2) + pad) - yOffset;
    if (i === 0) micCtx.moveTo(x, y);
    else micCtx.lineTo(x, y);
  }

  micCtx.stroke();
  micCtx.restore();
}

function autoCorrelate(buffer, sampleRate) {
  const SIZE = buffer.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    const val = buffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.004) return null;

  let r1 = 0;
  let r2 = SIZE - 1;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buffer[i]) < 0.02) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buffer[SIZE - i]) < 0.02) {
      r2 = SIZE - i;
      break;
    }
  }

  const clipped = buffer.slice(r1, r2);
  const clippedSize = clipped.length;
  const correlations = new Array(clippedSize).fill(0);

  for (let lag = 0; lag < clippedSize; lag++) {
    let sum = 0;
    for (let i = 0; i < clippedSize - lag; i++) {
      sum += clipped[i] * clipped[i + lag];
    }
    correlations[lag] = sum;
  }

  let d = 0;
  while (correlations[d] > correlations[d + 1]) d++;

  let maxPos = -1;
  let maxVal = -1;
  for (let i = d; i < clippedSize; i++) {
    if (correlations[i] > maxVal) {
      maxVal = correlations[i];
      maxPos = i;
    }
  }

  if (maxPos === -1) return null;

  const peak = maxPos;
  const xp = correlations[peak - 1] || 0;
  const yp = correlations[peak];
  const zp = correlations[peak + 1] || 0;
  const shift = (zp - xp) / (2 * (2 * yp - zp - xp) || 1);
  const period = peak + shift;
  if (period <= 0) return null;
  return sampleRate / period;
}

function animate(timestamp) {
  if (!isAnimating) return;
  if (!lastFrameTime) lastFrameTime = timestamp;
  const deltaMs = timestamp - lastFrameTime;
  lastFrameTime = timestamp;
  const deltaSeconds = Math.min(0.05, Math.max(0.001, deltaMs / 1000));
  lastTimestamp = (lastTimestamp || 0) + deltaSeconds;

  if (isStreaming && analyser && audioContext) {
    analyser.getFloatTimeDomainData(timeData);
    analyser.getFloatFrequencyData(freqData);

    const pitch = autoCorrelate(timeData, audioContext.sampleRate);
    if (pitch) {
      centerFreq = centerFreq * 0.85 + pitch * 0.15;
      const midi = frequencyToMidi(pitch);
      noteEl.textContent = midiToLabel(midi);
      freqEl.textContent = `${pitch.toFixed(1)} Hz`;
    } else {
      noteEl.textContent = "—";
      freqEl.textContent = "0 Hz";
    }

    addPitchBars(pitch, lastTimestamp);
  }

  renderHistory(lastTimestamp);
  drawGrid();
  drawHistory();
  drawLabels();
  drawSpectrumShape();

  rafId = requestAnimationFrame(animate);
}

async function startAudio() {
  if (isStreaming) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  await audioContext.resume();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.85;

  const bufferLength = analyser.fftSize;
  timeData = new Float32Array(bufferLength);
  freqData = new Float32Array(analyser.frequencyBinCount);

  mediaStream = stream;
  sourceNode = audioContext.createMediaStreamSource(stream);
  sourceNode.connect(analyser);

  isStreaming = true;
  micButton.classList.add("streaming");
  if (!isAnimating) {
    isAnimating = true;
    rafId = requestAnimationFrame(animate);
  }
}

async function stopAudio() {
  if (!isStreaming) return;
  isStreaming = false;
  micButton.classList.remove("streaming");
  lastFrameTime = 0;
  if (audioContext) await audioContext.close();
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  noteEl.textContent = "—";
  freqEl.textContent = "0 Hz";
}

micButton.addEventListener("click", async () => {
  try {
    if (isStreaming) {
      await stopAudio();
    } else {
      await startAudio();
    }
  } catch (error) {
    console.error(error);
  }
});

unitToggle.addEventListener("click", () => {
  showHz = !showHz;
  unitToggle.textContent = showHz ? "Hz" : "Note";
  drawGrid();
  drawHistory();
  drawLabels();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const direction = Math.sign(event.deltaY);
  const step = 0.15;
  const logCenter = Math.log2(centerFreq);
  const newCenter = Math.pow(2, logCenter + direction * step);
  centerFreq = Math.max(MIN_FREQ, Math.min(newCenter, MAX_FREQ));
  drawGrid();
  drawHistory();
});

canvas.addEventListener("pointerdown", (event) => {
  isDragging = true;
  lastDragY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointerup", (event) => {
  isDragging = false;
  canvas.releasePointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!isDragging) return;
  const delta = event.clientY - lastDragY;
  lastDragY = event.clientY;
  const step = delta * 0.002;
  const logCenter = Math.log2(centerFreq);
  const newCenter = Math.pow(2, logCenter + step);
  centerFreq = Math.max(MIN_FREQ, Math.min(newCenter, MAX_FREQ));
  drawGrid();
  drawHistory();
});

window.addEventListener("resize", () => {
  resize();
  drawGrid();
  drawLabels();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js");
  });
}

resize();
drawGrid();
drawHistory();
drawLabels();
if (!isAnimating) {
  isAnimating = true;
  rafId = requestAnimationFrame(animate);
}
