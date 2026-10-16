/**
 * Which opening hours apply on a given day. Runs in the browser: the site is static, so
 * anything computed at build time would show the hours for the day of the last deploy.
 *
 * Keep this module free of Node imports — it is bundled into a client script.
 */
import type { DayHours, OpeningHours } from "./load";

/** Every demo is a Swedish restaurant; "today" means today in Sweden, wherever the visitor is. */
export const RESTAURANT_TIME_ZONE = "Europe/Stockholm";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** The calendar date (YYYY-MM-DD) and lower-case English weekday at `now` in `timeZone`. */
export function restaurantDay(now: Date, timeZone = RESTAURANT_TIME_ZONE): { date: string; weekday: string } {
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
  if (!WEEKDAYS.includes(weekday)) throw new Error(`Unexpected weekday "${parts.weekday}"`);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday };
}

/** Opening hours on the restaurant's calendar day containing `now`; null when closed. */
export function hoursOn(hours: OpeningHours, now: Date, timeZone = RESTAURANT_TIME_ZONE): DayHours | null {
  const { date, weekday } = restaurantDay(now, timeZone);
  const exception = hours.exceptions.find((e) => e.date === date);
  if (exception) return exception.hours;
  return hours.weekly[weekday] ?? null;
}
