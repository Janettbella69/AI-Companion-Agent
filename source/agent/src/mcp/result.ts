export const HSHH_TOOL_STATUSES = [
  "accepted",
  "rejected",
  "completed",
  "stopped",
  "failed",
] as const;

export type HshhToolStatus = (typeof HSHH_TOOL_STATUSES)[number];

export type HshhStructuredResult<
  Payload extends Record<string, unknown> = Record<string, unknown>,
> = {
  status: HshhToolStatus;
  reason_code: string;
} & Payload;

const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

/** Convert policy detail into a stable, transport-safe reason code. */
export function normalizeReasonCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized && /^[a-z]/.test(normalized)
    ? normalized
    : "unspecified_result";
}

export function createStructuredResult<
  Payload extends Record<string, unknown>,
>(
  status: HshhToolStatus,
  reasonCode: string,
  payload: Payload,
): HshhStructuredResult<Payload> {
  const normalizedReasonCode = normalizeReasonCode(reasonCode);
  if (!REASON_CODE_PATTERN.test(normalizedReasonCode)) {
    throw new Error(`Invalid MCP reason_code: ${reasonCode}`);
  }
  return {
    ...payload,
    status,
    reason_code: normalizedReasonCode,
  };
}

/**
 * Every HSHH MCP tool returns the same object both as JSON text and as MCP
 * structuredContent. Expected policy rejections are not protocol errors;
 * only an execution failure sets isError.
 */
export function toMcpToolResult<Payload extends Record<string, unknown>>(
  structuredContent: HshhStructuredResult<Payload>,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
    ...(structuredContent.status === "failed" ? { isError: true } : {}),
  };
}

export function mcpResult<Payload extends Record<string, unknown>>(
  status: HshhToolStatus,
  reasonCode: string,
  payload: Payload,
) {
  return toMcpToolResult(createStructuredResult(status, reasonCode, payload));
}
