export type ConsentScope = 'approach_short' | 'invite_hug';

export interface AgentConnection {
  baseUrl: string;
  userToken: string;
  userId: string;
  deviceId: string;
}

export interface AgentDecision {
  reply_text: string;
  expression: string;
  emotion: {
    state: string;
    confidence: number;
  };
  requires_user_confirmation: boolean;
  confirmation_scope?: 'approach_short' | 'invite_hug' | 'memory';
  output_modalities?: string[];
}

export interface InteractionResult {
  decision: AgentDecision;
  session_id?: string;
  mode: 'claude' | 'fallback';
}

export interface MemoryRecord {
  id: string;
  kind: 'preference' | 'boundary' | 'shared_event' | 'profile';
  summary: string;
  source: 'explicit_user' | 'confirmed_interaction';
  confirmed: boolean;
  created_at: string;
  updated_at: string;
}

export interface MemoriesResult {
  settings: { user_id: string; enabled: boolean };
  memories: MemoryRecord[];
}

export interface AvatarJob {
  job_id: string;
  status: 'pending' | 'ready' | 'deploying' | 'active' | 'failed';
  pet_id?: string;
  asset_id?: string;
  reason_code?: string;
  active?: boolean;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  timeout?: number;
}

function normalizedOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '');
  if (!/^https?:\/\//u.test(trimmed)) {
    throw new Error('Agent 地址必须以 http:// 或 https:// 开头');
  }
  return trimmed;
}

function responseBody(value: unknown): any {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function validateConnection(connection: AgentConnection): AgentConnection {
  const result = {
    baseUrl: normalizedOrigin(connection.baseUrl),
    userToken: connection.userToken.trim(),
    userId: connection.userId.trim(),
    deviceId: connection.deviceId.trim(),
  };
  if (result.userToken.length < 16) throw new Error('联调会话令牌无效');
  if (!result.userId || !result.deviceId) throw new Error('用户 ID 和设备 ID 不能为空');
  return result;
}

export class AgentApi {
  readonly connection: AgentConnection;

  constructor(connection: AgentConnection) {
    this.connection = validateConnection(connection);
  }

  private request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    return new Promise((resolve, reject) => {
      ty.request({
        url: `${this.connection.baseUrl}${path}`,
        method,
        data: options.body === undefined ? undefined : JSON.stringify(options.body),
        timeout: options.timeout ?? 20_000,
        dataType: 'json',
        header: {
          Authorization: `Bearer ${this.connection.userToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        success: result => {
          const body = responseBody(result.data);
          if (result.statusCode < 200 || result.statusCode >= 300) {
            const reason =
              body && typeof body === 'object' && typeof body.reason_code === 'string'
                ? body.reason_code
                : `HTTP ${result.statusCode}`;
            reject(new Error(reason));
            return;
          }
          resolve(body as T);
        },
        failure: error => reject(new Error(error.errorMsg || 'Agent 网络请求失败')),
      });
    });
  }

  interact(transcript: string, sessionId?: string): Promise<InteractionResult> {
    const observedAt = new Date().toISOString();
    return this.request('/v1/interactions', {
      method: 'POST',
      timeout: 65_000,
      body: {
        transcript: transcript.trim(),
        ...(sessionId ? { session_id: sessionId } : {}),
        locale: 'zh-CN',
        task_mode: 'companion',
        // This is intentionally non-actuating. The Agent replaces it with the
        // latest device-originated context before any policy decision.
        device_context: {
          device_id: this.connection.deviceId,
          user_id: this.connection.userId,
          observed_at: observedAt,
          presence: 'unknown',
          pose: 'unknown',
          battery: 'unknown',
          safety_state: 'stopped',
        },
      },
    });
  }

  feedback(
    feedback: 'accept' | 'reject' | 'correction' | 'stop',
    options: { scope?: ConsentScope; detail?: string } = {},
  ): Promise<any> {
    return this.request('/v1/feedback', {
      method: 'POST',
      body: {
        user_id: this.connection.userId,
        device_id: this.connection.deviceId,
        feedback,
        ...(options.scope ? { consent_scope: options.scope } : {}),
        ...(options.detail?.trim() ? { detail: options.detail.trim() } : {}),
        occurred_at: new Date().toISOString(),
      },
    });
  }

  getMemories(): Promise<MemoriesResult> {
    return this.request(
      `/v1/memories?user_id=${encodeURIComponent(this.connection.userId)}`,
    );
  }

  setMemoryEnabled(enabled: boolean): Promise<{ user_id: string; enabled: boolean }> {
    return this.request('/v1/memory-settings', {
      method: 'PUT',
      body: { user_id: this.connection.userId, enabled },
    });
  }

  updateMemory(
    memoryId: string,
    update: { summary?: string; confirmed?: boolean },
  ): Promise<{ memory: MemoryRecord }> {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}`, {
      method: 'PATCH',
      body: { user_id: this.connection.userId, ...update },
    });
  }

  deleteMemory(memoryId: string): Promise<{ deleted: true }> {
    return this.request(
      `/v1/memories/${encodeURIComponent(memoryId)}?user_id=${encodeURIComponent(
        this.connection.userId,
      )}`,
      { method: 'DELETE' },
    );
  }

  createAvatar(input: {
    petId: string;
    petType: 'cat' | 'dog';
    visibleTraits: string[];
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    imageBase64: string;
  }): Promise<{ job_id: string; status: string }> {
    return this.request('/v1/avatar-packs', {
      method: 'POST',
      timeout: 65_000,
      body: {
        device_id: this.connection.deviceId,
        user_id: this.connection.userId,
        pet_id: input.petId,
        pet_type: input.petType,
        visible_traits: input.visibleTraits,
        mime_type: input.mimeType,
        image_base64: input.imageBase64,
      },
    });
  }

  getAvatarJob(jobId: string): Promise<AvatarJob> {
    return this.request(`/v1/avatar-packs/${encodeURIComponent(jobId)}`);
  }

  deployAvatar(jobId: string): Promise<AvatarJob> {
    return this.request(`/v1/avatar-packs/${encodeURIComponent(jobId)}/activate`, {
      method: 'POST',
      body: {},
    });
  }
}

export function readFileBase64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const manager = ty.getFileSystemManager();
    manager.readFile({
      filePath,
      encoding: 'base64',
      success: result => resolve(result.data),
      fail: error => reject(new Error(error.errorMsg || '读取图片失败')),
    });
  });
}
