import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:url_launcher/url_launcher.dart';
import 'mobile_pocket_api.dart';
import 'pocket_bridge.dart';
import 'push_notifications.dart';

class AndroidPairingScreen extends StatefulWidget {
  const AndroidPairingScreen({super.key, required this.onPaired});
  final void Function(PocketApi api) onPaired;
  @override
  State<AndroidPairingScreen> createState() => _AndroidPairingScreenState();
}

class _AndroidPairingScreenState extends State<AndroidPairingScreen> {
  bool busy = false;
  String? error;
  String status = 'Bilgisayardaki VS Code Codex Remote QR kodunu okutun.';
  final scanner = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
  );
  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    setState(() {
      busy = true;
      status = 'Kayıtlı bilgisayara bağlanılıyor…';
    });
    final api = await MobilePocketApi.restore();
    if (!mounted) return;
    if (api != null) {
      final pushToken = await PushNotifications.initialize();
      if (pushToken != null) {
        try {
          await api.registerPushToken(pushToken);
        } catch (_) {
          /* Pocket may still be reconnecting. */
        }
      }
      widget.onPaired(api);
      return;
    }
    setState(() {
      busy = false;
      status = 'Bilgisayardaki VS Code Codex Remote QR kodunu okutun.';
    });
  }

  @override
  void dispose() {
    scanner.dispose();
    super.dispose();
  }

  Future<void> _capture(BarcodeCapture capture) async {
    if (busy) return;
    final raw = capture.barcodes.firstOrNull?.rawValue;
    if (raw == null) return;
    setState(() {
      busy = true;
      error = null;
      status = 'Güvenli bağlantı kuruluyor…';
    });
    await scanner.stop();
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) throw const FormatException('QR içeriği geçersiz.');
      final api = await MobilePocketApi.pair(
        Map<String, dynamic>.from(decoded),
        (bot, code) async {
          if (mounted) {
            setState(() => status = 'Telegram doğrulaması bekleniyor…');
          }
          final uri = Uri.parse('https://t.me/$bot?start=p_$code');
          if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
            throw StateError('Telegram açılamadı.');
          }
        },
      );
      final pushToken = await PushNotifications.initialize();
      if (pushToken != null) await api.registerPushToken(pushToken);
      widget.onPaired(api);
    } catch (value) {
      if (mounted) {
        setState(() {
          busy = false;
          error = value.toString();
          status = 'QR kodunu yeniden okutun.';
        });
      }
      await scanner.start();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('VS Code Codex Remote eşleştirme')),
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: MobileScanner(controller: scanner, onDetect: _capture),
              ),
            ),
            const SizedBox(height: 20),
            Text(status, textAlign: TextAlign.center),
            if (busy)
              const Padding(
                padding: EdgeInsets.all(12),
                child: LinearProgressIndicator(),
              ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  error!,
                  style: const TextStyle(color: Colors.redAccent),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}
