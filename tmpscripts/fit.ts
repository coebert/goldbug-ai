import { fitAndStoreModel } from "../src/lib/decision-model/model.server";
const r = await fitAndStoreModel({ userId: "131e88aa-a805-4bcf-9bff-720699eea6e8", horizonDays: 5 });
console.log(JSON.stringify(r, null, 2).slice(0, 2500));
