import { buildDataset } from "../src/lib/decision-model/dataset.server";
const r = await buildDataset({ userId: "131e88aa-a805-4bcf-9bff-720699eea6e8", horizonDays: 5 });
console.log({ samples: r.samples.length, history: r.historySamples, historyFrom: r.historyFrom, from: r.from, to: r.to, dates: r.dates.length, symbols: r.symbols.length, skipped: r.skippedNoForwardPrice, meanWeight: r.meanWeight });
