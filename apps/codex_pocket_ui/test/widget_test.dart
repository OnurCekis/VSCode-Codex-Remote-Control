import 'dart:async';
import 'dart:io';
import 'package:codex_pocket_ui/main.dart';
import 'package:codex_pocket_ui/pocket_bridge.dart';
import 'package:codex_pocket_ui/android_pairing_screen.dart';
import 'package:codex_pocket_ui/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class FakeApi implements PocketApi {
  final controller = StreamController<Map<String, dynamic>>.broadcast();
  final calls = <String>[];
  bool fail = false;
  bool telegramConfigured = true;
  @override
  Future<Map<String, dynamic>> state() async {
    if (fail) throw StateError('offline');
    return {
      'pocket': 'ready',
      'codex': {'version': '26.903.71938', 'topology': 'sharedAppServer'},
      'telegram': {'state': 'ready'},
      'onboarding': {
        'telegramConfigured': telegramConfigured,
        'runtimeReady': true,
      },
      'workspaces': {
        'activeWorkspace': {
          'path': '/Projects/sample-app',
          'displayName': 'Sample App',
        },
        'recentWorkspaces': [
          {'path': '/Projects/sample-app', 'displayName': 'Sample App'},
        ],
      },
      'conversations': [
        {
          'id': 'thread-1',
          'title': 'Pocket task',
          'preview': 'Hello',
          'status': {'type': 'idle'},
        },
      ],
      'models': [
        {
          'id': 'gpt-5.6-sol',
          'model': 'gpt-5.6-sol',
          'displayName': 'GPT-5.6 Sol',
          'defaultReasoningEffort': 'medium',
          'isDefault': true,
          'supportedReasoningEfforts': [
            {'reasoningEffort': 'medium', 'description': 'Balanced'},
            {'reasoningEffort': 'high', 'description': 'Deeper reasoning'},
          ],
        },
      ],
      'selectedConversationId': 'thread-1',
      'preview': {
        'messages': [
          {
            'role': 'assistant',
            'text': 'First paragraph.\n\nSecond paragraph.',
          },
        ],
      },
      'approvals': [
        {'id': 'approval-1', 'command': 'safe command'},
      ],
    };
  }

  @override
  Stream<Map<String, dynamic>> events() => controller.stream;
  @override
  Future<Map<String, dynamic>> post(
    String route, [
    Map<String, dynamic> body = const {},
  ]) async {
    calls.add(
      '$route:${body['prompt'] ?? body['path'] ?? body['model'] ?? ''}:${body['reasoningEffort'] ?? ''}',
    );
    if (route == '/v1/pairing/start') {
      return {
        'telegramCode': 'DEMO1234',
        'qr': {
          'v': 1,
          'relay': 'wss://relay.example.invalid/connect',
          'pairingId': 'public-preview-demo',
          'secret': 'not-a-real-secret',
          'expiresAt': '2030-01-01T12:00:00Z',
          'desktopPublicKey': 'public-demo-key',
          'botUsername': 'example_remote_bot',
        },
      };
    }
    if (route == '/v1/onboarding/telegram/discover') {
      return {'userId': 42, 'displayName': '@pocket_user'};
    }
    if (route == '/v1/onboarding/telegram/configure') {
      telegramConfigured = true;
      return {
        'configured': true,
        'botUsername': 'codex_pocket_bot',
        'userId': 42,
        'delivered': true,
      };
    }
    return {};
  }

  @override
  void reset() {}
  @override
  void close() {
    controller.close();
  }
}

void main() {
  Future<void> capture(WidgetTester tester, String name) async {
    await tester.pumpAndSettle();
    await expectLater(
      find.byKey(const Key('public-screenshot-boundary')),
      matchesGoldenFile('../../../docs/images/$name.png'),
    );
  }

  testWidgets('renders status, canonical output and common controls', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1200, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final api = FakeApi();
    await tester.pumpWidget(CodexPocketApp(api: api));
    await tester.pumpAndSettle();
    expect(find.text('Pocket ready'), findsOneWidget);
    expect(find.textContaining('26.903.71938'), findsOneWidget);
    expect(find.text('First paragraph.\n\nSecond paragraph.'), findsOneWidget);
    expect(find.text('Approve'), findsOneWidget);
    expect(find.text('Deny'), findsOneWidget);
    await tester.enterText(find.byType(EditableText).last, 'Do the task');
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();
    expect(api.calls, contains('/v1/tasks:Do the task:'));
    await tester.tap(find.text('Approve'));
    await tester.pump();
    expect(
      api.calls.any(
        (value) => value.startsWith('/v1/approvals/approval-1/approve'),
      ),
      isTrue,
    );
    await tester.tap(find.byTooltip('Stop'));
    await tester.pump();
    expect(
      api.calls.any((value) => value.startsWith('/v1/tasks/stop')),
      isTrue,
    );
  });

  testWidgets('creates a conversation with a discovered model and effort', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1200, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final api = FakeApi();
    await tester.pumpWidget(CodexPocketApp(api: api));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Open project'), findsOneWidget);
    await tester.tap(find.byTooltip('New chat'));
    await tester.pumpAndSettle();
    expect(find.text('GPT-5.6 Sol'), findsOneWidget);
    expect(find.text('Medium'), findsOneWidget);
    await tester.tap(find.text('Create chat'));
    await tester.pumpAndSettle();
    expect(api.calls, contains('/v1/conversations:gpt-5.6-sol:medium'));
  });

  test(
    'propagates canonical live output without changing whitespace',
    () async {
      final api = FakeApi();
      final controller = PocketController(api);
      await controller.connect();
      api.controller.add({
        'type': 'liveOutput',
        'event': {'type': 'assistant.delta', 'text': 'Live one.\n\nLive two.'},
      });
      await Future<void>.delayed(Duration.zero);
      expect(controller.liveText, 'Live one.\n\nLive two.');
      controller.dispose();
    },
  );

  testWidgets('shows disconnected state and reconnect action', (tester) async {
    final api = FakeApi()..fail = true;
    await tester.pumpWidget(CodexPocketApp(api: api));
    await tester.pumpAndSettle();
    expect(find.text('Pocket is disconnected'), findsOneWidget);
    expect(find.text('Reconnect'), findsOneWidget);
    api.fail = false;
    await tester.tap(find.text('Reconnect'));
    await tester.pumpAndSettle();
    expect(find.text('Pocket ready'), findsOneWidget);
  });

  testWidgets('common control layout renders at a phone viewport', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final api = FakeApi();
    await tester.pumpWidget(CodexPocketApp(api: api));
    await tester.pumpAndSettle();
    expect(find.text('Workspaces'), findsOneWidget);
    expect(find.byTooltip('Send'), findsOneWidget);
    final exception = tester.takeException();
    if (exception is FlutterError) fail(exception.toStringDeep());
    expect(exception, isNull);
  });

  testWidgets('android UI exposes task controls through mobile navigation', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final api = FakeApi();
    await tester.pumpWidget(CodexPocketApp(api: api, mobileMode: true));
    await tester.pumpAndSettle();

    expect(find.text('Chat'), findsWidgets);
    expect(find.text('Projects'), findsOneWidget);
    expect(find.text('Control'), findsOneWidget);
    expect(find.text('First paragraph.\n\nSecond paragraph.'), findsOneWidget);
    expect(find.text('Approve'), findsOneWidget);
    expect(find.text('Deny'), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('mobile-prompt')),
      'Telefondan çalıştır',
    );
    await tester.tap(find.byKey(const Key('mobile-send')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('/v1/tasks:Telefondan çalıştır:'));

    await tester.tap(find.text('Approve'));
    await tester.pumpAndSettle();
    expect(
      api.calls.any(
        (value) => value.startsWith('/v1/approvals/approval-1/approve'),
      ),
      isTrue,
    );

    await tester.tap(find.byKey(const Key('mobile-new-chat')));
    await tester.pumpAndSettle();
    expect(find.text('GPT-5.6 Sol'), findsOneWidget);
    expect(find.text('Medium'), findsOneWidget);
    await tester.tap(find.byKey(const Key('mobile-create-chat')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('/v1/conversations:gpt-5.6-sol:medium'));
  });

  testWidgets('android project and control tabs expose Telegram equivalents', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final api = FakeApi();
    await tester.pumpWidget(CodexPocketApp(api: api, mobileMode: true));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Projects'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('mobile-browse-projects')), findsOneWidget);
    expect(find.text('CHATS IN THIS PROJECT'), findsOneWidget);

    await tester.tap(find.text('Control'));
    await tester.pumpAndSettle();
    expect(find.text('Latest task and output'), findsOneWidget);
    expect(find.text('Check for updates'), findsOneWidget);
    expect(find.text('Stop active task'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Screenshot unavailable'), 250);
    expect(find.text('Screenshot unavailable'), findsOneWidget);

    await tester.tap(find.text('Stop active task'));
    await tester.pumpAndSettle();
    expect(
      api.calls.any((value) => value.startsWith('/v1/tasks/stop')),
      isTrue,
    );
  });

  testWidgets('first run blocks the app until Telegram callback succeeds', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(900, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final api = FakeApi()..telegramConfigured = false;
    await tester.pumpWidget(CodexPocketApp(api: api));
    await tester.pumpAndSettle();
    expect(
      find.text('Welcome to VS Code Codex Remote Control'),
      findsOneWidget,
    );
    expect(find.text('Workspaces'), findsNothing);
    await tester.enterText(
      find.byKey(const Key('telegram-token')),
      ['123456', 'abcdefghijklmnopqrstuvwxyzABCDE'].join(':'),
    );
    await tester.tap(find.text('Find my ID'));
    await tester.pumpAndSettle();
    expect(find.text('42'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('verify-telegram')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('verify-telegram')));
    await tester.pumpAndSettle();
    expect(find.text('Workspaces'), findsOneWidget);
    expect(
      api.calls.any(
        (value) => value.startsWith('/v1/onboarding/telegram/configure'),
      ),
      isTrue,
    );
  });

  testWidgets('language menu switches between English and Turkish', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(900, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(CodexPocketApp(api: FakeApi(), mobileMode: true));
    await tester.pumpAndSettle();
    expect(find.text('Chat'), findsWidgets);
    await tester.tap(find.byTooltip('Language'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.widgetWithText(CheckedPopupMenuItem<String>, 'Türkçe'),
    );
    await tester.pumpAndSettle();
    expect(find.text('Sohbet'), findsWidgets);
    expect(find.text('Projeler'), findsOneWidget);
  });

  testWidgets('Android first screen greets and waits for an explicit QR tap', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    const secureStorage = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      secureStorage,
      (_) async => null,
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        secureStorage,
        null,
      ),
    );
    await tester.pumpWidget(
      AppLocaleScope(
        controller: AppLocaleController('en'),
        child: MaterialApp(home: AndroidPairingScreen(onPaired: (_) {})),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Hello!'), findsOneWidget);
    expect(find.text('Scan QR code to pair'), findsOneWidget);
    expect(find.byType(MobileScanner), findsNothing);
  });

  testWidgets('generates public screenshots from synthetic English data', (
    tester,
  ) async {
    if (!const bool.fromEnvironment('UPDATE_PUBLIC_SCREENSHOTS')) return;
    await tester.runAsync(() async {
      final fontBytes = await File(
        '/System/Library/Fonts/Supplemental/Arial.ttf',
      ).readAsBytes();
      await (FontLoader(
        'PublicPreview',
      )..addFont(Future.value(ByteData.sublistView(fontBytes)))).load();
      var directory = File(Platform.resolvedExecutable).parent;
      File? materialIcons;
      while (directory.parent.path != directory.path) {
        final candidate = File(
          '${directory.path}/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
        );
        if (await candidate.exists()) {
          materialIcons = candidate;
          break;
        }
        directory = directory.parent;
      }
      if (materialIcons == null) {
        throw StateError('Flutter Material Icons font was not found.');
      }
      final iconBytes = await materialIcons.readAsBytes();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(Future.value(ByteData.sublistView(iconBytes)))).load();
    });
    await tester.binding.setSurfaceSize(const Size(1200, 800));
    final desktopApi = FakeApi();
    await tester.pumpWidget(
      RepaintBoundary(
        key: const Key('public-screenshot-boundary'),
        child: CodexPocketApp(api: desktopApi, fontFamily: 'PublicPreview'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Pair phone'));
    await tester.pumpAndSettle();
    await capture(tester, 'desktop-qr-pairing');
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();

    await tester.binding.setSurfaceSize(const Size(390, 844));
    await tester.pumpWidget(
      RepaintBoundary(
        key: const Key('public-screenshot-boundary'),
        child: CodexPocketApp(
          api: FakeApi(),
          mobileMode: true,
          fontFamily: 'PublicPreview',
        ),
      ),
    );
    await capture(tester, 'android-chat');
    await tester.tap(find.byIcon(Icons.folder_outlined).last);
    await tester.pumpAndSettle();
    await capture(tester, 'android-projects');
    await tester.tap(find.byIcon(Icons.tune_outlined).last);
    await tester.pumpAndSettle();
    await capture(tester, 'android-controls');
    await tester.binding.setSurfaceSize(null);
  });
}
