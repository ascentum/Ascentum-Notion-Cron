import { loadEnvironment } from '../src/load-env';
import { runYoungminCalendar } from '../src/services/youngmin-calendar-service';
loadEnvironment();
runYoungminCalendar(new Date(), { targetDate: process.argv[2], dryRun: true })
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error); process.exitCode = 1; });
