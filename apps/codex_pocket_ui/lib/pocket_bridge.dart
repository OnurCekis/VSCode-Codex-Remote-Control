import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';

abstract class PocketApi {
  Future<Map<String, dynamic>> state();
  Stream<Map<String, dynamic>> events();
  Future<Map<String, dynamic>> post(
    String route, [
    Map<String, dynamic> body = const {},
  ]);
  void reset();
  void close();
}

class FilePocketApi implements PocketApi {
  HttpClient? _client;
  Uri? _endpoint;
  String? _token;
  Future<void> _ensureConnection() async {
    if (_endpoint != null) return;
    const definedRoot = String.fromEnvironment('POCKET_ROOT');
    final root = definedRoot.isNotEmpty ? definedRoot : Directory.current.path;
    final explicit = Platform.environment['CODEX_POCKET_UI_CONNECTION'];
    final home = Platform.environment['HOME'];
    final candidates = <File>[
      if (explicit != null) File(explicit),
      if (definedRoot.isNotEmpty)
        File('$definedRoot/.codex-pocket/ui-bridge/connection.json'),
      if (Platform.isMacOS && home != null)
        File('$home/Library/Application Support/Codex Pocket/connection.json'),
      File('$root/.codex-pocket/ui-bridge/connection.json'),
    ];
    File? file;
    final deadline = DateTime.now().add(const Duration(seconds: 30));
    while (file == null && DateTime.now().isBefore(deadline)) {
      for (final candidate in candidates) {
        if (candidate.existsSync()) {
          file = candidate;
          break;
        }
      }
      if (file == null) {
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
    }
    if (file == null) {
      throw StateError(
        'Codex Pocket yerel runtime başlatılamadı. Uygulamayı yeniden açın.',
      );
    }
    final descriptor =
        jsonDecode(await file.readAsString()) as Map<String, dynamic>;
    final endpoint = descriptor['endpoint'];
    final token = descriptor['token'];
    if (endpoint is! String ||
        token is! String ||
        !endpoint.startsWith('http://127.0.0.1:')) {
      throw const FormatException('Pocket bridge connection is invalid.');
    }
    _endpoint = Uri.parse(endpoint);
    _token = token;
    _client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
  }

  Future<HttpClientRequest> _request(String method, String route) async {
    await _ensureConnection();
    final request = await _client!.openUrl(method, _endpoint!.resolve(route));
    request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $_token');
    request.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
    return request;
  }

  Future<Map<String, dynamic>> _decode(HttpClientResponse response) async {
    final text = await utf8.decoder.bind(response).join();
    final value = text.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(text) as Map<String, dynamic>;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError(value['error']?.toString() ?? 'Pocket request failed.');
    }
    return value;
  }

  @override
  Future<Map<String, dynamic>> state() async =>
      _decode(await (await _request('GET', '/v1/state')).close());
  @override
  Future<Map<String, dynamic>> post(
    String route, [
    Map<String, dynamic> body = const {},
  ]) async {
    final request = await _request('POST', route);
    request.write(jsonEncode(body));
    return _decode(await request.close());
  }

  @override
  Stream<Map<String, dynamic>> events() async* {
    final response = await (await _request('GET', '/v1/events')).close();
    if (response.statusCode != 200) {
      throw StateError('Pocket event stream rejected.');
    }
    await for (final line
        in response.transform(utf8.decoder).transform(const LineSplitter())) {
      if (line.startsWith('data: ')) {
        yield jsonDecode(line.substring(6)) as Map<String, dynamic>;
      }
    }
  }

  @override
  void reset() {
    _client?.close(force: true);
    _client = null;
    _endpoint = null;
    _token = null;
  }

  @override
  void close() => reset();
}

class PocketController extends ChangeNotifier {
  PocketController(this.api);
  final PocketApi api;
  Map<String, dynamic>? data;
  String? error;
  bool connecting = true;
  String liveText = '';
  StreamSubscription<Map<String, dynamic>>? _subscription;
  Future<void> connect() async {
    connecting = true;
    error = null;
    notifyListeners();
    try {
      await _subscription?.cancel();
      _subscription = null;
      api.reset();
      data = await api.state();
      connecting = false;
      notifyListeners();
      _subscription = api.events().listen(
        _event,
        onError: (Object _) {
          error = 'Pocket connection lost.';
          notifyListeners();
        },
        onDone: () {
          error = 'Pocket disconnected.';
          notifyListeners();
        },
      );
    } catch (value) {
      connecting = false;
      error = value.toString();
      notifyListeners();
    }
  }

  Future<void> refresh() async {
    try {
      data = await api.state();
      error = null;
      notifyListeners();
    } catch (value) {
      error = value.toString();
      notifyListeners();
    }
  }

  Future<void> openWorkspace(String path) async {
    await api.post('/v1/workspaces/open', {'path': path});
    await refresh();
  }

  Future<void> selectConversation(String id) async {
    await api.post('/v1/conversations/select', {
      'id': id,
      'switchWorkspace': true,
    });
    liveText = '';
    await refresh();
  }

  Future<void> createConversation(String model, String reasoningEffort) async {
    await api.post('/v1/conversations', {
      'model': model,
      'reasoningEffort': reasoningEffort,
    });
    liveText = '';
    await refresh();
  }

  Future<void> send(String prompt) async {
    await api.post('/v1/tasks', {'prompt': prompt});
    liveText = '';
    await refresh();
  }

  Future<void> stop() async {
    await api.post('/v1/tasks/stop');
    await refresh();
  }

  Future<void> approval(String id, bool approve) async {
    await api.post('/v1/approvals/$id/${approve ? 'approve' : 'deny'}');
    await refresh();
  }

  Future<Map<String, dynamic>> startPairing() async =>
      api.post('/v1/pairing/start');
  Future<void> revokePairing() async {
    await api.post('/v1/pairing/revoke');
    await refresh();
  }

  Future<Map<String, dynamic>> workspaceRoots() =>
      api.post('/v1/workspaces/roots');
  Future<Map<String, dynamic>> workspaceDirectory(
    String path, [
    int page = 0,
  ]) => api.post('/v1/workspaces/directory', {'path': path, 'page': page});
  Future<void> selectBrowsableWorkspace(String path) async {
    await api.post('/v1/workspaces/select-browsable', {'path': path});
    await refresh();
  }

  Future<Map<String, dynamic>> history() => api.post('/v1/history');
  Future<Map<String, dynamic>> checkUpdates() => api.post('/v1/updates/check');
  Future<Map<String, dynamic>> discoverTelegram(String token) async =>
      api.post('/v1/onboarding/telegram/discover', {'token': token});
  Future<Map<String, dynamic>> telegramBot(String token) async =>
      api.post('/v1/onboarding/telegram/bot', {'token': token});
  Future<Map<String, dynamic>> configureTelegram(
    String token,
    String userId,
  ) async {
    final result = await api.post('/v1/onboarding/telegram/configure', {
      'token': token,
      'userId': userId,
    });
    await refresh();
    return result;
  }

  void _event(Map<String, dynamic> value) {
    if (value['type'] == 'mobile.connection' &&
        value['state'] == 'disconnected') {
      error = 'Mobile connection lost. Reconnecting…';
      notifyListeners();
      return;
    }
    if (value['type'] == 'liveOutput' && value['event'] is Map) {
      final event = value['event'] as Map<String, dynamic>;
      if (event['type'] == 'assistant.snapshot' ||
          event['type'] == 'turn.finished') {
        liveText = event['text']?.toString() ?? liveText;
      }
      if (event['type'] == 'assistant.delta') {
        liveText += event['text']?.toString() ?? '';
      }
    }
    if (value['type'] != 'bridge.connected') unawaited(refresh());
    notifyListeners();
  }

  @override
  void dispose() {
    _subscription?.cancel();
    api.close();
    super.dispose();
  }
}
