const { computeShiftSummary, groupPunchesIntoShifts } = require('./src/computeAttendance');

function dt(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`);
}

function assert(condition, label) {
  console.log(condition ? `PASS: ${label}` : `FAIL: ${label}`);
}

console.log('--- Case 1: Missing punch-out ---');
{
  const schedule = { start: '09:00', end: '18:00' };
  const punches = [{ type: 'in', timestamp: dt('2026-06-17', '09:05') }];
  const summary = computeShiftSummary(punches, schedule);
  console.log(summary);
  assert(summary.incomplete === true, 'shift flagged incomplete');
  assert(summary.undertimeMinutes === 0, 'no fabricated undertime on incomplete shift');
  assert(summary.lateMinutes === 5, 'lateness still computed from punch-in (5 min late)');
}

console.log('\n--- Case 2: Lunch break (two pairs) ---');
{
  const schedule = { start: '09:00', end: '18:00' };
  const punches = [
    { type: 'in', timestamp: dt('2026-06-17', '09:00') },
    { type: 'out', timestamp: dt('2026-06-17', '12:00') },
    { type: 'in', timestamp: dt('2026-06-17', '13:00') },
    { type: 'out', timestamp: dt('2026-06-17', '18:00') },
  ];
  const summary = computeShiftSummary(punches, schedule);
  console.log(summary);
  assert(summary.totalWorkedHours === 8, 'total worked = 8h (lunch gap excluded)');
  assert(summary.overtimeHours === 0, 'no phantom OT from the lunch-break span');
  assert(summary.lateMinutes === 0, 'on time (first punch-in used for lateness)');
  assert(summary.undertimeMinutes === 0, 'left exactly on time (last punch-out used)');
}

console.log('\n--- Case 3: Overnight shift (22:00 -> 06:00) ---');
{
  const schedule = { start: '22:00', end: '06:00' };
  const punches = [
    { type: 'in', timestamp: dt('2026-06-17', '22:00') },
    { type: 'out', timestamp: dt('2026-06-18', '06:00') },
  ];
  const summary = computeShiftSummary(punches, schedule);
  console.log(summary);
  assert(summary.date === '2026-06-17', 'shift attributed to start date (June 17), not June 18');
  assert(summary.totalWorkedHours === 8, 'full 8h worked, not split/truncated at midnight');
  assert(summary.nightDiffHours === 8, 'entire shift counts as night differential');
  assert(summary.overtimeHours === 0, 'no OT — worked exactly the scheduled 8h');
}

console.log('\n--- Bonus: Day shift running late into the night (ND overlap with OT) ---');
{
  const schedule = { start: '09:00', end: '18:00' };
  const punches = [
    { type: 'in', timestamp: dt('2026-06-17', '09:00') },
    { type: 'out', timestamp: dt('2026-06-17', '23:00') }, // 5h of unplanned OT
  ];
  const summary = computeShiftSummary(punches, schedule);
  console.log(summary);
  assert(summary.overtimeHours === 5, 'OT = 5h (worked 14h, scheduled 9h)');
  assert(summary.nightDiffHours === 1, 'ND = 1h (22:00-23:00 overlap), independent bucket from OT');
}

console.log('\n--- Grouping: punches across multiple shifts in one fetch ---');
{
  const allPunches = [
    { type: 'in', timestamp: dt('2026-06-17', '09:00') },
    { type: 'out', timestamp: dt('2026-06-17', '18:00') },
    { type: 'in', timestamp: dt('2026-06-18', '09:10') },
    { type: 'out', timestamp: dt('2026-06-18', '18:00') },
  ];
  const shifts = groupPunchesIntoShifts(allPunches);
  assert(shifts.length === 2, 'two separate shifts correctly split');
}