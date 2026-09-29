import 'dart:async';
import 'package:codex_pocket_ui/main.dart';
import 'package:codex_pocket_ui/pocket_bridge.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

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
        'activeWorkspace': {'path': '/project'},
        'recentWorkspaces': [
          {'path': '/project', 'displayName': 'project'},
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
    if (route == '/v1/pairing/start') return {'code': 'ABCD1234'};
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
    expect(find.byTooltip('Open Project'), findsOneWidget);
    await tester.tap(find.byTooltip('Yeni sohbet'));
    await tester.pumpAndSettle();
    expect(find.text('GPT-5.6 Sol'), findsOneWidget);
    expect(find.text('Orta'), findsOneWidget);
    await tester.tap(find.text('Sohbet oluştur'));
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

    expect(find.text('Sohbet'), findsWidgets);
    expect(find.text('Projeler'), findsOneWidget);
    expect(find.text('Kontrol'), findsOneWidget);
    expect(find.text('First paragraph.\n\nSecond paragraph.'), findsOneWidget);
    expect(find.text('Onayla'), findsOneWidget);
    expect(find.text('Reddet'), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('mobile-prompt')),
      'Telefondan çalıştır',
    );
    await tester.tap(find.byKey(const Key('mobile-send')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('/v1/tasks:Telefondan çalıştır:'));

    await tester.tap(find.text('Onayla'));
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
    expect(find.text('Orta'), findsOneWidget);
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

    await tester.tap(find.text('Projeler'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('mobile-browse-projects')), findsOneWidget);
    expect(find.text('BU PROJEDEKİ SOHBETLER'), findsOneWidget);

    await tester.tap(find.text('Kontrol'));
    await tester.pumpAndSettle();
    expect(find.text('Son görev ve çıktı'), findsOneWidget);
    expect(find.text('Güncellemeleri denetle'), findsOneWidget);
    expect(find.text('Aktif görevi durdur'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Ekran görüntüsü kullanılamıyor'),
      250,
    );
    expect(find.text('Ekran görüntüsü kullanılamıyor'), findsOneWidget);

    await tester.tap(find.text('Aktif görevi durdur'));
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
    expect(find.text('VS Code Codex Remote Control’a hoş geldiniz'), findsOneWidget);
    expect(find.text('Workspaces'), findsNothing);
    await tester.enterText(
      find.byKey(const Key('telegram-token')),
      ['123456', 'abcdefghijklmnopqrstuvwxyzABCDE'].join(':'),
    );
    await tester.tap(find.text('ID’mi bul'));
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
}
