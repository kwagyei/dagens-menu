/**
 * Opening hours for the admin (ADR-011 plan M5.4): the seven weekdays and dated exceptions
 * (holidays, special hours). Same rules as every content write: scoped to the context's
 * site, validated with the content schema, one batch with its audit entry.
 */
import { restaurantDay } from "../content/hours";
import { dayHours, isoDate, localizedText, TEXT_LIMITS } from "../content/schema";
import { WEEKDAYS, type Weekday } from "../content/vocabulary";
import { commit, commitIf, type RepoContext, type WriteResult } from "./repository";
import { stmt } from "./sql";

export interface Hours {
  open: string;
  close: string;
}

export interface AdminException {
  date: string;
  hours: Hours | null;
  note: { sv: string; en: string };
}

export interface AdminHours {
  weekly: Record<Weekday, Hours | null>;
  exceptions: AdminException[];
}

/** How far ahead an exception may be dated (ADR-011 §8). */
export const EXCEPTION_HORIZON_YEARS = 2;

type Row = Record<string, unknown>;
const hoursOf = (r: Row): Hours | null => (r.opens === null ? null : { open: r.opens as string, close: r.closes as string });

export async function adminHours(ctx: RepoContext): Promise<AdminHours> {
  const [weekly, exceptions] = await ctx.db.batch<Row>([
    ctx.db.prepare("SELECT weekday, opens, closes FROM weekly_hours WHERE site_id = ?").bind(ctx.siteId),
    ctx.db.prepare("SELECT date, opens, closes, note_sv, note_en FROM hours_exceptions WHERE site_id = ? ORDER BY date").bind(ctx.siteId),
  ]);
  const byDay = new Map(weekly.results.map((r) => [r.weekday as number, hoursOf(r)]));
  return {
    weekly: Object.fromEntries(WEEKDAYS.map((day, i) => [day, byDay.get(i) ?? null])) as Record<Weekday, Hours | null>,
    exceptions: exceptions.results.map((r) => ({ date: r.date as string, hours: hoursOf(r), note: { sv: r.note_sv as string, en: r.note_en as string } })),
  };
}

const describe = (h: Hours | null) => (h ? `${h.open}–${h.close}` : "closed");

/** Replace the weekly hours, all seven days in one write. */
export async function saveWeeklyHours(ctx: RepoContext, weekly: Record<Weekday, Hours | null>): Promise<WriteResult> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const day of WEEKDAYS) {
    const checked = dayHours.nullable().safeParse(weekly[day] ?? null);
    if (!checked.success) for (const i of checked.error.issues) issues.push({ path: [day, ...i.path].join("."), message: i.message });
  }
  if (issues.length > 0) return { ok: false, error: "invalid", issues };
  await commit(
    ctx,
    WEEKDAYS.map((day, weekday) =>
      stmt(
        `INSERT INTO weekly_hours (site_id, weekday, opens, closes) VALUES (?, ?, ?, ?)
         ON CONFLICT (site_id, weekday) DO UPDATE SET opens = excluded.opens, closes = excluded.closes`,
        ctx.siteId,
        weekday,
        weekly[day]?.open ?? null,
        weekly[day]?.close ?? null,
      ),
    ),
    { entity: "hours", entityId: null, action: "update", summary: `weekly hours: ${WEEKDAYS.map((d) => `${d.slice(0, 3)} ${describe(weekly[d])}`).join(", ")}` },
  );
  return { ok: true };
}

const exceptionNote = localizedText(TEXT_LIMITS.short);

export type ExceptionResult = WriteResult | { ok: false; error: "past" | "too-far" | "duplicate" };

function addYears(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number);
  // 29 Feb plus two years becomes 28 Feb, not 1 Mar.
  const target = new Date(Date.UTC(y + years, m - 1, 1));
  const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Add a holiday or special-hours day: from today (in Stockholm) up to two years ahead. */
export async function addException(ctx: RepoContext, exception: AdminException): Promise<ExceptionResult> {
  const issues: Array<{ path: string; message: string }> = [];
  const date = isoDate.safeParse(exception.date);
  if (!date.success) issues.push({ path: "date", message: date.error.issues[0].message });
  const hours = dayHours.nullable().safeParse(exception.hours);
  if (!hours.success) for (const i of hours.error.issues) issues.push({ path: ["hours", ...i.path].join("."), message: i.message });
  const note = exceptionNote.safeParse(exception.note);
  if (!note.success) for (const i of note.error.issues) issues.push({ path: ["note", ...i.path].join("."), message: i.message });
  if (issues.length > 0 || !date.success || !hours.success || !note.success) return { ok: false, error: "invalid", issues };

  const today = restaurantDay(ctx.now).date;
  if (date.data < today) return { ok: false, error: "past" };
  if (date.data > addYears(today, EXCEPTION_HORIZON_YEARS)) return { ok: false, error: "too-far" };

  const added = await commitIf(
    ctx,
    stmt(
      `INSERT INTO hours_exceptions (site_id, date, opens, closes, note_sv, note_en) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, date) DO NOTHING`,
      ctx.siteId,
      date.data,
      hours.data?.open ?? null,
      hours.data?.close ?? null,
      note.data.sv,
      note.data.en,
    ),
    { entity: "hours_exception", entityId: date.data, action: "create", summary: `${date.data}: ${describe(hours.data)} (${note.data.sv})` },
  );
  return added ? { ok: true } : { ok: false, error: "duplicate" };
}

export async function removeException(ctx: RepoContext, date: string): Promise<WriteResult> {
  const removed = await commitIf(ctx, stmt("DELETE FROM hours_exceptions WHERE site_id = ? AND date = ?", ctx.siteId, date), {
    entity: "hours_exception",
    entityId: date,
    action: "delete",
    summary: `${date}: exception removed`,
  });
  return removed ? { ok: true } : { ok: false, error: "not-found" };
}
