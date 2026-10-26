import assert from "assert";
import {
  isMonday,
  calculateDayCalendarDate,
  getLagosNextDayCutoff,
  isSubmissionLate,
  deriveDayOutcome,
  DayOutcome,
} from "../src/lib/refuelDates";
import { RefuelSubmissionStatus, RefuelWeekday } from "@prisma/client";

console.log("=== RUNNING REFUEL UNIT & SPECIFICATION TESTS ===");

// 1. Monday Anchor Validation
console.log("Test 1: Monday Anchor Validation");
assert.strictEqual(isMonday("2026-10-26"), true, "2026-10-26 must be a Monday");
assert.strictEqual(isMonday("2026-10-27"), false, "2026-10-27 is Tuesday, must be false");
assert.strictEqual(isMonday("2026-10-25"), false, "2026-10-25 is Sunday, must be false");
assert.strictEqual(isMonday("2026-11-02"), true, "2026-11-02 must be a Monday");
console.log("  ✓ Passed Monday Anchor Validation");

// 2. Canonical Date Offsets
console.log("Test 2: Canonical Date Offsets");
const startDate = "2026-10-26"; // Monday
assert.strictEqual(
  calculateDayCalendarDate(startDate, 1, RefuelWeekday.MONDAY),
  "2026-10-26",
  "Week 1 Monday must equal anchor date"
);
assert.strictEqual(
  calculateDayCalendarDate(startDate, 1, RefuelWeekday.WEDNESDAY),
  "2026-10-28",
  "Week 1 Wednesday must be anchor + 2 days"
);
assert.strictEqual(
  calculateDayCalendarDate(startDate, 1, RefuelWeekday.SUNDAY),
  "2026-11-01",
  "Week 1 Sunday must be anchor + 6 days"
);
assert.strictEqual(
  calculateDayCalendarDate(startDate, 2, RefuelWeekday.MONDAY),
  "2026-11-02",
  "Week 2 Monday must be anchor + 7 days"
);
assert.strictEqual(
  calculateDayCalendarDate(startDate, 2, RefuelWeekday.FRIDAY),
  "2026-11-06",
  "Week 2 Friday must be anchor + 11 days"
);
console.log("  ✓ Passed Canonical Date Offsets");

// 3. Lagos Midnight and Cutoff Comparisons
console.log("Test 3: Lagos Midnight and Cutoff Comparisons");
const cutoff0 = getLagosNextDayCutoff("2026-10-26", 0);
assert.strictEqual(
  cutoff0.toISOString(),
  "2026-10-26T23:00:00.000Z",
  "Midnight WAT must equal 23:00:00 UTC"
);

const cutoff300 = getLagosNextDayCutoff("2026-10-26", 300); // 5hr buffer
assert.strictEqual(
  cutoff300.toISOString(),
  "2026-10-27T04:00:00.000Z",
  "5:00 AM WAT must equal 04:00:00 UTC"
);

// Lateness evaluation
const onTimeSubmission = new Date("2026-10-26T22:30:00.000Z"); // 23:30 WAT (before midnight)
assert.strictEqual(isSubmissionLate("2026-10-26", onTimeSubmission, 0), false);

const pastMidnightSubmission = new Date("2026-10-26T23:30:00.000Z"); // 00:30 WAT
assert.strictEqual(isSubmissionLate("2026-10-26", pastMidnightSubmission, 0), true);
assert.strictEqual(isSubmissionLate("2026-10-26", pastMidnightSubmission, 300), false); // buffered

const morningPastBuffer = new Date("2026-10-27T04:30:00.000Z"); // 05:30 WAT
assert.strictEqual(isSubmissionLate("2026-10-26", morningPastBuffer, 300), true);
console.log("  ✓ Passed Lagos Midnight and Cutoff Comparisons");

// 4. Deterministic Day Outcome Precedence Table (Section 4)
console.log("Test 4: Deterministic Day Outcome Precedence Table");
const lagosToday = "2026-10-28"; // Wednesday

// 1. Valid approved submission -> COMPLETED (even if grace was granted!)
assert.strictEqual(
  deriveDayOutcome(
    { calendarDate: "2026-10-27" },
    { status: RefuelSubmissionStatus.VALID },
    { id: "grace-1" },
    lagosToday
  ),
  "COMPLETED",
  "Valid submission overrides grace to COMPLETED"
);

// 2. Permanent grace granted without valid submission -> EXCUSED
assert.strictEqual(
  deriveDayOutcome(
    { calendarDate: "2026-10-27" },
    null,
    { id: "grace-1" },
    lagosToday
  ),
  "EXCUSED",
  "Grace without valid submission yields EXCUSED"
);
assert.strictEqual(
  deriveDayOutcome(
    { calendarDate: "2026-10-27" },
    { status: RefuelSubmissionStatus.INVALID },
    { id: "grace-1" },
    lagosToday
  ),
  "EXCUSED",
  "Grace with invalid submission yields EXCUSED"
);

// 3. Pending review -> PENDING
assert.strictEqual(
  deriveDayOutcome(
    { calendarDate: "2026-10-28" },
    { status: RefuelSubmissionStatus.PENDING },
    null,
    lagosToday
  ),
  "PENDING",
  "Pending submission yields PENDING"
);

// 4. Rejected submission -> REJECTED
assert.strictEqual(
  deriveDayOutcome(
    { calendarDate: "2026-10-27" },
    { status: RefuelSubmissionStatus.INVALID },
    null,
    lagosToday
  ),
  "REJECTED",
  "Rejected submission yields REJECTED"
);

// 5. Future day, no submission -> UPCOMING
assert.strictEqual(
  deriveDayOutcome(
    { calendarDate: "2026-10-29" },
    null,
    null,
    lagosToday
  ),
  "UPCOMING",
  "Future day yields UPCOMING"
);

// 6. Past or current day past deadline, no submission -> MISSED
assert.strictEqual(
  deriveDayOutcome(
    { calendarDate: "2026-10-27" },
    null,
    null,
    lagosToday
  ),
  "MISSED",
  "Past unexcused day yields MISSED"
);
assert.strictEqual(
  deriveDayOutcome(
    { calendarDate: "2026-10-28" },
    null,
    null,
    lagosToday
  ),
  "MISSED",
  "Current day without submission yields MISSED"
);
console.log("  ✓ Passed Deterministic Day Outcome Precedence Table");

console.log("\nALL REFUEL SPECIFICATION TESTS PASSED SUCCESSFULLY! 🎉\n");
