import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DiagnosticsPanel } from "@/components/diagnostics-panel";
import { SignalDecayCard } from "@/components/signal-decay-card";
import { CorrelationHeatmapCard } from "@/components/correlation-heatmap-card";
import { LearningDiagnosticsCard } from "@/components/learning-diagnostics-card";
import { ShadowVariantCard } from "@/components/shadow-variant-card";

export function DiagnosticsSection({ portfolioId }: { portfolioId: string }) {
  const [showAdvancedDiag, setShowAdvancedDiag] = useState(false);
  return (
    <div className="space-y-4">
      <DiagnosticsPanel portfolioId={portfolioId} />
      <Collapsible open={showAdvancedDiag} onOpenChange={setShowAdvancedDiag}>
        <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
          <ChevronDown
            className={`h-4 w-4 transition-transform ${showAdvancedDiag ? "rotate-180" : ""}`}
          />
          {showAdvancedDiag ? "Hide" : "Show"} advanced diagnostics (signal decay,
          correlations, stress, learning delta, shadow variants)
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SignalDecayCard portfolioId={portfolioId} />
            <CorrelationHeatmapCard portfolioId={portfolioId} />
            <LearningDiagnosticsCard portfolioId={portfolioId} />
            <ShadowVariantCard portfolioId={portfolioId} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
