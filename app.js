/* ================================================================
   POMODORO TIMER — app.js
   ================================================================ */

'use strict';

// ── Constants ────────────────────────────────────────────────────
const RING_RADIUS      = 128;                           // must match SVG r="128"
const CIRCUMFERENCE    = 2 * Math.PI * RING_RADIUS;    // ≈ 804.25
const STORAGE_KEY      = 'pomodoroSettings';

// ── Default settings ─────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  workDuration:        25,
  shortBreakDuration:  5,
  longBreakDuration:   15,
  longBreakInterval:   4,
  autoStartBreaks:     true,
  autoStartWork:       false,
  soundAlert:          true,
};

// ── Application state ─────────────────────────────────────────────
const state = {
  mode:              'work',    // 'work' | 'shortBreak' | 'longBreak'
  status:            'idle',    // 'idle' | 'running' | 'paused'
  timeLeft:          DEFAULT_SETTINGS.workDuration * 60,
  totalTime:         DEFAULT_SETTINGS.workDuration * 60,
  sessionsCompleted: 0,
  intervalId:        null,
  settings:          { ...DEFAULT_SETTINGS },
};

// ── DOM references ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const appEl            = $('app');
const timeDisplay      = $('timeDisplay');
const timerStatus      = $('timerStatus');
const progressCircle   = $('progressCircle');
const progressDot      = $('progressDot');
const timerContainer   = $('timerContainer');
const startPauseBtn    = $('startPauseBtn');
const resetBtn         = $('resetBtn');
const skipBtn          = $('skipBtn');
const sessionsDots     = $('sessionsDots');
const sessionsCount    = $('sessionsCount');
const settingsBtn      = $('settingsBtn');
const settingsOverlay  = $('settingsOverlay');
const closeSettingsBtn = $('closeSettingsBtn');
const saveSettingsBtn  = $('saveSettingsBtn');
const playIcon         = startPauseBtn.querySelector('.play-icon');
const pauseIcon        = startPauseBtn.querySelector('.pause-icon');
const btnLabel         = startPauseBtn.querySelector('.btn-label');

// Settings inputs
const inputs = {
  workDuration:        $('workDuration'),
  shortBreakDuration:  $('shortBreakDuration'),
  longBreakDuration:   $('longBreakDuration'),
  longBreakInterval:   $('longBreakInterval'),
  autoStartBreaks:     $('autoStartBreaks'),
  autoStartWork:       $('autoStartWork'),
  soundAlert:          $('soundAlert'),
};

// ── Web Audio ─────────────────────────────────────────────────────
let audioCtx = null;

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume suspended context (browser autoplay policy)
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/**
 * Play a pleasant completion chime (3 ascending sine tones).
 */
function playCompletionSound() {
  if (!state.settings.soundAlert) return;
  try {
    const ctx = ensureAudioCtx();
    const notes = [523.25, 659.25, 783.99]; // C5 · E5 · G5
    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.22;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.28, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  } catch (_) { /* Audio unavailable — fail silently */ }
}

// Unlock audio context on first user gesture
document.addEventListener('click', () => {
  try { ensureAudioCtx(); } catch (_) {}
}, { once: true });

// ── Formatting helpers ────────────────────────────────────────────
function formatTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function getModeLabel(mode) {
  return { work: 'Focus', shortBreak: 'Short Break', longBreak: 'Long Break' }[mode];
}

function getDurationSecs(mode) {
  const s = state.settings;
  return { work: s.workDuration, shortBreak: s.shortBreakDuration, longBreak: s.longBreakDuration }[mode] * 60;
}

// ── Progress ring ─────────────────────────────────────────────────
/**
 * Update the SVG progress arc and the tip dot position.
 * progress: 0 (empty) → 1 (full)
 */
function setRingProgress(progress) {
  const clampedProgress = Math.max(0, Math.min(1, progress));

  // Stroke dashoffset: 0 = full circle, CIRCUMFERENCE = empty
  const offset = CIRCUMFERENCE * (1 - clampedProgress);
  progressCircle.style.strokeDasharray  = CIRCUMFERENCE;
  progressCircle.style.strokeDashoffset = offset;

  // Move the tip dot along the circle
  // The SVG ring is rotated -90deg in CSS, so angle 0 → top-centre
  const angle = 2 * Math.PI * clampedProgress;  // radians from top
  const cx = 150 + RING_RADIUS * Math.sin(angle);
  const cy = 150 - RING_RADIUS * Math.cos(angle);
  progressDot.setAttribute('cx', cx.toFixed(2));
  progressDot.setAttribute('cy', cy.toFixed(2));

  // Hide dot when ring is empty or full to avoid visual glitch
  progressDot.style.opacity = (clampedProgress <= 0.001 || clampedProgress >= 0.999) ? '0' : '1';
}

// ── Session dots ──────────────────────────────────────────────────
function renderSessionDots() {
  const interval = state.settings.longBreakInterval;
  const pos      = state.sessionsCompleted % interval;  // how many in current cycle
  sessionsDots.innerHTML = '';

  for (let i = 0; i < interval; i++) {
    const dot = document.createElement('div');
    dot.className = 'session-dot';
    dot.setAttribute('aria-hidden', 'true');

    if (i < pos) {
      dot.classList.add('completed');
    } else if (i === pos && state.mode === 'work' && state.status !== 'idle') {
      dot.classList.add('active');
    }

    sessionsDots.appendChild(dot);
  }

  const total = state.sessionsCompleted;
  sessionsCount.textContent = `${total} session${total !== 1 ? 's' : ''} completed`;
}

// ── Mode management ───────────────────────────────────────────────
function applyMode(mode, autoStart = false) {
  state.mode     = mode;
  state.status   = 'idle';
  state.timeLeft = getDurationSecs(mode);
  state.totalTime = state.timeLeft;

  // Colour theme
  appEl.className = `app mode-${mode}`;

  // Tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  // Timer display
  updateDisplay();
  setRingProgress(1);
  setStatusText('Ready');
  setButtonState('idle');
  renderSessionDots();
  updatePageTitle();

  if (autoStart) {
    // Tiny delay so the mode switch is visually apparent before countdown begins
    setTimeout(startTimer, 600);
  }
}

// ── Timer core ────────────────────────────────────────────────────
function startTimer() {
  if (state.status === 'running') return;
  state.status = 'running';
  setButtonState('running');
  setStatusText(getModeLabel(state.mode));
  renderSessionDots();

  state.intervalId = setInterval(tick, 1000);
}

function pauseTimer() {
  if (state.status !== 'running') return;
  clearInterval(state.intervalId);
  state.intervalId = null;
  state.status = 'paused';
  setButtonState('paused');
  setStatusText('Paused');
}

function resetTimer() {
  clearInterval(state.intervalId);
  state.intervalId = null;
  state.status     = 'idle';
  state.timeLeft   = getDurationSecs(state.mode);
  state.totalTime  = state.timeLeft;

  updateDisplay();
  setRingProgress(1);
  setStatusText('Ready');
  setButtonState('idle');
  renderSessionDots();
  updatePageTitle();
}

function skipSession() {
  clearInterval(state.intervalId);
  state.intervalId = null;

  if (state.mode === 'work') {
    state.sessionsCompleted++;
    const isLong = (state.sessionsCompleted % state.settings.longBreakInterval === 0);
    applyMode(isLong ? 'longBreak' : 'shortBreak');
  } else {
    applyMode('work');
  }
  renderSessionDots();
}

function tick() {
  if (state.timeLeft <= 0) {
    onTimerComplete();
    return;
  }
  state.timeLeft--;
  updateDisplay();
  setRingProgress(state.timeLeft / state.totalTime);
  updatePageTitle();
}

function onTimerComplete() {
  clearInterval(state.intervalId);
  state.intervalId = null;
  state.status     = 'idle';
  state.timeLeft   = 0;

  updateDisplay();
  setRingProgress(0);

  // Alert
  playCompletionSound();
  flashAlert();
  sendBrowserNotification();

  if (state.mode === 'work') {
    state.sessionsCompleted++;
    renderSessionDots();

    const isLong    = (state.sessionsCompleted % state.settings.longBreakInterval === 0);
    const nextMode  = isLong ? 'longBreak' : 'shortBreak';
    applyMode(nextMode, state.settings.autoStartBreaks);
  } else {
    applyMode('work', state.settings.autoStartWork);
  }
}

// ── Display helpers ───────────────────────────────────────────────
function updateDisplay() {
  timeDisplay.textContent = formatTime(state.timeLeft);
}

function setStatusText(text) {
  timerStatus.textContent = text;
}

function setButtonState(status) {
  if (status === 'running') {
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
    btnLabel.textContent = 'Pause';
    startPauseBtn.setAttribute('aria-label', 'Pause timer');
  } else if (status === 'paused') {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
    btnLabel.textContent = 'Resume';
    startPauseBtn.setAttribute('aria-label', 'Resume timer');
  } else {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
    btnLabel.textContent = 'Start';
    startPauseBtn.setAttribute('aria-label', 'Start timer');
  }
}

function updatePageTitle() {
  document.title = `${formatTime(state.timeLeft)} — ${getModeLabel(state.mode)} | Pomodoro`;
}

// ── Visual alert ──────────────────────────────────────────────────
function flashAlert() {
  timerContainer.classList.add('alerting');
  timerContainer.addEventListener('animationend', () => {
    timerContainer.classList.remove('alerting');
  }, { once: true });
}

// ── Browser notifications ─────────────────────────────────────────
function sendBrowserNotification() {
  if (!('Notification' in window)) return;

  const body = state.mode === 'work'
    ? (state.sessionsCompleted % state.settings.longBreakInterval === 0
        ? 'Long break time! Great work today.'
        : 'Short break time! Take a breath.')
    : 'Break over — time to focus!';

  if (Notification.permission === 'granted') {
    new Notification('🍅 Pomodoro Timer', { body, silent: true });
  } else if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ── Settings persistence ──────────────────────────────────────────
function loadSettings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) Object.assign(state.settings, JSON.parse(saved));
  } catch (_) {}
}

function persistSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings)); } catch (_) {}
}

function syncInputsFromSettings() {
  inputs.workDuration.value       = state.settings.workDuration;
  inputs.shortBreakDuration.value = state.settings.shortBreakDuration;
  inputs.longBreakDuration.value  = state.settings.longBreakDuration;
  inputs.longBreakInterval.value  = state.settings.longBreakInterval;
  inputs.autoStartBreaks.checked  = state.settings.autoStartBreaks;
  inputs.autoStartWork.checked    = state.settings.autoStartWork;
  inputs.soundAlert.checked       = state.settings.soundAlert;
}

function readInputsToSettings() {
  state.settings.workDuration        = clamp(parseInt(inputs.workDuration.value) || 25, 1, 60);
  state.settings.shortBreakDuration  = clamp(parseInt(inputs.shortBreakDuration.value) || 5, 1, 30);
  state.settings.longBreakDuration   = clamp(parseInt(inputs.longBreakDuration.value) || 15, 1, 60);
  state.settings.longBreakInterval   = clamp(parseInt(inputs.longBreakInterval.value) || 4, 2, 10);
  state.settings.autoStartBreaks     = inputs.autoStartBreaks.checked;
  state.settings.autoStartWork       = inputs.autoStartWork.checked;
  state.settings.soundAlert          = inputs.soundAlert.checked;
}

function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }

// ── Settings panel ────────────────────────────────────────────────
function openSettings() {
  syncInputsFromSettings();
  settingsOverlay.classList.add('open');
  settingsOverlay.querySelector('.settings-panel').scrollTop = 0;
  closeSettingsBtn.focus();
}

function closeSettings() {
  settingsOverlay.classList.remove('open');
  settingsBtn.focus();
}

function saveSettings() {
  readInputsToSettings();
  persistSettings();

  // Re-sync display if timer is idle (non-destructive)
  if (state.status === 'idle') {
    state.timeLeft  = getDurationSecs(state.mode);
    state.totalTime = state.timeLeft;
    updateDisplay();
    setRingProgress(1);
    updatePageTitle();
  }
  renderSessionDots();
  closeSettings();
}

// ── Event wiring ──────────────────────────────────────────────────
startPauseBtn.addEventListener('click', () => {
  ensureAudioCtx();   // Unlock audio on first interaction
  if (state.status === 'running') pauseTimer();
  else startTimer();
});

resetBtn.addEventListener('click', resetTimer);
skipBtn.addEventListener('click', skipSession);

document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (state.mode === tab.dataset.mode) return;
    clearInterval(state.intervalId);
    state.intervalId = null;
    applyMode(tab.dataset.mode);
  });
});

settingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', closeSettings);
saveSettingsBtn.addEventListener('click', saveSettings);

// Close settings when clicking outside the panel
settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) closeSettings();
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;           // Let inputs be typed in
  if (settingsOverlay.classList.contains('open')) {
    if (e.key === 'Escape') closeSettings();
    return;
  }
  switch (e.key) {
    case ' ':
    case 'Enter':
      e.preventDefault();
      startPauseBtn.click();
      break;
    case 'r': case 'R': resetTimer(); break;
    case 's': case 'S': skipSession(); break;
  }
});

// +/- buttons in settings
document.querySelectorAll('.num-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const val   = parseInt(input.value) || 0;
    const min   = parseInt(input.min)   || 1;
    const max   = parseInt(input.max)   || 99;
    input.value = btn.dataset.action === 'inc'
      ? Math.min(val + 1, max)
      : Math.max(val - 1, min);
  });
});

// Trap focus inside settings panel when open
settingsOverlay.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const focusable = Array.from(
    settingsOverlay.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')
  ).filter(el => !el.disabled && el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ── Initialisation ────────────────────────────────────────────────
function init() {
  loadSettings();
  applyMode('work');

  // Prompt for notification permission (non-blocking)
  if ('Notification' in window && Notification.permission === 'default') {
    // We'll request on first completion to avoid an immediate pop-up
  }
}

init();
