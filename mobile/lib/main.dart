import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client.dart';
import 'discovery.dart';

const _defaultServerUrl = 'http://127.0.0.1:53683';
const _prefServerUrl = 'serverUrl';
const _prefToken = 'token';
const _alertChannel = MethodChannel('stream_watcher_mobile/alerts');

void main() {
  runApp(const StreamWatcherMobileApp());
}

class StreamWatcherMobileApp extends StatelessWidget {
  const StreamWatcherMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Stream Watcher',
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      home: const MonitorScreen(),
    );
  }
}

class MonitorScreen extends StatefulWidget {
  const MonitorScreen({super.key});

  @override
  State<MonitorScreen> createState() => _MonitorScreenState();
}

class _MonitorScreenState extends State<MonitorScreen>
    with SingleTickerProviderStateMixin {
  final _pinController = TextEditingController();
  late final AnimationController _alertFlashController;
  String? _serverUrl;
  String? _token;
  String? _lastAlertKey;
  String _message = '';
  bool _initializing = true;
  bool _busy = false;
  Map<String, dynamic>? _status;
  StreamSubscription<Map<String, dynamic>>? _eventsSub;

  StreamWatcherApi get _api =>
      StreamWatcherApi(baseUrl: _serverUrl ?? _defaultServerUrl, token: _token);

  @override
  void initState() {
    super.initState();
    _alertFlashController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    );
    _restoreSession();
  }

  @override
  void dispose() {
    _eventsSub?.cancel();
    _alertFlashController.dispose();
    _pinController.dispose();
    super.dispose();
  }

  Future<void> _restoreSession() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_prefToken);
    final serverUrl = prefs.getString(_prefServerUrl);
    if (token == null ||
        token.isEmpty ||
        serverUrl == null ||
        serverUrl.isEmpty) {
      if (mounted) setState(() => _initializing = false);
      return;
    }

    _token = token;
    _serverUrl = serverUrl;
    try {
      await _loadStatus();
      _connectEvents();
    } catch (_) {
      await _clearSession();
      if (mounted) {
        setState(() => _message = '저장된 연결이 만료되었습니다. PIN으로 다시 연결하세요.');
      }
    } finally {
      if (mounted) setState(() => _initializing = false);
    }
  }

  Future<void> _pair() async {
    final pin = _pinController.text.trim();
    if (pin.isEmpty) {
      setState(() => _message = 'PIN을 입력하세요.');
      return;
    }

    await _run(() async {
      setState(() => _message = 'Stream Watcher 찾는 중...');
      final server = await MobileDiscoveryClient().discover();
      if (server == null) {
        throw Exception('Stream Watcher를 찾지 못했습니다. PC와 같은 Wi-Fi인지 확인하세요.');
      }

      _serverUrl = server.url;
      setState(() => _message = 'PIN 확인 중...');
      final result = await _api.pair(pin, 'Mobile Monitor');
      final token = result['token'] as String?;
      _token = token;
      _message = '페어링 완료';
      try {
        await _loadStatus();
        await _saveSession();
        _connectEvents();
      } catch (_) {
        _token = null;
        rethrow;
      }
    });
  }

  Future<void> _saveSession() async {
    final token = _token;
    final serverUrl = _serverUrl;
    if (token == null ||
        token.isEmpty ||
        serverUrl == null ||
        serverUrl.isEmpty) {
      return;
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefToken, token);
    await prefs.setString(_prefServerUrl, serverUrl);
  }

  Future<void> _clearSession() async {
    _eventsSub?.cancel();
    _eventsSub = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_prefToken);
    await prefs.remove(_prefServerUrl);
    _token = null;
    _serverUrl = null;
    _status = null;
  }

  Future<void> _forgetPairing() async {
    await _clearSession();
    if (mounted) {
      setState(() => _message = '연결을 해제했습니다. 다시 연결하려면 PIN을 입력하세요.');
    }
  }

  Future<void> _loadStatus() async {
    final status = await _api.status();
    if (mounted) setState(() => _status = status);
  }

  void _connectEvents() {
    _eventsSub?.cancel();
    _eventsSub = _api.events().listen(
      (event) {
        final type = event['event'];
        final data = event['data'];
        if (type == 'status' && data is Map<String, dynamic>) {
          setState(() => _status = data);
        } else if (type == 'scenario') {
          _loadStatus().catchError((_) {});
        }
      },
      onError: (_) {
        Timer.periodic(const Duration(seconds: 2), (timer) {
          if (_eventsSub == null) {
            timer.cancel();
            return;
          }
          _loadStatus().catchError((_) {});
        });
      },
    );
  }

  Future<void> _setStage(int index) async {
    await _run(() async {
      await _api.setScenarioStage(index);
      await _loadStatus();
      _message = '시나리오 단계 변경됨';
    });
  }

  Future<void> _ackAlert() async {
    final alert = _status?['activeAlert'] as Map<String, dynamic>?;
    await _run(() async {
      await _api.ack(alert?['id'] as String?);
      await _loadStatus();
    });
  }

  void _syncAlertFlash(Map<String, dynamic>? alert, bool hasAlert) {
    if (!hasAlert || alert == null) {
      _lastAlertKey = null;
      _alertFlashController.reset();
      return;
    }

    final key =
        '${alert['id'] ?? ''}|${alert['title'] ?? ''}|${alert['message'] ?? ''}';
    if (_lastAlertKey == key) return;
    _lastAlertKey = key;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      HapticFeedback.vibrate();
      _alertChannel.invokeMethod('vibrateAlert').catchError((_) {});
      _alertFlashController.forward(from: 0);
    });
  }

  Future<void> _run(Future<void> Function() task) async {
    setState(() {
      _busy = true;
      _message = '';
    });
    try {
      await task();
    } catch (err) {
      _message = err.toString().replaceFirst('Exception: ', '');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = _status;
    final alert = status?['activeAlert'] as Map<String, dynamic>?;
    final hasAlert = alert != null && alert['acknowledged'] != true;
    _syncAlertFlash(alert, hasAlert);

    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            if (_initializing)
              const _LoadingView()
            else if (_token == null)
              _PairingPanel(
                pinController: _pinController,
                busy: _busy,
                message: _message,
                onPair: _pair,
              )
            else
              ListView(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                children: [
                  if (status != null) ...[
                    _DashboardHeader(
                      busy: _busy,
                      onRefresh: () => _loadStatus().catchError((_) {}),
                      onForget: _forgetPairing,
                    ),
                    const SizedBox(height: 10),
                    _SummaryPanel(status: status),
                    const SizedBox(height: 10),
                    _StatusGrid(status: status),
                    const SizedBox(height: 10),
                    _ScenarioPanel(
                      scenario: status['scenario'] as Map<String, dynamic>?,
                      onStageTap: _setStage,
                    ),
                    const SizedBox(height: 10),
                    _AlertLog(
                      alerts:
                          status['recentAlerts'] as List<dynamic>? ?? const [],
                    ),
                  ] else
                    const _LoadingView(),
                ],
              ),
            if (hasAlert)
              _CriticalAlert(
                alert: alert,
                flash: _alertFlashController,
                onAck: _ackAlert,
              ),
          ],
        ),
      ),
    );
  }
}

class _LoadingView extends StatelessWidget {
  const _LoadingView();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: SizedBox(
        width: 26,
        height: 26,
        child: CircularProgressIndicator(strokeWidth: 2.5),
      ),
    );
  }
}

class _PairingPanel extends StatelessWidget {
  const _PairingPanel({
    required this.pinController,
    required this.busy,
    required this.message,
    required this.onPair,
  });

  final TextEditingController pinController;
  final bool busy;
  final String message;
  final VoidCallback onPair;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      color: Theme.of(context).scaffoldBackgroundColor,
      child: Stack(
        children: [
          IgnorePointer(
            child: Opacity(
              opacity: 0.42,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                children: [
                  _DashboardHeader(
                    busy: true,
                    onRefresh: () {},
                    onForget: () {},
                  ),
                  const SizedBox(height: 10),
                  _SummaryPanel(status: _pairingPreviewStatus),
                  const SizedBox(height: 10),
                  _StatusGrid(status: _pairingPreviewStatus),
                  const SizedBox(height: 10),
                  Panel(
                    title: '시나리오',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: const [
                        SizedBox(height: 58),
                        SizedBox(height: 10),
                        SizedBox(height: 58),
                        SizedBox(height: 10),
                        SizedBox(height: 58),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          Positioned.fill(
            child: Container(color: scheme.surface.withOpacity(0.38)),
          ),
          Align(
            alignment: const Alignment(0, -0.12),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 22),
              child: Container(
                constraints: const BoxConstraints(maxWidth: 420),
                padding: const EdgeInsets.fromLTRB(18, 18, 18, 16),
                decoration: BoxDecoration(
                  color: scheme.surface.withOpacity(0.92),
                  border: Border.all(color: Theme.of(context).dividerColor),
                  borderRadius: BorderRadius.circular(8),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(0.10),
                      blurRadius: 24,
                      offset: const Offset(0, 12),
                    ),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'PIN 연결',
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'PC 앱에서 생성한 PIN을 입력하세요.',
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(color: scheme.secondary),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: pinController,
                      autofocus: true,
                      keyboardType: TextInputType.number,
                      textInputAction: TextInputAction.done,
                      decoration: const InputDecoration(labelText: '페어링 PIN'),
                      onSubmitted: (_) {
                        if (!busy) onPair();
                      },
                    ),
                    const SizedBox(height: 12),
                    FilledButton(
                      onPressed: busy ? null : onPair,
                      child: Text(busy ? '연결 중...' : '연결'),
                    ),
                    if (message.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      Text(
                        message,
                        textAlign: TextAlign.center,
                        style: TextStyle(color: scheme.secondary),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

final Map<String, dynamic> _pairingPreviewStatus = {
  'summary': {
    'level': 'ok',
    'title': '모니터링 대기',
    'message': 'PIN 연결 후 PC의 송출 상태를 표시합니다.',
  },
  'obs': {
    'streaming': false,
    'bitrateKbps': '-',
    'droppedFramePct': '-',
  },
  'youtube': {'live': false},
  'lufs': {'shortTerm': '-', 'status': 'ok'},
  'audio': {'silent': false, 'status': 'ok'},
};

class _DashboardHeader extends StatelessWidget {
  const _DashboardHeader({
    required this.busy,
    required this.onRefresh,
    required this.onForget,
  });

  final bool busy;
  final VoidCallback onRefresh;
  final VoidCallback onForget;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(
            'Stream Watcher',
            style: Theme.of(
              context,
            ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          onPressed: busy ? null : onRefresh,
          icon: const Icon(Icons.refresh),
          tooltip: '새로고침',
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          onPressed: busy ? null : onForget,
          icon: const Icon(Icons.link_off),
          tooltip: '연결 해제',
        ),
      ],
    );
  }
}

class _SummaryPanel extends StatelessWidget {
  const _SummaryPanel({required this.status});

  final Map<String, dynamic> status;

  @override
  Widget build(BuildContext context) {
    final summary = status['summary'] as Map<String, dynamic>? ?? {};
    final level = summary['level'] as String? ?? 'ok';
    final color = levelColor(context, level);
    return Panel(
      title: '송출 상태',
      trailing: StatusDot(color: color),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: color.withOpacity(0.12),
            child: Icon(Icons.monitor_heart, color: color),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${summary['title'] ?? '정상 모니터링'}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 3),
                Text(
                  '${summary['message'] ?? '-'}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusGrid extends StatelessWidget {
  const _StatusGrid({required this.status});

  final Map<String, dynamic> status;

  @override
  Widget build(BuildContext context) {
    final obs = status['obs'] as Map<String, dynamic>? ?? {};
    final youtube = status['youtube'] as Map<String, dynamic>? ?? {};
    final lufs = status['lufs'] as Map<String, dynamic>? ?? {};
    final audio = status['audio'] as Map<String, dynamic>? ?? {};
    final tiles = [
      TileData(
        'OBS',
        obs['streaming'] == true ? 'LIVE' : '중지',
        obs['streaming'] == true ? 'ok' : 'warn',
      ),
      TileData(
        'YouTube',
        youtube['live'] == true ? 'LIVE' : '오프라인',
        youtube['live'] == true ? 'ok' : 'warn',
      ),
      TileData('비트레이트', '${obs['bitrateKbps'] ?? '-'} kbps', 'ok'),
      TileData(
        '드롭',
        '${obs['droppedFramePct'] ?? obs['droppedFrames'] ?? '-'}',
        'ok',
      ),
      TileData(
          'LUFS', '${lufs['shortTerm'] ?? '-'}', '${lufs['status'] ?? 'ok'}'),
      TileData(
        '오디오',
        audio['silent'] == true ? '무음' : 'OK',
        '${audio['status'] ?? 'ok'}',
      ),
    ];

    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: tiles.length,
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        childAspectRatio: 2.15,
        crossAxisSpacing: 10,
        mainAxisSpacing: 10,
      ),
      itemBuilder: (context, index) => StatusTile(data: tiles[index]),
    );
  }
}

class _ScenarioPanel extends StatelessWidget {
  const _ScenarioPanel({required this.scenario, required this.onStageTap});

  final Map<String, dynamic>? scenario;
  final ValueChanged<int> onStageTap;

  @override
  Widget build(BuildContext context) {
    final stages = scenario?['stages'] as List<dynamic>? ?? const [];
    final current = scenario?['currentStageIndex'] as int? ?? 0;
    return Panel(
      title: '시나리오',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final stage in stages)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: ScenarioStageButton(
                title: '${stage['title'] ?? '-'}',
                note: '${stage['note'] ?? ''}',
                selected: (stage['index'] as num).toInt() == current,
                onPressed: () => onStageTap((stage['index'] as num).toInt()),
              ),
            ),
          if (stages.isEmpty)
            Text(
              '시나리오 단계가 없습니다.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
        ],
      ),
    );
  }
}

class ScenarioStageButton extends StatelessWidget {
  const ScenarioStageButton({
    super.key,
    required this.title,
    required this.note,
    required this.selected,
    required this.onPressed,
  });

  final String title;
  final String note;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final bg = selected ? scheme.primary : scheme.surfaceContainerHighest;
    final fg = selected ? scheme.onPrimary : scheme.onSurface;
    return ConstrainedBox(
      constraints: BoxConstraints(minHeight: note.trim().isEmpty ? 72 : 96),
      child: FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: bg,
          foregroundColor: fg,
          minimumSize: Size.fromHeight(note.trim().isEmpty ? 72 : 96),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
        onPressed: onPressed,
        child: Align(
          alignment: Alignment.centerLeft,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      color: fg,
                      fontWeight: FontWeight.w800,
                    ),
              ),
              if (note.trim().isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  note,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: fg.withOpacity(0.78),
                      ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _AlertLog extends StatelessWidget {
  const _AlertLog({required this.alerts});

  final List<dynamic> alerts;

  @override
  Widget build(BuildContext context) {
    return Panel(
      title: '알림 이벤트',
      child: Column(
        children: [
          for (final alert in alerts.take(4))
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: StatusDot(
                color: levelColor(context, '${alert['level'] ?? 'info'}'),
              ),
              title: Text('${alert['title'] ?? alert['type'] ?? '-'}'),
              subtitle: Text(
                alert['acknowledged'] == true
                    ? '확인됨'
                    : '${alert['message'] ?? ''}',
              ),
            ),
          if (alerts.isEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                '알림 없음',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
        ],
      ),
    );
  }
}

class _CriticalAlert extends StatelessWidget {
  const _CriticalAlert({
    required this.alert,
    required this.flash,
    required this.onAck,
  });

  final Map<String, dynamic> alert;
  final Animation<double> flash;
  final VoidCallback onAck;

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: Stack(
        children: [
          AnimatedBuilder(
            animation: flash,
            builder: (context, child) {
              final pulse =
                  math.sin(flash.value * math.pi * 7).abs() * (1 - flash.value);
              return Container(
                color: Theme.of(
                  context,
                ).colorScheme.error.withOpacity(0.38 + pulse * 0.44),
              );
            },
          ),
          Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: onAck,
              child: Center(
                child: Container(
                  width: double.infinity,
                  margin: const EdgeInsets.symmetric(horizontal: 22),
                  constraints: const BoxConstraints(maxWidth: 440),
                  padding: const EdgeInsets.fromLTRB(24, 26, 24, 22),
                  decoration: BoxDecoration(
                    color:
                        Theme.of(context).colorScheme.error.withOpacity(0.94),
                    borderRadius: BorderRadius.circular(8),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withOpacity(0.24),
                        blurRadius: 30,
                        offset: const Offset(0, 16),
                      ),
                    ],
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(
                        Icons.warning_amber_rounded,
                        color: Colors.white,
                        size: 68,
                      ),
                      const SizedBox(height: 18),
                      Text(
                        '${alert['title'] ?? '긴급 경고'}',
                        textAlign: TextAlign.center,
                        style:
                            Theme.of(context).textTheme.headlineSmall?.copyWith(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w800,
                                ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        '${alert['message'] ?? '상태를 확인하세요.'}',
                        textAlign: TextAlign.center,
                        style: Theme.of(
                          context,
                        ).textTheme.bodyLarge?.copyWith(color: Colors.white),
                      ),
                      const SizedBox(height: 28),
                      FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: Colors.white,
                          foregroundColor: Colors.red.shade700,
                        ),
                        onPressed: onAck,
                        child: const Text('탭하여 확인'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class Panel extends StatelessWidget {
  const Panel({
    super.key,
    required this.title,
    required this.child,
    this.trailing,
  });

  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border.all(color: Theme.of(context).dividerColor),
        borderRadius: BorderRadius.circular(10),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.04),
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    title.toUpperCase(),
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.5,
                        ),
                  ),
                ),
                if (trailing != null) trailing!,
              ],
            ),
          ),
          Divider(height: 1, color: Theme.of(context).dividerColor),
          Padding(padding: const EdgeInsets.all(14), child: child),
        ],
      ),
    );
  }
}

class StatusTile extends StatelessWidget {
  const StatusTile({super.key, required this.data});

  final TileData data;

  @override
  Widget build(BuildContext context) {
    final color = levelColor(context, data.level);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Theme.of(
          context,
        ).colorScheme.surfaceContainerHighest.withOpacity(0.45),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Theme.of(context).dividerColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  data.label,
                  style: Theme.of(context).textTheme.labelMedium,
                ),
              ),
              StatusDot(color: color),
            ],
          ),
          Text(
            data.value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

class TileData {
  TileData(this.label, this.value, this.level);
  final String label;
  final String value;
  final String level;
}

Color levelColor(BuildContext context, String level) {
  return switch (level) {
    'critical' || 'err' => AppColors.err,
    'warn' => AppColors.warn,
    'ok' => AppColors.ok,
    _ => Theme.of(context).colorScheme.secondary,
  };
}

class AppTheme {
  static ThemeData light() {
    return _theme(
      brightness: Brightness.light,
      bg: const Color(0xfff5f7fb),
      surface: Colors.white,
      border: const Color(0xffe1e7f0),
      text: const Color(0xff182235),
      muted: const Color(0xff647184),
      accent: const Color(0xff2563eb),
    );
  }

  static ThemeData dark() {
    return _theme(
      brightness: Brightness.dark,
      bg: const Color(0xff0f172a),
      surface: const Color(0xff111827),
      border: const Color(0xff263449),
      text: const Color(0xffe5edf8),
      muted: const Color(0xff9aa8bc),
      accent: const Color(0xff60a5fa),
    );
  }

  static ThemeData _theme({
    required Brightness brightness,
    required Color bg,
    required Color surface,
    required Color border,
    required Color text,
    required Color muted,
    required Color accent,
  }) {
    final scheme = ColorScheme.fromSeed(
      seedColor: accent,
      brightness: brightness,
    ).copyWith(surface: surface, secondary: muted, error: AppColors.err);
    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      scaffoldBackgroundColor: bg,
      colorScheme: scheme,
      dividerColor: border,
      appBarTheme: AppBarTheme(
        backgroundColor: surface,
        foregroundColor: text,
        elevation: 0,
        centerTitle: false,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
      ),
      textTheme: ThemeData(
        brightness: brightness,
      ).textTheme.apply(bodyColor: text, displayColor: text),
    );
  }
}

class AppColors {
  static const ok = Color(0xff16a34a);
  static const warn = Color(0xffd97706);
  static const err = Color(0xffdc2626);
}
