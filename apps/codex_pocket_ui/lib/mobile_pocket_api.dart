import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:web_socket_channel/io.dart';
import 'pocket_bridge.dart';
import 'mobile_secure_channel.dart';

typedef PairingChallenge =
    Future<void> Function(String botUsername, String telegramCode);

class MobilePocketApi implements PocketApi {
  MobilePocketApi._(this._socket, this._secure, this._subscription);
  final IOWebSocketChannel _socket;
  final MobileSecureChannel _secure;
  final StreamSubscription<dynamic> _subscription;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final _pending = <String, Completer<Map<String, dynamic>>>{};
  int _request = 0;

  static Future<MobilePocketApi> pair(
    Map<String, dynamic> qr,
    PairingChallenge challenge,
  ) async {
    if (qr['version'] != 1 ||
        qr['relayUrl'] is! String ||
        qr['roomId'] is! String ||
        qr['pairingId'] is! String ||
        qr['claimSecret'] is! String ||
        qr['desktopPublicKey'] is! String ||
        qr['expiresAt'] is! String) {
      throw const FormatException('VS Code Codex Remote QR kodu geçersiz.');
    }
    final expires = DateTime.tryParse('${qr['expiresAt']}');
    if (expires == null || !expires.isAfter(DateTime.now().toUtc())) {
      throw const FormatException('QR eşleştirme süresi dolmuş.');
    }
    final relay = Uri.parse('${qr['relayUrl']}');
    if (relay.scheme != 'wss') {
      throw const FormatException('Pocket Relay güvenli WSS kullanmalıdır.');
    }

    final x25519 = X25519();
    final keyPair = await x25519.newKeyPair();
    final publicKey = await keyPair.extractPublicKey();
    final shared = await x25519.sharedSecretKey(
      keyPair: keyPair,
      remotePublicKey: SimplePublicKey(
        decodeBase64Url('${qr['desktopPublicKey']}'),
        type: KeyPairType.x25519,
      ),
    );
    final secure = await MobileSecureChannel.fromSharedSecret(
      await shared.extractBytes(),
      '${qr['pairingId']}',
    );
    final endpoint = relay.replace(
      path:
          '${relay.path.replaceFirst(RegExp(r'/$'), '')}/v1/rooms/${qr['roomId']}/connect',
    );
    final socket = IOWebSocketChannel.connect(
      endpoint,
      headers: {
        HttpHeaders.authorizationHeader: 'Bearer ${qr['claimSecret']}',
        'x-pocket-role': 'mobile',
      },
      pingInterval: const Duration(seconds: 20),
      connectTimeout: const Duration(seconds: 15),
    );
    await socket.ready;
    final accepted = Completer<void>();
    late final MobilePocketApi api;
    final subscription = socket.stream.listen(
      (dynamic raw) async {
        try {
          final decoded = jsonDecode('$raw');
          if (decoded is Map && decoded['type'] == 'relay.offline') {
            throw StateError('Bilgisayar şu anda çevrimdışı.');
          }
          final message = await secure.open(
            Map<String, dynamic>.from(decoded as Map),
          );
          if (message['type'] == 'pair.challenge') {
            await challenge(
              '${message['botUsername']}',
              '${message['telegramCode']}',
            );
          } else if (message['type'] == 'pair.accepted') {
            if (!accepted.isCompleted) {
              accepted.complete();
            }
          } else if (message['type'] == 'response') {
            final pending = api._pending.remove('${message['id']}');
            if (message['error'] != null) {
              pending?.completeError(StateError('${message['error']}'));
            } else {
              pending?.complete(
                Map<String, dynamic>.from(
                  (message['result'] as Map?) ?? const {},
                ),
              );
            }
          } else if (message['type'] == 'event') {
            api._events.add(Map<String, dynamic>.from(message['event'] as Map));
          }
        } catch (error, stack) {
          if (!accepted.isCompleted) accepted.completeError(error, stack);
        }
      },
      onError: (Object error, StackTrace stack) {
        if (!accepted.isCompleted) accepted.completeError(error, stack);
      },
      onDone: () {
        if (!accepted.isCompleted) {
          accepted.completeError(
            StateError('Pocket Relay bağlantısı kapandı.'),
          );
        }
      },
    );
    api = MobilePocketApi._(socket, secure, subscription);
    final claim = await secure.seal({'claimSecret': qr['claimSecret']});
    socket.sink.add(
      jsonEncode({
        'type': 'pair.claim',
        'pairingId': qr['pairingId'],
        'deviceName': 'Android',
        'devicePublicKey': base64UrlNoPad(publicKey.bytes),
        'envelope': claim,
      }),
    );
    await accepted.future.timeout(const Duration(minutes: 5));
    const storage = FlutterSecureStorage(
      aOptions: AndroidOptions(encryptedSharedPreferences: true),
    );
    await storage.write(
      key: 'pocket.mobile.pairing',
      value: jsonEncode({
        'relayUrl': qr['relayUrl'],
        'roomId': qr['roomId'],
        'pairingId': qr['pairingId'],
        'desktopPublicKey': qr['desktopPublicKey'],
        'privateKey': base64UrlNoPad(await keyPair.extractPrivateKeyBytes()),
        'publicKey': base64UrlNoPad(publicKey.bytes),
      }),
    );
    return api;
  }

  static Future<MobilePocketApi?> restore() async {
    const storage = FlutterSecureStorage(
      aOptions: AndroidOptions(encryptedSharedPreferences: true),
    );
    final raw = await storage.read(key: 'pocket.mobile.pairing');
    if (raw == null) return null;
    try {
      final value = Map<String, dynamic>.from(jsonDecode(raw) as Map);
      final relay = Uri.parse('${value['relayUrl']}');
      if (relay.scheme != 'wss') return null;
      final publicBytes = decodeBase64Url('${value['publicKey']}');
      final keyPair = SimpleKeyPairData(
        decodeBase64Url('${value['privateKey']}'),
        publicKey: SimplePublicKey(publicBytes, type: KeyPairType.x25519),
        type: KeyPairType.x25519,
      );
      final shared = await X25519().sharedSecretKey(
        keyPair: keyPair,
        remotePublicKey: SimplePublicKey(
          decodeBase64Url('${value['desktopPublicKey']}'),
          type: KeyPairType.x25519,
        ),
      );
      final secure = await MobileSecureChannel.fromSharedSecret(
        await shared.extractBytes(),
        '${value['pairingId']}',
      );
      final endpoint = relay.replace(
        path:
            '${relay.path.replaceFirst(RegExp(r'/$'), '')}/v1/rooms/${value['roomId']}/connect',
      );
      final credential = '${value['pairingId']}.${value['publicKey']}';
      final socket = IOWebSocketChannel.connect(
        endpoint,
        headers: {
          HttpHeaders.authorizationHeader: 'Bearer $credential',
          'x-pocket-role': 'mobile',
        },
        pingInterval: const Duration(seconds: 20),
        connectTimeout: const Duration(seconds: 15),
      );
      await socket.ready;
      final accepted = Completer<void>();
      late final MobilePocketApi api;
      final subscription = socket.stream.listen(
        (dynamic rawMessage) async {
          try {
            final decoded = jsonDecode('$rawMessage');
            if (decoded is Map && decoded['type'] == 'relay.offline') {
              throw StateError('Bilgisayar şu anda çevrimdışı.');
            }
            final message = await secure.open(
              Map<String, dynamic>.from(decoded as Map),
            );
            if (message['type'] == 'pair.accepted') {
              if (!accepted.isCompleted) {
                accepted.complete();
              }
            } else if (message['type'] == 'response') {
              final pending = api._pending.remove('${message['id']}');
              if (message['error'] != null) {
                pending?.completeError(StateError('${message['error']}'));
              } else {
                pending?.complete(
                  Map<String, dynamic>.from(
                    (message['result'] as Map?) ?? const {},
                  ),
                );
              }
            } else if (message['type'] == 'event') {
              api._events.add(
                Map<String, dynamic>.from(message['event'] as Map),
              );
            }
          } catch (error, stack) {
            if (!accepted.isCompleted) accepted.completeError(error, stack);
          }
        },
        onError: (Object error, StackTrace stack) {
          if (!accepted.isCompleted) accepted.completeError(error, stack);
        },
        onDone: () {
          if (!accepted.isCompleted) {
            accepted.completeError(
              StateError('Pocket Relay bağlantısı kapandı.'),
            );
          }
        },
      );
      api = MobilePocketApi._(socket, secure, subscription);
      socket.sink.add(
        jsonEncode({
          'type': 'device.resume',
          'pairingId': value['pairingId'],
          'devicePublicKey': value['publicKey'],
          'envelope': await secure.seal({'resume': true}),
        }),
      );
      await accepted.future.timeout(const Duration(seconds: 20));
      return api;
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, dynamic>> _call(
    String method, [
    Map<String, dynamic> params = const {},
  ]) async {
    final id = '${DateTime.now().microsecondsSinceEpoch}-${++_request}';
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;
    _socket.sink.add(
      jsonEncode(
        await _secure.seal({
          'type': 'request',
          'id': id,
          'method': method,
          'params': params,
        }),
      ),
    );
    return completer.future.timeout(const Duration(seconds: 30));
  }

  Future<void> registerPushToken(String token) async {
    await _call('registerPush', {'token': token});
  }

  @override
  Future<Map<String, dynamic>> state() => _call('state');
  @override
  Stream<Map<String, dynamic>> events() => _events.stream;
  @override
  Future<Map<String, dynamic>> post(
    String route, [
    Map<String, dynamic> body = const {},
  ]) {
    if (route == '/v1/workspaces/open') return _call('openWorkspace', body);
    if (route == '/v1/workspaces/roots') return _call('workspaceRoots');
    if (route == '/v1/workspaces/directory') {
      return _call('workspaceDirectory', body);
    }
    if (route == '/v1/workspaces/select-browsable') {
      return _call('selectBrowsableWorkspace', body);
    }
    if (route == '/v1/conversations') return _call('createConversation', body);
    if (route == '/v1/conversations/select') {
      return _call('selectConversation', body);
    }
    if (route == '/v1/tasks') return _call('sendTask', body);
    if (route == '/v1/tasks/stop') return _call('stopTask');
    if (route == '/v1/history') return _call('history');
    if (route == '/v1/updates/check') return _call('checkUpdates');
    final approval = RegExp(
      r'^/v1/approvals/([^/]+)/(approve|deny)$',
    ).firstMatch(route);
    if (approval != null) {
      return _call('decideApproval', {
        'id': Uri.decodeComponent(approval.group(1)!),
        'decision': approval.group(2),
      });
    }
    throw UnsupportedError('Bu mobil işlem desteklenmiyor.');
  }

  @override
  void reset() {}
  @override
  void close() {
    _subscription.cancel();
    _socket.sink.close();
    _events.close();
  }
}
