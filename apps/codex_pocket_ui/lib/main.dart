import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'dart:async';
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
  Timer? _mobileReconnectTimer;
  bool _mobileReconnectInProgress = false;
  DateTime _nextMobileReconnect = DateTime.fromMillisecondsSinceEpoch(0);
  @override
  void initState() {
    super.initState();
    localeController = widget.localeController ?? AppLocaleController();
    final isMobile = widget.mobileMode ?? Platform.isAndroid;
    if (widget.api == null && isMobile) {
      _mobileReconnectTimer = Timer.periodic(const Duration(seconds: 5), (_) {
        if (controller?.error != null &&
            !_mobileReconnectInProgress &&
            DateTime.now().isAfter(_nextMobileReconnect)) {
          unawaited(_reconnectMobile());
        }
      });
    }
    if (widget.api != null || !Platform.isAndroid) {
      controller = PocketController(widget.api ?? FilePocketApi())..connect();
    }
  }

  @override
  void dispose() {
    controller?.dispose();
    _mobileReconnectTimer?.cancel();
    super.dispose();
  }

  Future<void> _reconnectMobile() async {
    if (_mobileReconnectInProgress) return;
    _mobileReconnectInProgress = true;
    try {
      final restored = await MobilePocketApi.restore();
      if (!mounted) {
        restored?.close();
        return;
      }
      if (restored == null) {
        _nextMobileReconnect = DateTime.now().add(const Duration(seconds: 20));
        return;
      }
      final previous = controller;
      final next = PocketController(restored);
      setState(() => controller = next);
      await next.connect();
      if (next.error != null) {
        next.dispose();
        if (mounted) setState(() => controller = previous);
        _nextMobileReconnect = DateTime.now().add(const Duration(seconds: 20));
      } else {
        previous?.dispose();
      }
    } catch (_) {
      _nextMobileReconnect = DateTime.now().add(const Duration(seconds: 20));
    } finally {
      _mobileReconnectInProgress = false;
    }
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
