import { fitAndStoreModel } from "../src/lib/decision-model/model.server";
const r: any = await fitAndStoreModel({ userId: "131e88aa-a805-4bcf-9bff-720699eea6e8", horizonDays: 5 });
console.log(JSON.stringify({ usable: r.usable, verdict: r.verdict, reason: r.reason, metrics: r.metrics, coverage: r.coverage }, null, 2));
