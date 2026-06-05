// ── 상태 표시 헬퍼 ───────────────────────────────────────────────
function setText(selector, value) {
  document.querySelectorAll(selector).forEach((el) => {
    el.textContent = value === undefined || value === null || value === '' ? '-' : String(value);
  });
}

function setTileStatus(tile, status) {
  if (status) tile.setAttribute('data-status', status);
  else tile.removeAttribute('data-status');
}

function classifyBitrate(kbps) {
  if (kbps == null) return null;
  if (kbps < 500) return 'err';
  if (kbps < 2000) return 'warn';
  return 'ok';
}

function classifyDropped(n) {
  if (n == null) return null;
  if (n > 100) return 'err';
  if (n > 0) return 'warn';
  return 'ok';
}

function classifyCpu(pct) {
  if (pct == null) return null;
  if (pct > 80) return 'err';
  if (pct > 60) return 'warn';
  return 'ok';
}

function classifyBool(v) {
  if (v === undefined || v === null) return null;
  return v ? 'ok' : 'err';
}

const scenarioState = {
  stageIndex: 0,
  stages: [],
  alertDelayMs: 5000,
  stageChangedAt: 0,
  alertTimer: null,
  alertedKeys: new Set(),
  obsSources: null,
  audioInputs: null,
  obs: null,
  youtube: null,
  lufs: null,
};

const DEFAULT_SCENARIO_STAGES = [
  {
    id: 'standby',
    title: '예배 준비',
    notify: false,
    checks: {
      scene: { enabled: true, expected: '예배준비' },
      audio: { enabled: false, expected: '' },
      recording: { enabled: false, expected: false },
    },
  },
  {
    id: 'start',
    title: '예배 시작',
    notify: true,
    checks: {
      scene: { enabled: true, expected: '' },
      audio: { enabled: true, expected: '' },
      recording: { enabled: false, expected: false },
    },
  },
  {
    id: 'sermon',
    title: '설교',
    notify: true,
    checks: {
      scene: { enabled: true, expected: '' },
      audio: { enabled: true, expected: '' },
      recording: { enabled: true, expected: true },
    },
  },
  {
    id: 'closing',
    title: '마무리',
    notify: true,
    checks: {
      scene: { enabled: false, expected: '' },
      audio: { enabled: false, expected: '' },
      recording: { enabled: false, expected: false },
    },
  },
];

scenarioState.stages = DEFAULT_SCENARIO_STAGES.map((stage) => ({ ...stage }));
scenarioState.stageIndex = Math.max(0, Math.min(scenarioState.stages.length - 1, scenarioState.stageIndex));

function setIndicator(id, state, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('is-ok', 'is-err');
  if (state === 'ok') el.classList.add('is-ok');
  else if (state === 'err') el.classList.add('is-err');
  if (label) {
    const dot = el.querySelector('.dot');
    el.textContent = '';
    if (dot) el.appendChild(dot);
    el.append(label);
  }
}

function setIndicators(ids, state, label) {
  for (const id of ids) setIndicator(id, state, label);
}

function updateSidebarClock() {
  const now = new Date();
  const time = document.getElementById('sidebar-time');
  const date = document.getElementById('sidebar-date');
  if (time) {
    time.textContent = now.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  if (date) {
    date.textContent = now.toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    });
  }
}

updateSidebarClock();
setInterval(updateSidebarClock, 1000);

// ── 비트레이트/드롭 차트 (uPlot) ─────────────────────────────────
const CHART_MAX_POINTS = 300; // 5분 @ 1Hz
const chartBuf = { t: [], bitrate: [], dropDelta: [] };
let chart = null;
let prevDroppedTotal = null;
let chartResizeObserver = null;

function initBitrateChart() {
  if (chart || typeof uPlot === 'undefined') return;
  const container = document.getElementById('bitrate-chart');
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const opts = {
    width: Math.max(200, rect.width),
    height: Math.max(140, rect.height),
    padding: [10, 10, 0, 0],
    cursor: { drag: { x: false, y: false } },
    legend: { show: true },
    series: [
      { value: (_, v) => v == null ? '-' : new Date(v * 1000).toLocaleTimeString('ko-KR') },
      { label: 'kbps', stroke: '#2b7cff', width: 1.5, spanGaps: false, value: (_, v) => v == null ? '-' : Math.round(v) },
      { label: 'drop/s', stroke: '#ef4444', width: 1.5, scale: 'drop', spanGaps: false, value: (_, v) => v == null ? '-' : Math.round(v) },
    ],
    scales: {
      x: { time: true },
      y: { auto: true },
      drop: { auto: true },
    },
    axes: [
      { stroke: '#9aa3b2', grid: { stroke: '#eef0f4' } },
      { stroke: '#2b7cff', scale: 'y', grid: { stroke: '#eef0f4' } },
      { stroke: '#ef4444', scale: 'drop', side: 1, grid: { show: false } },
    ],
  };
  chart = new uPlot(opts, [chartBuf.t, chartBuf.bitrate, chartBuf.dropDelta], container);

  chartResizeObserver = new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) chart.setSize({ width: r.width, height: r.height });
  });
  chartResizeObserver.observe(container);
}

function pushChartPoint(ts, bitrateKbps, droppedTotal) {
  if (!chart) return;
  const tSec = Math.floor(ts / 1000);
  // dropped는 누적이므로 직전과의 차이를 보여 줌 (감소 시 0)
  let delta = 0;
  if (prevDroppedTotal != null && droppedTotal != null) {
    delta = Math.max(0, droppedTotal - prevDroppedTotal);
  }
  if (droppedTotal != null) prevDroppedTotal = droppedTotal;

  chartBuf.t.push(tSec);
  chartBuf.bitrate.push(bitrateKbps ?? null);
  chartBuf.dropDelta.push(delta);
  while (chartBuf.t.length > CHART_MAX_POINTS) {
    chartBuf.t.shift();
    chartBuf.bitrate.shift();
    chartBuf.dropDelta.shift();
  }
  chart.setData([chartBuf.t, chartBuf.bitrate, chartBuf.dropDelta]);
}

// ── OBS 상태 → 타일 갱신 ──────────────────────────────────────────
function applyObsState(s) {
  const tiles = document.querySelectorAll('.tile');
  for (const tile of tiles) {
    const key = tile.dataset.tile;
    const el = tile.querySelector(`[data-key="${key}"]`);
    if (!el) continue;
    switch (key) {
      case 'streaming':
        el.textContent = s.streaming ? '송출 중' : '중지';
        setTileStatus(tile, classifyBool(s.streaming));
        break;
      case 'recording':
        el.textContent = s.recording ? '녹화 중' : '중지';
        setTileStatus(tile, s.recording ? 'ok' : null);
        break;
      case 'bitrateKbps':
        el.textContent = s.bitrateKbps ?? '-';
        setTileStatus(tile, classifyBitrate(s.bitrateKbps));
        break;
      case 'droppedFrames':
        el.textContent = s.droppedFrames ?? '-';
        setTileStatus(tile, classifyDropped(s.droppedFrames));
        break;
      case 'renderSkippedFrames':
        el.textContent = s.renderSkippedFrames ?? '-';
        setTileStatus(tile, classifyDropped(s.renderSkippedFrames));
        break;
      case 'cpuUsage':
        el.textContent = s.cpuUsage != null ? s.cpuUsage.toFixed(1) : '-';
        setTileStatus(tile, classifyCpu(s.cpuUsage));
        break;
      case 'memoryUsageMb':
        el.textContent = s.memoryUsageMb != null ? Math.round(s.memoryUsageMb) : '-';
        setTileStatus(tile, null);
        break;
      case 'scene':
        el.textContent = s.scene || '-';
        setTileStatus(tile, s.scene ? 'ok' : null);
        break;
    }
  }
  document.getElementById('status-updated').textContent = new Date(s.ts).toLocaleTimeString('ko-KR');
  document.getElementById('last-obs-ts').textContent = new Date(s.ts).toLocaleString('ko-KR');

  applyAudioMeters(s.audioMeters || []);
  // 차트는 폴링 결과 (bitrate가 있는) state에서만 갱신. audio meter 이벤트는 bitrateKbps가 undefined.
  if (s.bitrateKbps != null) pushChartPoint(s.ts, s.bitrateKbps, s.droppedFrames);
}

// ── YouTube 상태 → 타일/디테일 갱신 ───────────────────────────────
function classifyHealthStatus(v) {
  if (v == null) return null;
  if (v === 'good') return 'ok';
  if (v === 'ok') return 'ok';
  if (v === 'bad') return 'err';
  if (v === 'noData') return 'warn';
  return null;
}

function formatStatusText(v) {
  if (v == null || v === '') return '-';
  return String(v).charAt(0).toUpperCase() + String(v).slice(1);
}

function classifyStreamStatus(v) {
  if (v == null) return null;
  if (v === 'active') return 'ok';
  if (v === 'error') return 'err';
  if (v === 'inactive') return 'warn';
  return null;
}

function applyYoutubeState(s) {
  const tiles = document.querySelectorAll('.tile');
  for (const tile of tiles) {
    const key = tile.dataset.tile;
    const el = tile.querySelector(`[data-key="${key}"]`);
    if (!el) continue;
    switch (key) {
      case 'live':
        el.textContent = s.live ? '온에어' : '오프라인';
        setTileStatus(tile, s.live ? 'ok' : null);
        break;
      case 'concurrentViewers':
        el.textContent = s.concurrentViewers ?? '-';
        setTileStatus(tile, s.live ? 'ok' : null);
        break;
      case 'broadcastStatus':
        el.textContent = s.broadcastStatus || '-';
        setTileStatus(tile, s.broadcastStatus === 'live' ? 'ok' : (s.broadcastStatus === 'upcoming' ? 'warn' : null));
        break;
      case 'activeLiveChatId':
        el.textContent = s.activeLiveChatId ? '활성' : '없음';
        setTileStatus(tile, s.activeLiveChatId ? 'ok' : null);
        break;
      case 'healthStatus':
        el.textContent = formatStatusText(s.healthStatus);
        setTileStatus(tile, classifyHealthStatus(s.healthStatus));
        break;
      case 'streamStatus':
        el.textContent = s.streamStatus || '-';
        setTileStatus(tile, classifyStreamStatus(s.streamStatus));
        break;
      case 'configurationIssues': {
        const issues = s.configurationIssues || [];
        el.textContent = issues.length ? `${issues.length}건` : '없음';
        const hasErr = issues.some((i) => i.severity === 'error');
        const hasWarn = issues.some((i) => i.severity === 'warning');
        setTileStatus(tile, hasErr ? 'err' : (hasWarn ? 'warn' : (issues.length === 0 && s.live ? 'ok' : null)));
        break;
      }
    }
  }

  const detail = document.getElementById('current-broadcast');
  detail.querySelector('[data-key="title"]').textContent = s.title || '-';
  detail.querySelector('[data-key="url"]').textContent = s.url || '-';
  detail.querySelector('[data-key="activeLiveChatId"]').textContent = s.activeLiveChatId || '-';
  detail.querySelector('[data-key="broadcastStatus"]').textContent = s.broadcastStatus || '-';
  document.getElementById('yt-mode').textContent = s.mode || '-';
  document.getElementById('config-issues-detail').textContent = formatConfigIssues(s.configurationIssues);
  document.getElementById('last-yt-ts').textContent = new Date(s.ts).toLocaleString('ko-KR');
}

function formatConfigIssues(issues) {
  if (!issues || !issues.length) return '없음';
  return issues
    .map((i) => `[${i.severity || '?'}] ${i.type || '?'}: ${i.reason || i.description || ''}`)
    .join(' · ');
}

// ── 오디오 미터 ──────────────────────────────────────────────────
// audioMeters: [{ inputName, inputLevelsMul: [[mag, peak, input_peak], ...] }, ...]
// 모든 인풋의 채널0/1 중 max peak를 L/R로 표시 (전체 송출 레벨에 가깝게).
function applyAudioMeters(meters) {
  if (!meters || !meters.length) return;
  let maxL = 0, maxR = 0;
  for (const input of meters) {
    const ch = input?.inputLevelsMul || [];
    const l = ch[0]?.[1] ?? 0;
    const r = ch[1]?.[1] ?? l;
    if (l > maxL) maxL = l;
    if (r > maxR) maxR = r;
  }
  drawMeter('meter-l', 'meter-l-db', maxL);
  drawMeter('meter-r', 'meter-r-db', maxR);
}

function drawMeter(barId, dbId, peakMul) {
  const bar = document.getElementById(barId);
  const db = document.getElementById(dbId);
  if (!bar || !db) return;
  // -60dB → 0%, 0dB → 100%
  const dbVal = peakMul > 0 ? 20 * Math.log10(peakMul) : -Infinity;
  const pct = Math.max(0, Math.min(100, ((dbVal + 60) / 60) * 100));
  bar.style.width = pct + '%';
  db.textContent = peakMul > 0 ? dbVal.toFixed(1) + ' dB' : '-∞ dB';
}

// ── 예배 시나리오 체크 ───────────────────────────────────────────
function getInputPeakDb(input) {
  let maxMul = 0;
  for (const ch of input?.inputLevelsMul || []) {
    const peak = ch?.[1] ?? 0;
    if (peak > maxMul) maxMul = peak;
  }
  return maxMul > 0 ? 20 * Math.log10(maxMul) : -Infinity;
}

function getAudioSourceStatus() {
  const meters = scenarioState.obs?.audioMeters || [];
  const mixerInputs = meters.filter((input) => /믹서|mixer|mix/i.test(input?.inputName || ''));
  const desktopInputs = meters.filter((input) => /desktop audio|데스크탑|데스크톱|pc audio/i.test(input?.inputName || ''));
  const mixerPeak = mixerInputs.reduce((max, input) => Math.max(max, getInputPeakDb(input)), -Infinity);
  const desktopPeak = desktopInputs.reduce((max, input) => Math.max(max, getInputPeakDb(input)), -Infinity);
  return {
    mixerFound: mixerInputs.length > 0,
    mixerActive: mixerPeak > -50,
    mixerPeak,
    desktopFound: desktopInputs.length > 0,
    desktopActive: desktopPeak > -50,
    desktopPeak,
  };
}

function getSelectedAudioStatus(inputName) {
  const meters = scenarioState.obs?.audioMeters || [];
  const target = meters.find((input) => input?.inputName === inputName);
  const peak = target ? getInputPeakDb(target) : -Infinity;
  return {
    found: !!target,
    active: peak > -50,
    peak,
  };
}

function isStandbyScene(scene) {
  return /준비|대기|standby|ready|waiting/i.test(scene || '');
}

function getScenarioStages() {
  return scenarioState.stages?.length ? scenarioState.stages : DEFAULT_SCENARIO_STAGES;
}

function getStageKind(stage) {
  const text = `${stage?.id || ''} ${stage?.title || ''}`.toLowerCase();
  if (/standby|ready|준비|대기/.test(text)) return 'standby';
  if (/sermon|설교/.test(text)) return 'sermon';
  if (/closing|close|end|마무리|종료/.test(text)) return 'closing';
  return 'start';
}

function defaultChecksForStage(stage) {
  const kind = getStageKind(stage);
  if (kind === 'standby') {
    return {
      scene: { enabled: true, expected: '예배준비' },
      audio: { enabled: false, expected: '' },
      recording: { enabled: false, expected: false },
    };
  }
  if (kind === 'sermon') {
    return {
      scene: { enabled: true, expected: '' },
      audio: { enabled: true, expected: '' },
      recording: { enabled: true, expected: true },
    };
  }
  if (kind === 'closing') {
    return {
      scene: { enabled: false, expected: '' },
      audio: { enabled: false, expected: '' },
      recording: { enabled: false, expected: false },
    };
  }
  return {
    scene: { enabled: true, expected: '' },
    audio: { enabled: true, expected: '' },
    recording: { enabled: false, expected: false },
  };
}

function getStageChecks(stage) {
  const defaults = defaultChecksForStage(stage);
  const checks = stage?.checks || {};
  return {
    scene: { ...defaults.scene, ...(checks.scene || {}) },
    audio: { ...defaults.audio, ...(checks.audio || {}) },
    recording: { ...defaults.recording, ...(checks.recording || {}) },
  };
}

function defaultNotifyForStage(stage) {
  return getStageKind(stage) !== 'standby';
}

function getStageNotify(stage) {
  return typeof stage?.notify === 'boolean' ? stage.notify : defaultNotifyForStage(stage);
}

function makeScenarioChecks() {
  const stage = getScenarioStages()[scenarioState.stageIndex];
  const stageKind = getStageKind(stage);
  const obs = scenarioState.obs || {};
  const yt = scenarioState.youtube || {};
  const audio = getAudioSourceStatus();
  const scene = obs.scene || '';
  const sources = Array.isArray(obs.sources) ? obs.sources : [];
  const stageChecks = getStageChecks(stage);
  const checks = [];

  const push = (id, label, detail, status) => checks.push({ id, label, detail, status });
  const liveReady = !!obs.streaming && !!yt.live;
  const expectedSource = stageChecks.scene.expected;
  const sourceReady = expectedSource ? sources.includes(expectedSource) : false;
  const expectedAudio = stageChecks.audio.expected;
  const selectedAudio = getSelectedAudioStatus(expectedAudio);

  push(
    'streaming',
    'OBS 송출',
    obs.streaming ? 'OBS가 송출 중입니다.' : 'OBS 송출이 꺼져 있습니다.',
    obs.streaming ? 'ok' : (stageKind === 'standby' ? 'warn' : 'err'),
  );
  push(
    'youtube',
    'YouTube Live',
    yt.live ? 'YouTube 라이브가 감지되었습니다.' : 'YouTube 라이브가 아직 감지되지 않았습니다.',
    yt.live ? 'ok' : (stageKind === 'standby' ? 'warn' : 'err'),
  );

  if (stageChecks.scene.enabled && stageKind === 'standby') {
    push(
      'scene',
      '소스 선택',
      expectedSource
        ? (sourceReady ? `현재 소스에 있음: ${expectedSource}` : `현재 소스 ${scene || '-'} / 기대 소스 ${expectedSource}`)
        : '기대 소스가 설정되지 않았습니다 (시나리오 편집에서 선택하세요)',
      expectedSource ? (sourceReady ? 'ok' : 'err') : 'warn',
    );
  } else {
    if (stageChecks.scene.enabled) {
      if (!expectedSource) {
        push(
          'scene',
          '소스 선택',
          '기대 소스가 설정되지 않았습니다 (시나리오 편집에서 선택하세요)',
          'warn',
        );
      } else {
        push(
          'scene',
          '소스 선택',
          sourceReady
            ? `현재 소스에 있음: ${expectedSource}`
            : `현재 소스 ${scene || '-'} / 기대 소스 ${expectedSource}`,
          sourceReady ? 'ok' : 'err',
        );
      }
    }
    if (stageChecks.audio.enabled) {
      if (!expectedAudio) {
        push(
          'mixer',
          '오디오 선택',
          '기대 오디오 입력이 설정되지 않았습니다 (시나리오 편집에서 선택하세요)',
          'warn',
        );
      } else {
        push(
          'mixer',
          '오디오 선택',
          selectedAudio.found
            ? (selectedAudio.active
                ? `${expectedAudio} 신호 감지 (${formatDb(selectedAudio.peak)})`
                : `${expectedAudio} 신호가 약합니다 (${formatDb(selectedAudio.peak)})`)
            : `${expectedAudio} 입력을 찾지 못했습니다.`,
          selectedAudio.found && selectedAudio.active ? 'ok' : 'err',
        );
      }
    }
  }

  if (stageChecks.recording.enabled) {
    const expectedRecording = stageChecks.recording.expected !== false;
    push(
      'recording',
      '녹화 상태',
      obs.recording === expectedRecording
        ? (obs.recording ? '녹화가 켜져 있습니다.' : '녹화가 꺼져 있습니다.')
        : (expectedRecording ? '녹화가 켜져 있어야 합니다.' : '녹화가 꺼져 있어야 합니다.'),
      obs.recording === expectedRecording ? 'ok' : 'err',
    );
  }

  if (stageKind !== 'standby') {
    push(
      'quality',
      '기본 신호',
      liveReady ? 'OBS와 YouTube가 모두 라이브 상태입니다.' : 'OBS 또는 YouTube 라이브 상태를 확인해야 합니다.',
      liveReady ? 'ok' : 'err',
    );
  }

  return checks;
}

function formatDb(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} dB` : '-∞ dB';
}

function scenarioStatusLabel(status) {
  if (status === 'ok') return 'OK';
  if (status === 'warn') return '확인 필요';
  if (status === 'err') return '위험';
  return '대기';
}

function scenarioCheckIcon(id) {
  const icons = {
    streaming: 'broadcast',
    youtube: 'play',
    scene: 'monitor',
    recording: 'record',
    mixer: 'sliders',
    desktop: 'speaker',
    quality: 'activity',
  };
  return icons[id] || 'check';
}

function signalIcon(id) {
  const icons = {
    'scenario-signal-streaming': 'monitor',
    'scenario-signal-live': 'youtube',
    'scenario-signal-scene': 'layers',
    'scenario-signal-recording': 'record',
    'scenario-signal-bitrate': 'trend',
    'scenario-signal-lufs': 'wave',
  };
  return icons[id] || 'activity';
}

function iconSvg(name) {
  const attrs = 'viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  const paths = {
    activity: '<path d="M22 12h-4l-3 7-6-14-3 7H2"/>',
    broadcast: '<rect x="4" y="5" width="16" height="10" rx="2"/><path d="M8 19h8"/><path d="M12 15v4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
    play: '<path d="m9 7 8 5-8 5V7Z"/><rect x="3" y="5" width="18" height="14" rx="4"/>',
    record: '<circle cx="12" cy="12" r="7"/>',
    sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
    speaker: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/>',
    trend: '<path d="m3 17 6-6 4 4 7-7"/><path d="M14 8h6v6"/>',
    wave: '<path d="M2 12h3l2-7 4 14 3-7h8"/>',
    youtube: '<path d="M22 12s0-4-1-5-5-1-9-1-8 0-9 1-1 5-1 5 0 4 1 5 5 1 9 1 8 0 9-1 1-5 1-5Z"/><path d="m10 9 5 3-5 3V9Z"/>',
  };
  return `<svg ${attrs}>${paths[name] || paths.activity}</svg>`;
}

function renderScenarioRail() {
  const rail = document.getElementById('scenario-stage-rail');
  if (!rail) return;
  const stages = getScenarioStages();
  rail.style.setProperty('--stage-count', String(stages.length));

  const existing = rail.querySelectorAll('.stage-step');
  const sameStructure =
    existing.length === stages.length &&
    [...existing].every((btn, i) => btn.textContent === stages[i].title);

  if (sameStructure) {
    existing.forEach((btn, i) => {
      btn.classList.toggle('active', i === scenarioState.stageIndex);
      btn.classList.toggle('done', i < scenarioState.stageIndex);
    });
    return;
  }

  rail.textContent = '';
  stages.forEach((stage, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stage-step';
    btn.dataset.stageIndex = String(index);
    btn.classList.toggle('active', index === scenarioState.stageIndex);
    btn.classList.toggle('done', index < scenarioState.stageIndex);
    btn.textContent = stage.title;
    rail.appendChild(btn);
  });
}

function renderScenarioChecks() {
  const stages = getScenarioStages();
  scenarioState.stageIndex = Math.max(0, Math.min(stages.length - 1, scenarioState.stageIndex));
  const stage = stages[scenarioState.stageIndex];
  const title = document.getElementById('scenario-stage-title');
  const note = document.getElementById('scenario-stage-note');
  if (title) title.textContent = stage.title;
  if (note) note.textContent = stage.note;

  renderScenarioRail();

  const checks = makeScenarioChecks();
  const grid = document.getElementById('scenario-check-grid');
  if (grid) {
    grid.textContent = '';
    for (const check of checks) {
      const item = document.createElement('div');
      item.className = 'scenario-check';
      item.dataset.status = check.status;
      const icon = document.createElement('span');
      icon.className = 'scenario-check-icon';
      icon.innerHTML = iconSvg(scenarioCheckIcon(check.id));
      const body = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = check.label;
      const detail = document.createElement('p');
      detail.textContent = check.detail;
      const status = document.createElement('span');
      status.className = 'scenario-check-status';
      status.textContent = scenarioStatusLabel(check.status);
      body.appendChild(label);
      body.appendChild(detail);
      item.appendChild(icon);
      item.appendChild(body);
      item.appendChild(status);
      grid.appendChild(item);
    }
  }

  const counts = checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, {});
  const summary = document.getElementById('scenario-summary');
  if (summary) summary.textContent = `OK ${counts.ok || 0} · 확인 ${counts.warn || 0} · 위험 ${counts.err || 0}`;

  updateScenarioSignals();
}

function updateScenarioSignals() {
  const obs = scenarioState.obs || {};
  const yt = scenarioState.youtube || {};
  const lufs = scenarioState.lufs || {};
  setScenarioSignal('scenario-signal-streaming', 'OBS 송출', obs.streaming ? '송출 중' : '중지', obs.streaming ? 'ok' : 'err', [
    ['경과 시간', '-'],
    ['드롭 프레임', obs.droppedFrames == null ? '-' : String(obs.droppedFrames)],
  ]);
  setScenarioSignal('scenario-signal-live', 'YouTube Live', yt.live ? '라이브' : '오프라인', yt.live ? 'ok' : 'warn', [
    ['현재 시청자', yt.concurrentViewers == null ? '-' : String(yt.concurrentViewers)],
    ['상태', yt.healthStatus || yt.broadcastStatus || '-'],
  ]);
  setScenarioSignal('scenario-signal-scene', '현재 Scene', obs.scene || '-', obs.scene && !isStandbyScene(obs.scene) ? 'ok' : 'warn', [
    ['다음 전환', '-'],
    ['자동 전환', '비활성'],
  ]);
  setScenarioSignal('scenario-signal-recording', '녹화 상태', obs.recording ? '녹화 중' : '녹화 중지', obs.recording ? 'ok' : 'err', [
    ['녹화 파일', '-'],
    ['경과 시간', '-'],
  ]);
  setScenarioSignal('scenario-signal-bitrate', '비트레이트', obs.bitrateKbps == null ? '-' : `${obs.bitrateKbps} kbps`, classifyBitrate(obs.bitrateKbps), [
    ['목표 비트레이트', '-'],
    ['업로드 상태', classifyBitrate(obs.bitrateKbps) === 'ok' ? '좋음' : '확인'],
  ]);
  setScenarioSignal('scenario-signal-lufs', 'LUFS (통합)', lufs.shortTerm == null ? '-' : `${lufs.shortTerm.toFixed(1)} LUFS`, null, [
    ['범위', '-23.1 ~ -15.2'],
    ['상태', lufs.shortTerm == null ? '-' : '수신 중'],
  ]);
}

function setScenarioSignal(id, label, value, status, meta = []) {
  const el = document.getElementById(id);
  if (!el) return;
  const card = el.parentElement;
  if (!card) return;
  card.dataset.status = status || '';
  card.querySelector('.scenario-signal-icon')?.remove();
  const icon = document.createElement('span');
  icon.className = 'scenario-signal-icon';
  icon.innerHTML = iconSvg(signalIcon(id));
  card.prepend(icon);
  const labelEl = card.querySelector('span:not(.scenario-signal-icon)');
  if (labelEl) labelEl.textContent = label;
  el.textContent = value;
  card.querySelector('.scenario-signal-meta')?.remove();
  const metaWrap = document.createElement('div');
  metaWrap.className = 'scenario-signal-meta';
  for (const [k, v] of meta) {
    const item = document.createElement('div');
    const key = document.createElement('span');
    const val = document.createElement('strong');
    key.textContent = k;
    val.textContent = v;
    item.appendChild(key);
    item.appendChild(val);
    metaWrap.appendChild(item);
  }
  card.appendChild(metaWrap);
}

function applyScenarioStageIndex(index, options = {}) {
  const stages = getScenarioStages();
  scenarioState.stageIndex = Math.max(0, Math.min(stages.length - 1, index));
  scenarioState.stageChangedAt = options.changedAt || Date.now();
  scenarioState.alertedKeys = new Set();
  if (options.schedule !== false) scheduleScenarioAlertCheck();
  renderScenarioChecks();
}

function setScenarioStage(index) {
  applyScenarioStageIndex(index);
  window.api.setScenarioStage?.({ stageIndex: scenarioState.stageIndex }).catch(() => {});
}

function scheduleScenarioAlertCheck() {
  if (scenarioState.alertTimer) clearTimeout(scenarioState.alertTimer);
  scenarioState.alertTimer = setTimeout(() => {
    scenarioState.alertTimer = null;
    sendScenarioBlockAlerts();
  }, Math.max(0, Number(scenarioState.alertDelayMs || 5000)));
}

const SCENARIO_SEVERITY = {
  streaming: '[긴급]',
  mixer: '[긴급]',
  youtube: '[오류]',
  scene: '[오류]',
  recording: '[오류]',
};

function sendScenarioBlockAlerts() {
  const stage = getScenarioStages()[scenarioState.stageIndex];
  if (!stage) return;
  if (!getStageNotify(stage)) return;
  const failures = makeScenarioChecks()
    .filter((check) => ['streaming', 'youtube', 'scene', 'mixer', 'recording'].includes(check.id))
    .filter((check) => check.status === 'err');
  for (const failure of failures) {
    const key = `${scenarioState.stageIndex}:${failure.id}`;
    if (scenarioState.alertedKeys.has(key)) continue;
    scenarioState.alertedKeys.add(key);
    const sev = SCENARIO_SEVERITY[failure.id] || '[오류]';
    window.api.sendScenarioAlert?.({
      message: `${sev} ${failure.detail}`,
    }).catch(() => {});
  }
}

function normalizeScenarioStages(stages) {
  if (!Array.isArray(stages)) return DEFAULT_SCENARIO_STAGES.map((stage) => ({ ...stage }));
  const normalized = stages
    .map((stage, index) => ({
      id: String(stage?.id || `stage-${index}`),
      title: String(stage?.title || '').trim(),
      note: String(stage?.note || '').trim(),
      notify: getStageNotify(stage),
      checks: getStageChecks(stage),
    }))
    .filter((stage) => stage.title);
  return normalized.length ? normalized : DEFAULT_SCENARIO_STAGES.map((stage) => ({ ...stage }));
}

function applyScenarioConfig(scenario) {
  scenarioState.stages = normalizeScenarioStages(scenario?.stages);
  scenarioState.alertDelayMs = Number.isFinite(Number(scenario?.alertDelayMs)) ? Number(scenario.alertDelayMs) : 5000;
  scenarioState.stageIndex = Math.max(0, Math.min(
    scenarioState.stages.length - 1,
    Number.isFinite(Number(scenario?.currentStageIndex)) ? Number(scenario.currentStageIndex) : scenarioState.stageIndex,
  ));
  scenarioState.alertedKeys = new Set();
  renderScenarioChecks();
}

function renderScenarioEditor(stages = getScenarioStages()) {
  const editor = $('scenario-editor');
  if (!editor) return;
  editor.textContent = '';
  stages.forEach((stage, index) => editor.appendChild(createScenarioEditorRow(stage, index)));
}

function createScenarioEditorRow(stage, index) {
  const checks = getStageChecks(stage);
  const notify = getStageNotify(stage);
  const row = document.createElement('div');
  row.className = 'scenario-editor-row';
  row.dataset.index = String(index);
  row.innerHTML = `
    <div class="scenario-editor-head">
      <strong>단계 ${index + 1}</strong>
      <button class="btn btn-ghost scenario-remove-stage" type="button">삭제</button>
    </div>
    <label>단계명<input class="scenario-stage-title-input" type="text" value="${escapeAttr(stage.title || '')}" /></label>
    <label>설명<input class="scenario-stage-note-input" type="text" value="${escapeAttr(stage.note || '')}" /></label>
    <label class="inline"><input class="scenario-stage-notify-input" type="checkbox" ${notify ? 'checked' : ''} /><span>이 단계에서 알림 보내기</span></label>
    <div class="scenario-block-grid">
      <label class="inline"><input class="scenario-check-enabled" data-check="scene" type="checkbox" ${checks.scene.enabled ? 'checked' : ''} /><span>소스 선택</span></label>
      <select class="scenario-check-value" data-check="scene">${optionList(scenarioState.obsSources, checks.scene.expected, '소스 선택 안 함')}</select>
      <label class="inline"><input class="scenario-check-enabled" data-check="audio" type="checkbox" ${checks.audio.enabled ? 'checked' : ''} /><span>오디오 선택</span></label>
      <select class="scenario-check-value" data-check="audio">${optionList(scenarioState.audioInputs, checks.audio.expected, '오디오 선택 안 함')}</select>
      <label class="inline"><input class="scenario-check-enabled" data-check="recording" type="checkbox" ${checks.recording.enabled ? 'checked' : ''} /><span>녹화 상태 감지</span></label>
      <select class="scenario-check-value" data-check="recording">
        <option value="true" ${checks.recording.expected !== false ? 'selected' : ''}>녹화 켜짐이어야 함</option>
        <option value="false" ${checks.recording.expected === false ? 'selected' : ''}>녹화 꺼짐이어야 함</option>
      </select>
    </div>
  `;
  row.querySelector('.scenario-remove-stage')?.addEventListener('click', () => {
    row.remove();
    refreshScenarioEditorNumbers();
  });
  return row;
}

function refreshScenarioEditorNumbers() {
  document.querySelectorAll('.scenario-editor-row').forEach((row, index) => {
    row.dataset.index = String(index);
    const label = row.querySelector('.scenario-editor-head strong');
    if (label) label.textContent = `단계 ${index + 1}`;
  });
}

function readScenarioEditor() {
  return Array.from(document.querySelectorAll('.scenario-editor-row'))
    .map((row, index) => {
      const title = row.querySelector('.scenario-stage-title-input')?.value.trim() || '';
      if (!title) return null;
      const note = row.querySelector('.scenario-stage-note-input')?.value.trim() || '';
      const notify = row.querySelector('.scenario-stage-notify-input')?.checked || false;
      const sceneEnabled = row.querySelector('.scenario-check-enabled[data-check="scene"]')?.checked || false;
      const audioEnabled = row.querySelector('.scenario-check-enabled[data-check="audio"]')?.checked || false;
      const recordingEnabled = row.querySelector('.scenario-check-enabled[data-check="recording"]')?.checked || false;
      const sceneExpected = row.querySelector('.scenario-check-value[data-check="scene"]')?.value || '';
      const audioExpected = row.querySelector('.scenario-check-value[data-check="audio"]')?.value || '';
      const recordingExpected = row.querySelector('.scenario-check-value[data-check="recording"]')?.value !== 'false';
      return {
        id: `stage-${index}`,
        title,
        note,
        notify,
        checks: {
          scene: { enabled: sceneEnabled, expected: sceneExpected },
          audio: { enabled: audioEnabled, expected: audioExpected },
          recording: { enabled: recordingEnabled, expected: recordingExpected },
        },
      };
    })
    .filter(Boolean);
}

async function refreshScenarioSourceOptions() {
  try {
    const [sources, inputs] = await Promise.all([
      window.api.obsSources?.(),
      window.api.obsAudioInputs?.(),
    ]);
    scenarioState.obsSources = Array.isArray(sources) ? sources : null;
    scenarioState.audioInputs = Array.isArray(inputs) ? inputs : null;
  } catch {
    scenarioState.obsSources = null;
    scenarioState.audioInputs = null;
  }
}

function optionList(values, selected, emptyLabel) {
  const options = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
  const obsResponded = Array.isArray(values);
  const fresh = (values || []).filter(Boolean);
  const baseList = obsResponded ? fresh : (selected ? [selected] : []);
  const stillSelected = baseList.includes(selected) ? selected : '';
  for (const value of [...new Set(baseList)]) {
    options.push(`<option value="${escapeAttr(value)}" ${value === stillSelected ? 'selected' : ''}>${escapeHtml(value)}</option>`);
  }
  return options.join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

// ── 알림 로그 ────────────────────────────────────────────────────
const ALERT_HISTORY_KEY = 'alert.history';
const ALERT_HISTORY_LIMIT = 500;
const ALERT_SEVERITY_BY_TYPE = {
  OBS_AUDIO_SILENCE: '긴급',
  OBS_AUDIO_PEAK: '오류',
  OBS_BITRATE_LOW: '오류',
  OBS_DROPPED_FRAMES_HIGH: '오류',
  LUFS_TOO_LOUD: '오류',
  LUFS_TOO_QUIET: '오류',
  YOUTUBE_HEALTH_BAD: '오류',
  YOUTUBE_CONFIG_ISSUE: '오류',
  OBS_STREAM_STARTED: '알림',
  OBS_STREAM_STOPPED: '알림',
  OBS_RECORD_STARTED: '알림',
  OBS_RECORD_STOPPED: '알림',
  OBS_BITRATE_RECOVERED: '알림',
  OBS_DROPPED_FRAMES_RECOVERED: '알림',
  LUFS_RECOVERED: '알림',
  YOUTUBE_LIVE_DETECTED: '알림',
  YOUTUBE_LIVE_ENDED: '알림',
  YOUTUBE_HEALTH_RECOVERED: '알림',
};
let alertCount = 0;
let alertHistory = loadAlertHistory();
let alertFilterSeverity = '';

function getAlertSeverity(alert) {
  if (alert?.type === 'SCENARIO_CHECK_FAILED' && alert.message) {
    if (alert.message.startsWith('[긴급]')) return '긴급';
    if (alert.message.startsWith('[오류]')) return '오류';
    if (alert.message.startsWith('[알림]')) return '알림';
  }
  return ALERT_SEVERITY_BY_TYPE[alert?.type] || null;
}

function loadAlertHistory() {
  try {
    const raw = localStorage.getItem(ALERT_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistAlertHistory() {
  try {
    localStorage.setItem(ALERT_HISTORY_KEY, JSON.stringify(alertHistory));
  } catch {}
}

function appendAlert(alert) {
  const item = createAlertItem(alert);
  const log = document.getElementById('alert-log');
  if (log) log.prepend(item);

  const scenarioLog = document.getElementById('scenario-alert-log');
  if (scenarioLog) scenarioLog.prepend(createAlertItem(alert));

  alertCount += 1;
  const countText = `${alertCount}건`;
  document.getElementById('alert-count').textContent = countText;
  const scenarioCount = document.getElementById('scenario-alert-count');
  if (scenarioCount) scenarioCount.textContent = countText;

  alertHistory.unshift({ ...alert, ts: alert.ts || Date.now() });
  if (alertHistory.length > ALERT_HISTORY_LIMIT) alertHistory.length = ALERT_HISTORY_LIMIT;
  persistAlertHistory();
  if (!document.getElementById('view-alerts')?.hidden) renderAlertHistory();
}

function renderAlertHistory() {
  const log = document.getElementById('alerts-history-log');
  const empty = document.getElementById('alerts-history-empty');
  const count = document.getElementById('alerts-history-count');
  if (!log) return;
  log.textContent = '';

  const filtered = alertFilterSeverity
    ? alertHistory.filter((a) => getAlertSeverity(a) === alertFilterSeverity)
    : alertHistory;
  const totalLabel = alertFilterSeverity ? ` / 전체 ${alertHistory.length}건` : '';
  if (count) count.textContent = `${filtered.length}건${totalLabel}`;
  if (empty) empty.hidden = filtered.length > 0;

  let currentDate = '';
  for (const alert of filtered) {
    const dateLabel = formatAlertDate(alert.ts);
    if (dateLabel !== currentDate) {
      currentDate = dateLabel;
      const header = document.createElement('li');
      header.className = 'alert-date';
      header.textContent = dateLabel;
      log.appendChild(header);
    }
    const item = createAlertItem(alert);
    const sev = getAlertSeverity(alert);
    if (sev) item.dataset.severity = sev;
    log.appendChild(item);
  }
}

function formatAlertDate(ts) {
  const d = new Date(ts || Date.now());
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (isSameDay(d, today)) return '오늘';
  if (isSameDay(d, yesterday)) return '어제';
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
}

function clearAlertHistory() {
  alertHistory = [];
  persistAlertHistory();
  renderAlertHistory();
}

function createAlertItem(alert) {
  const li = document.createElement('li');
  const time = new Date(alert.ts || Date.now()).toLocaleTimeString('ko-KR');
  const msg = document.createElement('span');
  msg.className = 'alert-msg';
  if (alert.type?.includes('STOPPED') || alert.type?.includes('ENDED')) msg.classList.add('is-warn');
  msg.textContent = formatAlertLabel(alert);
  const t = document.createElement('span');
  t.className = 'alert-time';
  t.textContent = time;
  li.appendChild(msg);
  li.appendChild(t);
  return li;
}

function formatAlertLabel(alert) {
  const map = {
    OBS_STREAM_STARTED: 'OBS 송출 시작',
    OBS_STREAM_STOPPED: 'OBS 송출 종료',
    OBS_STREAM_REPORT: 'OBS 송출 리포트',
    OBS_RECORD_STARTED: '녹화 시작',
    OBS_RECORD_STOPPED: '녹화 종료',
    OBS_AUDIO_SILENCE: '오디오가 감지되지 않음',
    OBS_AUDIO_PEAK: '오디오 피크 감지',
    OBS_BITRATE_LOW: '비트레이트 낮음',
    OBS_BITRATE_RECOVERED: '비트레이트 복구',
    OBS_DROPPED_FRAMES_HIGH: '드롭 프레임 높음',
    OBS_DROPPED_FRAMES_RECOVERED: '드롭 프레임 복구',
    LUFS_TOO_LOUD: '적정 LUFS 초과',
    LUFS_TOO_QUIET: '적정 LUFS 미달',
    LUFS_RECOVERED: '적정 LUFS 복구',
    YOUTUBE_LIVE_DETECTED: 'YouTube 라이브 시작',
    YOUTUBE_LIVE_ENDED: 'YouTube 라이브 종료',
    YOUTUBE_HEALTH_BAD: 'YouTube Status 이상',
    YOUTUBE_HEALTH_RECOVERED: 'YouTube Status 복구',
    YOUTUBE_CONFIG_ISSUE: 'YT 설정 이슈',
    SCENARIO_CHECK_FAILED: '시나리오 확인 필요',
  };
  let label = map[alert.type] || alert.type;
  if (alert.type === 'SCENARIO_CHECK_FAILED' && alert.message) label = alert.message;
  if (alert.peakDb != null) label += ` (${alert.peakDb} dB)`;
  if (alert.shortTermLufs != null) label += ` (${alert.shortTermLufs} LUFS)`;
  if (alert.bitrateKbps != null) label += ` (${alert.bitrateKbps} kbps)`;
  if (alert.droppedPct != null) label += ` (${alert.droppedPct}%)`;
  if (alert.durationMs != null) label += ` (${(alert.durationMs / 1000).toFixed(1)}s)`;
  if (alert.healthStatus) label += ` (${formatStatusText(alert.healthStatus)})`;
  if (alert.issueType) label += ` (${alert.issueType})`;
  return label;
}

// ── 부트 상태 ────────────────────────────────────────────────────
function setBootStatus(text, kind) {
  const el = document.getElementById('boot-status');
  el.textContent = text;
  el.classList.remove('is-ok', 'is-err');
  if (kind === 'ok') el.classList.add('is-ok');
  else if (kind === 'err') el.classList.add('is-err');
}

// ── IPC 이벤트 wiring ────────────────────────────────────────────
window.api.onObsState((s) => {
  scenarioState.obs = s;
  if (s.obsConnected === false) {
    setIndicators(['indicator-obs', 'scenario-indicator-obs'], 'err', 'OBS');
    setBootStatus('OBS 연결 끊김', 'err');
  } else {
    setIndicators(['indicator-obs', 'scenario-indicator-obs'], 'ok', 'OBS');
    setBootStatus('연결됨', 'ok');
  }
  applyObsState(s);
  renderScenarioChecks();
});
window.api.onYoutubeState((s) => {
  scenarioState.youtube = s;
  setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], s?.live ? 'ok' : 'warn', 'YouTube');
  applyYoutubeState(s);
  renderScenarioChecks();
});
window.api.onLufsState((s) => {
  if (s.ready) {
    const status = $('lufs-short-term');
    const updated = $('lufs-updated');
    if (status) status.textContent = 'UDP 대기 중';
    if (updated) updated.textContent = `${s.host}:${s.port}`;
    return;
  }
  scenarioState.lufs = s;
  const value = s.shortTerm;
  const status = $('lufs-short-term');
  const updated = $('lufs-updated');
  if (status) status.textContent = value == null ? 'shortTerm 없음' : `${value.toFixed(1)} LUFS`;
  if (updated) updated.textContent = new Date(s.ts || Date.now()).toLocaleTimeString('ko-KR');
  renderScenarioChecks();
});
window.api.onConfigChanged?.((cfg) => {
  updateMessengerBadge(cfg);
  applyScenarioConfig(cfg?.scenario);
  const chatInput = document.querySelector('[data-cfg="notify.telegram.chatIds"]');
  if (chatInput && document.activeElement !== chatInput) {
    chatInput.value = cfg?.notify?.telegram?.chatIds || cfg?.notify?.telegram?.chatId || '';
  }
});
window.api.onScenarioChanged?.((payload) => {
  if (payload?.source === 'desktop') return;
  const scenario = payload?.scenario;
  if (!scenario) return;
  applyScenarioStageIndex(Number(scenario.currentStageIndex || 0), {
    changedAt: scenario.currentStageChangedAt || Date.now(),
    schedule: true,
  });
});
window.api.onAlert(appendAlert);
window.api.onObsError((e) => {
  setIndicators(['indicator-obs', 'scenario-indicator-obs'], 'err', 'OBS');
  setBootStatus('OBS 오류: ' + e.message, 'err');
});
window.api.onYoutubeError((e) => {
  setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], 'err', 'YouTube');
  setBootStatus('YouTube 오류: ' + e.message, 'err');
});
window.api.onLufsError((e) => setBootStatus('LUFS 오류: ' + e.message, 'err'));
window.api.onBootError((e) => setBootStatus('부팅 오류: ' + e.message, 'err'));

// ── 뷰 전환 ──────────────────────────────────────────────────────
const VIEWS = ['dashboard', 'scenario', 'alerts', 'settings'];
const $ = (id) => document.getElementById(id);

function showView(name) {
  for (const v of VIEWS) {
    const el = document.getElementById('view-' + v);
    if (el) el.hidden = v !== name;
  }
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  if (name === 'settings') loadSettingsForm();
  if (name === 'scenario') renderScenarioChecks();
  if (name === 'alerts') renderAlertHistory();
}

function isMessengerReady(name, settings = {}) {
  if (!settings.enabled) return false;
  if (name === 'kakao') return !!settings.accessToken;
  if (name === 'kakaoBiz') {
    return !!(
      settings.apiKey &&
      settings.apiSecret &&
      settings.pfId &&
      settings.templateId &&
      settings.from &&
      settings.recipients
    );
  }
  if (name === 'discord') return !!settings.webhookUrl;
  if (name === 'telegram') return !!(settings.botToken && (settings.chatIds || settings.chatId));
  return false;
}

function updateMessengerBadge(cfg) {
  const badge = $('telegram-badge');
  const label = $('telegram-label');
  const indicator = $('indicator-telegram');
  const notify = cfg?.notify || {};
  const tg = cfg?.notify?.telegram || {};
  const chatIds = tg.chatIds || tg.chatId;
  const telegramReady = !!(tg.enabled && tg.botToken && chatIds);
  const messengerEntries = Object.entries(notify).filter(([, settings]) => settings?.enabled);
  const readyCount = messengerEntries.filter(([name, settings]) => isMessengerReady(name, settings)).length;
  if (!badge || !label) return;
  badge.classList.remove('is-ok', 'is-err');
  indicator?.classList.remove('is-ok', 'is-err');
  const scenarioIndicator = $('scenario-indicator-telegram');
  scenarioIndicator?.classList.remove('is-ok', 'is-err');
  if (readyCount > 0) {
    badge.classList.add('is-ok');
    label.textContent = readyCount > 1 ? `메신저 ${readyCount}개 연결됨` : '메신저 연결됨';
  } else if (messengerEntries.length) {
    badge.classList.add('is-err');
    label.textContent = '메신저 설정 필요';
  } else {
    label.textContent = '메신저 미설정';
  }

  if (telegramReady) {
    indicator?.classList.add('is-ok');
    scenarioIndicator?.classList.add('is-ok');
  } else if (tg.enabled) {
    indicator?.classList.add('is-err');
    scenarioIndicator?.classList.add('is-err');
  }
}

$('telegram-badge')?.addEventListener('click', () => showView('settings'));
$('indicator-telegram')?.addEventListener('click', () => showView('settings'));
$('scenario-indicator-telegram')?.addEventListener('click', () => showView('settings'));
$('scenario-stage-rail')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.stage-step');
  if (!btn) return;
  setScenarioStage(Number(btn.dataset.stageIndex));
});
$('scenario-edit-open')?.addEventListener('click', async () => {
  const modal = $('scenario-modal');
  const status = $('scenario-editor-status');
  if (status) {
    status.textContent = '';
    status.classList.remove('is-ok', 'is-err');
  }
  await refreshScenarioSourceOptions();
  renderScenarioEditor();
  if (modal) modal.hidden = false;
  setTimeout(() => document.querySelector('.scenario-stage-title-input')?.focus(), 0);
});
$('scenario-modal-close')?.addEventListener('click', () => {
  const modal = $('scenario-modal');
  if (modal) modal.hidden = true;
});
$('scenario-modal')?.addEventListener('click', (e) => {
  if (e.target === $('scenario-modal')) $('scenario-modal').hidden = true;
});
$('scenario-reset-default')?.addEventListener('click', () => {
  renderScenarioEditor(DEFAULT_SCENARIO_STAGES);
});
$('scenario-add-stage')?.addEventListener('click', () => {
  const editor = $('scenario-editor');
  if (!editor) return;
  const index = document.querySelectorAll('.scenario-editor-row').length;
  editor.appendChild(createScenarioEditorRow({
    id: `stage-${index}`,
    title: '새 단계',
    note: '',
    checks: defaultChecksForStage({ title: '새 단계' }),
  }, index));
});
$('scenario-save')?.addEventListener('click', async () => {
  const btn = $('scenario-save');
  const status = $('scenario-editor-status');
  const stages = readScenarioEditor();
  status?.classList.remove('is-ok', 'is-err');
  if (!stages.length) {
    if (status) {
      status.textContent = '최소 한 개 이상의 단계를 입력하세요.';
      status.classList.add('is-err');
    }
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const cfg = await window.api.setConfig({ scenario: { stages } });
    applyScenarioConfig(cfg?.scenario);
    if (status) {
      status.textContent = '저장되었습니다.';
      status.classList.add('is-ok');
    }
    setTimeout(() => {
      const modal = $('scenario-modal');
      if (modal) modal.hidden = true;
    }, 400);
  } catch (err) {
    if (status) {
      status.textContent = '저장 실패: ' + err.message;
      status.classList.add('is-err');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.view;
    if (VIEWS.includes(v)) showView(v);
  });
});

document.getElementById('alerts-history-clear')?.addEventListener('click', () => {
  if (!alertHistory.length) return;
  if (!confirm('알림 이력을 모두 지울까요?')) return;
  clearAlertHistory();
});

document.getElementById('alerts-filter-severity')?.addEventListener('change', (e) => {
  alertFilterSeverity = e.target.value || '';
  renderAlertHistory();
});

renderScenarioChecks();

// ── 카카오 연결 모달 ─────────────────────────────────────────────
const modal = $('kakao-modal');
const kakaoBadge = $('kakao-badge');
const restKeyInput = $('kakao-rest-key');
const redirectInput = $('kakao-redirect');
const statusText = $('kakao-status-text');
const connectBtn = $('kakao-connect');
const disconnectBtn = $('kakao-disconnect');
const testBtn = $('kakao-test');

function setStatusText(msg, kind) {
  statusText.textContent = msg || '';
  statusText.classList.remove('is-ok', 'is-err');
  if (kind === 'ok') statusText.classList.add('is-ok');
  else if (kind === 'err') statusText.classList.add('is-err');
}

function setBadge(connected) {
  if (!kakaoBadge) return;
  kakaoBadge.classList.remove('is-ok', 'is-err');
  if (connected) {
    kakaoBadge.classList.add('is-ok');
    $('kakao-label').textContent = '카카오 연결됨';
  } else {
    $('kakao-label').textContent = '카카오 미연결';
  }
}

function updateModalUiFromState(state) {
  setBadge(state.connected);
  restKeyInput.value = state.restApiKey || '';
  if (state.redirectUri) redirectInput.value = state.redirectUri;
  disconnectBtn.hidden = !state.connected;
  testBtn.hidden = !state.connected;
  connectBtn.textContent = state.connected ? '재연결' : '연결';
  setStatusText(state.connected ? '연결됨' : '', state.connected ? 'ok' : null);
}

async function refreshKakaoStatus() {
  try {
    const state = await window.api.kakaoStatus();
    updateModalUiFromState(state);
  } catch (e) {
    setStatusText('상태 조회 실패: ' + e.message, 'err');
  }
}

function openModal() {
  modal.hidden = false;
  refreshKakaoStatus();
  setTimeout(() => restKeyInput.focus(), 0);
}

function closeModal() { modal.hidden = true; }

kakaoBadge?.addEventListener('click', openModal);
$('kakao-modal-close').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

connectBtn.addEventListener('click', async () => {
  const restApiKey = restKeyInput.value.trim();
  const redirectUri = redirectInput.value.trim();
  if (!restApiKey) { setStatusText('REST API 키를 입력하세요.', 'err'); return; }
  if (!redirectUri) { setStatusText('Redirect URI를 입력하세요.', 'err'); return; }
  connectBtn.disabled = true;
  setStatusText('카카오 인증 창을 여는 중...');
  try {
    await window.api.kakaoConnect({ restApiKey, redirectUri });
    setStatusText('연결됨', 'ok');
    await refreshKakaoStatus();
  } catch (e) {
    setStatusText('연결 실패: ' + e.message, 'err');
  } finally {
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener('click', async () => {
  if (!confirm('카카오 연결을 해제하시겠습니까?')) return;
  try {
    await window.api.kakaoDisconnect();
    await refreshKakaoStatus();
  } catch (e) {
    setStatusText('해제 실패: ' + e.message, 'err');
  }
});

testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  setStatusText('테스트 메시지 전송 중...');
  try {
    await window.api.testNotify('kakao');
    setStatusText('테스트 메시지 전송 완료', 'ok');
  } catch (e) {
    setStatusText('전송 실패: ' + e.message, 'err');
  } finally {
    testBtn.disabled = false;
  }
});

// 초기 상태 표시
refreshKakaoStatus();
// uPlot은 DOM이 layout된 후 초기화
requestAnimationFrame(() => initBitrateChart());

// ── 설정 뷰 ──────────────────────────────────────────────────────
function getDeep(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setDeep(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function coerceValue(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number') {
    if (input.value === '') return null;
    const scale = Number(input.dataset.scale || 1);
    return Number(input.value) * scale;
  }
  return input.value;
}

function setInputValue(input, value) {
  if (input.type === 'checkbox') input.checked = !!value;
  else if (input.type === 'number') {
    const scale = input.type === 'number' ? Number(input.dataset.scale || 1) : 1;
    input.value = value == null ? '' : Number(value) / scale;
  } else {
    input.value = value == null ? '' : value;
  }
}

async function loadSettingsForm() {
  try {
    const cfg = await window.api.getConfig();
    updateMessengerBadge(cfg);
    updateYoutubeIndicatorFromConfig(cfg);
    document.querySelectorAll('[data-cfg]').forEach((input) => {
      const path = input.dataset.cfg;
      let value = getDeep(cfg, path);
      if (path === 'notify.telegram.chatIds' && !value) {
        value = getDeep(cfg, 'notify.telegram.chatId');
      }
      setInputValue(input, value);
    });
    setSettingsFeedback('', null);
    await refreshYoutubeOauthStatus();
    await refreshAutoStartToggle();
    await refreshMobileStatus();
  } catch (e) {
    setSettingsFeedback('설정 로드 실패: ' + e.message, 'err');
  }
}

async function refreshTelegramBadge() {
  try {
    const cfg = await window.api.getConfig();
    updateMessengerBadge(cfg);
    applyScenarioConfig(cfg?.scenario);
  } catch {}
}

refreshTelegramBadge();

function updateYoutubeIndicatorFromConfig(cfg) {
  const youtube = cfg?.youtube || {};
  const oauth = youtube.oauth || {};
  const oauthReady = !!(oauth.clientId && oauth.accessToken && oauth.refreshToken);
  const apiKeyReady = !!(youtube.apiKey && youtube.channelId);
  const partiallyConfigured = !!(oauth.clientId || oauth.clientSecret || youtube.apiKey || youtube.channelId);

  if (oauthReady || apiKeyReady) {
    setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], 'ok', 'YouTube');
  } else if (partiallyConfigured) {
    setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], 'err', 'YouTube');
  } else {
    setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], null, 'YouTube');
  }
}

async function refreshYoutubeIndicator() {
  try {
    updateYoutubeIndicatorFromConfig(await window.api.getConfig());
  } catch {}
}

refreshYoutubeIndicator();

async function refreshAutoStartToggle() {
  const cb = $('cfg-autostart');
  if (!cb) return;
  try {
    const s = await window.api.getStartup();
    cb.checked = !!s.autoStart;
  } catch {}
}

$('cfg-autostart')?.addEventListener('change', async (e) => {
  try {
    await window.api.setAutoStart(e.target.checked);
  } catch (err) {
    setSettingsFeedback('자동 실행 설정 실패: ' + err.message, 'err');
  }
});

async function refreshMobileStatus() {
  if (!window.api.mobileStatus) return;
  try {
    const info = await window.api.mobileStatus();
    renderMobileStatus(info);
  } catch (err) {
    setMobileFeedback('모바일 상태 조회 실패: ' + err.message, 'err');
  }
}

function renderMobileStatus(info = {}) {
  const badge = $('mobile-server-badge');
  const label = $('mobile-server-label');
  badge?.classList.toggle('is-ok', !!info.running);
  if (label) label.textContent = info.running ? '실행 중' : '중지';
  if ($('mobile-url')) $('mobile-url').value = info.url || '';
  if ($('mobile-service-type')) $('mobile-service-type').value = info.serviceType || '_streamwatcher._tcp.local';
  if ($('mobile-server-id')) $('mobile-server-id').value = info.serverId || '';
  if ($('mobile-pairing-pin')) $('mobile-pairing-pin').textContent = info.pairingPin || '------';
  if ($('mobile-pairing-expiry')) {
    $('mobile-pairing-expiry').textContent = info.pairingPinExpiresAt
      ? `${new Date(info.pairingPinExpiresAt).toLocaleTimeString('ko-KR')}까지 유효`
      : 'PIN 없음';
  }
  if ($('mobile-device-count')) $('mobile-device-count').textContent = `${info.deviceCount || 0}대`;

  const list = $('mobile-device-list');
  if (list) {
    list.textContent = '';
    const devices = info.devices || [];
    if (!devices.length) {
      const item = document.createElement('li');
      item.innerHTML = '<span>등록된 기기 없음</span><small>PIN으로 연결하면 여기에 표시됩니다</small>';
      list.appendChild(item);
    } else {
      for (const device of devices) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        const meta = document.createElement('small');
        name.textContent = device.name || '모바일 기기';
        meta.textContent = device.lastSeenAt
          ? `마지막 접속 ${new Date(device.lastSeenAt).toLocaleString('ko-KR')}`
          : `등록 ${new Date(device.pairedAt || Date.now()).toLocaleString('ko-KR')}`;
        item.append(name, meta);
        list.appendChild(item);
      }
    }
  }
}

function setMobileFeedback(msg, kind) {
  const el = $('mobile-feedback');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.remove('is-ok', 'is-err');
  if (kind === 'ok') el.classList.add('is-ok');
  else if (kind === 'err') el.classList.add('is-err');
}

$('mobile-refresh')?.addEventListener('click', () => refreshMobileStatus());

$('mobile-generate-pin')?.addEventListener('click', async () => {
  const btn = $('mobile-generate-pin');
  btn.disabled = true;
  setMobileFeedback('PIN 생성 중...');
  try {
    const info = await window.api.mobileGeneratePin();
    renderMobileStatus(info);
    setMobileFeedback('PIN이 생성되었습니다. 모바일 앱에서 입력하세요.', 'ok');
  } catch (err) {
    setMobileFeedback('PIN 생성 실패: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('mobile-clear-devices')?.addEventListener('click', async () => {
  if (!confirm('등록된 모바일 기기를 모두 초기화할까요?')) return;
  const btn = $('mobile-clear-devices');
  btn.disabled = true;
  setMobileFeedback('기기 초기화 중...');
  try {
    const info = await window.api.mobileClearDevices();
    renderMobileStatus(info);
    setMobileFeedback('등록된 기기를 초기화했습니다.', 'ok');
  } catch (err) {
    setMobileFeedback('초기화 실패: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

function collectSettingsForm() {
  const cfg = {};
  document.querySelectorAll('[data-cfg]').forEach((input) => {
    setDeep(cfg, input.dataset.cfg, coerceValue(input));
  });
  return cfg;
}

function setSettingsFeedback(msg, kind) {
  const el = $('settings-feedback');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.remove('is-ok', 'is-err');
  if (kind === 'ok') el.classList.add('is-ok');
  else if (kind === 'err') el.classList.add('is-err');
}

const saveBtn = $('settings-save');
const resetBtn = $('settings-reset');

saveBtn?.addEventListener('click', async () => {
  saveBtn.disabled = true;
  setSettingsFeedback('저장 중...');
  try {
    const partial = collectSettingsForm();
    const cfg = await window.api.setConfig(partial);
    updateMessengerBadge(cfg);
    updateYoutubeIndicatorFromConfig(cfg);
    await refreshMobileStatus();
    setSettingsFeedback('저장됨 (모니터 재시작)', 'ok');
    setTimeout(() => setSettingsFeedback('', null), 3000);
  } catch (e) {
    setSettingsFeedback('저장 실패: ' + e.message, 'err');
  } finally {
    saveBtn.disabled = false;
  }
});

resetBtn?.addEventListener('click', () => {
  loadSettingsForm();
  setSettingsFeedback('되돌렸습니다', null);
  setTimeout(() => setSettingsFeedback('', null), 2000);
});

document.querySelectorAll('.test-channel').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const ch = btn.dataset.channel;
    btn.disabled = true;
    setSettingsFeedback(`${ch} 설정 반영 후 테스트 전송 중...`);
    try {
      const cfg = await window.api.setConfig(collectSettingsForm());
      updateMessengerBadge(cfg);
      const result = await window.api.testNotify(ch);
      const sent = result?.sent ? ` (${result.sent}명)` : '';
      setSettingsFeedback(`${ch} 테스트 전송 완료${sent}`, 'ok');
    } catch (e) {
      setSettingsFeedback(`${ch} 테스트 실패: ${e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });
});

$('telegram-load-chats')?.addEventListener('click', async () => {
  const btn = $('telegram-load-chats');
  const tokenInput = document.querySelector('[data-cfg="notify.telegram.botToken"]');
  const chatInput = document.querySelector('[data-cfg="notify.telegram.chatIds"]');
  btn.disabled = true;
  setSettingsFeedback('Telegram Chat ID 조회 중...');
  try {
    const chats = await window.api.telegramChats(tokenInput.value.trim());
    if (!chats.length) {
      setSettingsFeedback('먼저 받을 사람이 봇과 1:1 대화를 시작하고 메시지를 하나 보내야 합니다.', 'err');
      return;
    }
    chatInput.value = chats.map((chat) => String(chat.id)).join('\n');
    const labels = chats
      .map((chat) => chat.title || chat.username || chat.first_name || chat.id)
      .slice(0, 3)
      .join(', ');
    setSettingsFeedback(`Chat ID ${chats.length}개 입력됨: ${labels}`, 'ok');
  } catch (e) {
    setSettingsFeedback('Chat ID 조회 실패: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// ── YouTube OAuth (in settings) ──────────────────────────────────
function setYtOauthFeedback(msg, kind) {
  const el = $('yt-oauth-feedback');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.remove('is-ok', 'is-err');
  if (kind === 'ok') el.classList.add('is-ok');
  else if (kind === 'err') el.classList.add('is-err');
}

function setYtOauthBadge(connected) {
  const badge = $('yt-oauth-badge');
  if (!badge) return;
  badge.classList.toggle('is-ok', !!connected);
  $('yt-oauth-label').textContent = connected ? '연결됨' : '미연결';
  setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], connected ? 'ok' : null, 'YouTube');
}

async function refreshYoutubeOauthStatus() {
  try {
    const s = await window.api.youtubeOauthStatus();
    setYtOauthBadge(s.connected);
    if ($('yt-oauth-client-id')) $('yt-oauth-client-id').value = s.clientId || '';
    if ($('yt-oauth-client-secret')) $('yt-oauth-client-secret').value = s.clientSecret || '';
    if ($('yt-oauth-redirect') && s.redirectUri) $('yt-oauth-redirect').value = s.redirectUri;
    if ($('yt-oauth-disconnect')) $('yt-oauth-disconnect').hidden = !s.connected;
    if ($('yt-oauth-connect')) $('yt-oauth-connect').textContent = s.connected ? '재연결' : 'Google 연결';
    if (s.connected && s.expiryDate) {
      setYtOauthFeedback(`연결됨 · 토큰 만료 예상 ${new Date(s.expiryDate).toLocaleString('ko-KR')}`, 'ok');
    }
  } catch (e) {
    setYtOauthFeedback('상태 조회 실패: ' + e.message, 'err');
  }
}

$('yt-oauth-connect')?.addEventListener('click', async () => {
  const clientId = $('yt-oauth-client-id').value.trim();
  const clientSecret = $('yt-oauth-client-secret').value.trim();
  const redirectUri = $('yt-oauth-redirect').value.trim();
  if (!clientId || !clientSecret) {
    setYtOauthFeedback('Client ID와 Secret을 입력하세요.', 'err');
    return;
  }
  const btn = $('yt-oauth-connect');
  btn.disabled = true;
  setYtOauthFeedback('Google 인증 창을 여는 중...');
  try {
    await window.api.youtubeOauthConnect({ clientId, clientSecret, redirectUri });
    setYtOauthFeedback('연결됨', 'ok');
    setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], 'ok', 'YouTube');
    await refreshYoutubeOauthStatus();
  } catch (e) {
    setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], 'err', 'YouTube');
    setYtOauthFeedback('연결 실패: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('yt-oauth-import')?.addEventListener('click', async () => {
  const btn = $('yt-oauth-import');
  btn.disabled = true;
  setYtOauthFeedback('Google OAuth JSON 불러오는 중...');
  try {
    const result = await window.api.youtubeOauthImportClient();
    if (!result?.ok) {
      setYtOauthFeedback('가져오기를 취소했습니다.', null);
      return;
    }
    if ($('yt-oauth-client-id')) $('yt-oauth-client-id').value = result.clientId || '';
    if ($('yt-oauth-client-secret')) $('yt-oauth-client-secret').value = result.clientSecret || '';
    if ($('yt-oauth-redirect')) $('yt-oauth-redirect').value = result.redirectUri || '';
    setYtOauthFeedback('Client ID/Secret과 JSON 경로를 저장했습니다. Google 연결을 누르거나 앱 재시작 시 자동 로그인됩니다.', 'ok');
  } catch (e) {
    setYtOauthFeedback('가져오기 실패: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('yt-oauth-disconnect')?.addEventListener('click', async () => {
  if (!confirm('Google 연결을 해제하시겠습니까?')) return;
  try {
    await window.api.youtubeOauthDisconnect();
    await refreshYoutubeOauthStatus();
    setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], null, 'YouTube');
    setYtOauthFeedback('해제됨', null);
  } catch (e) {
    setYtOauthFeedback('해제 실패: ' + e.message, 'err');
  }
});

$('yt-diagnose')?.addEventListener('click', async () => {
  const btn = $('yt-diagnose');
  btn.disabled = true;
  setYtOauthFeedback('YouTube 연결 진단 중...');
  try {
    const result = await window.api.youtubeDiagnose();
    setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], result.ok ? 'ok' : 'err', 'YouTube');
    setYtOauthFeedback(result.message || '진단 완료', result.ok ? 'ok' : 'err');
  } catch (e) {
    setIndicators(['indicator-youtube', 'scenario-indicator-youtube'], 'err', 'YouTube');
    setYtOauthFeedback('진단 실패: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});
