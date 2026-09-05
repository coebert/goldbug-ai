import { buildDataset } from "../src/lib/decision-model/dataset.server";
const r = await buildDataset({ userId: "131e88aa-a805-4bcf-9bff-720699eea6e8", horizonDays: 5 });
console.log({ samples: r.samples.length, rt: r.roundTripCostBps, fee: r.costFeeBps, slip: r.costSlippageBps, fills: r.costFills, invoiced: r.costInvoicedFills, calib: r.costCalibratedSymbols });
