/**
 * Which opening hours apply on a given day, worked out on each request in the restaurant's
 * time zone, and the week's hours as runs of days for display.
 */
import { t } from "../i18n";
import type { DayHours, OpeningHours } from "./load";
import { WEEKDAYS, type Weekday } from "./vocabulary";

/** Every demo is a Swedish restaurant; "today" means today in Sweden, wherever the visitor is. */
export const RESTAURANT_TIME_ZONE = "Europe/Stockholm";

const isWeekday = (value: string): value is Weekday => (WEEKDAYS as readonly string[]).includes(value);

/** The calendar date (YYYY-MM-DD) and lower-case English weekday at `now` in `timeZone`. */
export function restaurantDay(now: Date, timeZone = RESTAURANT_TIME_ZONE): { date: string; weekday: Weekday } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = parts.weekday.toLowerCase();
  if (!isWeekday(weekday)) throw new Error(`Unexpected weekday "${parts.weekday}"`);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday };
}

/** Opening hours on the restaurant's calendar day containing `now`; null when closed. */
export function hoursOn(hours: OpeningHours, now: Date, timeZone = RESTAURANT_TIME_ZONE): DayHours | null {
  const { date, weekday } = restaurantDay(now, timeZone);
  const exception = hours.exceptions.find((e) => e.date === date);
  if (exception) return exception.hours;
  return hours.weekly[weekday] ?? null;
}

/** Special days from `today` (YYYY-MM-DD) on, earliest first: past ones stop showing at midnight. */
export function upcomingExceptions(hours: OpeningHours, today: string): OpeningHours["exceptions"] {
  return hours.exceptions.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
}

/** A date as owners and guests say it: "24 december" / "24 December". */
export function dayAndMonth(date: string, locale: "sv" | "en"): string {
  return new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export interface WeekRun {
  first: Weekday;
  last: Weekday;
  hours: DayHours | null;
}

/**
 * The week as runs of days with the same hours, Monday first: "Tuesday–Thursday 12:00–22:00".
 * A closed day is a run of its own kind (hours null). For the modern home's hours column.
 */
export function weekRuns(weekly: OpeningHours["weekly"]): WeekRun[] {
  const same = (a: DayHours | null, b: DayHours | null) => (a === null || b === null ? a === b : a.open === b.open && a.close === b.close);
  const runs: WeekRun[] = [];
  for (const day of WEEKDAYS) {
    const hours = weekly[day] ?? null;
    const last = runs.at(-1);
    if (last && same(last.hours, hours)) last.last = day;
    else runs.push({ first: day, last: day, hours });
  }
  return runs;
}

/**
 * A run's day label: "Måndag" for one day, "Tisdag–torsdag" / "Tuesday–Thursday" for several.
 * Swedish writes the second day of a range in lower case; English doesn't.
 */
export function runLabel(run: WeekRun, locale: "sv" | "en"): string {
  const name = (day: Weekday) => t(locale, `weekday.${day}`);
  if (run.first === run.last) return name(run.first);
  const last = name(run.last);
  return `${name(run.first)}–${locale === "sv" ? last.toLowerCase() : last}`;
}
