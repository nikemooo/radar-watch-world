import { alertDecision } from "../src/lib/market/events";
const cases = [70,75,79,80,84];
for (const s of cases) {
  const base = alertDecision({ importance: s, isBaseline: true, isNewEvent: true });
  const inc  = alertDecision({ importance: s, isBaseline: false, isNewEvent: true });
  const upd  = alertDecision({ importance: s, isBaseline: false, isNewEvent: false, isMaterialUpdate: true, lastAlertedAt: new Date(Date.now()-1000*60*60*24).toISOString() });
  const cool = alertDecision({ importance: s, isBaseline: false, isNewEvent: false, isMaterialUpdate: true, lastAlertedAt: new Date().toISOString() });
  console.log(`score=${s} baseline=${base.alert}(${base.reason}) incremental_new=${inc.alert}(${inc.reason}) update_1d=${upd.alert}(${upd.reason}) update_now=${cool.alert}(${cool.reason})`);
}
