/**
 * What "today" means for a request: the restaurant's calendar date in Stockholm, today's
 * opening hours (exceptions first) and which dishes are sold out today. Computed on the
 * server for every request, so it is right without JavaScript and changes at midnight.
 */
import { hoursOn, restaurantDay } from "./hours";
import type { DayHours, OpeningHours } from "./load";

export interface Today {
  date: string;
  hours: DayHours | null;
  /** Ids of dishes sold out for the rest of today. */
  soldOut: readonly string[];
}

export function todayFor(hours: OpeningHours, soldOutOn: Readonly<Record<string, string>>, now: Date): Today {
  const date = restaurantDay(now).date;
  return {
    date,
    hours: hoursOn(hours, now),
    soldOut: Object.entries(soldOutOn)
      .filter(([, day]) => day === date)
      .map(([id]) => id),
  };
}
