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
        setTileStatus(tile, classifyBool(s.live));
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
        el.textContent = s.healthStatus || '-';
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

// ── 알림 로그 ────────────────────────────────────────────────────
let alertCount = 0;
function appendAlert(alert) {
  const log = document.getElementById('alert-log');
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
  log.prepend(li);
  alertCount += 1;
  document.getElementById('alert-count').textContent = `${alertCount}건`;
}

function formatAlertLabel(alert) {
  const map = {
    OBS_STREAM_STARTED: '방송 시작',
    OBS_STREAM_STOPPED: '방송 종료',
    OBS_RECORD_STARTED: '녹화 시작',
    OBS_RECORD_STOPPED: '녹화 종료',
    OBS_AUDIO_SILENCE: '오디오 무음 감지',
    OBS_AUDIO_PEAK: '오디오 피크 감지',
    YOUTUBE_LIVE_DETECTED: 'YouTube 라이브 감지',
    YOUTUBE_LIVE_ENDED: 'YouTube 라이브 종료',
    YOUTUBE_HEALTH_BAD: 'YT 헬스 이상',
    YOUTUBE_HEALTH_RECOVERED: 'YT 헬스 복구',
    YOUTUBE_CONFIG_ISSUE: 'YT 설정 이슈',
  };
  let label = map[alert.type] || alert.type;
  if (alert.peakDb != null) label += ` (${alert.peakDb} dB)`;
  if (alert.durationMs != null) label += ` (${(alert.durationMs / 1000).toFixed(1)}s)`;
  if (alert.healthStatus) label += ` (${alert.healthStatus})`;
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
  setBootStatus('연결됨', 'ok');
  applyObsState(s);
});
window.api.onYoutubeState(applyYoutubeState);
window.api.onAlert(appendAlert);
window.api.onObsError((e) => setBootStatus('OBS 오류: ' + e.message, 'err'));
window.api.onYoutubeError((e) => setBootStatus('YouTube 오류: ' + e.message, 'err'));
window.api.onBootError((e) => setBootStatus('부팅 오류: ' + e.message, 'err'));

// ── 뷰 전환 ──────────────────────────────────────────────────────
const VIEWS = ['dashboard', 'settings'];

function showView(name) {
  for (const v of VIEWS) {
    const el = document.getElementById('view-' + v);
    if (el) el.hidden = v !== name;
  }
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  if (name === 'settings') loadSettingsForm();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.view;
    if (v === 'alerts') {
      showView('dashboard');
      document.querySelector('.panel-log')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (VIEWS.includes(v)) showView(v);
  });
});

// ── 카카오 연결 모달 ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const modal = $('kakao-modal');
const badge = $('kakao-badge');
const modeSelect = $('kakao-mode');
const channelIdInput = $('kakao-channel-id');
const channelRow = $('kakao-channel-row');
const restKeyInput = $('kakao-rest-key');
const redirectInput = $('kakao-redirect');
const statusText = $('kakao-status-text');
const connectBtn = $('kakao-connect');
const disconnectBtn = $('kakao-disconnect');
const testBtn = $('kakao-test');

function updateChannelRowVisibility() {
  if (channelRow) channelRow.hidden = modeSelect?.value !== 'channel';
}
modeSelect?.addEventListener('change', updateChannelRowVisibility);

function setStatusText(msg, kind) {
  statusText.textContent = msg || '';
  statusText.classList.remove('is-ok', 'is-err');
  if (kind === 'ok') statusText.classList.add('is-ok');
  else if (kind === 'err') statusText.classList.add('is-err');
}

function setBadge(connected) {
  badge.classList.remove('is-ok', 'is-err');
  if (connected) {
    badge.classList.add('is-ok');
    $('kakao-label').textContent = '카카오 연결됨';
  } else {
    $('kakao-label').textContent = '카카오 미연결';
  }
}

function updateModalUiFromState(state) {
  setBadge(state.connected);
  if (modeSelect) modeSelect.value = state.mode || 'memo';
  if (channelIdInput) channelIdInput.value = state.channelPublicId || '';
  restKeyInput.value = state.restApiKey || '';
  if (state.redirectUri) redirectInput.value = state.redirectUri;
  disconnectBtn.hidden = !state.connected;
  testBtn.hidden = !state.connected;
  connectBtn.textContent = state.connected ? '재연결' : '연결';
  setStatusText(state.connected ? '연결됨' : '', state.connected ? 'ok' : null);
  updateChannelRowVisibility();
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

badge.addEventListener('click', openModal);
$('kakao-modal-close').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

connectBtn.addEventListener('click', async () => {
  const restApiKey = restKeyInput.value.trim();
  const redirectUri = redirectInput.value.trim();
  const mode = modeSelect?.value || 'memo';
  const channelPublicId = channelIdInput?.value.trim() || '';
  if (!restApiKey) { setStatusText('REST API 키를 입력하세요.', 'err'); return; }
  if (!redirectUri) { setStatusText('Redirect URI를 입력하세요.', 'err'); return; }
  if (mode === 'channel' && !channelPublicId) { setStatusText('채널 공개 ID를 입력하세요.', 'err'); return; }
  connectBtn.disabled = true;
  setStatusText('카카오 인증 창을 여는 중...');
  try {
    await window.api.kakaoConnect({ restApiKey, redirectUri, mode, channelPublicId });
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
    return Number(input.value);
  }
  return input.value;
}

function setInputValue(input, value) {
  if (input.type === 'checkbox') input.checked = !!value;
  else input.value = value == null ? '' : value;
}

async function loadSettingsForm() {
  try {
    const cfg = await window.api.getConfig();
    document.querySelectorAll('[data-cfg]').forEach((input) => {
      const path = input.dataset.cfg;
      setInputValue(input, getDeep(cfg, path));
    });
    setSettingsFeedback('', null);
    await refreshYoutubeOauthStatus();
    await refreshAutoStartToggle();
  } catch (e) {
    setSettingsFeedback('설정 로드 실패: ' + e.message, 'err');
  }
}

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
    await window.api.setConfig(partial);
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
    setSettingsFeedback(`${ch} 테스트 전송 중...`);
    try {
      await window.api.testNotify(ch);
      setSettingsFeedback(`${ch} 테스트 전송 완료`, 'ok');
    } catch (e) {
      setSettingsFeedback(`${ch} 테스트 실패: ${e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });
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
    await refreshYoutubeOauthStatus();
  } catch (e) {
    setYtOauthFeedback('연결 실패: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('yt-oauth-disconnect')?.addEventListener('click', async () => {
  if (!confirm('Google 연결을 해제하시겠습니까?')) return;
  try {
    await window.api.youtubeOauthDisconnect();
    await refreshYoutubeOauthStatus();
    setYtOauthFeedback('해제됨', null);
  } catch (e) {
    setYtOauthFeedback('해제 실패: ' + e.message, 'err');
  }
});
