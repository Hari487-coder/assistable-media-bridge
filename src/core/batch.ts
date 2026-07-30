import { mapLimit } from "./concurrency";
import { type ProvisionDeps, provisionTenant } from "./provision";
import type { TenantInput } from "../store/tenants";

/**
 * Bulk onboarding for an agency running one Assistable workspace across many
 * subaccounts. The three credentials are pasted ONCE and stamped onto every
 * row; only the per-subaccount identifiers vary.
 *
 * Each row is provisioned through the ordinary `provisionTenant` path, so batch
 * onboarding has exactly the same validation, tool creation and reconnect
 * semantics as the single form — there is no second, weaker code path. That
 * also makes a batch safely re-runnable: rows that already succeeded reconnect
 * in place (same token, same live tool URL) instead of duplicating, so fixing
 * one bad line and re-submitting the whole list is the intended workflow.
 */

/** Hard ceiling on one submission — bounds request size and blast radius. */
export const MAX_BATCH_ROWS = 50;

/** Rows run a few at a time: sequential is slow enough on a long list to risk a
 *  proxy timeout mid-provision, and unbounded parallelism would hammer the v3
 *  rate limiter. Four is well inside both. */
const BATCH_CONCURRENCY = 4;

export interface BatchRow {
  subAccountId: string;
  locationId: string;
  /** Optional — resolved automatically when the subaccount has exactly one. */
  assistantId?: string;
  label?: string;
}

export interface BatchShared {
  provider: TenantInput["provider"];
  v3Key: string;
  ghlPit: string;
  aiKey: string;
}

export interface BatchOutcome {
  row: BatchRow;
  ok: boolean;
  token?: string;
  assistantId?: string;
  toolId?: string | null;
  reconnected?: boolean;
  warnings: string[];
  error?: string;
}

/**
 * Parse the pasted subaccount list. One row per line, comma OR tab separated so
 * a spreadsheet column paste works unchanged:
 *
 *   subAccountId, locationId[, assistantId[, label]]
 *
 * Blank lines and `#` comments are skipped. Parse errors are returned per line
 * rather than thrown — one malformed line must not discard the other 40.
 */
export function parseBatchRows(
  text: string
): { rows: BatchRow[]; errors: Array<{ line: number; text: string; error: string }> } {
  const rows: BatchRow[] = [];
  const errors: Array<{ line: number; text: string; error: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = raw.split(/[\t,]/).map((p) => p.trim());
    const [subAccountId, locationId, assistantId, ...rest] = parts;
    if (!subAccountId || !locationId) {
      errors.push({
        line: i + 1, text: raw,
        error: "expected at least: subAccountId, locationId",
      });
      continue;
    }
    // Anything past the 4th field rejoins the label — a comma inside a business
    // name ("Main Street Dental, PC") is far likelier than a fifth column.
    rows.push({
      subAccountId, locationId,
      ...(assistantId ? { assistantId } : {}),
      ...(rest.length ? { label: rest.join(", ") } : {}),
    });
  }
  if (rows.length > MAX_BATCH_ROWS) {
    errors.push({
      line: 0, text: "",
      error: `${rows.length} subaccounts listed — ${MAX_BATCH_ROWS} is the per-submission limit. Split the list.`,
    });
    rows.length = 0;
  }
  return { rows, errors };
}

/**
 * Fill in a row's assistant when it was left blank. Only unambiguous when the
 * subaccount holds exactly one assistant — otherwise the row fails loudly with
 * the actual choices rather than the bridge picking one and silently wiring
 * media into the wrong bot.
 */
async function resolveAssistantId(
  deps: ProvisionDeps, shared: BatchShared, row: BatchRow
): Promise<string> {
  if (row.assistantId) return row.assistantId;
  const assistants = await deps.v3Factory(shared.v3Key, row.subAccountId).listAssistants();
  if (assistants.length === 1) return assistants[0].id;
  if (assistants.length === 0) {
    throw new Error("this subaccount has no assistants — create one first");
  }
  throw new Error(
    `this subaccount has ${assistants.length} assistants, so the assistant ID cannot be inferred — name one of: ` +
    assistants.map((a) => `${a.id} (${a.name})`).join(", ")
  );
}

export async function provisionBatch(
  deps: ProvisionDeps, shared: BatchShared, rows: BatchRow[]
): Promise<BatchOutcome[]> {
  return mapLimit(rows, BATCH_CONCURRENCY, async (row): Promise<BatchOutcome> => {
    try {
      const assistantId = await resolveAssistantId(deps, shared, row);
      const r = await provisionTenant(deps, {
        label: row.label?.trim() || row.locationId,
        locationId: row.locationId,
        assistantId,
        subAccountId: row.subAccountId,
        provider: shared.provider,
        v3Key: shared.v3Key,
        ghlPit: shared.ghlPit,
        aiKey: shared.aiKey,
      });
      return {
        row, ok: true, token: r.tenant.token, assistantId,
        toolId: r.toolId, reconnected: r.reconnected, warnings: r.warnings,
      };
    } catch (err) {
      // One bad subaccount (revoked PIT, wrong id, missing assistant) must never
      // abort the rest of the list — it becomes a failed ROW, and re-running the
      // batch after fixing it reconnects the rows that already worked.
      return {
        row, ok: false, warnings: [],
        error: err instanceof Error ? err.message : "provisioning failed",
      };
    }
  });
}
