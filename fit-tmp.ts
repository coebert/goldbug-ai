import { fitAndStoreModel } from "@/lib/decision-model/model.server";
const userId = process.argv[2]!;
const m = await fitAndStoreModel({ userId, horizonDays: 5, realMoneyOnly: false, labelMode: "risk_net" });
console.log(JSON.stringify({ id: m.id, usable: m.usable, note: m.note, buckets: m.bucket_weights, coverage: m.coverage, test: m.metrics.test }, null, 2));
