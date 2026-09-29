import 'package:codex_pocket_ui/mobile_secure_channel.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('opens the Node desktop AES-GCM vector and rejects replay', () async {
    final channel = await MobileSecureChannel.fromSharedSecret(
      List<int>.filled(32, 7),
      'pair-vector',
    );
    final envelope = <String, dynamic>{
      'version': 1,
      'direction': 'desktop',
      'sequence': 1,
      'messageId': 'fixed-message-id',
      'iv': 'AwMDAwMDAwMDAwMD',
      'ciphertext': 'BbvArBLMfHS6pAGKIWonj5fbeYQK-_IY-5M',
      'tag': 'G1CeNiO7NNV95gJpKhOzcw',
    };
    await expectLater(
      channel.open(envelope),
      completion({'type': 'state', 'ok': true}),
    );
    await expectLater(channel.open(envelope), throwsFormatException);
  });

  test('rejects modified authenticated ciphertext', () async {
    final channel = await MobileSecureChannel.fromSharedSecret(
      List<int>.filled(32, 7),
      'pair-vector',
    );
    final envelope = <String, dynamic>{
      'version': 1,
      'direction': 'desktop',
      'sequence': 1,
      'messageId': 'fixed-message-id',
      'iv': 'AwMDAwMDAwMDAwMD',
      'ciphertext': 'AbvArBLMfHS6pAGKIWonj5fbeYQK-_IY-5M',
      'tag': 'G1CeNiO7NNV95gJpKhOzcw',
    };
    await expectLater(channel.open(envelope), throwsA(anything));
  });
}
