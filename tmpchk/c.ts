import { mapSaxoChargeRows } from "../src/lib/brokers/saxo-charges";
import { checkChargeUnits } from "../src/lib/valuation/unit-validation";
import f from "../src/lib/brokers/__tests__/fixtures/saxo-charge-reports.json";
const c = mapSaxoChargeRows((f as any).tradesReportLse.slice(1));
console.log(c[0]);
console.log(checkChargeUnits({id:"x",symbol:"VOD.L",quantity:400,fillPrice:0.72,fillCurrency:"GBP",chargeTotal:c[0]!.total,chargeCurrency:c[0]!.currency}));
