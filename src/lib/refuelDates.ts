import { RefuelWeekday, RefuelSubmissionStatus } from "@prisma/client";

export const WEEKDAY_OFFSETS: Record<RefuelWeekday, number> = {
  MONDAY: 0,
  TUESDAY: 1,
  WEDNESDAY: 2,
  THURSDAY: 3,
  FRIDAY: 4,
  SATURDAY: 5,
  SUNDAY: 6,
};

export function parseDateParts(dateStr: string): {
  year: number;
  month: number;
  day: number;
} {
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid date format: ${dateStr}. Expected YYYY-MM-DD.`);
  }
  return { year: parts[0], month: parts[1], day: parts[2] };
}

/**
 * Validates that dateStr is in YYYY-MM-DD format and falls on a Monday.
 * Evaluated in UTC to be deterministic regardless of host timezone.
 */
export function isMonday(dateStr: string): boolean {
  const { year, month, day } = parseDateParts(dateStr);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return date.getUTCDay() === 1; // 1 = Monday
}

/**
 * Calculates calendarDate as: startDate + (weekNumber - 1) * 7 + weekdayOffset
 * Returns YYYY-MM-DD string.
 */
export function calculateDayCalendarDate(
  startDateStr: string,
  weekNumber: number,
  weekday: RefuelWeekday,
): string {
  const { year, month, day } = parseDateParts(startDateStr);
  const offset = (weekNumber - 1) * 7 + WEEKDAY_OFFSETS[weekday];
  const date = new Date(Date.UTC(year, month - 1, day + offset, 12, 0, 0));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns today's calendar date in Africa/Lagos (WAT, UTC+1) formatted as YYYY-MM-DD.
 */
export function getLagosToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(
    now,
  );
}

/**
 * Computes the exact timestamp cutoff for a calendar date in Africa/Lagos.
 * Standard cutoff is the next day's Lagos midnight (calendarDate + 1 day at 00:00:00 WAT).
 * Because Africa/Lagos is UTC+1 year-round, Lagos midnight = 23:00:00 UTC of calendarDate.
 * bufferMinutes (e.g. 300 for 05:00:00 AM) extends this deadline.
 */
export function getLagosNextDayCutoff(
  calendarDate: string,
  bufferMinutes: number = 0,
): Date {
  const { year, month, day } = parseDateParts(calendarDate);
  const nextDayMidnightUtcMs =
    Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0) - 1 * 60 * 60 * 1000;
  const cutoffMs = nextDayMidnightUtcMs + bufferMinutes * 60 * 1000;
  return new Date(cutoffMs);
}

/**
 * Returns true if submittedAt occurs on or after the Lagos next-day cutoff.
 */
export function isSubmissionLate(
  calendarDate: string,
  submittedAt: Date,
  bufferMinutes: number = 0,
): boolean {
  const cutoff = getLagosNextDayCutoff(calendarDate, bufferMinutes);
  return submittedAt.getTime() >= cutoff.getTime();
}

export type DayOutcome =
  | "COMPLETED" // 1. Valid approved submission
  | "EXCUSED" // 2. Permanent grace granted (day not completed validly)
  | "PENDING" // 3. Clock-in submitted, awaiting review
  | "REJECTED" // 4. Clock-in rejected without grace
  | "UPCOMING" // 5. Future day, no submission
  | "MISSED"; // 6. Past or current day past deadline, no submission, no grace

/**
 * Deterministic Day Outcome Precedence:
 * 1. Valid submission always yields COMPLETED (even if grace was previously given)
 * 2. If grace exists and the day is not completed validly, it is EXCUSED
 * 3. If a submission is submitted and waiting for review, it is PENDING
 * 4. If submission was reviewed and rejected, it is REJECTED
 * 5. Future day with no submission is UPCOMING
 * 6. Past or current day with no submission and no grace is MISSED
 */
export function deriveDayOutcome(
  day: { calendarDate: string },
  submission: { status: RefuelSubmissionStatus } | null,
  grace: { id: string } | null,
  lagosToday: string,
): DayOutcome {
  if (submission?.status === "VALID") return "COMPLETED";
  if (grace) return "EXCUSED";
  if (submission?.status === "PENDING") return "PENDING";
  if (submission?.status === "INVALID") return "REJECTED";
  if (day.calendarDate > lagosToday) return "UPCOMING";
  return "MISSED";
}
