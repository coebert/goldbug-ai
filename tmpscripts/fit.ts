import { fitAndStoreModel } from "../src/lib/decision-model/model.server";
const m = await fitAndStoreModel({ userId: "131e88aa-a805-4bcf-9bff-720699eea6e8" });
console.log(m.usable, m.note, JSON.stringify(m.coverage));
