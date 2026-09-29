import 'package:flutter/material.dart';
import 'pocket_bridge.dart';

class MobilePocketScreen extends StatefulWidget {
  const MobilePocketScreen({
    super.key,
    required this.controller,
    required this.onReconnect,
  });

  final PocketController controller;
  final Future<void> Function() onReconnect;

  @override
  State<MobilePocketScreen> createState() => _MobilePocketScreenState();
}

class _MobilePocketScreenState extends State<MobilePocketScreen> {
  final _prompt = TextEditingController();
  int _tab = 0;
  bool _busy = false;

  @override
  void dispose() {
    _prompt.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(_cleanError(error))));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _cleanError(Object error) => error
      .toString()
      .replaceFirst('Bad state: ', '')
      .replaceFirst('StateError: ', '');

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      if (controller.connecting) {
        return const Scaffold(
          body: SafeArea(child: Center(child: CircularProgressIndicator())),
        );
      }
      final data = controller.data;
      if (data == null) {
        return _MobileOffline(
          message: controller.error ?? 'Bilgisayara ulaşılamıyor.',
          reconnect: widget.onReconnect,
        );
      }
      final activeWorkspace =
          (data['workspaces'] as Map?)?['activeWorkspace'] as Map?;
      final selectedConversation = _selectedConversation(data);
      return Scaffold(
        appBar: AppBar(
          titleSpacing: 16,
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(switch (_tab) {
                0 => 'Sohbet',
                1 => 'Projeler',
                _ => 'Kontrol',
              }),
              Text(
                activeWorkspace?['displayName']?.toString() ??
                    activeWorkspace?['path']?.toString().split('/').last ??
                    'Proje seçilmedi',
                style: const TextStyle(fontSize: 12, color: Colors.white54),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
          actions: [
            if (_tab == 0)
              IconButton.filledTonal(
                key: const Key('mobile-new-chat'),
                onPressed: activeWorkspace == null || _busy
                    ? null
                    : () => _newConversation(data),
                icon: const Icon(Icons.add_comment_outlined),
                tooltip: 'Yeni sohbet',
              ),
            IconButton(
              onPressed: _busy ? null : () => _run(widget.controller.refresh),
              icon: const Icon(Icons.refresh),
              tooltip: 'Yenile',
            ),
            const SizedBox(width: 6),
          ],
        ),
        body: SafeArea(
          top: false,
          child: Column(
            children: [
              if (controller.error != null)
                _ConnectionWarning(
                  message: controller.error!,
                  reconnect: widget.onReconnect,
                ),
              if (_busy) const LinearProgressIndicator(minHeight: 2),
              Expanded(
                child: IndexedStack(
                  index: _tab,
                  children: [
                    _ChatPage(
                      controller: controller,
                      data: data,
                      selectedConversation: selectedConversation,
                      prompt: _prompt,
                      busy: _busy,
                      selectConversation: (id) =>
                          _run(() => controller.selectConversation(id)),
                      newConversation: () => _newConversation(data),
                      send: () => _send(),
                      stop: () => _run(controller.stop),
                      decide: (id, approve) =>
                          _run(() => controller.approval(id, approve)),
                    ),
                    _ProjectsPage(
                      controller: controller,
                      data: data,
                      busy: _busy,
                      browse: () => _browseComputer(),
                      openWorkspace: (path) =>
                          _run(() => controller.openWorkspace(path)),
                      selectConversation: (id) async {
                        await _run(() => controller.selectConversation(id));
                        if (mounted) setState(() => _tab = 0);
                      },
                    ),
                    _ControlPage(
                      data: data,
                      busy: _busy,
                      showHistory: _showHistory,
                      showUpdates: _showUpdates,
                      stop: () => _run(controller.stop),
                      refresh: () => _run(controller.refresh),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (value) => setState(() => _tab = value),
          destinations: const [
            NavigationDestination(
              icon: Icon(Icons.chat_bubble_outline),
              selectedIcon: Icon(Icons.chat_bubble),
              label: 'Sohbet',
            ),
            NavigationDestination(
              icon: Icon(Icons.folder_outlined),
              selectedIcon: Icon(Icons.folder),
              label: 'Projeler',
            ),
            NavigationDestination(
              icon: Icon(Icons.tune_outlined),
              selectedIcon: Icon(Icons.tune),
              label: 'Kontrol',
            ),
          ],
        ),
      );
    },
  );

  Map? _selectedConversation(Map<String, dynamic> data) {
    final selected = data['selectedConversationId']?.toString();
    for (final value in (data['conversations'] as List? ?? const [])) {
      if (value is Map && value['id']?.toString() == selected) return value;
    }
    return null;
  }

  Future<void> _send() async {
    final text = _prompt.text.trim();
    if (text.isEmpty) return;
    await _run(() async {
      await widget.controller.send(text);
      _prompt.clear();
    });
  }

  Future<void> _newConversation(Map<String, dynamic> data) async {
    final models = (data['models'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    if (models.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Kullanılabilir Codex modeli yok.')),
      );
      return;
    }
    Map model = models.firstWhere(
      (entry) => entry['isDefault'] == true,
      orElse: () => models.first,
    );
    String effort = _defaultEffort(model);
    final selection = await showModalBottomSheet<(String, String)>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setSheetState) {
          final efforts =
              (model['supportedReasoningEfforts'] as List? ?? const [])
                  .whereType<Map>()
                  .toList();
          return Padding(
            padding: EdgeInsets.fromLTRB(
              20,
              4,
              20,
              24 + MediaQuery.viewInsetsOf(context).bottom,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Yeni sohbet',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 6),
                const Text(
                  'Bu proje için model ve düşünme düzeyini seçin.',
                  style: TextStyle(color: Colors.white60),
                ),
                const SizedBox(height: 20),
                DropdownButtonFormField<String>(
                  key: const Key('mobile-model'),
                  initialValue: model['model']?.toString(),
                  decoration: const InputDecoration(
                    labelText: 'Model',
                    prefixIcon: Icon(Icons.psychology_outlined),
                  ),
                  items: [
                    for (final entry in models)
                      DropdownMenuItem(
                        value: entry['model']?.toString(),
                        child: Text(
                          entry['displayName']?.toString() ??
                              entry['model']?.toString() ??
                              'Model',
                        ),
                      ),
                  ],
                  onChanged: (value) {
                    if (value == null) return;
                    setSheetState(() {
                      model = models.firstWhere(
                        (entry) => entry['model']?.toString() == value,
                      );
                      effort = _defaultEffort(model);
                    });
                  },
                ),
                const SizedBox(height: 14),
                DropdownButtonFormField<String>(
                  key: ValueKey('mobile-effort-${model['model']}-$effort'),
                  initialValue: effort.isEmpty ? null : effort,
                  decoration: const InputDecoration(
                    labelText: 'Düşünme düzeyi',
                    prefixIcon: Icon(Icons.speed_outlined),
                  ),
                  items: [
                    for (final entry in efforts)
                      DropdownMenuItem(
                        value: entry['reasoningEffort']?.toString(),
                        child: Text(
                          _effortLabel('${entry['reasoningEffort']}'),
                        ),
                      ),
                  ],
                  onChanged: (value) =>
                      setSheetState(() => effort = value ?? effort),
                ),
                const SizedBox(height: 8),
                Text(
                  efforts
                          .where((entry) => entry['reasoningEffort'] == effort)
                          .firstOrNull?['description']
                          ?.toString() ??
                      '',
                  style: const TextStyle(color: Colors.white54, fontSize: 12),
                ),
                const SizedBox(height: 22),
                FilledButton.icon(
                  key: const Key('mobile-create-chat'),
                  onPressed: effort.isEmpty
                      ? null
                      : () => Navigator.pop(context, (
                          '${model['model']}',
                          effort,
                        )),
                  icon: const Icon(Icons.add_comment_outlined),
                  label: const Text('Sohbeti oluştur'),
                ),
              ],
            ),
          );
        },
      ),
    );
    if (selection == null) return;
    await _run(
      () => widget.controller.createConversation(selection.$1, selection.$2),
    );
  }

  String _defaultEffort(Map model) {
    final efforts = (model['supportedReasoningEfforts'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final preferred = model['defaultReasoningEffort']?.toString();
    if (preferred != null &&
        efforts.any((entry) => entry['reasoningEffort'] == preferred)) {
      return preferred;
    }
    return efforts.isEmpty ? '' : '${efforts.first['reasoningEffort']}';
  }

  Future<void> _browseComputer() async {
    try {
      final rootsResult = await widget.controller.workspaceRoots();
      final roots = (rootsResult['roots'] as List? ?? const [])
          .whereType<Map>()
          .toList();
      if (!mounted) return;
      Map<String, dynamic>? page;
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (sheetContext) => StatefulBuilder(
          builder: (context, setSheetState) {
            final entries = page == null
                ? roots
                : (page!['directories'] as List? ?? const [])
                      .whereType<Map>()
                      .toList();
            final directory = page?['directory'] as Map?;
            return SizedBox(
              height: MediaQuery.sizeOf(context).height * .78,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          page == null
                              ? 'Bilgisayardan proje seç'
                              : directory?['displayName']?.toString() ??
                                    'Klasör',
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        if (directory?['path'] != null)
                          Text(
                            '${directory!['path']}',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Colors.white54),
                          ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: ListView(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      children: [
                        if (page != null && page!['parent'] != null)
                          ListTile(
                            leading: const Icon(Icons.arrow_upward),
                            title: const Text('Üst klasör'),
                            onTap: () async {
                              final next = await widget.controller
                                  .workspaceDirectory('${page!['parent']}');
                              setSheetState(() => page = next);
                            },
                          ),
                        for (final entry in entries)
                          ListTile(
                            leading: const Icon(Icons.folder_outlined),
                            title: Text('${entry['displayName']}'),
                            subtitle: page == null
                                ? Text(
                                    '${entry['path']}',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  )
                                : null,
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () async {
                              final next = await widget.controller
                                  .workspaceDirectory('${entry['path']}');
                              setSheetState(() => page = next);
                            },
                          ),
                      ],
                    ),
                  ),
                  if (directory?['path'] != null)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 10, 20, 24),
                      child: FilledButton.icon(
                        onPressed: () async {
                          await widget.controller.selectBrowsableWorkspace(
                            '${directory!['path']}',
                          );
                          if (sheetContext.mounted) Navigator.pop(sheetContext);
                        },
                        icon: const Icon(Icons.folder_open),
                        label: const Text('Bu klasörü aç'),
                      ),
                    ),
                ],
              ),
            );
          },
        ),
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(_cleanError(error))));
      }
    }
  }

  Future<void> _showHistory() async {
    await _run(() async {
      final value = await widget.controller.history();
      if (!mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (context) => SizedBox(
          height: MediaQuery.sizeOf(context).height * .82,
          child: SelectionArea(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 30),
              children: [
                Text(
                  'Son görev',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 16),
                const _SectionLabel('SİZ'),
                const SizedBox(height: 6),
                Text(value['task']?.toString() ?? 'Görev bulunamadı.'),
                const SizedBox(height: 24),
                const _SectionLabel('CODEX'),
                const SizedBox(height: 6),
                Text(
                  value['output']?.toString() ?? 'Henüz çıktı yok.',
                  style: const TextStyle(height: 1.5),
                ),
              ],
            ),
          ),
        ),
      );
    });
  }

  Future<void> _showUpdates() async {
    await _run(() async {
      final value = await widget.controller.checkUpdates();
      if (!mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (context) => Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 30),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Güncelleme durumu',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 18),
              _DetailRow(
                label: 'Durum',
                value: '${value['state'] ?? 'bilinmiyor'}',
              ),
              _DetailRow(
                label: 'Kurulu',
                value: '${value['currentVersion'] ?? 'bilinmiyor'}',
              ),
              _DetailRow(
                label: 'Mevcut',
                value: '${value['availableVersion'] ?? 'bilinmiyor'}',
              ),
            ],
          ),
        ),
      );
    });
  }
}

class _ChatPage extends StatelessWidget {
  const _ChatPage({
    required this.controller,
    required this.data,
    required this.selectedConversation,
    required this.prompt,
    required this.busy,
    required this.selectConversation,
    required this.newConversation,
    required this.send,
    required this.stop,
    required this.decide,
  });

  final PocketController controller;
  final Map<String, dynamic> data;
  final Map? selectedConversation;
  final TextEditingController prompt;
  final bool busy;
  final Future<void> Function(String id) selectConversation;
  final VoidCallback newConversation;
  final VoidCallback send;
  final VoidCallback stop;
  final void Function(String id, bool approve) decide;

  @override
  Widget build(BuildContext context) {
    final conversations = (data['conversations'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final preview = data['preview'] as Map?;
    final messages = (preview?['messages'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final approvals = (data['approvals'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final hasWorkspace =
        (data['workspaces'] as Map?)?['activeWorkspace'] != null;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
          child: conversations.isEmpty
              ? _EmptyConversationHeader(
                  enabled: hasWorkspace && !busy,
                  create: newConversation,
                )
              : DropdownButtonFormField<String>(
                  key: ValueKey(data['selectedConversationId']),
                  initialValue: selectedConversation?['id']?.toString(),
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Aktif sohbet',
                    prefixIcon: Icon(Icons.forum_outlined),
                    contentPadding: EdgeInsets.symmetric(horizontal: 12),
                  ),
                  items: [
                    for (final conversation in conversations)
                      DropdownMenuItem(
                        value: '${conversation['id']}',
                        child: Text(
                          conversation['title']?.toString() ?? 'Sohbet',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: busy
                      ? null
                      : (value) {
                          if (value != null) selectConversation(value);
                        },
                ),
        ),
        Expanded(
          child: messages.isEmpty && controller.liveText.isEmpty
              ? _ChatEmpty(
                  hasWorkspace: hasWorkspace,
                  hasConversation: selectedConversation != null,
                  create: newConversation,
                )
              : SelectionArea(
                  child: ListView(
                    key: const Key('mobile-message-list'),
                    padding: const EdgeInsets.fromLTRB(14, 8, 14, 20),
                    children: [
                      for (final message in messages)
                        _MessageBubble(
                          role: message['role']?.toString() ?? 'assistant',
                          text: message['text']?.toString() ?? '',
                        ),
                      if (controller.liveText.isNotEmpty)
                        _MessageBubble(role: 'live', text: controller.liveText),
                    ],
                  ),
                ),
        ),
        for (final approval in approvals)
          _ApprovalCard(approval: approval, busy: busy, decide: decide),
        _Composer(
          controller: prompt,
          enabled: selectedConversation != null && !busy,
          send: send,
          stop: stop,
        ),
      ],
    );
  }
}

class _ProjectsPage extends StatelessWidget {
  const _ProjectsPage({
    required this.controller,
    required this.data,
    required this.busy,
    required this.browse,
    required this.openWorkspace,
    required this.selectConversation,
  });

  final PocketController controller;
  final Map<String, dynamic> data;
  final bool busy;
  final VoidCallback browse;
  final Future<void> Function(String path) openWorkspace;
  final Future<void> Function(String id) selectConversation;

  @override
  Widget build(BuildContext context) {
    final workspaceState = data['workspaces'] as Map? ?? const {};
    final activePath = (workspaceState['activeWorkspace'] as Map?)?['path'];
    final workspaces = (workspaceState['recentWorkspaces'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final conversations = (data['conversations'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 30),
      children: [
        FilledButton.icon(
          key: const Key('mobile-browse-projects'),
          onPressed: busy ? null : browse,
          icon: const Icon(Icons.folder_open),
          label: const Text('Bilgisayardan proje seç'),
        ),
        const SizedBox(height: 24),
        const _SectionLabel('PROJELER'),
        const SizedBox(height: 8),
        if (workspaces.isEmpty)
          const _EmptyCard(text: 'Henüz açılmış bir proje yok.'),
        for (final workspace in workspaces)
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: ListTile(
              selected: workspace['path'] == activePath,
              leading: Icon(
                workspace['path'] == activePath
                    ? Icons.folder
                    : Icons.folder_outlined,
              ),
              title: Text('${workspace['displayName']}'),
              subtitle: Text(
                '${workspace['path']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              trailing: workspace['path'] == activePath
                  ? const Icon(Icons.check_circle, color: Color(0xFF8D80FF))
                  : const Icon(Icons.chevron_right),
              onTap: busy ? null : () => openWorkspace('${workspace['path']}'),
            ),
          ),
        const SizedBox(height: 22),
        const _SectionLabel('BU PROJEDEKİ SOHBETLER'),
        const SizedBox(height: 8),
        if (conversations.isEmpty)
          const _EmptyCard(
            text: 'Sohbet yok. Sohbet ekranındaki + düğmesiyle oluşturun.',
          ),
        for (final conversation in conversations)
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: ListTile(
              leading: Icon(
                (conversation['status'] as Map?)?['type'] == 'active'
                    ? Icons.bolt
                    : Icons.chat_bubble_outline,
              ),
              title: Text(
                conversation['title']?.toString() ?? 'Sohbet',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Text(
                conversation['preview']?.toString() ?? '',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: busy
                  ? null
                  : () => selectConversation('${conversation['id']}'),
            ),
          ),
      ],
    );
  }
}

class _ControlPage extends StatelessWidget {
  const _ControlPage({
    required this.data,
    required this.busy,
    required this.showHistory,
    required this.showUpdates,
    required this.stop,
    required this.refresh,
  });

  final Map<String, dynamic> data;
  final bool busy;
  final VoidCallback showHistory;
  final VoidCallback showUpdates;
  final VoidCallback stop;
  final VoidCallback refresh;

  @override
  Widget build(BuildContext context) {
    final codex = data['codex'] as Map?;
    final telegram = data['telegram'] as Map?;
    final pairing = data['pairing'] as Map?;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 30),
      children: [
        Row(
          children: [
            Expanded(
              child: _StatusCard(
                icon: Icons.computer,
                label: 'Pocket',
                value: data['pocket'] == 'ready' ? 'Bağlı' : 'Çevrimdışı',
                healthy: data['pocket'] == 'ready',
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _StatusCard(
                icon: Icons.send_outlined,
                label: 'Telegram',
                value: telegram?['state'] == 'ready'
                    ? 'Bağlı'
                    : '${telegram?['state'] ?? 'Kapalı'}',
                healthy: telegram?['state'] == 'ready',
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _StatusCard(
                icon: Icons.memory,
                label: 'Codex',
                value: codex?['version']?.toString() ?? 'Çevrimdışı',
                healthy: codex?['version'] != null,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _StatusCard(
                icon: Icons.phone_android,
                label: 'Telefon',
                value: pairing?['state'] == 'paired'
                    ? 'Eşleşti'
                    : '${pairing?['state'] ?? 'Bekliyor'}',
                healthy: pairing?['state'] == 'paired',
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),
        const _SectionLabel('HIZLI İŞLEMLER'),
        const SizedBox(height: 8),
        _ActionTile(
          icon: Icons.history,
          title: 'Son görev ve çıktı',
          subtitle: 'Telegram /history karşılığı',
          onTap: busy ? null : showHistory,
        ),
        _ActionTile(
          icon: Icons.system_update_alt,
          title: 'Güncellemeleri denetle',
          subtitle: 'Salt okunur sürüm kontrolü',
          onTap: busy ? null : showUpdates,
        ),
        _ActionTile(
          icon: Icons.stop_circle_outlined,
          title: 'Aktif görevi durdur',
          subtitle: 'Telegram /stop karşılığı',
          destructive: true,
          onTap: busy ? null : stop,
        ),
        _ActionTile(
          icon: Icons.refresh,
          title: 'Durumu yenile',
          subtitle: 'Bilgisayar ve runtime bilgisini tekrar al',
          onTap: busy ? null : refresh,
        ),
        const SizedBox(height: 24),
        const _SectionLabel('TARAYICI'),
        const SizedBox(height: 8),
        const Card(
          child: ListTile(
            enabled: false,
            leading: Icon(Icons.image_not_supported_outlined),
            title: Text('Ekran görüntüsü kullanılamıyor'),
            subtitle: Text(
              'Windows Browser Gate 2 ve production BrowserManager tamamlandığında açılacak.',
            ),
          ),
        ),
      ],
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.role, required this.text});
  final String role;
  final String text;

  @override
  Widget build(BuildContext context) {
    final user = role == 'user';
    final live = role == 'live';
    return Align(
      alignment: user ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * .88,
        ),
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: user
              ? const Color(0xFF5145A7)
              : live
              ? const Color(0xFF242039)
              : const Color(0xFF1B1D25),
          borderRadius: BorderRadius.circular(18).copyWith(
            bottomRight: user ? const Radius.circular(4) : null,
            bottomLeft: user ? null : const Radius.circular(4),
          ),
          border: live ? Border.all(color: const Color(0xFF6E61D9)) : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              user
                  ? 'SİZ'
                  : live
                  ? 'CODEX · CANLI'
                  : 'CODEX',
              style: TextStyle(
                fontSize: 10,
                letterSpacing: 1.2,
                fontWeight: FontWeight.w700,
                color: user ? Colors.white70 : const Color(0xFFA89FFF),
              ),
            ),
            const SizedBox(height: 6),
            Text(text, style: const TextStyle(fontSize: 15, height: 1.5)),
          ],
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.enabled,
    required this.send,
    required this.stop,
  });
  final TextEditingController controller;
  final bool enabled;
  final VoidCallback send;
  final VoidCallback stop;

  @override
  Widget build(BuildContext context) => Material(
    color: const Color(0xFF15171E),
    child: Padding(
      padding: EdgeInsets.fromLTRB(
        12,
        10,
        12,
        10 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          IconButton.filledTonal(
            key: const Key('mobile-stop'),
            onPressed: enabled ? stop : null,
            icon: const Icon(Icons.stop_rounded),
            tooltip: 'Durdur',
          ),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              key: const Key('mobile-prompt'),
              controller: controller,
              enabled: enabled,
              minLines: 1,
              maxLines: 5,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                hintText: enabled
                    ? 'Codex’e bir görev yazın…'
                    : 'Önce bir sohbet seçin',
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          IconButton.filled(
            key: const Key('mobile-send'),
            onPressed: enabled ? send : null,
            icon: const Icon(Icons.arrow_upward_rounded),
            tooltip: 'Gönder',
          ),
        ],
      ),
    ),
  );
}

class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({
    required this.approval,
    required this.busy,
    required this.decide,
  });
  final Map approval;
  final bool busy;
  final void Function(String id, bool approve) decide;

  @override
  Widget build(BuildContext context) => Card(
    color: const Color(0xFF322617),
    margin: const EdgeInsets.fromLTRB(12, 4, 12, 8),
    child: Padding(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Row(
            children: [
              Icon(Icons.shield_outlined, color: Color(0xFFFFBE68)),
              SizedBox(width: 8),
              Text(
                'Onayınız gerekiyor',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '${approval['command'] ?? approval['grantRoot'] ?? approval['reason'] ?? 'Codex bir işlem için izin istiyor.'}',
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton.tonal(
                  onPressed: busy
                      ? null
                      : () => decide('${approval['id']}', false),
                  child: const Text('Reddet'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton(
                  onPressed: busy
                      ? null
                      : () => decide('${approval['id']}', true),
                  child: const Text('Onayla'),
                ),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}

class _EmptyConversationHeader extends StatelessWidget {
  const _EmptyConversationHeader({required this.enabled, required this.create});
  final bool enabled;
  final VoidCallback create;
  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          const Expanded(child: Text('Bu projede henüz sohbet yok.')),
          FilledButton.tonalIcon(
            onPressed: enabled ? create : null,
            icon: const Icon(Icons.add),
            label: const Text('Yeni'),
          ),
        ],
      ),
    ),
  );
}

class _ChatEmpty extends StatelessWidget {
  const _ChatEmpty({
    required this.hasWorkspace,
    required this.hasConversation,
    required this.create,
  });
  final bool hasWorkspace;
  final bool hasConversation;
  final VoidCallback create;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            hasWorkspace ? Icons.chat_bubble_outline : Icons.folder_open,
            size: 52,
            color: Colors.white30,
          ),
          const SizedBox(height: 16),
          Text(
            hasWorkspace
                ? hasConversation
                      ? 'Mesajınızı yazıp Codex’i çalıştırın.'
                      : 'Yeni bir sohbet oluşturun.'
                : 'Projeler bölümünden bir workspace seçin.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white60),
          ),
          if (hasWorkspace && !hasConversation) ...[
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: create,
              icon: const Icon(Icons.add_comment_outlined),
              label: const Text('Yeni sohbet'),
            ),
          ],
        ],
      ),
    ),
  );
}

class _ConnectionWarning extends StatelessWidget {
  const _ConnectionWarning({required this.message, required this.reconnect});
  final String message;
  final Future<void> Function() reconnect;
  @override
  Widget build(BuildContext context) => Material(
    color: const Color(0xFF5A3518),
    child: ListTile(
      dense: true,
      leading: const Icon(Icons.cloud_off_outlined),
      title: const Text('Bilgisayar bağlantısı kesildi'),
      subtitle: Text(message, maxLines: 1, overflow: TextOverflow.ellipsis),
      trailing: TextButton(onPressed: reconnect, child: const Text('Bağlan')),
    ),
  );
}

class _MobileOffline extends StatelessWidget {
  const _MobileOffline({required this.message, required this.reconnect});
  final String message;
  final Future<void> Function() reconnect;
  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.cloud_off_outlined,
                size: 58,
                color: Colors.white38,
              ),
              const SizedBox(height: 18),
              Text(
                'Bilgisayar çevrimdışı',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 8),
              Text(
                message,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white60),
              ),
              const SizedBox(height: 22),
              FilledButton.icon(
                onPressed: reconnect,
                icon: const Icon(Icons.refresh),
                label: const Text('Yeniden bağlan'),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({
    required this.icon,
    required this.label,
    required this.value,
    required this.healthy,
  });
  final IconData icon;
  final String label;
  final String value;
  final bool healthy;
  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 20),
              const Spacer(),
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: healthy
                      ? const Color(0xFF65E5A3)
                      : Colors.orangeAccent,
                  shape: BoxShape.circle,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            label,
            style: const TextStyle(color: Colors.white54, fontSize: 12),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
        ],
      ),
    ),
  );
}

class _ActionTile extends StatelessWidget {
  const _ActionTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.destructive = false,
  });
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;
  final bool destructive;
  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 8),
    child: ListTile(
      leading: Icon(icon, color: destructive ? Colors.redAccent : null),
      title: Text(title),
      subtitle: Text(subtitle),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    ),
  );
}

class _EmptyCard extends StatelessWidget {
  const _EmptyCard({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(18),
      child: Text(text, style: const TextStyle(color: Colors.white54)),
    ),
  );
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Text(
    text,
    style: const TextStyle(
      fontSize: 11,
      fontWeight: FontWeight.w700,
      letterSpacing: 1.4,
      color: Colors.white54,
    ),
  );
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 7),
    child: Row(
      children: [
        Expanded(
          child: Text(label, style: const TextStyle(color: Colors.white54)),
        ),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );
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
