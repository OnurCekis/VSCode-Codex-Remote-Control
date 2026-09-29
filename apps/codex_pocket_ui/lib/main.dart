import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'dart:io';
import 'pocket_bridge.dart';
import 'pocket_screen.dart';
import 'android_pairing_screen.dart';
import 'mobile_pocket_api.dart';
import 'mobile_pocket_screen.dart';
import 'app_localizations.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final locale = await AppLocaleController.restore();
  runApp(CodexPocketApp(localeController: locale));
}

class CodexPocketApp extends StatefulWidget {
  const CodexPocketApp({
    super.key,
    this.api,
    this.mobileMode,
    this.localeController,
    this.fontFamily,
  });
  final PocketApi? api;
  final bool? mobileMode;
  final AppLocaleController? localeController;
  final String? fontFamily;
  @override
  State<CodexPocketApp> createState() => _CodexPocketAppState();
}

class _CodexPocketAppState extends State<CodexPocketApp> {
  PocketController? controller;
  late final AppLocaleController localeController;
  @override
  void initState() {
    super.initState();
    localeController = widget.localeController ?? AppLocaleController();
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
  Widget build(BuildContext context) => AppLocaleScope(
    controller: localeController,
    child: ListenableBuilder(
      listenable: localeController,
      builder: (context, _) => MaterialApp(
        title: 'VS Code Codex Remote Control',
        locale: localeController.locale,
        supportedLocales: const [Locale('en'), Locale('tr')],
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          fontFamily: widget.fontFamily,
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
                onPaired: (api) => setState(
                  () => controller = PocketController(api)..connect(),
                ),
              )
            : (widget.mobileMode ?? Platform.isAndroid)
            ? MobilePocketScreen(
                controller: controller!,
                onReconnect: _reconnectMobile,
              )
            : PocketScreen(controller: controller!),
      ),
    ),
  );
}
