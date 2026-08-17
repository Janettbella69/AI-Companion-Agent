import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import sharp from "sharp";
import { z } from "zod";
import { EXPRESSIONS, type Expression } from "../domain/contracts.js";
import {
  HshhDatabase,
  type PetAssetRecord,
} from "../store/database.js";

export const MAX_AVATAR_SOURCE_BYTES = 8 * 1024 * 1024;
const PIPELINE_RECORD_TTL_MS = 15 * 60_000;
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type AvatarStatus = "completed" | "rejected" | "failed";

export interface StagedAvatarAsset {
  asset_ref?: string;
  device_id: string;
  request_id: string;
  pet_id: string;
  asset_version: string;
  mime_type: (typeof ALLOWED_MIME_TYPES)[number] | string;
  byte_length: number;
  width: number;
  height: number;
  header_hex: string;
  checksum_sha256: string;
  computed_checksum_sha256: string;
}

interface StoredStagedAsset extends StagedAvatarAsset {
  asset_ref: string;
  staged_at: string;
  expires_at: string;
  /** Ephemeral original upload. It is zeroed after composition or expiry. */
  source_bytes?: Buffer;
}

interface ValidationRecord {
  validation_id: string;
  asset_ref: string;
  device_id: string;
  request_id: string;
  pet_id: string;
  asset_version: string;
  mime_type: (typeof ALLOWED_MIME_TYPES)[number];
  width: number;
  height: number;
  source_checksum_sha256: string;
  expires_at: string;
}

interface IdentityRecord {
  identity_id: string;
  validation_id: string;
  device_id: string;
  request_id: string;
  pet_id: string;
  asset_version: string;
  pet_type: "cat" | "dog";
  visible_traits: string[];
  identity_checksum_sha256: string;
  expires_at: string;
}

interface StoredPack {
  asset_id: string;
  device_id: string;
  root: string;
}

export interface AvatarMetadataPipelineOptions {
  now?: () => Date;
  idFactory?: () => string;
  assetRoot?: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  reason_code:
    | "manifest_valid"
    | "manifest_invalid"
    | "missing_expression"
    | "unexpected_expression"
    | "invalid_frame_count"
    | "invalid_file_checksum"
    | "duplicate_file_path";
  expression_count: number;
  frame_count: number;
}

interface PipelineResult extends Record<string, unknown> {
  status: AvatarStatus;
  reason_code: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function hasValidSignature(mime: string, headerHex: string): boolean {
  const normalized = headerHex.toLowerCase();
  if (!/^[a-f0-9]+$/u.test(normalized) || normalized.length % 2 !== 0) {
    return false;
  }
  switch (mime) {
    case "image/jpeg":
      return normalized.startsWith("ffd8ff");
    case "image/png":
      return normalized.startsWith("89504e470d0a1a0a");
    case "image/webp":
      return (
        normalized.length >= 24 &&
        normalized.startsWith("52494646") &&
        normalized.slice(16, 24) === "57454250"
      );
    default:
      return false;
  }
}

function isSafePackPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 240 &&
    !value.startsWith("/") &&
    !value.includes("..") &&
    /^[A-Za-z0-9_./-]+$/u.test(value)
  );
}

/** Validate the frozen 9-expression × 5-frame package contract. */
export function validateAvatarManifest(
  manifest: Record<string, unknown>,
): ManifestValidationResult {
  const expressions = manifest["expressions"];
  if (
    manifest["schema_version"] !== 1 ||
    typeof manifest["pet_id"] !== "string" ||
    typeof manifest["asset_version"] !== "string" ||
    manifest["display_mode"] !== "pet" ||
    !Number.isInteger(manifest["width"]) ||
    !Number.isInteger(manifest["height"]) ||
    typeof expressions !== "object" ||
    expressions === null ||
    Array.isArray(expressions)
  ) {
    return {
      valid: false,
      reason_code: "manifest_invalid",
      expression_count: 0,
      frame_count: 0,
    };
  }
  const expressionMap = expressions as Record<string, unknown>;
  const names = Object.keys(expressionMap);
  for (const name of names) {
    if (!EXPRESSIONS.includes(name as (typeof EXPRESSIONS)[number])) {
      return {
        valid: false,
        reason_code: "unexpected_expression",
        expression_count: names.length,
        frame_count: 0,
      };
    }
  }
  const paths = new Set<string>();
  let frameCount = 0;
  for (const expression of EXPRESSIONS) {
    const frames = expressionMap[expression];
    if (frames === undefined) {
      return {
        valid: false,
        reason_code: "missing_expression",
        expression_count: names.length,
        frame_count: frameCount,
      };
    }
    if (!Array.isArray(frames) || frames.length !== 5) {
      return {
        valid: false,
        reason_code: "invalid_frame_count",
        expression_count: names.length,
        frame_count: frameCount,
      };
    }
    for (const frame of frames) {
      if (
        typeof frame !== "object" ||
        frame === null ||
        Array.isArray(frame)
      ) {
        return {
          valid: false,
          reason_code: "manifest_invalid",
          expression_count: names.length,
          frame_count: frameCount,
        };
      }
      const file = frame as Record<string, unknown>;
      if (!isSafePackPath(file["path"]) || !isSha256(file["sha256"])) {
        return {
          valid: false,
          reason_code: "invalid_file_checksum",
          expression_count: names.length,
          frame_count: frameCount,
        };
      }
      if (paths.has(file["path"])) {
        return {
          valid: false,
          reason_code: "duplicate_file_path",
          expression_count: names.length,
          frame_count: frameCount,
        };
      }
      paths.add(file["path"]);
      frameCount += 1;
    }
  }
  const identity = manifest["identity"];
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity) ||
    !isSafePackPath((identity as Record<string, unknown>)["path"]) ||
    !isSha256((identity as Record<string, unknown>)["sha256"])
  ) {
    return {
      valid: false,
      reason_code: "invalid_file_checksum",
      expression_count: names.length,
      frame_count: frameCount,
    };
  }
  return {
    valid: true,
    reason_code: "manifest_valid",
    expression_count: names.length,
    frame_count: frameCount,
  };
}

/** Validate the compact JPEG variant consumed by the T5 display runtime. */
export function validateDeviceAvatarManifest(
  manifest: unknown,
): ManifestValidationResult {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return {
      valid: false,
      reason_code: "manifest_invalid",
      expression_count: 0,
      frame_count: 0,
    };
  }
  const record = manifest as Record<string, unknown>;
  const expressions = record["expressions"];
  const identity = record["identity"];
  const identityRecord = identity as Record<string, unknown>;
  const identityPath = identityRecord?.["path"];
  if (
    record["schema_version"] !== 1 ||
    record["encoding"] !== "jpeg" ||
    record["renderer_contract"] !== "hshh-overlay-v1" ||
    record["width"] !== 320 ||
    record["height"] !== 240 ||
    record["frame_count"] !== EXPRESSIONS.length * 5 ||
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity) ||
    typeof identityPath !== "string" ||
    !isSafePackPath(identityPath) ||
    !identityPath.startsWith("device/") ||
    !identityPath.endsWith(".jpg") ||
    !isSha256(identityRecord["sha256"]) ||
    typeof expressions !== "object" ||
    expressions === null ||
    Array.isArray(expressions)
  ) {
    return {
      valid: false,
      reason_code: "manifest_invalid",
      expression_count: 0,
      frame_count: 0,
    };
  }
  const expressionMap = expressions as Record<string, unknown>;
  const names = Object.keys(expressionMap);
  if (
    names.length !== EXPRESSIONS.length ||
    names.some((name) => !EXPRESSIONS.includes(name as Expression))
  ) {
    return {
      valid: false,
      reason_code: "unexpected_expression",
      expression_count: names.length,
      frame_count: 0,
    };
  }
  const paths = new Set<string>();
  let frameCount = 0;
  for (const expression of EXPRESSIONS) {
    const frames = expressionMap[expression];
    if (!Array.isArray(frames) || frames.length !== 5) {
      return {
        valid: false,
        reason_code:
          frames === undefined ? "missing_expression" : "invalid_frame_count",
        expression_count: names.length,
        frame_count: frameCount,
      };
    }
    for (const frame of frames) {
      if (
        typeof frame !== "object" ||
        frame === null ||
        Array.isArray(frame)
      ) {
        return {
          valid: false,
          reason_code: "manifest_invalid",
          expression_count: names.length,
          frame_count: frameCount,
        };
      }
      const item = frame as Record<string, unknown>;
      const path = item["path"];
      if (
        !isSafePackPath(path) ||
        !path.startsWith("device/") ||
        !path.endsWith(".jpg") ||
        !isSha256(item["sha256"])
      ) {
        return {
          valid: false,
          reason_code: "invalid_file_checksum",
          expression_count: names.length,
          frame_count: frameCount,
        };
      }
      if (paths.has(path)) {
        return {
          valid: false,
          reason_code: "duplicate_file_path",
          expression_count: names.length,
          frame_count: frameCount,
        };
      }
      paths.add(path);
      frameCount += 1;
    }
  }
  return {
    valid: true,
    reason_code: "manifest_valid",
    expression_count: names.length,
    frame_count: frameCount,
  };
}

function packageManifest(
  identity: IdentityRecord,
  now: Date,
  identityChecksum: string,
  expressions: Record<Expression, Array<{ path: string; sha256: string }>>,
  deviceIdentityChecksum: string,
  deviceExpressions: Record<Expression, Array<{ path: string; sha256: string }>>,
): Record<string, unknown> {
  return {
    schema_version: 1,
    pet_id: identity.pet_id,
    asset_version: identity.asset_version,
    display_mode: "pet",
    width: 240,
    height: 320,
    pixel_format: "RGB565",
    identity: {
      path: "identity.png",
      sha256: identityChecksum,
    },
    expressions,
    device_package: {
      schema_version: 1,
      encoding: "jpeg",
      renderer_contract: "hshh-overlay-v1",
      width: 320,
      height: 240,
      frame_count: EXPRESSIONS.length * 5,
      identity: {
        path: "device/identity.jpg",
        sha256: deviceIdentityChecksum,
      },
      expressions: deviceExpressions,
    },
    created_at: now.toISOString(),
    compatible_firmware_resource_version: "hshh-p0-v1",
    composition: "single_identity_with_deterministic_overlays",
  };
}

const EXPRESSION_TINT: Record<Expression, string> = {
  idle: "#8fd3ff",
  noticed: "#ffe28a",
  listening: "#9de8d0",
  thinking: "#c9b6ff",
  happy: "#ffd1dc",
  confused: "#b6d8ff",
  sad: "#8db6d9",
  sleeping: "#8693c7",
  angry: "#ff9a8b",
};

function overlaySvg(expression: Expression, frameIndex: number): Buffer {
  const phase = frameIndex - 2;
  const blink = frameIndex === 2;
  const eyeHeight = blink ? 2 : expression === "noticed" ? 18 : 12;
  const eyeY = 130 + Math.abs(phase);
  const mouthByExpression: Record<Expression, string> = {
    idle: "M92 196 Q120 208 148 196",
    noticed: "M110 195 Q120 205 130 195 Q120 185 110 195",
    listening: "M96 198 Q120 210 144 198",
    thinking: "M104 200 Q120 194 136 200",
    happy: "M82 190 Q120 228 158 190",
    confused: "M92 202 Q106 188 120 202 Q134 216 148 202",
    sad: "M88 210 Q120 178 152 210",
    sleeping: "M104 202 Q120 208 136 202",
    angry: "M90 210 Q120 184 150 210",
  };
  const eyebrow = expression === "angry"
    ? '<path d="M62 111 L98 122 M178 111 L142 122" />'
    : expression === "confused"
      ? '<path d="M62 116 Q80 103 98 116 M142 112 Q160 124 178 112" />'
      : "";
  const sleepMarks = expression === "sleeping"
    ? '<text x="174" y="84" font-size="28" fill="#ffffff">z</text><text x="194" y="58" font-size="20" fill="#ffffff">z</text>'
    : "";
  const tear = expression === "sad"
    ? '<path d="M164 150 Q176 166 164 178 Q152 166 164 150" fill="#7dd9ff" stroke="none" />'
    : "";
  return Buffer.from(
    `<svg width="240" height="320" viewBox="0 0 240 320" xmlns="http://www.w3.org/2000/svg">
      <rect width="240" height="320" rx="26" fill="${EXPRESSION_TINT[expression]}" opacity="0.13" />
      <g fill="#151515" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <ellipse cx="78" cy="${eyeY}" rx="12" ry="${eyeHeight}" />
        <ellipse cx="162" cy="${eyeY}" rx="12" ry="${eyeHeight}" />
        ${eyebrow}
        <path d="${mouthByExpression[expression]}" fill="none" />
        ${tear}
      </g>
      ${sleepMarks}
      <circle cx="120" cy="286" r="5" fill="${EXPRESSION_TINT[expression]}" opacity="${0.55 + frameIndex * 0.08}" />
    </svg>`,
  );
}

function deviceOverlaySvg(expression: Expression, frameIndex: number): Buffer {
  const phase = frameIndex - 2;
  const blink = frameIndex === 2 || expression === "sleeping";
  const eyeHeight = blink ? 2 : expression === "noticed" ? 16 : 10;
  const eyeY = 96 + Math.abs(phase);
  const mouthByExpression: Record<Expression, string> = {
    idle: "M126 150 Q160 162 194 150",
    noticed: "M148 150 Q160 162 172 150 Q160 138 148 150",
    listening: "M130 151 Q160 166 190 151",
    thinking: "M142 154 Q160 146 178 154",
    happy: "M112 144 Q160 188 208 144",
    confused: "M124 156 Q142 140 160 156 Q178 172 196 156",
    sad: "M120 166 Q160 130 200 166",
    sleeping: "M142 155 Q160 162 178 155",
    angry: "M122 164 Q160 134 198 164",
  };
  const eyebrow = expression === "angry"
    ? '<path d="M78 76 L126 90 M242 76 L194 90" />'
    : expression === "confused"
      ? '<path d="M82 78 L124 72 M238 72 L196 80" />'
      : "";
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">` +
      `<g fill="#20232a" stroke="#f8f7f2" stroke-width="4" stroke-linecap="round">` +
      `<ellipse cx="106" cy="${eyeY}" rx="10" ry="${eyeHeight}"/>` +
      `<ellipse cx="214" cy="${eyeY}" rx="10" ry="${eyeHeight}"/>` +
      `<path d="${mouthByExpression[expression]}" fill="none" stroke-width="6"/>` +
      eyebrow +
      `</g></svg>`,
    "utf8",
  );
}

/**
 * Host-side, ephemeral metadata pipeline. Upload code stages trusted metadata;
 * the Agent only receives an opaque asset_ref and never raw pet photos.
 */
export class AvatarMetadataPipeline {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly assetRoot: string;
  private readonly staged = new Map<string, StoredStagedAsset>();
  private readonly validations = new Map<string, ValidationRecord>();
  private readonly identities = new Map<string, IdentityRecord>();
  private readonly packs = new Map<string, StoredPack>();

  constructor(options: AvatarMetadataPipelineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.assetRoot = resolve(
      options.assetRoot ?? join(tmpdir(), "hshh-avatar-packs"),
    );
  }

  stageAsset(input: StagedAvatarAsset, sourceBytes?: Uint8Array): string {
    const now = this.now();
    this.cleanup(now);
    const assetRef = input.asset_ref ?? `upload_${this.idFactory()}`;
    const retainedBytes = sourceBytes === undefined ? undefined : Buffer.from(sourceBytes);
    this.staged.set(assetRef, {
      ...structuredClone(input),
      asset_ref: assetRef,
      staged_at: now.toISOString(),
      expires_at: new Date(now.getTime() + PIPELINE_RECORD_TTL_MS).toISOString(),
      ...(retainedBytes === undefined ? {} : { source_bytes: retainedBytes }),
    });
    return assetRef;
  }

  validateAsset(
    assetRef: string,
    deviceId: string,
    requestId: string,
  ): PipelineResult {
    const now = this.now();
    this.cleanup(now);
    const asset = this.staged.get(assetRef);
    if (!asset || asset.device_id !== deviceId || asset.request_id !== requestId) {
      return { status: "rejected", reason_code: "asset_scope_mismatch" };
    }
    if (!ALLOWED_MIME_TYPES.includes(asset.mime_type as never)) {
      return { status: "rejected", reason_code: "unsupported_mime" };
    }
    if (
      !Number.isSafeInteger(asset.byte_length) ||
      asset.byte_length <= 0 ||
      asset.byte_length > MAX_AVATAR_SOURCE_BYTES
    ) {
      return { status: "rejected", reason_code: "asset_size_invalid" };
    }
    if (
      !Number.isSafeInteger(asset.width) ||
      !Number.isSafeInteger(asset.height) ||
      asset.width < 1 ||
      asset.height < 1 ||
      asset.width > 8_192 ||
      asset.height > 8_192
    ) {
      return { status: "rejected", reason_code: "asset_dimensions_invalid" };
    }
    if (!hasValidSignature(asset.mime_type, asset.header_hex)) {
      return { status: "rejected", reason_code: "mime_signature_mismatch" };
    }
    if (
      !isSha256(asset.checksum_sha256) ||
      !isSha256(asset.computed_checksum_sha256) ||
      asset.checksum_sha256.toLowerCase() !==
        asset.computed_checksum_sha256.toLowerCase()
    ) {
      return { status: "rejected", reason_code: "checksum_mismatch" };
    }
    const validationId = `validation_${this.idFactory()}`;
    const record: ValidationRecord = {
      validation_id: validationId,
      asset_ref: assetRef,
      device_id: deviceId,
      request_id: requestId,
      pet_id: asset.pet_id,
      asset_version: asset.asset_version,
      mime_type: asset.mime_type as (typeof ALLOWED_MIME_TYPES)[number],
      width: asset.width,
      height: asset.height,
      source_checksum_sha256: asset.computed_checksum_sha256.toLowerCase(),
      expires_at: asset.expires_at,
    };
    this.validations.set(validationId, record);
    return {
      status: "completed",
      reason_code: "asset_metadata_valid",
      validation_id: validationId,
      asset_ref: assetRef,
      mime_type: record.mime_type,
      byte_length: asset.byte_length,
      width: record.width,
      height: record.height,
      checksum_sha256: record.source_checksum_sha256,
      expires_at: record.expires_at,
    };
  }

  generateIdentity(
    validationId: string,
    deviceId: string,
    requestId: string,
    petType: "cat" | "dog",
    visibleTraits: string[],
  ): PipelineResult {
    const now = this.now();
    this.cleanup(now);
    const validation = this.validations.get(validationId);
    if (
      !validation ||
      validation.device_id !== deviceId ||
      validation.request_id !== requestId
    ) {
      return { status: "rejected", reason_code: "validation_scope_mismatch" };
    }
    const identityId = `identity_${this.idFactory()}`;
    const traits = visibleTraits.map((item) => item.trim()).filter(Boolean);
    const checksum = sha256(
      [validation.source_checksum_sha256, petType, ...traits].join(":"),
    );
    const identity: IdentityRecord = {
      identity_id: identityId,
      validation_id: validationId,
      device_id: deviceId,
      request_id: requestId,
      pet_id: validation.pet_id,
      asset_version: validation.asset_version,
      pet_type: petType,
      visible_traits: traits,
      identity_checksum_sha256: checksum,
      expires_at: validation.expires_at,
    };
    this.identities.set(identityId, identity);
    return {
      status: "completed",
      reason_code: "identity_spec_created",
      identity_id: identityId,
      pet_id: identity.pet_id,
      pet_type: identity.pet_type,
      visible_traits: identity.visible_traits,
      identity_checksum_sha256: checksum,
      expires_at: identity.expires_at,
      deterministic_composition: true,
    };
  }

  async composePack(
    identityId: string,
    deviceId: string,
    requestId: string,
    database: HshhDatabase,
  ): Promise<PipelineResult> {
    const now = this.now();
    this.cleanup(now);
    const identity = this.identities.get(identityId);
    if (
      !identity ||
      identity.device_id !== deviceId ||
      identity.request_id !== requestId
    ) {
      return { status: "rejected", reason_code: "identity_scope_mismatch" };
    }
    const validationRecord = this.validations.get(identity.validation_id);
    const staged = validationRecord
      ? this.staged.get(validationRecord.asset_ref)
      : undefined;
    if (!staged?.source_bytes) {
      return { status: "failed", reason_code: "source_bytes_unavailable" };
    }

    const packName = `${identity.pet_id}-${identity.asset_version}`;
    const finalRoot = resolve(this.assetRoot, packName);
    const tempRoot = resolve(
      this.assetRoot,
      `.${packName}.tmp-${this.idFactory()}`,
    );
    if (
      !finalRoot.startsWith(`${this.assetRoot}${sep}`) ||
      !tempRoot.startsWith(`${this.assetRoot}${sep}`)
    ) {
      return { status: "failed", reason_code: "unsafe_pack_path" };
    }

    try {
      await mkdir(this.assetRoot, { recursive: true });
      await mkdir(tempRoot, { recursive: false });

      const identityBytes = await sharp(staged.source_bytes, {
        limitInputPixels: 8_192 * 8_192,
        failOn: "error",
      })
        .rotate()
        .resize(240, 320, {
          fit: "cover",
          position: sharp.strategy.attention,
          withoutEnlargement: false,
        })
        .removeAlpha()
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      await writeFile(join(tempRoot, "identity.png"), identityBytes, {
        flag: "wx",
      });

      const expressionFiles = Object.fromEntries(
        await Promise.all(
          EXPRESSIONS.map(async (expression) => {
            const directory = join(tempRoot, "expressions", expression);
            await mkdir(directory, { recursive: true });
            const frames = await Promise.all(
              Array.from({ length: 5 }, async (_, index) => {
                const frameNumber = String(index + 1).padStart(2, "0");
                const relativePath =
                  `expressions/${expression}/${expression}_${frameNumber}.png`;
                const composed = sharp(identityBytes).composite([
                  { input: overlaySvg(expression, index) },
                ]);
                const frameBytes = await composed
                  .clone()
                  .png({ compressionLevel: 9, adaptiveFiltering: true })
                  .toBuffer();
                await writeFile(join(tempRoot, relativePath), frameBytes, {
                  flag: "wx",
                });
                return { path: relativePath, sha256: sha256(frameBytes) };
              }),
            );
            return [expression, frames] as const;
          }),
        ),
      ) as Record<Expression, Array<{ path: string; sha256: string }>>;

      const deviceDirectory = join(tempRoot, "device");
      await mkdir(deviceDirectory, { recursive: true });
      const deviceIdentitySource = sharp(staged.source_bytes, {
        limitInputPixels: 8_192 * 8_192,
        failOn: "error",
      })
        .rotate()
        .resize(320, 240, {
          fit: "cover",
          position: sharp.strategy.attention,
          withoutEnlargement: false,
        })
        .removeAlpha();
      let deviceIdentityBytes = await deviceIdentitySource
        .clone()
        .flatten({ background: "#111111" })
        .jpeg({ quality: 70, chromaSubsampling: "4:2:0" })
        .toBuffer();
      if (deviceIdentityBytes.length > 48 * 1024) {
        deviceIdentityBytes = await deviceIdentitySource
          .clone()
          .flatten({ background: "#111111" })
          .jpeg({ quality: 52, chromaSubsampling: "4:2:0" })
          .toBuffer();
      }
      if (deviceIdentityBytes.length > 48 * 1024) {
        throw new Error("device_identity_too_large");
      }
      await writeFile(join(deviceDirectory, "identity.jpg"), deviceIdentityBytes, {
        flag: "wx",
      });
      const deviceExpressionFiles = Object.fromEntries(
        await Promise.all(
          EXPRESSIONS.map(async (expression) => {
            const frames = await Promise.all(
              Array.from({ length: 5 }, async (_, index) => {
                const frameNumber = String(index + 1).padStart(2, "0");
                const relativePath = `device/${expression}_${frameNumber}.jpg`;
                const frameBytes = await sharp(deviceIdentityBytes)
                  .composite([{ input: deviceOverlaySvg(expression, index) }])
                  .flatten({ background: "#111111" })
                  .jpeg({ quality: 74, chromaSubsampling: "4:2:0" })
                  .toBuffer();
                await writeFile(join(tempRoot, relativePath), frameBytes, {
                  flag: "wx",
                });
                return { path: relativePath, sha256: sha256(frameBytes) };
              }),
            );
            return [expression, frames] as const;
          }),
        ),
      ) as Record<Expression, Array<{ path: string; sha256: string }>>;

      const manifest = packageManifest(
        identity,
        now,
        sha256(identityBytes),
        expressionFiles,
        sha256(deviceIdentityBytes),
        deviceExpressionFiles,
      );
      const validation = validateAvatarManifest(manifest);
      if (!validation.valid) {
        return {
          status: "failed",
          reason_code: validation.reason_code,
          manifest_validation: validation,
        };
      }
      const manifestBytes = Buffer.from(
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(tempRoot, "manifest.json"), manifestBytes, {
        flag: "wx",
      });
      await rename(tempRoot, finalRoot);
      const checksum = sha256(JSON.stringify(manifest));
      const asset = database.createPetAsset({
        device_id: deviceId,
        pet_id: identity.pet_id,
        asset_version: identity.asset_version,
        manifest,
        checksum_sha256: checksum,
        status: "ready",
      });
      this.packs.set(asset.id, {
        asset_id: asset.id,
        device_id: deviceId,
        root: finalRoot,
      });
      return {
        status: "completed",
        reason_code: "expression_pack_ready",
        asset,
        manifest_validation: validation,
        generated_files: 93,
        original_photo_deleted: true,
      };
    } catch (error) {
      return {
        status: "failed",
        reason_code:
          error instanceof Error && "code" in error && error.code === "EEXIST"
            ? "asset_version_conflict"
            : "image_composition_failed",
      };
    } finally {
      staged.source_bytes.fill(0);
      delete staged.source_bytes;
      this.staged.delete(staged.asset_ref);
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  async readPackFile(
    assetId: string,
    deviceId: string,
    relativePath: string,
  ): Promise<Buffer | undefined> {
    const pack = this.packs.get(assetId);
    if (!pack || pack.device_id !== deviceId || !isSafePackPath(relativePath)) {
      return undefined;
    }
    const candidate = resolve(pack.root, relativePath);
    if (!candidate.startsWith(`${pack.root}${sep}`)) return undefined;
    try {
      return await readFile(candidate);
    } catch {
      return undefined;
    }
  }

  /** Re-attaches a persisted pack after a service restart only after rehashing every file. */
  async restorePack(asset: PetAssetRecord): Promise<boolean> {
    if (
      !validateAvatarManifest(asset.manifest).valid ||
      !validateDeviceAvatarManifest(asset.manifest["device_package"]).valid ||
      sha256(JSON.stringify(asset.manifest)) !== asset.checksum_sha256
    ) {
      return false;
    }
    const packRoot = resolve(
      this.assetRoot,
      `${asset.pet_id}-${asset.asset_version}`,
    );
    if (!packRoot.startsWith(`${this.assetRoot}${sep}`)) return false;

    const fileRecords: Array<{ path: string; sha256: string }> = [];
    const identity = asset.manifest["identity"] as
      | Record<string, unknown>
      | undefined;
    if (
      !identity ||
      !isSafePackPath(identity["path"]) ||
      !isSha256(identity["sha256"])
    ) {
      return false;
    }
    fileRecords.push({
      path: identity["path"],
      sha256: identity["sha256"].toLowerCase(),
    });
    const devicePackage = asset.manifest["device_package"] as
      | Record<string, unknown>
      | undefined;
    const deviceIdentity = devicePackage?.["identity"] as
      | Record<string, unknown>
      | undefined;
    if (
      !deviceIdentity ||
      !isSafePackPath(deviceIdentity["path"]) ||
      !isSha256(deviceIdentity["sha256"])
    ) {
      return false;
    }
    fileRecords.push({
      path: deviceIdentity["path"],
      sha256: deviceIdentity["sha256"].toLowerCase(),
    });
    for (const key of ["expressions", "device_package"] as const) {
      const container =
        key === "expressions"
          ? asset.manifest
          : (asset.manifest["device_package"] as Record<string, unknown>);
      const expressions = container["expressions"] as Record<string, unknown>;
      for (const expression of EXPRESSIONS) {
        for (const raw of expressions[expression] as unknown[]) {
          const frame = raw as Record<string, unknown>;
          if (!isSafePackPath(frame["path"]) || !isSha256(frame["sha256"])) {
            return false;
          }
          fileRecords.push({
            path: frame["path"],
            sha256: frame["sha256"].toLowerCase(),
          });
        }
      }
    }
    try {
      for (const file of fileRecords) {
        const candidate = resolve(packRoot, file.path);
        if (!candidate.startsWith(`${packRoot}${sep}`)) return false;
        if (sha256(await readFile(candidate)) !== file.sha256) return false;
      }
    } catch {
      return false;
    }
    this.packs.set(asset.id, {
      asset_id: asset.id,
      device_id: asset.device_id,
      root: packRoot,
    });
    return true;
  }

  hasPack(assetId: string, deviceId: string): boolean {
    const pack = this.packs.get(assetId);
    return pack?.device_id === deviceId;
  }

  private cleanup(now: Date): void {
    for (const [key, item] of this.staged) {
      if (Date.parse(item.expires_at) <= now.getTime()) {
        item.source_bytes?.fill(0);
        this.staged.delete(key);
      }
    }
    for (const [key, item] of this.validations) {
      if (Date.parse(item.expires_at) <= now.getTime()) {
        this.validations.delete(key);
      }
    }
    for (const [key, item] of this.identities) {
      if (Date.parse(item.expires_at) <= now.getTime()) {
        this.identities.delete(key);
      }
    }
  }
}

export interface HshhAvatarMcpOptions {
  database: HshhDatabase;
  pipeline: AvatarMetadataPipeline;
  deviceId: string;
  requestId: string;
}

function mcpResult(value: PipelineResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(value.status === "failed" ? { isError: true } : {}),
  };
}

function scopeCheck(
  deviceId: string,
  requestId: string,
  options: HshhAvatarMcpOptions,
): PipelineResult | undefined {
  if (deviceId !== options.deviceId) {
    return { status: "rejected", reason_code: "device_scope_mismatch" };
  }
  if (requestId !== options.requestId) {
    return { status: "rejected", reason_code: "request_scope_mismatch" };
  }
  return undefined;
}

function scopedAsset(
  database: HshhDatabase,
  assetId: string,
  deviceId: string,
): PetAssetRecord | undefined {
  const asset = database.getPetAsset(assetId);
  return asset?.device_id === deviceId ? asset : undefined;
}

/** Request-scoped avatar MCP. Raw user photos are never tool input. */
export function createHshhAvatarMcpServer(
  options: HshhAvatarMcpOptions,
): McpSdkServerConfigWithInstance {
  const scopedInput = {
    device_id: z.string().trim().min(1).max(128),
    request_id: z.string().trim().min(1).max(128),
  };

  const validateAsset = tool(
    "validate_asset",
    "Validate trusted metadata for an already staged JPEG/PNG/WebP pet photo. The Agent passes only an opaque asset_ref; raw photos, URLs, and base64 are not accepted. Maximum size is 8 MB.",
    {
      ...scopedInput,
      asset_ref: z.string().trim().min(1).max(128),
    },
    async ({ device_id, request_id, asset_ref }) => {
      const scope = scopeCheck(device_id, request_id, options);
      return mcpResult(
        scope ?? options.pipeline.validateAsset(asset_ref, device_id, request_id),
      );
    },
    {
      annotations: {
        title: "Validate staged pet asset metadata",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const generateIdentity = tool(
    "generate_identity",
    "Create a single identity-layer specification from a validated staged asset. The source photo remains opaque to the Agent and deterministic frame composition happens in the next tool.",
    {
      ...scopedInput,
      validation_id: z.string().trim().min(1).max(128),
      pet_type: z.enum(["cat", "dog"]),
      visible_traits: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
    },
    async ({ device_id, request_id, validation_id, pet_type, visible_traits }) => {
      const scope = scopeCheck(device_id, request_id, options);
      return mcpResult(
        scope ??
          options.pipeline.generateIdentity(
            validation_id,
            device_id,
            request_id,
            pet_type,
            visible_traits,
          ),
      );
    },
    {
      annotations: {
        title: "Generate pet identity metadata",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const composeExpressionPack = tool(
    "compose_expression_pack",
    "Compose a real deterministic P0 PNG pack from one identity layer with exactly 9 registered expressions and 5 frames each, validate actual file SHA-256 values, delete the original upload, then store the pack as ready. It does not activate the pack.",
    {
      ...scopedInput,
      identity_id: z.string().trim().min(1).max(128),
    },
    async ({ device_id, request_id, identity_id }) => {
      const scope = scopeCheck(device_id, request_id, options);
      if (scope) return mcpResult(scope);
      return mcpResult(
        await options.pipeline.composePack(
          identity_id,
          device_id,
          request_id,
          options.database,
        ),
      );
    },
    {
      annotations: {
        title: "Compose deterministic expression pack",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const previewPack = tool(
    "preview_pack",
    "Read validated preview metadata for a ready or active real PNG pack. It returns no original upload and performs no activation.",
    {
      ...scopedInput,
      asset_id: z.string().trim().min(1).max(128),
    },
    async ({ device_id, request_id, asset_id }) => {
      const scope = scopeCheck(device_id, request_id, options);
      if (scope) return mcpResult(scope);
      const asset = scopedAsset(options.database, asset_id, device_id);
      if (!asset) {
        return mcpResult({ status: "rejected", reason_code: "asset_not_found" });
      }
      const validation = validateAvatarManifest(asset.manifest);
      if (!validation.valid) {
        return mcpResult({
          status: "failed",
          reason_code: validation.reason_code,
          active_asset_unchanged: true,
        });
      }
      return mcpResult({
        status: "completed",
        reason_code: "preview_metadata_ready",
        asset_id: asset.id,
        pet_id: asset.pet_id,
        asset_version: asset.asset_version,
        asset_status: asset.status,
        manifest_validation: validation,
        preview: {
          expression_ids: [...EXPRESSIONS],
          frames_per_expression: 5,
          total_frames: 45,
        },
        generated_pack_available: options.pipeline.hasPack(asset.id, device_id),
      });
    },
    {
      annotations: {
        title: "Preview expression pack metadata",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const activatePack = tool(
    "activate_pack",
    "Atomically activate one ready, fully revalidated pack. Validation failure leaves the currently active pack unchanged.",
    {
      ...scopedInput,
      asset_id: z.string().trim().min(1).max(128),
    },
    async ({ device_id, request_id, asset_id }) => {
      const scope = scopeCheck(device_id, request_id, options);
      if (scope) return mcpResult(scope);
      const asset = scopedAsset(options.database, asset_id, device_id);
      if (!asset) {
        return mcpResult({ status: "rejected", reason_code: "asset_not_found" });
      }
      if (asset.status !== "ready" && asset.status !== "active") {
        return mcpResult({
          status: "rejected",
          reason_code: "asset_not_ready",
          active_asset_unchanged: true,
        });
      }
      const validation = validateAvatarManifest(asset.manifest);
      const computedChecksum = sha256(JSON.stringify(asset.manifest));
      if (
        !validation.valid ||
        computedChecksum !== asset.checksum_sha256.toLowerCase()
      ) {
        return mcpResult({
          status: "failed",
          reason_code: validation.valid
            ? "package_checksum_mismatch"
            : validation.reason_code,
          active_asset_unchanged: true,
        });
      }
      const activated = options.database.activatePetAsset(device_id, asset_id);
      if (!activated) {
        return mcpResult({
          status: "failed",
          reason_code: "atomic_activation_failed",
          active_asset_unchanged: true,
        });
      }
      return mcpResult({
        status: "completed",
        reason_code: "pack_atomically_activated",
        asset: activated,
      });
    },
    {
      annotations: {
        title: "Atomically activate pet pack",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  return createSdkMcpServer({
    name: "hshh_avatar",
    version: "0.1.0",
    instructions:
      "Request-scoped P0 avatar pipeline. Never expose raw pet photos. Validation, deterministic image composition and activation are separate; only a ready, checksum-valid 9x5 pack may be atomically activated.",
    tools: [
      validateAsset,
      generateIdentity,
      composeExpressionPack,
      previewPack,
      activatePack,
    ],
  });
}

export const HSHH_AVATAR_TOOL_NAMES = [
  "mcp__hshh_avatar__validate_asset",
  "mcp__hshh_avatar__generate_identity",
  "mcp__hshh_avatar__compose_expression_pack",
  "mcp__hshh_avatar__preview_pack",
  "mcp__hshh_avatar__activate_pack",
] as const;
