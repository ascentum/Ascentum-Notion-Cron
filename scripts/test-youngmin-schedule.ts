import assert from 'node:assert/strict';
import { getYoungminCalendarSchedule } from '../src/services/youngmin-calendar-service';
for (const [time, due, target] of [
  ['2026-11-10T11:59:00Z', false, '2026-11-11'],
  ['2026-11-10T12:00:00Z', true, '2026-11-11'],
  ['2026-11-13T12:00:00Z', true, '2026-11-14'],
  ['2026-11-14T12:00:00Z', true, '2026-11-15'],
  ['2026-11-15T12:00:00Z', true, '2026-11-16'],
] as const) {
  const result = getYoungminCalendarSchedule(new Date(time));
  assert.equal(result.due, due);
  assert.equal(result.targetDate, target);
}
console.log('Youngmin schedule tests passed');
