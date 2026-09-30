import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app_localizations.dart';
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
  bool scanning = false;
  bool restoring = true;
  bool hasSavedPairing = false;
  String? error;
  final scanner = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
    autoStart: false,
  );

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    if (busy) return;
    setState(() {
      busy = true;
      restoring = true;
      error = null;
    });
    MobilePocketApi? api;
    try {
      hasSavedPairing = await MobilePocketApi.hasSavedPairing();
      api = await MobilePocketApi.restore();
      if (!mounted) {
        api?.close();
        return;
      }
      if (api != null) {
        await _registerPushToken(api);
        widget.onPaired(api);
        return;
      }
    } catch (value) {
      api?.close();
      if (mounted) error = value.toString();
    }
    if (!mounted) return;
    setState(() {
      busy = false;
      restoring = false;
    });
  }

  Future<void> _registerPushToken(MobilePocketApi api) async {
    try {
      final pushToken = await PushNotifications.initialize();
      if (pushToken != null) await api.registerPushToken(pushToken);
    } catch (_) {
      // Push delivery is optional; the encrypted live connection is not.
    }
  }

  @override
  void dispose() {
    scanner.dispose();
    super.dispose();
  }

  Future<void> _startScanner() async {
    setState(() {
      scanning = true;
      error = null;
    });
    await scanner.start();
  }

  Future<void> _capture(BarcodeCapture capture) async {
    if (busy) return;
    final raw = capture.barcodes.firstOrNull?.rawValue;
    if (raw == null) return;
    setState(() {
      busy = true;
      error = null;
    });
    await scanner.stop();
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) throw const FormatException('Invalid QR code.');
      final api = await MobilePocketApi.pair(
        Map<String, dynamic>.from(decoded),
        (bot, code) async {
          final uri = Uri.parse('https://t.me/$bot?start=p_$code');
          if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
            throw StateError('Could not open Telegram.');
          }
        },
      );
      await _registerPushToken(api);
      widget.onPaired(api);
    } catch (value) {
      if (mounted) {
        setState(() {
          busy = false;
          error = value.toString();
        });
      }
      await scanner.start();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      leading: scanning
          ? IconButton(
              tooltip: context.tr('Back', 'Geri'),
              icon: const Icon(Icons.arrow_back),
              onPressed: () async {
                await scanner.stop();
                if (mounted) setState(() => scanning = false);
              },
            )
          : null,
      title: const Text('VS Code Codex Remote'),
      actions: const [LanguageMenuButton(), SizedBox(width: 8)],
    ),
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: scanning
            ? Column(
                children: [
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(20),
                      child: MobileScanner(
                        controller: scanner,
                        onDetect: _capture,
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    context.tr(
                      'Scan the pairing QR code shown on your computer.',
                      'Bilgisayarda gösterilen eşleştirme QR kodunu okutun.',
                    ),
                    textAlign: TextAlign.center,
                  ),
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
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.redAccent),
                      ),
                    ),
                ],
              )
            : Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Icon(
                        Icons.waving_hand_rounded,
                        size: 64,
                        color: Color(0xFFB9AEFF),
                      ),
                      const SizedBox(height: 20),
                      Text(
                        context.tr('Hello!', 'Merhaba!'),
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 10),
                      Text(
                        context.tr(
                          'Connect to your computer to choose a project, chat with Codex, and approve or stop tasks from your phone.',
                          'Projeni seçmek, Codex ile sohbet etmek ve görevleri telefondan onaylamak ya da durdurmak için bilgisayarına bağlan.',
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 24),
                      if (restoring) ...[
                        const Center(child: CircularProgressIndicator()),
                        const SizedBox(height: 12),
                        Text(
                          context.tr(
                            'Checking your saved connection…',
                            'Kayıtlı bağlantı kontrol ediliyor…',
                          ),
                          textAlign: TextAlign.center,
                        ),
                      ] else ...[
                        if (hasSavedPairing) ...[
                          Text(
                            context.tr(
                              'Could not reconnect to the paired computer. Check that Pocket is running and try again.',
                              'Eşleşmiş bilgisayara bağlanılamadı. Pocket’ın çalıştığını kontrol edip yeniden dene.',
                            ),
                            textAlign: TextAlign.center,
                            style: const TextStyle(color: Colors.orangeAccent),
                          ),
                          const SizedBox(height: 14),
                          OutlinedButton.icon(
                            onPressed: busy ? null : _restore,
                            icon: const Icon(Icons.refresh),
                            label: Text(
                              context.tr('Reconnect', 'Yeniden bağlan'),
                            ),
                          ),
                          const SizedBox(height: 10),
                        ],
                        FilledButton.icon(
                          onPressed: busy ? null : _startScanner,
                          icon: const Icon(Icons.qr_code_scanner),
                          label: Text(
                            context.tr(
                              'Scan QR code to pair',
                              'QR kodunu okut ve eşleştir',
                            ),
                          ),
                        ),
                        if (error != null) ...[
                          const SizedBox(height: 12),
                          Text(
                            error!,
                            textAlign: TextAlign.center,
                            style: const TextStyle(color: Colors.redAccent),
                          ),
                        ],
                      ],
                    ],
                  ),
                ),
              ),
      ),
    ),
  );
}
