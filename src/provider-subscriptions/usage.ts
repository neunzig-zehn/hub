import { z } from "zod";

const windowSchema = z
  .object({
    utilization: z.number().finite(),
    resets_at: z.string().optional().nullable(),
  })
  .passthrough();
const codexWindowSchema = z
  .object({
    used_percent: z.number().finite(),
    limit_window_seconds: z.number().int(),
    reset_at: z.number().int().optional(),
  })
  .passthrough();
const codexSchema = z
  .object({
    rate_limit: z
      .object({
        primary_window: codexWindowSchema.nullable().optional(),
        secondary_window: codexWindowSchema.nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();
const claudeSchema = z
  .object({
    five_hour: windowSchema.nullable().optional(),
    seven_day: windowSchema.nullable().optional(),
    limits: z.array(z.unknown()).optional(),
  })
  .passthrough();
const scopedLimitSchema = z
  .object({
    kind: z.literal("weekly_scoped"),
    percent: z.number().finite(),
    resets_at: z.string().optional().nullable(),
    scope: z.object({ model: z.object({ display_name: z.string().nullable().optional() }) }),
  })
  .passthrough();

export interface UsageWindow {
  usedPercent: number;
  resetsAt: string | null;
}

export interface ProviderUsage {
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  fable: UsageWindow | null;
  checkedAt: string;
}

/** Usage APIs are read only; an unavailable window stays absent rather than being guessed. */
export async function fetchProviderUsage(
  family: "codex" | "claude",
  credential: string,
  fetcher: typeof fetch = fetch,
): Promise<ProviderUsage | null> {
  let url: string;
  let headers: Record<string, string>;
  if (family === "codex") {
    const auth = z
      .object({
        tokens: z
          .object({
            access_token: z.string().min(1),
            account_id: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .safeParse(JSON.parse(credential) as unknown);
    if (!auth.success) return null;
    url = "https://chatgpt.com/backend-api/wham/usage";
    headers = { Authorization: `Bearer ${auth.data.tokens.access_token}` };
    if (auth.data.tokens.account_id) headers["ChatGPT-Account-ID"] = auth.data.tokens.account_id;
  } else {
    url = "https://api.anthropic.com/api/oauth/usage";
    headers = { Authorization: `Bearer ${credential}`, "anthropic-beta": "oauth-2025-04-20" };
  }
  const response = await fetcher(url, {
    headers,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return null;
  const body = await response.text();
  if (body.length > 100_000) return null;
  const raw: unknown = JSON.parse(body);
  return family === "codex" ? codexUsage(raw) : claudeUsage(raw);
}

export function codexUsage(raw: unknown): ProviderUsage | null {
  const parsed = codexSchema.safeParse(raw);
  if (!parsed.success) return null;
  const windows = [
    parsed.data.rate_limit?.primary_window,
    parsed.data.rate_limit?.secondary_window,
  ];
  const window = (seconds: number): UsageWindow | null => {
    const found = windows.find((item) => item?.limit_window_seconds === seconds);
    return found ? { usedPercent: found.used_percent, resetsAt: epoch(found.reset_at) } : null;
  };
  return {
    fiveHour: window(18_000),
    weekly: window(604_800),
    fable: null,
    checkedAt: new Date().toISOString(),
  };
}

export function claudeUsage(raw: unknown): ProviderUsage | null {
  const parsed = claudeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { five_hour, seven_day, limits } = parsed.data;
  const scoped = limits
    ?.map((item) => scopedLimitSchema.safeParse(item))
    .find(
      (item) => item.success && /^fable(?:\s|$)/iu.test(item.data.scope.model.display_name ?? ""),
    );
  const window = (item: typeof five_hour): UsageWindow | null =>
    item ? { usedPercent: item.utilization, resetsAt: iso(item.resets_at) } : null;
  return {
    fiveHour: window(five_hour),
    weekly: window(seven_day),
    fable: scoped?.success
      ? { usedPercent: scoped.data.percent, resetsAt: iso(scoped.data.resets_at) }
      : null,
    checkedAt: new Date().toISOString(),
  };
}

function epoch(value: number | undefined): string | null {
  if (value === undefined) return null;
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
