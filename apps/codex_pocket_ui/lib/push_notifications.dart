import 'dart:io';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

@pragma('vm:entry-point')
Future<void> pocketFirebaseBackgroundHandler(RemoteMessage message) async {
  final options = pocketFirebaseOptions();
  if (options != null && Firebase.apps.isEmpty) {
    await Firebase.initializeApp(options: options);
  }
}

FirebaseOptions? pocketFirebaseOptions() {
  const apiKey = String.fromEnvironment('POCKET_FIREBASE_API_KEY');
  const appId = String.fromEnvironment('POCKET_FIREBASE_APP_ID');
  const sender = String.fromEnvironment('POCKET_FIREBASE_SENDER_ID');
  const project = String.fromEnvironment('POCKET_FIREBASE_PROJECT_ID');
  if ([apiKey, appId, sender, project].any((value) => value.isEmpty)) {
    return null;
  }
  return const FirebaseOptions(
    apiKey: apiKey,
    appId: appId,
    messagingSenderId: sender,
    projectId: project,
  );
}

class PushNotifications {
  static final _local = FlutterLocalNotificationsPlugin();
  static const _channel = AndroidNotificationChannel(
    'codex_pocket_events',
    'VS Code Codex Remote olayları',
    description: 'Görev tamamlanması ve onay istekleri',
    importance: Importance.high,
  );

  static Future<String?> initialize() async {
    if (!Platform.isAndroid) return null;
    try {
      final options = pocketFirebaseOptions();
      if (options == null) return null;
      if (Firebase.apps.isEmpty) {
        await Firebase.initializeApp(options: options);
      }
      FirebaseMessaging.onBackgroundMessage(pocketFirebaseBackgroundHandler);
      await _local.initialize(
        const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        ),
      );
      await _local
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >()
          ?.createNotificationChannel(_channel);
      await FirebaseMessaging.instance.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
      FirebaseMessaging.onMessage.listen(
        (message) => show(message.data['event']),
      );
      return await FirebaseMessaging.instance.getToken();
    } catch (_) {
      return null;
    }
  }

  static Future<void> show(String? event) async {
    if (event != 'taskCompleted' && event != 'approvalRequired') return;
    await _local.show(
      event == 'approvalRequired' ? 2001 : 2002,
      'VS Code Codex Remote Control',
      event == 'approvalRequired'
          ? 'Codex onayınızı bekliyor.'
          : 'Codex görevi tamamladı.',
      const NotificationDetails(
        android: AndroidNotificationDetails(
          'codex_pocket_events',
          'VS Code Codex Remote olayları',
          channelDescription: 'Görev tamamlanması ve onay istekleri',
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
    );
  }
}
