import 'package:flutter/material.dart';
import 'dart:io';
import 'pocket_bridge.dart';
import 'pocket_screen.dart';
import 'android_pairing_screen.dart';
import 'mobile_pocket_api.dart';
import 'mobile_pocket_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CodexPocketApp());
}

class CodexPocketApp extends StatefulWidget {
  const CodexPocketApp({super.key, this.api, this.mobileMode});
  final PocketApi? api;
  final bool? mobileMode;
  @override
  State<CodexPocketApp> createState() => _CodexPocketAppState();
}

class _CodexPocketAppState extends State<CodexPocketApp> {
  PocketController? controller;
  @override
  void initState() {
    super.initState();
    if (widget.api != null || !Platform.isAndroid) {
      controller = PocketController(widget.api ?? FilePocketApi())..connect();
    }
  }

  @override
  void dispose() {
    controller?.dispose();
    super.dispose();
  }

  Future<void> _reconnectMobile() async {
    final restored = await MobilePocketApi.restore();
    if (!mounted || restored == null) return;
    controller?.dispose();
    setState(() => controller = PocketController(restored)..connect());
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'VS Code Codex Remote Control',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xFF6557D2),
        brightness: Brightness.dark,
      ),
      scaffoldBackgroundColor: const Color(0xFF101116),
      useMaterial3: true,
      cardTheme: const CardThemeData(
        color: Color(0xFF191B23),
        elevation: 0,
        margin: EdgeInsets.zero,
      ),
      inputDecorationTheme: const InputDecorationTheme(
        filled: true,
        fillColor: Color(0xFF20232D),
        border: OutlineInputBorder(),
      ),
    ),
    home: controller == null
        ? AndroidPairingScreen(
            onPaired: (api) =>
                setState(() => controller = PocketController(api)..connect()),
          )
        : (widget.mobileMode ?? Platform.isAndroid)
        ? MobilePocketScreen(
            controller: controller!,
            onReconnect: _reconnectMobile,
          )
        : PocketScreen(controller: controller!),
  );
}
