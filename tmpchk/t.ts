import { normalizeLseDisplayPriceToBase } from "../src/lib/market-price-units";
for (const [s,p] of [["BP.L",550.195455],["GLEN.L",570.17],["VOD.L",119.673791],["HSBA.L",1552],["VUSA.L",108.04],["VMID.L",37.9],["VWRL.L",139.44],["BP:xlon",550.19],["VOD:xlon",119.67],["GLEN:xlon",570.17]] as [string,number][]) {
  console.log(s, p, "->", normalizeLseDisplayPriceToBase(s,p));
}
