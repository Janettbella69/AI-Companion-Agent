import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  deviceContextSchema,
  isoTimestampSchema,
  memoryCandidateSchema,
  memoryUpdateSchema,
  type DeviceContext,
  type MemoryCandidate,
  type MemoryKind,
  type MemorySource,
  type MemoryUpdate,
} from "../domain/contracts.js";

const DATABASE_VERSION = 2;

export const PET_ASSET_STATUSES = [
  "pending",
  "ready",
  "active",
  "failed",
] as const;

export type PetAssetStatus = (typeof PET_ASSET_STATUSES)[number];

export interface DatabaseOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export interface MemorySetting {
  user_id: string;
  enabled: boolean;
}

export interface MemoryRecord {
  id: string;
  user_id: string;
  kind: MemoryKind;
  summary: string;
  source: MemorySource;
  confirmed: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface ListMemoryOptions {
  confirmedOnly?: boolean;
  includeDeleted?: boolean;
  limit?: number;
}

export interface AgentSessionRecord {
  conversation_key: string;
  session_id: string;
  user_id?: string;
  device_id?: string;
  updated_at: string;
}

export interface SaveAgentSessionInput {
  conversation_key: string;
  session_id: string;
  user_id?: string;
  device_id?: string;
}

export interface InteractionEventInput {
  event_type: string;
  occurred_at: string;
  user_id?: string;
  device_id?: string;
  request_id?: string;
  payload?: Record<string, unknown>;
}

export interface InteractionEventRecord extends InteractionEventInput {
  id: string;
  created_at: string;
}

export interface ListInteractionEventOptions {
  user_id?: string;
  device_id?: string;
  event_type?: string;
  request_id?: string;
  limit?: number;
}

export interface CreatePetAssetInput {
  device_id: string;
  pet_id: string;
  asset_version: string;
  manifest: Record<string, unknown>;
  checksum_sha256: string;
  status?: Exclude<PetAssetStatus, "active">;
}

export interface PetAssetRecord {
  id: string;
  device_id: string;
  pet_id: string;
  asset_version: string;
  manifest: Record<string, unknown>;
  checksum_sha256: string;
  status: PetAssetStatus;
  active: boolean;
  created_at: string;
  updated_at: string;
  activated_at?: string;
}

interface MemoryRow {
  id: string;
  user_id: string;
  kind: string;
  summary: string;
  source: string;
  confirmed: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface AgentSessionRow {
  conversation_key: string;
  session_id: string;
  user_id: string | null;
  device_id: string | null;
  updated_at: string;
}

interface InteractionEventRow {
  id: string;
  event_type: string;
  occurred_at: string;
  user_id: string | null;
  device_id: string | null;
  request_id: string | null;
  payload_json: string | null;
  created_at: string;
}

interface PetAssetRow {
  id: string;
  device_id: string;
  pet_id: string;
  asset_version: string;
  manifest_json: string;
  checksum_sha256: string;
  status: string;
  active: number;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
}

function prepareDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) {
    return;
  }
  mkdirSync(dirname(databasePath), { recursive: true });
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) {
    throw new Error(`${label} must contain between 1 and 512 characters`);
  }
  return normalized;
}

function assertIsoTimestamp(value: string, label: string): string {
  const result = isoTimestampSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} must be an ISO 8601 timestamp with a timezone`);
  }
  return result.data;
}

function clampInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`limit must be an integer between 1 and ${max}`);
  }
  return value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored event payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  const record: MemoryRecord = {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind as MemoryKind,
    summary: row.summary,
    source: row.source as MemorySource,
    confirmed: row.confirmed === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.deleted_at !== null) {
    record.deleted_at = row.deleted_at;
  }
  return record;
}

function toAgentSessionRecord(row: AgentSessionRow): AgentSessionRecord {
  const record: AgentSessionRecord = {
    conversation_key: row.conversation_key,
    session_id: row.session_id,
    updated_at: row.updated_at,
  };
  if (row.user_id !== null) {
    record.user_id = row.user_id;
  }
  if (row.device_id !== null) {
    record.device_id = row.device_id;
  }
  return record;
}

function toInteractionEventRecord(row: InteractionEventRow): InteractionEventRecord {
  const record: InteractionEventRecord = {
    id: row.id,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
  if (row.user_id !== null) {
    record.user_id = row.user_id;
  }
  if (row.device_id !== null) {
    record.device_id = row.device_id;
  }
  if (row.request_id !== null) {
    record.request_id = row.request_id;
  }
  const payload = parseJsonObject(row.payload_json);
  if (payload !== undefined) {
    record.payload = payload;
  }
  return record;
}

function toPetAssetRecord(row: PetAssetRow): PetAssetRecord {
  const record: PetAssetRecord = {
    id: row.id,
    device_id: row.device_id,
    pet_id: row.pet_id,
    asset_version: row.asset_version,
    manifest: parseJsonObject(row.manifest_json) ?? {},
    checksum_sha256: row.checksum_sha256,
    status: row.status as PetAssetStatus,
    active: row.active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.activated_at !== null) {
    record.activated_at = row.activated_at;
  }
  return record;
}

function assertPetAssetStatus(value: string): PetAssetStatus {
  if (!(PET_ASSET_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported pet asset status: ${value}`);
  }
  return value as PetAssetStatus;
}

function assertSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("checksum_sha256 must be a 64-character SHA-256 hex digest");
  }
  return normalized;
}

/**
 * SQLite-backed product data. Claude SDK sessions are stored separately from
 * opt-in product memory and are never treated as long-term memory.
 */
export class HshhDatabase {
  readonly connection: DatabaseSync;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(databasePath: string, options: DatabaseOptions = {}) {
    prepareDatabaseDirectory(databasePath);
    this.connection = new DatabaseSync(databasePath);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.configure();
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  isMemoryEnabled(userId: string): boolean {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    const row = this.connection
      .prepare("SELECT memory_enabled FROM profiles WHERE user_id = ?")
      .get(normalizedUserId) as { memory_enabled: number } | undefined;
    return row?.memory_enabled === 1;
  }

  getMemorySetting(userId: string): MemorySetting {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    return {
      user_id: normalizedUserId,
      enabled: this.isMemoryEnabled(normalizedUserId),
    };
  }

  setMemoryEnabled(userId: string, enabled: boolean): MemorySetting {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    const timestamp = this.nowIso();
    this.connection
      .prepare(
        `INSERT INTO profiles (user_id, memory_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           memory_enabled = excluded.memory_enabled,
           updated_at = excluded.updated_at`,
      )
      .run(normalizedUserId, enabled ? 1 : 0, timestamp, timestamp);
    return { user_id: normalizedUserId, enabled };
  }

  /**
   * Creates an unconfirmed candidate only when the user has opted in. A null
   * result means memory is disabled; callers should not retry behind the user.
   */
  proposeMemory(userId: string, candidate: MemoryCandidate): MemoryRecord | null {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    if (!this.isMemoryEnabled(normalizedUserId)) {
      return null;
    }

    const parsed = memoryCandidateSchema.parse(candidate);
    const id = this.idFactory();
    const timestamp = this.nowIso();
    this.connection
      .prepare(
        `INSERT INTO memories
           (id, user_id, kind, summary, source, confirmed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        normalizedUserId,
        parsed.kind,
        parsed.summary,
        parsed.source,
        timestamp,
        timestamp,
      );

    return this.requireMemory(normalizedUserId, id, true);
  }

  getMemory(
    userId: string,
    memoryId: string,
    includeDeleted = false,
  ): MemoryRecord | null {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    const normalizedMemoryId = assertIdentifier(memoryId, "memory_id");
    const deletedClause = includeDeleted ? "" : " AND deleted_at IS NULL";
    const row = this.connection
      .prepare(
        `SELECT id, user_id, kind, summary, source, confirmed,
                created_at, updated_at, deleted_at
           FROM memories
          WHERE user_id = ? AND id = ?${deletedClause}`,
      )
      .get(normalizedUserId, normalizedMemoryId) as MemoryRow | undefined;
    return row === undefined ? null : toMemoryRecord(row);
  }

  confirmMemory(userId: string, memoryId: string): MemoryRecord | null {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    const normalizedMemoryId = assertIdentifier(memoryId, "memory_id");
    if (!this.isMemoryEnabled(normalizedUserId)) {
      return null;
    }

    const result = this.connection
      .prepare(
        `UPDATE memories
            SET confirmed = 1, updated_at = ?
          WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .run(this.nowIso(), normalizedUserId, normalizedMemoryId);
    return Number(result.changes) === 0
      ? null
      : this.requireMemory(normalizedUserId, normalizedMemoryId, false);
  }

  updateMemory(
    userId: string,
    memoryId: string,
    update: MemoryUpdate,
  ): MemoryRecord | null {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    const normalizedMemoryId = assertIdentifier(memoryId, "memory_id");
    const parsed = memoryUpdateSchema.parse(update);
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];

    if (parsed.summary !== undefined) {
      assignments.push("summary = ?");
      values.push(parsed.summary);
    }
    if (parsed.confirmed !== undefined) {
      if (parsed.confirmed && !this.isMemoryEnabled(normalizedUserId)) {
        return null;
      }
      assignments.push("confirmed = ?");
      values.push(parsed.confirmed ? 1 : 0);
    }

    assignments.push("updated_at = ?");
    values.push(this.nowIso(), normalizedUserId, normalizedMemoryId);
    const result = this.connection
      .prepare(
        `UPDATE memories
            SET ${assignments.join(", ")}
          WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .run(...values);
    return Number(result.changes) === 0
      ? null
      : this.requireMemory(normalizedUserId, normalizedMemoryId, false);
  }

  softDeleteMemory(userId: string, memoryId: string): boolean {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    const normalizedMemoryId = assertIdentifier(memoryId, "memory_id");
    const timestamp = this.nowIso();
    const result = this.connection
      .prepare(
        `UPDATE memories
            SET deleted_at = ?, updated_at = ?
          WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .run(timestamp, timestamp, normalizedUserId, normalizedMemoryId);
    return Number(result.changes) > 0;
  }

  listMemories(
    userId: string,
    options: ListMemoryOptions = {},
  ): MemoryRecord[] {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    const limit = clampInteger(options.limit, 100, 500);
    const conditions = ["user_id = ?"];
    if (options.confirmedOnly === true) {
      conditions.push("confirmed = 1");
    }
    if (options.includeDeleted !== true) {
      conditions.push("deleted_at IS NULL");
    }

    const rows = this.connection
      .prepare(
        `SELECT id, user_id, kind, summary, source, confirmed,
                created_at, updated_at, deleted_at
           FROM memories
          WHERE ${conditions.join(" AND ")}
          ORDER BY CASE kind WHEN 'boundary' THEN 0 ELSE 1 END,
                   updated_at DESC
          LIMIT ?`,
      )
      .all(normalizedUserId, limit) as unknown as MemoryRow[];
    return rows.map(toMemoryRecord);
  }

  /** Returns at most five confirmed, active memories when opt-in is enabled. */
  recallMemories(userId: string, query = "", limit = 5): MemoryRecord[] {
    const normalizedUserId = assertIdentifier(userId, "user_id");
    if (!this.isMemoryEnabled(normalizedUserId)) {
      return [];
    }
    const normalizedLimit = clampInteger(limit, 5, 5);
    const normalizedQuery = query.trim();
    const queryClause = normalizedQuery.length === 0
      ? ""
      : " AND summary LIKE ? ESCAPE '\\' COLLATE NOCASE";
    const parameters: SQLInputValue[] = [normalizedUserId];
    if (normalizedQuery.length > 0) {
      parameters.push(`%${escapeLike(normalizedQuery)}%`);
    }
    parameters.push(normalizedLimit);

    const rows = this.connection
      .prepare(
        `SELECT id, user_id, kind, summary, source, confirmed,
                created_at, updated_at, deleted_at
           FROM memories
          WHERE user_id = ? AND confirmed = 1 AND deleted_at IS NULL${queryClause}
          ORDER BY CASE kind WHEN 'boundary' THEN 0 ELSE 1 END,
                   updated_at DESC
          LIMIT ?`,
      )
      .all(...parameters) as unknown as MemoryRow[];
    return rows.map(toMemoryRecord);
  }

  upsertDeviceContext(context: DeviceContext): DeviceContext {
    const parsed = deviceContextSchema.parse(context);
    const observedAtMs = Date.parse(parsed.observed_at);
    const timestamp = this.nowIso();
    this.connection
      .prepare(
        `INSERT INTO device_state
           (device_id, user_id, context_json, observed_at, observed_at_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           user_id = excluded.user_id,
           context_json = excluded.context_json,
           observed_at = excluded.observed_at,
           observed_at_ms = excluded.observed_at_ms,
           updated_at = excluded.updated_at
         WHERE excluded.observed_at_ms >= device_state.observed_at_ms`,
      )
      .run(
        parsed.device_id,
        parsed.user_id ?? null,
        JSON.stringify(parsed),
        parsed.observed_at,
        observedAtMs,
        timestamp,
      );
    return this.getDeviceContext(parsed.device_id) ?? parsed;
  }

  getDeviceContext(deviceId: string): DeviceContext | null {
    const normalizedDeviceId = assertIdentifier(deviceId, "device_id");
    const row = this.connection
      .prepare("SELECT context_json FROM device_state WHERE device_id = ?")
      .get(normalizedDeviceId) as { context_json: string } | undefined;
    if (row === undefined) {
      return null;
    }
    return deviceContextSchema.parse(JSON.parse(row.context_json));
  }

  saveAgentSession(input: SaveAgentSessionInput): AgentSessionRecord {
    const conversationKey = assertIdentifier(
      input.conversation_key,
      "conversation_key",
    );
    const sessionId = assertIdentifier(input.session_id, "session_id");
    const userId = input.user_id === undefined
      ? null
      : assertIdentifier(input.user_id, "user_id");
    const deviceId = input.device_id === undefined
      ? null
      : assertIdentifier(input.device_id, "device_id");
    const timestamp = this.nowIso();
    this.connection
      .prepare(
        `INSERT INTO agent_sessions
           (conversation_key, session_id, user_id, device_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(conversation_key) DO UPDATE SET
           session_id = excluded.session_id,
           user_id = excluded.user_id,
           device_id = excluded.device_id,
           updated_at = excluded.updated_at`,
      )
      .run(conversationKey, sessionId, userId, deviceId, timestamp);
    return this.requireAgentSession(conversationKey);
  }

  getAgentSession(conversationKey: string): AgentSessionRecord | null {
    const normalizedKey = assertIdentifier(conversationKey, "conversation_key");
    const row = this.connection
      .prepare(
        `SELECT conversation_key, session_id, user_id, device_id, updated_at
           FROM agent_sessions WHERE conversation_key = ?`,
      )
      .get(normalizedKey) as AgentSessionRow | undefined;
    return row === undefined ? null : toAgentSessionRecord(row);
  }

  deleteAgentSession(conversationKey: string): boolean {
    const normalizedKey = assertIdentifier(conversationKey, "conversation_key");
    const result = this.connection
      .prepare("DELETE FROM agent_sessions WHERE conversation_key = ?")
      .run(normalizedKey);
    return Number(result.changes) > 0;
  }

  recordInteractionEvent(input: InteractionEventInput): InteractionEventRecord {
    const eventType = assertIdentifier(input.event_type, "event_type");
    if (!/^[a-z][a-z0-9_]*$/.test(eventType)) {
      throw new Error("event_type must use lowercase snake_case");
    }
    const occurredAt = assertIsoTimestamp(input.occurred_at, "occurred_at");
    const id = this.idFactory();
    const createdAt = this.nowIso();
    const userId = input.user_id === undefined
      ? null
      : assertIdentifier(input.user_id, "user_id");
    const deviceId = input.device_id === undefined
      ? null
      : assertIdentifier(input.device_id, "device_id");
    const requestId = input.request_id === undefined
      ? null
      : assertIdentifier(input.request_id, "request_id");
    const payloadJson = input.payload === undefined
      ? null
      : JSON.stringify(input.payload);

    this.connection
      .prepare(
        `INSERT INTO interaction_events
           (id, user_id, device_id, event_type, request_id, payload_json,
            occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        deviceId,
        eventType,
        requestId,
        payloadJson,
        occurredAt,
        createdAt,
      );
    return this.requireInteractionEvent(id);
  }

  getInteractionEvent(eventId: string): InteractionEventRecord | null {
    const normalizedEventId = assertIdentifier(eventId, "event_id");
    const row = this.connection
      .prepare(
        `SELECT id, user_id, device_id, event_type, request_id, payload_json,
                occurred_at, created_at
           FROM interaction_events WHERE id = ?`,
      )
      .get(normalizedEventId) as InteractionEventRow | undefined;
    return row === undefined ? null : toInteractionEventRecord(row);
  }

  listInteractionEvents(
    optionsOrLimit: ListInteractionEventOptions | number = {},
  ): InteractionEventRecord[] {
    const options = typeof optionsOrLimit === "number"
      ? { limit: optionsOrLimit }
      : optionsOrLimit;
    const normalizedLimit = clampInteger(options.limit, 100, 500);
    const conditions: string[] = [];
    const parameters: SQLInputValue[] = [];

    if (options.user_id !== undefined) {
      conditions.push("user_id = ?");
      parameters.push(assertIdentifier(options.user_id, "user_id"));
    }
    if (options.device_id !== undefined) {
      conditions.push("device_id = ?");
      parameters.push(assertIdentifier(options.device_id, "device_id"));
    }
    if (options.event_type !== undefined) {
      conditions.push("event_type = ?");
      parameters.push(assertIdentifier(options.event_type, "event_type"));
    }
    if (options.request_id !== undefined) {
      conditions.push("request_id = ?");
      parameters.push(assertIdentifier(options.request_id, "request_id"));
    }
    parameters.push(normalizedLimit);
    const whereClause = conditions.length === 0
      ? ""
      : `WHERE ${conditions.join(" AND ")}`;

    const rows = this.connection
      .prepare(
        `SELECT id, user_id, device_id, event_type, request_id, payload_json,
                occurred_at, created_at
           FROM interaction_events
          ${whereClause}
          ORDER BY occurred_at DESC, created_at DESC
          LIMIT ?`,
      )
      .all(...parameters) as unknown as InteractionEventRow[];
    return rows.map(toInteractionEventRecord);
  }

  createPetAsset(input: CreatePetAssetInput): PetAssetRecord {
    const id = this.idFactory();
    const deviceId = assertIdentifier(input.device_id, "device_id");
    const petId = assertIdentifier(input.pet_id, "pet_id");
    const assetVersion = assertIdentifier(input.asset_version, "asset_version");
    const checksum = assertSha256(input.checksum_sha256);
    const status = assertPetAssetStatus(input.status ?? "pending");
    if (status === "active") {
      throw new Error("Use activatePetAsset() to activate a resource package");
    }
    const manifestJson = JSON.stringify(input.manifest);
    parseJsonObject(manifestJson);
    const timestamp = this.nowIso();

    this.connection
      .prepare(
        `INSERT INTO pet_assets
           (id, device_id, pet_id, asset_version, manifest_json,
            checksum_sha256, status, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        deviceId,
        petId,
        assetVersion,
        manifestJson,
        checksum,
        status,
        timestamp,
        timestamp,
      );
    return this.requirePetAsset(id);
  }

  getPetAsset(assetId: string): PetAssetRecord | null {
    const normalizedAssetId = assertIdentifier(assetId, "asset_id");
    const row = this.connection
      .prepare(
        `SELECT id, device_id, pet_id, asset_version, manifest_json,
                checksum_sha256, status, active, created_at, updated_at,
                activated_at
           FROM pet_assets WHERE id = ?`,
      )
      .get(normalizedAssetId) as PetAssetRow | undefined;
    return row === undefined ? null : toPetAssetRecord(row);
  }

  getActivePetAsset(deviceId: string): PetAssetRecord | null {
    const normalizedDeviceId = assertIdentifier(deviceId, "device_id");
    const row = this.connection
      .prepare(
        `SELECT id, device_id, pet_id, asset_version, manifest_json,
                checksum_sha256, status, active, created_at, updated_at,
                activated_at
           FROM pet_assets WHERE device_id = ? AND active = 1`,
      )
      .get(normalizedDeviceId) as PetAssetRow | undefined;
    return row === undefined ? null : toPetAssetRecord(row);
  }

  listPetAssets(deviceId: string, limit = 100): PetAssetRecord[] {
    const normalizedDeviceId = assertIdentifier(deviceId, "device_id");
    const normalizedLimit = clampInteger(limit, 100, 500);
    const rows = this.connection
      .prepare(
        `SELECT id, device_id, pet_id, asset_version, manifest_json,
                checksum_sha256, status, active, created_at, updated_at,
                activated_at
           FROM pet_assets
          WHERE device_id = ?
          ORDER BY active DESC, updated_at DESC
          LIMIT ?`,
      )
      .all(normalizedDeviceId, normalizedLimit) as unknown as PetAssetRow[];
    return rows.map(toPetAssetRecord);
  }

  updatePetAssetStatus(
    assetId: string,
    status: Exclude<PetAssetStatus, "active">,
  ): PetAssetRecord | null {
    const normalizedAssetId = assertIdentifier(assetId, "asset_id");
    const normalizedStatus = assertPetAssetStatus(status);
    if (normalizedStatus === "active") {
      throw new Error("Use activatePetAsset() to activate a resource package");
    }
    const result = this.connection
      .prepare(
        `UPDATE pet_assets
            SET status = ?, active = 0, activated_at = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(normalizedStatus, this.nowIso(), normalizedAssetId);
    return Number(result.changes) === 0
      ? null
      : this.requirePetAsset(normalizedAssetId);
  }

  /** Atomically switches the active package for one device. */
  activatePetAsset(deviceId: string, assetId: string): PetAssetRecord | null {
    const normalizedDeviceId = assertIdentifier(deviceId, "device_id");
    const normalizedAssetId = assertIdentifier(assetId, "asset_id");
    const target = this.getPetAsset(normalizedAssetId);
    if (
      target === null ||
      target.device_id !== normalizedDeviceId ||
      (target.status !== "ready" && target.status !== "active")
    ) {
      return null;
    }

    const timestamp = this.nowIso();
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection
        .prepare(
          `UPDATE pet_assets
              SET status = 'ready', active = 0, updated_at = ?
            WHERE device_id = ? AND active = 1 AND id <> ?`,
        )
        .run(timestamp, normalizedDeviceId, normalizedAssetId);
      const result = this.connection
        .prepare(
          `UPDATE pet_assets
              SET status = 'active', active = 1,
                  activated_at = ?, updated_at = ?
            WHERE id = ? AND device_id = ? AND status IN ('ready', 'active')`,
        )
        .run(timestamp, timestamp, normalizedAssetId, normalizedDeviceId);
      if (Number(result.changes) === 0) {
        this.connection.exec("ROLLBACK");
        return null;
      }
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
    return this.requirePetAsset(normalizedAssetId);
  }

  private configure(): void {
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    this.connection.exec("PRAGMA journal_mode = WAL");
  }

  private migrate(): void {
    const versionRow = this.connection
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    if (versionRow.user_version > DATABASE_VERSION) {
      throw new Error(
        `Database version ${versionRow.user_version} is newer than supported version ${DATABASE_VERSION}`,
      );
    }
    if (versionRow.user_version === DATABASE_VERSION) {
      return;
    }

    this.connection.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY,
        memory_enabled INTEGER NOT NULL DEFAULT 0 CHECK (memory_enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('preference', 'boundary', 'shared_event', 'profile')),
        summary TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('explicit_user', 'confirmed_interaction')),
        confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS memories_user_active_idx
        ON memories (user_id, confirmed, deleted_at, updated_at DESC);

      CREATE TABLE IF NOT EXISTS interaction_events (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        device_id TEXT,
        event_type TEXT NOT NULL,
        request_id TEXT,
        payload_json TEXT,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS interaction_events_device_idx
        ON interaction_events (device_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS interaction_events_user_idx
        ON interaction_events (user_id, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        conversation_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT,
        device_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS device_state (
        device_id TEXT PRIMARY KEY,
        user_id TEXT,
        context_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pet_assets (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        pet_id TEXT NOT NULL,
        asset_version TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'active', 'failed')),
        active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activated_at TEXT,
        UNIQUE (device_id, pet_id, asset_version),
        CHECK (active = 0 OR status = 'active')
      );

      CREATE INDEX IF NOT EXISTS pet_assets_device_idx
        ON pet_assets (device_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS pet_assets_one_active_per_device_idx
        ON pet_assets (device_id) WHERE active = 1;

      PRAGMA user_version = ${DATABASE_VERSION};
      COMMIT;
    `);
  }

  private requireMemory(
    userId: string,
    memoryId: string,
    includeDeleted: boolean,
  ): MemoryRecord {
    const memory = this.getMemory(userId, memoryId, includeDeleted);
    if (memory === null) {
      throw new Error(`Memory ${memoryId} was not found after persistence`);
    }
    return memory;
  }

  private requireAgentSession(conversationKey: string): AgentSessionRecord {
    const session = this.getAgentSession(conversationKey);
    if (session === null) {
      throw new Error(`Agent session ${conversationKey} was not found after persistence`);
    }
    return session;
  }

  private requireInteractionEvent(eventId: string): InteractionEventRecord {
    const event = this.getInteractionEvent(eventId);
    if (event === null) {
      throw new Error(`Interaction event ${eventId} was not found after persistence`);
    }
    return event;
  }

  private requirePetAsset(assetId: string): PetAssetRecord {
    const asset = this.getPetAsset(assetId);
    if (asset === null) {
      throw new Error(`Pet asset ${assetId} was not found after persistence`);
    }
    return asset;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

export function makeConversationKey(userId: string, deviceId: string): string {
  const normalizedUserId = assertIdentifier(userId, "user_id");
  const normalizedDeviceId = assertIdentifier(deviceId, "device_id");
  return `${encodeURIComponent(normalizedUserId)}:${encodeURIComponent(normalizedDeviceId)}`;
}
