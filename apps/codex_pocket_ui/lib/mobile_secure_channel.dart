import 'dart:convert';
import 'dart:math';
import 'package:cryptography/cryptography.dart';

String base64UrlNoPad(List<int> bytes) =>
    base64UrlEncode(bytes).replaceAll('=', '');
List<int> decodeBase64Url(String value) =>
    base64Url.decode(base64Url.normalize(value));

class MobileSecureChannel {
  MobileSecureChannel._(this._key, this.context);
  final SecretKey _key;
  final String context;
  final _cipher = AesGcm.with256bits();
  int _sendSequence = 0;
  int _receiveSequence = 0;

  static Future<MobileSecureChannel> fromSharedSecret(
    List<int> sharedSecret,
    String context,
  ) async {
    final key = await Hkdf(hmac: Hmac.sha256(), outputLength: 32).deriveKey(
      secretKey: SecretKey(sharedSecret),
      nonce: utf8.encode('codex-pocket-mobile-v1'),
      info: utf8.encode(context),
    );
    return MobileSecureChannel._(key, context);
  }

  Future<Map<String, dynamic>> seal(Object? value) async {
    final sequence = ++_sendSequence;
    final random = Random.secure();
    final messageId = base64UrlNoPad(
      List<int>.generate(16, (_) => random.nextInt(256)),
    );
    final aad = utf8.encode('1:mobile:$sequence:$messageId');
    final box = await _cipher.encrypt(
      utf8.encode(jsonEncode(value)),
      secretKey: _key,
      aad: aad,
    );
    return {
      'version': 1,
      'direction': 'mobile',
      'sequence': sequence,
      'messageId': messageId,
      'iv': base64UrlNoPad(box.nonce),
      'ciphertext': base64UrlNoPad(box.cipherText),
      'tag': base64UrlNoPad(box.mac.bytes),
    };
  }

  Future<Map<String, dynamic>> open(Map<String, dynamic> envelope) async {
    final sequence = envelope['sequence'];
    final messageId = envelope['messageId'];
    if (envelope['version'] != 1 ||
        envelope['direction'] != 'desktop' ||
        sequence != _receiveSequence + 1 ||
        messageId is! String) {
      throw const FormatException('Şifreli mesaj sırası veya yönü reddedildi.');
    }
    final aad = utf8.encode('1:desktop:$sequence:$messageId');
    final clear = await _cipher.decrypt(
      SecretBox(
        decodeBase64Url('${envelope['ciphertext']}'),
        nonce: decodeBase64Url('${envelope['iv']}'),
        mac: Mac(decodeBase64Url('${envelope['tag']}')),
      ),
      secretKey: _key,
      aad: aad,
    );
    _receiveSequence = sequence as int;
    final decoded = jsonDecode(utf8.decode(clear));
    if (decoded is! Map) {
      throw const FormatException('Şifreli Pocket mesajı geçersiz.');
    }
    return Map<String, dynamic>.from(decoded);
  }
}
