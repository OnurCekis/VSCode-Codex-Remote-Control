import 'package:flutter/material.dart';
import 'package:file_selector/file_selector.dart';
import 'dart:convert';
import 'dart:io';
import 'package:qr_flutter/qr_flutter.dart';
import 'pocket_bridge.dart';
import 'telegram_onboarding.dart';

class PocketScreen extends StatefulWidget {
  const PocketScreen({super.key, required this.controller, this.onReconnect});
  final PocketController controller;
  final Future<void> Function()? onReconnect;
  @override
  State<PocketScreen> createState() => _PocketScreenState();
}

class _PocketScreenState extends State<PocketScreen> {
  final prompt = TextEditingController();
  @override
  void dispose() {
    prompt.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final data = controller.data;
      if (controller.connecting) {
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      }
      if (data == null) {
        return Scaffold(
          body: _Offline(
            message: controller.error ?? 'Pocket is unavailable.',
            retry: () => widget.onReconnect?.call() ?? controller.connect(),
          ),
        );
      }
      final onboarding = data['onboarding'] as Map<String, dynamic>?;
      if (onboarding?['telegramConfigured'] == false ||
          onboarding?['runtimeReady'] == false) {
        return TelegramOnboarding(controller: controller);
      }
      return Scaffold(
        appBar: AppBar(
          title: const Text('VS Code Codex Remote Control'),
          actions: [
            IconButton(
              onPressed: () => _showHistory(context),
              icon: const Icon(Icons.history),
              tooltip: 'Geçmiş',
            ),
            IconButton(
              onPressed: () => _showUpdates(context),
              icon: const Icon(Icons.system_update_alt),
              tooltip: 'Güncellemeleri denetle',
            ),
            IconButton(
              onPressed: controller.refresh,
              icon: const Icon(Icons.refresh),
              tooltip: 'Refresh',
            ),
            IconButton(
              onPressed: () => _pair(context),
              icon: const Icon(Icons.phonelink),
              tooltip: 'Pair phone',
            ),
            const SizedBox(width: 8),
          ],
        ),
        body: LayoutBuilder(
          builder: (context, constraints) => constraints.maxWidth >= 850
              ? Row(
                  children: [
                    SizedBox(
                      width: 310,
                      child: _Sidebar(controller: controller, data: data),
                    ),
                    const VerticalDivider(width: 1),
                    Expanded(
                      child: _Conversation(
                        controller: controller,
                        data: data,
                        prompt: prompt,
                      ),
                    ),
                  ],
                )
              : Column(
                  children: [
                    SizedBox(
                      height: 140,
                      child: _Sidebar(controller: controller, data: data),
                    ),
                    const Divider(height: 1),
                    Expanded(
                      child: _Conversation(
                        controller: controller,
                        data: data,
                        prompt: prompt,
                      ),
                    ),
                  ],
                ),
        ),
      );
    },
  );

  Future<void> _pair(BuildContext context) async {
    try {
      final result = await widget.controller.startPairing();
      final qr = result['qr'] as Map<String, dynamic>?;
      final code = result['telegramCode'];
      if (qr == null) throw StateError('QR eşleştirme bilgisi alınamadı.');
      if (!context.mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Telefonu eşleştir'),
          content: SizedBox(
            width: 360,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  color: Colors.white,
                  padding: const EdgeInsets.all(12),
                  child: QrImageView(data: jsonEncode(qr), size: 240),
                ),
                const SizedBox(height: 16),
                const Text(
                  'Android uygulamasında QR kodu okutun. Ardından beş dakika içinde Telegram doğrulamasını tamamlayın.',
                ),
                const SizedBox(height: 10),
                SelectableText('/pair $code'),
                const SizedBox(height: 8),
                Text(
                  'Son kullanım: ${qr['expiresAt']}',
                  style: const TextStyle(color: Colors.white54, fontSize: 12),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () async {
                await widget.controller.revokePairing();
                if (context.mounted) Navigator.pop(context);
              },
              child: const Text('Eşleştirmeyi iptal et'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Tamam'),
            ),
          ],
        ),
      );
    } catch (value) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(value.toString())));
      }
    }
  }

  Future<void> _showHistory(BuildContext context) async {
    try {
      final value = await widget.controller.history();
      if (!context.mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Son task ve output'),
          content: SizedBox(
            width: 560,
            child: SingleChildScrollView(
              child: SelectableText(
                'TASK\n\n${value['task'] ?? '(bulunamadı)'}\n\nOUTPUT\n\n${value['output'] ?? '(henüz yok)'}',
              ),
            ),
          ),
          actions: [
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Tamam'),
            ),
          ],
        ),
      );
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  Future<void> _showUpdates(BuildContext context) async {
    try {
      final value = await widget.controller.checkUpdates();
      if (!context.mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Güncelleme durumu'),
          content: SelectableText(
            'Durum: ${value['state']}\nKurulu: ${value['currentVersion'] ?? 'bilinmiyor'}\nMevcut: ${value['availableVersion'] ?? 'bilinmiyor'}',
          ),
          actions: [
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Tamam'),
            ),
          ],
        ),
      );
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }
}

class _Sidebar extends StatelessWidget {
  const _Sidebar({required this.controller, required this.data});
  final PocketController controller;
  final Map<String, dynamic> data;
  @override
  Widget build(BuildContext context) {
    final state = data['workspaces'] as Map<String, dynamic>? ?? {};
    final workspaces = (state['recentWorkspaces'] as List? ?? const [])
        .cast<Map>();
    final conversations = (data['conversations'] as List? ?? const [])
        .cast<Map>();
    return Material(
      color: const Color(0xFF15171E),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              Text(
                'Workspaces',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const Spacer(),
              IconButton(
                onPressed: () => _open(context),
                icon: const Icon(Icons.create_new_folder_outlined),
                tooltip: 'Open Project',
              ),
            ],
          ),
          for (final workspace in workspaces)
            ListTile(
              dense: true,
              leading: const Icon(Icons.folder_outlined),
              title: Text('${workspace['displayName']}'),
              subtitle: Text(
                '${workspace['path']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              selected:
                  (state['activeWorkspace'] as Map?)?['path'] ==
                  workspace['path'],
              onTap: () => controller.openWorkspace('${workspace['path']}'),
            ),
          const SizedBox(height: 16),
          Row(
            children: [
              Text(
                'Conversations',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const Spacer(),
              IconButton(
                onPressed: state['activeWorkspace'] == null
                    ? null
                    : () => _newConversation(context),
                icon: const Icon(Icons.add_comment_outlined),
                tooltip: 'Yeni sohbet',
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (conversations.isEmpty)
            const Text(
              'No conversation in this workspace.',
              style: TextStyle(color: Colors.white54),
            ),
          for (final conversation in conversations)
            ListTile(
              dense: true,
              leading: Icon(
                (conversation['status'] as Map?)?['type'] == 'active'
                    ? Icons.bolt
                    : Icons.chat_bubble_outline,
              ),
              title: Text(
                '${conversation['title']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Text(
                '${conversation['preview']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              selected: data['selectedConversationId'] == conversation['id'],
              onTap: () =>
                  controller.selectConversation('${conversation['id']}'),
            ),
        ],
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    if (Platform.isAndroid) {
      await _browseComputer(context);
      return;
    }
    try {
      final value = await getDirectoryPath(confirmButtonText: 'Projeyi Aç');
      if (value != null && value.trim().isNotEmpty) {
        await controller.openWorkspace(value.trim());
      }
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  Future<void> _browseComputer(BuildContext context) async {
    try {
      final rootResult = await controller.workspaceRoots();
      final roots = (rootResult['roots'] as List? ?? const []).cast<Map>();
      if (!context.mounted) return;
      Map<String, dynamic>? page;
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => StatefulBuilder(
          builder: (context, setState) {
            final entries = page == null
                ? roots
                : ((page!['directories'] as List? ?? const []).cast<Map>());
            return AlertDialog(
              title: Text(
                page == null
                    ? 'Bilgisayardan workspace seç'
                    : '${(page!['directory'] as Map?)?['displayName']}',
              ),
              content: SizedBox(
                width: 460,
                height: 420,
                child: Column(
                  children: [
                    if (page != null)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          '${(page!['directory'] as Map?)?['path']}',
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    const SizedBox(height: 8),
                    Expanded(
                      child: ListView(
                        children: [
                          if (page != null && page!['parent'] != null)
                            ListTile(
                              leading: const Icon(Icons.arrow_upward),
                              title: const Text('Üst klasör'),
                              onTap: () async {
                                final next = await controller
                                    .workspaceDirectory('${page!['parent']}');
                                setState(() => page = next);
                              },
                            ),
                          for (final entry in entries)
                            ListTile(
                              leading: const Icon(Icons.folder_outlined),
                              title: Text('${entry['displayName']}'),
                              onTap: () async {
                                final next = await controller
                                    .workspaceDirectory('${entry['path']}');
                                setState(() => page = next);
                              },
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogContext),
                  child: const Text('Vazgeç'),
                ),
                if (page != null)
                  FilledButton(
                    onPressed: () async {
                      await controller.selectBrowsableWorkspace(
                        '${(page!['directory'] as Map)['path']}',
                      );
                      if (dialogContext.mounted) Navigator.pop(dialogContext);
                    },
                    child: const Text('Bu klasörü kullan'),
                  ),
              ],
            );
          },
        ),
      );
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  Future<void> _newConversation(BuildContext context) async {
    final models = (data['models'] as List? ?? const []).cast<Map>();
    if (models.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Kullanılabilir Codex modeli bulunamadı.'),
        ),
      );
      return;
    }
    Map selectedModel = models.firstWhere(
      (model) => model['isDefault'] == true,
      orElse: () => models.first,
    );
    String selectedEffort = _defaultEffort(selectedModel);
    final selected = await showDialog<(String, String)>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) {
          final efforts =
              (selectedModel['supportedReasoningEfforts'] as List? ?? const [])
                  .cast<Map>();
          return AlertDialog(
            title: const Text('Yeni sohbet'),
            content: SizedBox(
              width: 440,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  DropdownButtonFormField<String>(
                    initialValue: '${selectedModel['model']}',
                    decoration: const InputDecoration(labelText: 'Model'),
                    items: [
                      for (final model in models)
                        DropdownMenuItem(
                          value: '${model['model']}',
                          child: Text('${model['displayName']}'),
                        ),
                    ],
                    onChanged: (value) {
                      if (value == null) return;
                      setState(() {
                        selectedModel = models.firstWhere(
                          (model) => model['model'] == value,
                        );
                        selectedEffort = _defaultEffort(selectedModel);
                      });
                    },
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    key: ValueKey('${selectedModel['model']}:$selectedEffort'),
                    initialValue: selectedEffort,
                    decoration: const InputDecoration(
                      labelText: 'Düşünme düzeyi',
                    ),
                    items: [
                      for (final effort in efforts)
                        DropdownMenuItem(
                          value: '${effort['reasoningEffort']}',
                          child: Text(
                            _effortLabel('${effort['reasoningEffort']}'),
                          ),
                        ),
                    ],
                    onChanged: (value) => setState(
                      () => selectedEffort = value ?? selectedEffort,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      efforts
                              .firstWhere(
                                (effort) =>
                                    effort['reasoningEffort'] == selectedEffort,
                                orElse: () => const {},
                              )['description']
                              ?.toString() ??
                          '',
                      style: const TextStyle(
                        color: Colors.white54,
                        fontSize: 12,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Vazgeç'),
              ),
              FilledButton(
                onPressed: efforts.isEmpty
                    ? null
                    : () => Navigator.pop(context, (
                        '${selectedModel['model']}',
                        selectedEffort,
                      )),
                child: const Text('Sohbet oluştur'),
              ),
            ],
          );
        },
      ),
    );
    if (selected == null) return;
    try {
      await controller.createConversation(selected.$1, selected.$2);
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  String _defaultEffort(Map model) {
    final efforts = (model['supportedReasoningEfforts'] as List? ?? const [])
        .cast<Map>();
    final preferred = model['defaultReasoningEffort']?.toString();
    if (preferred != null &&
        efforts.any((effort) => effort['reasoningEffort'] == preferred)) {
      return preferred;
    }
    return efforts.isEmpty ? '' : '${efforts.first['reasoningEffort']}';
  }

  String _effortLabel(String effort) => switch (effort) {
    'none' => 'Yok',
    'minimal' => 'En düşük',
    'low' => 'Düşük',
    'medium' => 'Orta',
    'high' => 'Yüksek',
    'xhigh' => 'Çok yüksek',
    'max' => 'Maksimum',
    'ultra' => 'Ultra',
    _ => effort,
  };
}

class _Conversation extends StatelessWidget {
  const _Conversation({
    required this.controller,
    required this.data,
    required this.prompt,
  });
  final PocketController controller;
  final Map<String, dynamic> data;
  final TextEditingController prompt;
  @override
  Widget build(BuildContext context) {
    final preview = data['preview'] as Map<String, dynamic>?;
    final messages = (preview?['messages'] as List? ?? const []).cast<Map>();
    final approvals = (data['approvals'] as List? ?? const []).cast<Map>();
    final codex = data['codex'] as Map<String, dynamic>?;
    final telegram = data['telegram'] as Map<String, dynamic>?;
    final pairing = data['pairing'] as Map<String, dynamic>?;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: [
              _Pill(
                icon: Icons.computer,
                text: data['pocket'] == 'ready'
                    ? 'Pocket ready'
                    : 'Pocket offline',
              ),
              _Pill(
                icon: Icons.memory,
                text: 'Codex ${codex?['version'] ?? 'offline'}',
              ),
              _Pill(
                icon: Icons.hub_outlined,
                text: '${codex?['topology'] ?? 'disconnected'}',
              ),
              _Pill(
                icon: Icons.send_outlined,
                text: 'Telegram ${telegram?['state'] ?? 'offline'}',
              ),
              _Pill(
                icon: Icons.phone_iphone,
                text: pairing?['state'] == 'paired'
                    ? 'Phone paired'
                    : 'Phone not paired',
              ),
              const _Pill(icon: Icons.language, text: 'Browser unavailable'),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: Card(
              child: SelectionArea(
                child: ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    if (messages.isEmpty && controller.liveText.isEmpty)
                      const Center(
                        child: Padding(
                          padding: EdgeInsets.all(40),
                          child: Text(
                            'Select a conversation to view and control Codex.',
                            style: TextStyle(color: Colors.white54),
                          ),
                        ),
                      ),
                    for (final message in messages)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 18),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              message['role'] == 'user' ? 'YOU' : 'CODEX',
                              style: const TextStyle(
                                fontSize: 11,
                                color: Colors.white54,
                                letterSpacing: 1.4,
                              ),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              '${message['text']}',
                              style: const TextStyle(fontSize: 15, height: 1.5),
                            ),
                          ],
                        ),
                      ),
                    if (controller.liveText.isNotEmpty)
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'CODEX · LIVE',
                            style: TextStyle(
                              fontSize: 11,
                              color: Color(0xFF9D92FF),
                              letterSpacing: 1.4,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            controller.liveText,
                            style: const TextStyle(fontSize: 15, height: 1.5),
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            ),
          ),
          for (final approval in approvals)
            Card(
              color: const Color(0xFF2A231A),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Approval required\n${approval['command'] ?? approval['grantRoot'] ?? approval['reason'] ?? ''}',
                      maxLines: 3,
                    ),
                    const SizedBox(height: 10),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        FilledButton.tonal(
                          onPressed: () =>
                              controller.approval('${approval['id']}', false),
                          child: const Text('Deny'),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: () =>
                              controller.approval('${approval['id']}', true),
                          child: const Text('Approve'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 12),
          LayoutBuilder(
            builder: (context, constraints) {
              final field = TextField(
                controller: prompt,
                minLines: 1,
                maxLines: 5,
                decoration: const InputDecoration(hintText: 'Ask Codex…'),
              );
              final controls = Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton.filledTonal(
                    onPressed: controller.stop,
                    icon: const Icon(Icons.stop),
                    tooltip: 'Stop',
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: () async {
                      final text = prompt.text;
                      if (text.trim().isEmpty) return;
                      await controller.send(text);
                      prompt.clear();
                    },
                    icon: const Icon(Icons.arrow_upward),
                    tooltip: 'Send',
                  ),
                ],
              );
              if (constraints.maxWidth < 520) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    field,
                    const SizedBox(height: 8),
                    Align(alignment: Alignment.centerRight, child: controls),
                  ],
                );
              }
              return Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(child: field),
                  const SizedBox(width: 10),
                  controls,
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    decoration: BoxDecoration(
      color: const Color(0xFF20232D),
      borderRadius: BorderRadius.circular(99),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [Icon(icon, size: 15), const SizedBox(width: 7), Text(text)],
    ),
  );
}

class _Offline extends StatelessWidget {
  const _Offline({required this.message, required this.retry});
  final String message;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Center(
    child: Card(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off, size: 42),
            const SizedBox(height: 16),
            const Text(
              'Pocket is disconnected',
              style: TextStyle(fontSize: 20),
            ),
            const SizedBox(height: 8),
            Text(message, style: const TextStyle(color: Colors.white54)),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: retry,
              icon: const Icon(Icons.refresh),
              label: const Text('Reconnect'),
            ),
          ],
        ),
      ),
    ),
  );
}
