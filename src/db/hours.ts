/**
 * Opening hours for the admin (ADR-011 plan M5.4): the seven weekdays and dated exceptions
 * (holidays, special hours). Same rules as every content write: scoped to the context's
 * site, validated with the content schema, one batch with its audit entry.
 */
import { restaurantDay } from "../content/hours";
import { dayHours, isoDate, localizedText, TEXT_LIMITS } from "../content/schema";
import { WEEKDAYS, type Weekday } from "../content/vocabulary";
import { commitIf, type RepoContext, type WriteResult } from "./repository";
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
  /** The version token for the weekly form: saving with a stale one is a conflict. */
  weeklyToken: string;
  exceptions: AdminException[];
}

/** How far ahead an exception may be dated (ADR-011 §8). */
export const EXCEPTION_HORIZON_YEARS = 2;

type Row = Record<string, unknown>;
const hoursOf = (r: Row): Hours | null => (r.opens === null ? null : { open: r.opens as string, close: r.closes as string });

const describe = (h: Hours | null) => (h ? `${h.open}–${h.close}` : "closed");
const sameHours = (a: Hours | null, b: Hours | null) => (a === null || b === null ? a === b : a.open === b.open && a.close === b.close);

/**
 * The week as the form saw it, Monday first: "11:00-22:00,closed,…". The week has no row of
 * its own to carry a row_version, so the token is the content itself, which makes the check
 * exact: a save goes through only if the stored week is still the one the form showed.
 */
export const weeklyToken = (weekly: Record<Weekday, Hours | null>): string => WEEKDAYS.map((d) => (weekly[d] ? `${weekly[d].open}-${weekly[d].close}` : "closed")).join(",");

/** The week a token stands for, or null if it isn't one (a tampered or truncated form). */
export function parseWeeklyToken(token: string): Record<Weekday, Hours | null> | null {
  const days = token.split(",");
  if (days.length !== WEEKDAYS.length) return null;
  const weekly = {} as Record<Weekday, Hours | null>;
  for (const [i, day] of WEEKDAYS.entries()) {
    if (days[i] === "closed") weekly[day] = null;
    else {
      const [open, close, extra] = days[i].split("-");
      const checked = dayHours.safeParse({ open, close });
      if (extra !== undefined || !checked.success) return null;
      weekly[day] = checked.data;
    }
  }
  return weekly;
}

export async function adminHours(ctx: RepoContext): Promise<AdminHours> {
  const [weekly, exceptions] = await ctx.db.batch<Row>([
    ctx.db.prepare("SELECT weekday, opens, closes FROM weekly_hours WHERE site_id = ?").bind(ctx.siteId),
    ctx.db.prepare("SELECT date, opens, closes, note_sv, note_en FROM hours_exceptions WHERE site_id = ? ORDER BY date").bind(ctx.siteId),
  ]);
  const byDay = new Map(weekly.results.map((r) => [r.weekday as number, hoursOf(r)]));
  const week = Object.fromEntries(WEEKDAYS.map((day, i) => [day, byDay.get(i) ?? null])) as Record<Weekday, Hours | null>;
  return {
    weekly: week,
    weeklyToken: weeklyToken(week),
    exceptions: exceptions.results.map((r) => ({ date: r.date as string, hours: hoursOf(r), note: { sv: r.note_sv as string, en: r.note_en as string } })),
  };
}

export type WeeklyResult =
  { ok: true; unchanged?: true } | { ok: false; error: "conflict"; current: string } | { ok: false; error: "invalid"; issues: Array<{ path: string; message: string }> };

/**
 * Save the weekly hours. `token` is weeklyToken() of the week the form was rendered from:
 *
 * - Only the days that differ from it are written, so an unchanged save writes nothing: no
 *   content_version bump, no audit entry. The result says `unchanged`.
 * - If someone saved the week in between, the result is a conflict with the current token
 *   and nothing is written; saving again with that token overwrites, knowingly.
 *
 * The check and the write are one statement, so nothing can slip in between them.
 */
export async function saveWeeklyHours(ctx: RepoContext, token: string, weekly: Record<Weekday, Hours | null>): Promise<WeeklyResult> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const day of WEEKDAYS) {
    const checked = dayHours.nullable().safeParse(weekly[day] ?? null);
    if (!checked.success) for (const i of checked.error.issues) issues.push({ path: [day, ...i.path].join("."), message: i.message });
  }
  if (issues.length > 0) return { ok: false, error: "invalid", issues };
  const conflict = async (): Promise<WeeklyResult> => {
    const current = (await adminHours(ctx)).weekly;
    // Someone else saved exactly this week in between: already the outcome asked for.
    if (WEEKDAYS.every((d) => sameHours(current[d], weekly[d] ?? null))) return { ok: true, unchanged: true };
    return { ok: false, error: "conflict", current: weeklyToken(current) };
  };
  const seen = parseWeeklyToken(token);
  if (!seen) return conflict();
  const changed = WEEKDAYS.flatMap((day, weekday) => (sameHours(seen[day], weekly[day] ?? null) ? [] : [{ day, weekday, hours: weekly[day] ?? null }]));
  if (changed.length === 0) return { ok: true, unchanged: true };

  // A missing row reads as closed, as in adminHours(): the LEFT JOIN gives it NULL hours.
  const seenRows = WEEKDAYS.map(() => "(?, ?, ?)").join(", ");
  const newRows = changed.map(() => "(?, ?, ?)").join(", ");
  const written = await commitIf(
    ctx,
    stmt(
      `INSERT INTO weekly_hours (site_id, weekday, opens, closes)
       SELECT ?, n.column1, n.column2, n.column3 FROM (VALUES ${newRows}) AS n
       WHERE NOT EXISTS (
         SELECT 1 FROM (VALUES ${seenRows}) AS s
         LEFT JOIN weekly_hours w ON w.site_id = ? AND w.weekday = s.column1
         WHERE w.opens IS NOT s.column2 OR w.closes IS NOT s.column3)
       ON CONFLICT (site_id, weekday) DO UPDATE SET opens = excluded.opens, closes = excluded.closes`,
      ctx.siteId,
      ...changed.flatMap((c) => [c.weekday, c.hours?.open ?? null, c.hours?.close ?? null]),
      ...WEEKDAYS.flatMap((d, weekday) => [weekday, seen[d]?.open ?? null, seen[d]?.close ?? null]),
      ctx.siteId,
    ),
    {
      entity: "hours",
      entityId: null,
      action: "update",
      summary: `weekly hours: ${changed.map((c) => `${c.day.slice(0, 3)} ${describe(seen[c.day])} → ${describe(c.hours)}`).join(", ")}`,
    },
  );
  return written ? { ok: true } : conflict();
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
