import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:url_launcher/url_launcher.dart';
import 'mobile_pocket_api.dart';
import 'pocket_bridge.dart';
import 'push_notifications.dart';
import 'app_localizations.dart';

class AndroidPairingScreen extends StatefulWidget {
  const AndroidPairingScreen({super.key, required this.onPaired});
  final void Function(PocketApi api) onPaired;
  @override
  State<AndroidPairingScreen> createState() => _AndroidPairingScreenState();
}

class _AndroidPairingScreenState extends State<AndroidPairingScreen> {
  bool busy = false;
  String? error;
  String? statusKey;
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
      statusKey = 'restore';
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
      statusKey = null;
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
      statusKey = 'secure';
    });
    await scanner.stop();
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) throw const FormatException('QR içeriği geçersiz.');
      final api = await MobilePocketApi.pair(
        Map<String, dynamic>.from(decoded),
        (bot, code) async {
          if (mounted) {
            setState(() => statusKey = 'telegram');
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
          statusKey = 'retry';
        });
      }
      await scanner.start();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        context.tr(
          'Pair VS Code Codex Remote',
          'VS Code Codex Remote eşleştirme',
        ),
      ),
      actions: const [LanguageMenuButton(), SizedBox(width: 8)],
    ),
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
            Text(switch (statusKey) {
              'restore' => context.tr(
                'Connecting to the saved computer…',
                'Kayıtlı bilgisayara bağlanılıyor…',
              ),
              'secure' => context.tr(
                'Establishing a secure connection…',
                'Güvenli bağlantı kuruluyor…',
              ),
              'telegram' => context.tr(
                'Waiting for Telegram verification…',
                'Telegram doğrulaması bekleniyor…',
              ),
              'retry' => context.tr(
                'Scan the QR code again.',
                'QR kodunu yeniden okutun.',
              ),
              _ => context.tr(
                'Scan the VS Code Codex Remote QR code shown on your computer.',
                'Bilgisayardaki VS Code Codex Remote QR kodunu okutun.',
              ),
            }, textAlign: TextAlign.center),
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
