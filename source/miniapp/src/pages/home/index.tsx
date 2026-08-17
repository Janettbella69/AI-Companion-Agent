import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Image,
  Input,
  ScrollView,
  Switch,
  Text,
  View,
} from '@ray-js/ray';
import { useDevInfo } from '@ray-js/panel-sdk';

import {
  AgentApi,
  type AgentConnection,
  type AvatarJob,
  type ConsentScope,
  type MemoryRecord,
  readFileBase64,
  validateConnection,
} from '@/services/agentApi';
import styles from './index.module.less';

type Tab = 'chat' | 'memory' | 'avatar' | 'settings';
type Message = {
  id: string;
  role: 'user' | 'robot' | 'system';
  text: string;
  meta?: string;
};

const SETTINGS_KEY = 'hshh-agent-connection-v1';
const EXPRESSIONS: Record<string, string> = {
  idle: '˶ᵔ ᵕ ᵔ˶',
  noticed: '◉ ᴥ ◉',
  listening: '• ᴥ •',
  thinking: '◌ ᴥ ◌',
  happy: '˃ ᴥ ˂',
  confused: '・ ᴥ ・?',
  sad: '╥ ᴥ ╥',
  sleeping: '− ᴥ − z',
  angry: 'ಠ ᴥ ಠ',
};

const INITIAL_MESSAGES: Message[] = [
  {
    id: 'hello',
    role: 'robot',
    text: '我在这里。想说话、安静待着，或者让我靠近一点都可以。',
    meta: 'HSHH · 安全陪伴模式',
  },
];

function messageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    authentication_not_configured: 'Agent 尚未配置用户认证',
    unauthorized: '联调会话令牌不正确或已失效',
    device_context_required: '机器人还没有上报设备状态',
    motion_adapter_unavailable: '运动控制器未连接；停止意图已记录',
    avatar_pack_integrity_failed: '资源包完整性校验失败，已保留基础形象',
    avatar_deployment_not_requested: '请先确认把该形象部署到机器人',
  };
  return known[value] || value || '请求失败';
}

function toast(title: string): void {
  ty.showToast({ title, icon: 'none', duration: 2200 });
}

function inferMime(base64: string): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return undefined;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export default function Home() {
  const devInfo = useDevInfo() as any;
  const detectedDeviceId = String(devInfo?.devId || devInfo?.deviceId || devInfo?.id || 'hshh-robot-01');
  const [tab, setTab] = useState<Tab>('chat');
  const [connection, setConnection] = useState<AgentConnection>({
    baseUrl: 'http://192.168.1.10:8787',
    userToken: '',
    userId: 'demo-user',
    deviceId: detectedDeviceId,
  });
  const [configured, setConfigured] = useState(false);
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [draft, setDraft] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [expression, setExpression] = useState('idle');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const voiceManager = useRef<any>();
  const voiceListener = useRef<(event: { body: string }) => void>();

  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string>();
  const [memoryDraft, setMemoryDraft] = useState('');

  const [petId, setPetId] = useState('my-pet');
  const [petType, setPetType] = useState<'cat' | 'dog'>('cat');
  const [petTraits, setPetTraits] = useState('主要毛色、花纹、耳朵形状');
  const [selectedPhoto, setSelectedPhoto] = useState('');
  const [avatarBase64, setAvatarBase64] = useState('');
  const [avatarMime, setAvatarMime] = useState<'image/jpeg' | 'image/png' | 'image/webp'>();
  const [avatarJob, setAvatarJob] = useState<AvatarJob>();
  const [avatarBusy, setAvatarBusy] = useState(false);

  const api = useMemo(() => {
    try {
      return configured ? new AgentApi(connection) : undefined;
    } catch {
      return undefined;
    }
  }, [configured, connection]);

  useEffect(() => {
    ty.getStorage({
      key: SETTINGS_KEY,
      success: result => {
        if (!result.data) return;
        try {
          const stored = JSON.parse(result.data) as Partial<AgentConnection>;
          setConnection(current => ({
            ...current,
            baseUrl: stored.baseUrl || current.baseUrl,
            userId: stored.userId || current.userId,
            deviceId: stored.deviceId || detectedDeviceId,
            // Long-lived credentials are deliberately never persisted here.
            userToken: '',
          }));
        } catch {
          // Ignore malformed local preferences and keep safe defaults.
        }
      },
    });
  }, [detectedDeviceId]);

  useEffect(() => {
    if (tab === 'memory' && api) void loadMemories(api);
  }, [tab, api]);

  useEffect(() => {
    return () => {
      if (voiceManager.current && voiceListener.current) {
        voiceManager.current.offAudioRgbChange?.(voiceListener.current);
      }
      voiceManager.current?.stopRGBRecord?.({});
    };
  }, []);

  async function loadMemories(client: AgentApi = api as AgentApi): Promise<void> {
    if (!client) return;
    setMemoryLoading(true);
    try {
      const result = await client.getMemories();
      setMemories(result.memories);
      setMemoryEnabled(result.settings.enabled);
    } catch (error) {
      toast(errorText(error));
    } finally {
      setMemoryLoading(false);
    }
  }

  function appendMessage(message: Omit<Message, 'id'>): void {
    setMessages(current => [...current, { ...message, id: messageId(message.role) }]);
  }

  async function sendText(text = draft): Promise<void> {
    const normalized = text.trim();
    if (!normalized || busy) return;
    if (!api) {
      setTab('settings');
      toast('请先连接 Agent');
      return;
    }
    setDraft('');
    setBusy(true);
    setExpression('thinking');
    appendMessage({ role: 'user', text: normalized });
    try {
      const result = await api.interact(normalized, sessionId);
      if (result.session_id) setSessionId(result.session_id);
      setExpression(result.decision.expression || 'idle');
      appendMessage({
        role: 'robot',
        text: result.decision.reply_text,
        meta: `${result.mode === 'claude' ? 'Claude Agent' : '安全降级'} · 情绪线索 ${result.decision.emotion.state}`,
      });
    } catch (error) {
      setExpression('confused');
      appendMessage({ role: 'system', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function submitConsent(scope: ConsentScope): Promise<void> {
    if (!api || busy) {
      if (!api) setTab('settings');
      return;
    }
    const phrase = scope === 'approach_short' ? '可以，靠近一点。' : '可以邀请我抱抱。';
    setBusy(true);
    try {
      await api.feedback('accept', { scope, detail: phrase });
      setBusy(false);
      await sendText(phrase);
    } catch (error) {
      setBusy(false);
      toast(errorText(error));
    }
  }

  async function rejectInvitation(): Promise<void> {
    if (!api || busy) return;
    setBusy(true);
    try {
      await api.feedback('reject', { detail: '不用了。' });
      appendMessage({ role: 'user', text: '不用了。' });
      appendMessage({ role: 'robot', text: '好，我停在这里。', meta: '本轮不再邀请' });
      setExpression('idle');
    } catch (error) {
      toast(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function emergencyStop(): Promise<void> {
    if (!api) {
      setTab('settings');
      toast('请先连接 Agent');
      return;
    }
    try {
      const result = await api.feedback('stop', { detail: '停下。' });
      const status = result?.motion_stop?.status;
      appendMessage({
        role: 'system',
        text: status === 'stopped' || status === 'completed' ? '停止命令已执行。' : '停止意图已送达；请同时按实体按钮确认。',
      });
      setExpression('confused');
    } catch (error) {
      appendMessage({ role: 'system', text: `网络停止失败：${errorText(error)}。请立即按实体停止按钮。` });
    }
  }

  function startVoice(): void {
    const media = (ty as any).media;
    if (!media?.getRGBAudioManager) {
      toast('当前环境不支持语音识别，请使用文字输入');
      return;
    }
    if (!voiceManager.current) {
      voiceManager.current = media.getRGBAudioManager({ interval: 450 });
      voiceListener.current = event => {
        if (event?.body) setDraft(event.body.trim());
      };
      voiceManager.current.onAudioRgbChange?.(voiceListener.current);
    }
    voiceManager.current.startRGBRecord({
      interval: 450,
      success: () => {
        setRecording(true);
        setExpression('listening');
      },
      fail: (error: any) => toast(error?.errorMsg || '无法启动语音识别'),
    });
  }

  function stopVoice(): void {
    voiceManager.current?.stopRGBRecord({
      success: () => {
        setRecording(false);
        setExpression('idle');
      },
    });
  }

  async function saveConnection(): Promise<void> {
    try {
      const valid = validateConnection(connection);
      const candidate = new AgentApi(valid);
      await candidate.getMemories();
      setConnection(valid);
      setConfigured(true);
      ty.setStorage({
        key: SETTINGS_KEY,
        data: JSON.stringify({
          baseUrl: valid.baseUrl,
          userId: valid.userId,
          deviceId: valid.deviceId,
        }),
      });
      toast('Agent 已连接');
      setTab('chat');
    } catch (error) {
      setConfigured(false);
      toast(errorText(error));
    }
  }

  async function toggleMemory(enabled: boolean): Promise<void> {
    if (!api) return;
    try {
      const result = await api.setMemoryEnabled(enabled);
      setMemoryEnabled(result.enabled);
      if (!enabled) setMemories([]);
      else await loadMemories(api);
    } catch (error) {
      toast(errorText(error));
    }
  }

  async function saveMemory(memory: MemoryRecord): Promise<void> {
    if (!api || !memoryDraft.trim()) return;
    try {
      await api.updateMemory(memory.id, { summary: memoryDraft.trim() });
      await api.feedback('correction', { detail: `请将记忆改为：${memoryDraft.trim()}` });
      setEditingMemoryId(undefined);
      setMemoryDraft('');
      await loadMemories(api);
    } catch (error) {
      toast(errorText(error));
    }
  }

  async function confirmMemory(memory: MemoryRecord): Promise<void> {
    if (!api) return;
    try {
      await api.updateMemory(memory.id, { confirmed: true });
      await loadMemories(api);
    } catch (error) {
      toast(errorText(error));
    }
  }

  function startNewSession(): void {
    setSessionId(undefined);
    appendMessage({
      role: 'system',
      text: '下一条消息会开启新会话；已确认的长期记忆仍可被取回。',
    });
  }

  function confirmDeleteMemory(memory: MemoryRecord): void {
    if (!api) return;
    ty.showModal({
      title: '删除这条记忆？',
      content: memory.summary,
      confirmText: '删除',
      confirmColor: '#d93f46',
      success: async result => {
        if (!result.confirm) return;
        try {
          await api.deleteMemory(memory.id);
          await loadMemories(api);
        } catch (error) {
          toast(errorText(error));
        }
      },
    });
  }

  function choosePetPhoto(): void {
    ty.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: async result => {
        const path = result.tempFilePaths[0] || result.tempFiles?.[0]?.path;
        const size = result.tempFiles?.[0]?.size;
        if (!path) return;
        if (typeof size === 'number' && size > 8 * 1024 * 1024) {
          toast('图片不能超过 8 MB');
          return;
        }
        try {
          const base64 = await readFileBase64(path);
          const mime = inferMime(base64);
          if (!mime) throw new Error('只支持 JPEG、PNG 或 WebP');
          setSelectedPhoto(path);
          setAvatarBase64(base64);
          setAvatarMime(mime);
          setAvatarJob(undefined);
        } catch (error) {
          toast(errorText(error));
        }
      },
    });
  }

  async function pollAvatar(jobId: string, attempts: number): Promise<AvatarJob> {
    if (!api) throw new Error('Agent 未连接');
    let latest: AvatarJob | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await api.getAvatarJob(jobId);
      setAvatarJob(latest);
      if (latest.status !== 'pending' && latest.status !== 'deploying') return latest;
      await wait(1200);
    }
    return latest || { job_id: jobId, status: 'failed', reason_code: 'timeout' };
  }

  async function createAvatar(): Promise<void> {
    if (!api) {
      setTab('settings');
      return;
    }
    if (!avatarBase64 || !avatarMime) {
      toast('请先选择一张宠物照片');
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,80}$/u.test(petId.trim())) {
      toast('宠物 ID 仅支持字母、数字、横线和下划线');
      return;
    }
    const traits = petTraits.split(/[，,、]/u).map(item => item.trim()).filter(Boolean).slice(0, 12);
    if (!traits.length) {
      toast('请填写至少一个可见特征');
      return;
    }
    setAvatarBusy(true);
    try {
      const created = await api.createAvatar({
        petId: petId.trim(),
        petType,
        visibleTraits: traits,
        mimeType: avatarMime,
        imageBase64: avatarBase64,
      });
      // Drop the original bytes as soon as the backend accepts the job.
      setAvatarBase64('');
      setAvatarMime(undefined);
      const ready = await pollAvatar(created.job_id, 75);
      if (ready.status === 'failed') toast(errorText(ready.reason_code || '生成失败'));
    } catch (error) {
      toast(errorText(error));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function deployAvatar(): Promise<void> {
    if (!api || !avatarJob) return;
    setAvatarBusy(true);
    try {
      const deployment = await api.deployAvatar(avatarJob.job_id);
      setAvatarJob(deployment);
      const active = await pollAvatar(avatarJob.job_id, 100);
      if (active.status === 'active') {
        setSelectedPhoto('');
        toast('T5 校验完成，宠物形象已启用');
      } else if (active.status === 'failed') {
        toast('设备校验失败，仍使用基础形象');
      } else {
        toast('仍在等待 T5 下载校验');
      }
    } catch (error) {
      toast(errorText(error));
    } finally {
      setAvatarBusy(false);
    }
  }

  function renderChat() {
    return (
      <View className={styles.pageBody}>
        <View className={styles.companionCard}>
          <View className={styles.statusRow}>
            <View className={`${styles.onlineDot} ${configured ? styles.online : ''}`} />
            <Text className={styles.statusText}>{configured ? 'Agent 已连接' : '等待连接'}</Text>
            <Text className={styles.privacyChip}>触发式感知</Text>
            <Text className={styles.privacyChip} onClick={startNewSession}>新会话</Text>
          </View>
          <View className={styles.face}><Text>{EXPRESSIONS[expression] || EXPRESSIONS.idle}</Text></View>
          <Text className={styles.companionName}>HSHH</Text>
          <Text className={styles.companionHint}>会先问你，再靠近。抱它由你主动决定。</Text>
          <View className={styles.stopButton} onClick={emergencyStop}>
            <Text>停止 / 释放</Text>
          </View>
        </View>

        <ScrollView className={styles.messageList} scrollY>
          {messages.map(message => (
            <View key={message.id} className={`${styles.message} ${styles[message.role]}`}>
              <Text className={styles.messageText}>{message.text}</Text>
              {!!message.meta && <Text className={styles.messageMeta}>{message.meta}</Text>}
            </View>
          ))}
          {busy && <View className={`${styles.message} ${styles.robot}`}><Text>正在想一想…</Text></View>}
        </ScrollView>

        <View className={styles.consentPanel}>
          <Text className={styles.panelTitle}>明确选择</Text>
          <View className={styles.actionGrid}>
            <View className={styles.actionPrimary} onClick={() => void submitConsent('approach_short')}>
              <Text>可以靠近</Text>
            </View>
            <View className={styles.actionPrimary} onClick={() => void submitConsent('invite_hug')}>
              <Text>邀请抱抱</Text>
            </View>
            <View className={styles.actionQuiet} onClick={() => void rejectInvitation()}>
              <Text>这次不用</Text>
            </View>
          </View>
        </View>

        <View className={styles.composer}>
          <View className={`${styles.voiceButton} ${recording ? styles.recording : ''}`} onClick={recording ? stopVoice : startVoice}>
            <Text>{recording ? '■' : '◉'}</Text>
          </View>
          <Input
            className={styles.chatInput}
            value={draft}
            maxLength={500}
            confirmType="send"
            placeholder={recording ? '正在听…' : '告诉它你现在想要什么'}
            onInput={event => setDraft(event.detail.value)}
            onConfirm={() => void sendText()}
          />
          <View className={`${styles.sendButton} ${busy ? styles.disabled : ''}`} onClick={() => void sendText()}>
            <Text>发送</Text>
          </View>
        </View>
      </View>
    );
  }

  function renderMemory() {
    return (
      <View className={styles.pageBody}>
        <View className={styles.sectionHero}>
          <View><Text className={styles.sectionTitle}>共同记忆</Text><Text className={styles.sectionSubtitle}>只保存你确认过的偏好与共同事件</Text></View>
          <Switch checked={memoryEnabled} onChange={event => void toggleMemory(!!event.detail.value)} />
        </View>
        {!memoryEnabled ? (
          <View className={styles.emptyCard}><Text className={styles.emptyTitle}>长期记忆已暂停</Text><Text className={styles.emptyText}>暂停后不会新增记忆；已有内容也不会进入 Agent 上下文。</Text></View>
        ) : memoryLoading ? (
          <View className={styles.emptyCard}><Text>正在读取…</Text></View>
        ) : memories.length === 0 ? (
          <View className={styles.emptyCard}><Text className={styles.emptyTitle}>还没有确认的记忆</Text><Text className={styles.emptyText}>例如：“叫我小余”“我更喜欢安静陪伴”。</Text></View>
        ) : (
          <View className={styles.memoryList}>
            {memories.map(memory => (
              <View className={styles.memoryCard} key={memory.id}>
                <View className={styles.memoryHeader}><Text className={styles.memoryKind}>{memory.kind}</Text><Text className={styles.memoryTime}>{memory.created_at.slice(0, 10)}</Text></View>
                {editingMemoryId === memory.id ? (
                  <View className={styles.memoryEditor}>
                    <Input className={styles.memoryInput} value={memoryDraft} maxLength={500} onInput={event => setMemoryDraft(event.detail.value)} />
                    <Button size="mini" type="primary" onClick={() => void saveMemory(memory)}>保存更正</Button>
                  </View>
                ) : <Text className={styles.memorySummary}>{memory.summary}</Text>}
                <Text className={styles.memorySource}>{memory.confirmed ? '已确认' : '等待确认'} · {memory.source}</Text>
                <View className={styles.memoryActions}>
                  {!memory.confirmed && <Text onClick={() => void confirmMemory(memory)}>确认</Text>}
                  <Text onClick={() => { setEditingMemoryId(memory.id); setMemoryDraft(memory.summary); }}>更正</Text>
                  <Text className={styles.deleteText} onClick={() => confirmDeleteMemory(memory)}>删除</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  }

  function renderAvatar() {
    const statusLabel: Record<string, string> = {
      pending: '正在生成 9 × 5 帧',
      ready: '预览资源已就绪，等待你的确认',
      deploying: 'T5 正在下载、逐帧校验并试解码',
      active: '宠物形象已启用',
      failed: '生成或校验失败，基础形象仍在使用',
    };
    return (
      <View className={styles.pageBody}>
        <View className={styles.sectionHero}><View><Text className={styles.sectionTitle}>宠物形象</Text><Text className={styles.sectionSubtitle}>同一身份层，确定性生成 9 种表情 × 5 帧</Text></View></View>
        <View className={styles.avatarPreview} onClick={choosePetPhoto}>
          {selectedPhoto ? <Image className={styles.petPhoto} src={selectedPhoto} mode="aspectFill" /> : <View className={styles.uploadPlaceholder}><Text className={styles.uploadIcon}>＋</Text><Text>选择清晰的正面宠物照</Text><Text className={styles.uploadHint}>JPEG / PNG / WebP，最大 8 MB</Text></View>}
        </View>
        <View className={styles.formCard}>
          <Text className={styles.fieldLabel}>宠物 ID</Text>
          <Input className={styles.fieldInput} value={petId} maxLength={80} onInput={event => setPetId(event.detail.value)} />
          <Text className={styles.fieldLabel}>宠物类型</Text>
          <View className={styles.segmented}>
            <Text className={petType === 'cat' ? styles.segmentActive : ''} onClick={() => setPetType('cat')}>猫</Text>
            <Text className={petType === 'dog' ? styles.segmentActive : ''} onClick={() => setPetType('dog')}>狗</Text>
          </View>
          <Text className={styles.fieldLabel}>可见特征（逗号分隔）</Text>
          <Input className={styles.fieldInput} value={petTraits} maxLength={300} onInput={event => setPetTraits(event.detail.value)} />
          {!avatarJob && <Button className={styles.fullButton} type="primary" loading={avatarBusy} disabled={avatarBusy} onClick={() => void createAvatar()}>生成宠物表情包</Button>}
          {!!avatarJob && <View className={styles.jobCard}><Text className={styles.jobStatus}>{statusLabel[avatarJob.status]}</Text>{avatarJob.reason_code && <Text className={styles.jobReason}>{avatarJob.reason_code}</Text>}{avatarJob.status === 'ready' && <Button className={styles.fullButton} type="primary" loading={avatarBusy} onClick={() => void deployAvatar()}>确认并部署到机器人</Button>}</View>}
        </View>
        <View className={styles.privacyNote}><Text>隐私：原图仅用于本次生成，服务端合成后立即清除；设备校验失败时不会替换内置 basic 形象。</Text></View>
      </View>
    );
  }

  function renderSettings() {
    return (
      <View className={styles.pageBody}>
        <View className={styles.sectionHero}><View><Text className={styles.sectionTitle}>联调连接</Text><Text className={styles.sectionSubtitle}>连接同一局域网内的 HSHH Agent</Text></View></View>
        <View className={styles.formCard}>
          <Text className={styles.fieldLabel}>Agent 地址</Text>
          <Input className={styles.fieldInput} value={connection.baseUrl} maxLength={200} onInput={event => setConnection(current => ({ ...current, baseUrl: event.detail.value }))} />
          <Text className={styles.fieldLabel}>用户 ID</Text>
          <Input className={styles.fieldInput} value={connection.userId} maxLength={128} onInput={event => setConnection(current => ({ ...current, userId: event.detail.value }))} />
          <Text className={styles.fieldLabel}>设备 ID</Text>
          <Input className={styles.fieldInput} value={connection.deviceId} maxLength={128} onInput={event => setConnection(current => ({ ...current, deviceId: event.detail.value }))} />
          <Text className={styles.fieldLabel}>短时联调会话令牌</Text>
          <Input className={styles.fieldInput} password value={connection.userToken} maxLength={512} placeholder="不会写入源码或本地持久存储" onInput={event => setConnection(current => ({ ...current, userToken: event.detail.value }))} />
          <Button className={styles.fullButton} type="primary" onClick={() => void saveConnection()}>测试并连接</Button>
        </View>
        <View className={styles.safetyCard}><Text className={styles.safetyTitle}>实物安全边界</Text><Text className={styles.safetyText}>仅在封闭、平整地面并有人看护时使用。没有新鲜距离与姿态数据时，机器人会拒绝移动；桌面和台阶附近禁止自主靠近。</Text></View>
      </View>
    );
  }

  return (
    <View className={styles.app}>
      <View className={styles.topBar}>
        <View><Text className={styles.brand}>HSHH</Text><Text className={styles.brandSub}>AI 情感陪伴宠物</Text></View>
        <View className={styles.settingsShortcut} onClick={() => setTab('settings')}><Text>•••</Text></View>
      </View>
      <ScrollView className={styles.content} scrollY>
        {tab === 'chat' && renderChat()}
        {tab === 'memory' && renderMemory()}
        {tab === 'avatar' && renderAvatar()}
        {tab === 'settings' && renderSettings()}
      </ScrollView>
      <View className={styles.tabBar}>
        {([
          ['chat', '陪伴'],
          ['memory', '记忆'],
          ['avatar', '形象'],
          ['settings', '连接'],
        ] as Array<[Tab, string]>).map(item => (
          <View key={item[0]} className={`${styles.tabItem} ${tab === item[0] ? styles.tabActive : ''}`} onClick={() => setTab(item[0])}>
            <Text>{item[1]}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
