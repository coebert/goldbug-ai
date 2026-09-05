export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_decision_audit: {
        Row: {
          action: string
          asset_class: string | null
          created_at: string
          decided_at: string
          decision_id: string | null
          id: string
          instrument_ccy: string | null
          market_inputs: Json
          model: string | null
          notional: number | null
          order_id: string | null
          outcome: string
          outcome_at: string | null
          outcome_detail: string | null
          portfolio_id: string
          price: number | null
          rationale: string | null
          requested_quantity: number | null
          run_date: string
          source: string
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          action: string
          asset_class?: string | null
          created_at?: string
          decided_at?: string
          decision_id?: string | null
          id?: string
          instrument_ccy?: string | null
          market_inputs?: Json
          model?: string | null
          notional?: number | null
          order_id?: string | null
          outcome?: string
          outcome_at?: string | null
          outcome_detail?: string | null
          portfolio_id: string
          price?: number | null
          rationale?: string | null
          requested_quantity?: number | null
          run_date: string
          source?: string
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          action?: string
          asset_class?: string | null
          created_at?: string
          decided_at?: string
          decision_id?: string | null
          id?: string
          instrument_ccy?: string | null
          market_inputs?: Json
          model?: string | null
          notional?: number | null
          order_id?: string | null
          outcome?: string
          outcome_at?: string | null
          outcome_detail?: string | null
          portfolio_id?: string
          price?: number | null
          rationale?: string | null
          requested_quantity?: number | null
          run_date?: string
          source?: string
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_decision_audit_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_decision_audit_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "live_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_decision_audit_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_gateway_health_alerts: {
        Row: {
          alert_date: string
          created_at: string
          detail: string | null
          id: string
          kind: string
        }
        Insert: {
          alert_date: string
          created_at?: string
          detail?: string | null
          id?: string
          kind: string
        }
        Update: {
          alert_date?: string
          created_at?: string
          detail?: string | null
          id?: string
          kind?: string
        }
        Relationships: []
      }
      alert_webhook_deliveries: {
        Row: {
          attempt_log: Json
          attempts: number
          category: string
          created_at: string
          duration_ms: number | null
          endpoint_host: string | null
          error: string | null
          event: string
          http_status: number | null
          id: string
          payload: Json | null
          portfolio_id: string | null
          status: string
          user_id: string
        }
        Insert: {
          attempt_log?: Json
          attempts?: number
          category: string
          created_at?: string
          duration_ms?: number | null
          endpoint_host?: string | null
          error?: string | null
          event: string
          http_status?: number | null
          id?: string
          payload?: Json | null
          portfolio_id?: string | null
          status: string
          user_id: string
        }
        Update: {
          attempt_log?: Json
          attempts?: number
          category?: string
          created_at?: string
          duration_ms?: number | null
          endpoint_host?: string | null
          error?: string | null
          event?: string
          http_status?: number | null
          id?: string
          payload?: Json | null
          portfolio_id?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_webhook_deliveries_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      algo_regime_config_overrides: {
        Row: {
          config: Json
          created_at: string
          notes: string | null
          portfolio_id: string
          tuned_at: string
          updated_at: string
        }
        Insert: {
          config: Json
          created_at?: string
          notes?: string | null
          portfolio_id: string
          tuned_at?: string
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          notes?: string | null
          portfolio_id?: string
          tuned_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "algo_regime_config_overrides_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: true
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      algo_regime_tune_history: {
        Row: {
          applied_at: string
          baseline_extreme_mean: number | null
          baseline_matched: number
          baseline_monotone: boolean
          baseline_normal_mean: number | null
          created_at: string
          decision_reason: string | null
          evaluated_at: string | null
          id: string
          new_config: Json
          notes: string | null
          portfolio_id: string
          post_extreme_mean: number | null
          post_matched: number | null
          post_monotone: boolean | null
          post_normal_mean: number | null
          prev_config: Json
          status: Database["public"]["Enums"]["algo_regime_tune_status"]
        }
        Insert: {
          applied_at?: string
          baseline_extreme_mean?: number | null
          baseline_matched: number
          baseline_monotone: boolean
          baseline_normal_mean?: number | null
          created_at?: string
          decision_reason?: string | null
          evaluated_at?: string | null
          id?: string
          new_config: Json
          notes?: string | null
          portfolio_id: string
          post_extreme_mean?: number | null
          post_matched?: number | null
          post_monotone?: boolean | null
          post_normal_mean?: number | null
          prev_config: Json
          status?: Database["public"]["Enums"]["algo_regime_tune_status"]
        }
        Update: {
          applied_at?: string
          baseline_extreme_mean?: number | null
          baseline_matched?: number
          baseline_monotone?: boolean
          baseline_normal_mean?: number | null
          created_at?: string
          decision_reason?: string | null
          evaluated_at?: string | null
          id?: string
          new_config?: Json
          notes?: string | null
          portfolio_id?: string
          post_extreme_mean?: number | null
          post_matched?: number | null
          post_monotone?: boolean | null
          post_normal_mean?: number | null
          prev_config?: Json
          status?: Database["public"]["Enums"]["algo_regime_tune_status"]
        }
        Relationships: [
          {
            foreignKeyName: "algo_regime_tune_history_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      alpha_model_performance: {
        Row: {
          as_of: string
          avg_edge_bps: number | null
          created_at: string
          hit_rate: number | null
          hits: number
          id: string
          model_kind: string
          portfolio_id: string
          samples: number
          updated_at: string
          window_days: number
        }
        Insert: {
          as_of: string
          avg_edge_bps?: number | null
          created_at?: string
          hit_rate?: number | null
          hits?: number
          id?: string
          model_kind: string
          portfolio_id: string
          samples?: number
          updated_at?: string
          window_days?: number
        }
        Update: {
          as_of?: string
          avg_edge_bps?: number | null
          created_at?: string
          hit_rate?: number | null
          hits?: number
          id?: string
          model_kind?: string
          portfolio_id?: string
          samples?: number
          updated_at?: string
          window_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "alpha_model_performance_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      backtest_runs: {
        Row: {
          created_at: string
          days: number
          equity: Json | null
          id: string
          metrics: Json
          portfolio_id: string
          ran_at: string
          risk_level: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          days: number
          equity?: Json | null
          id?: string
          metrics: Json
          portfolio_id: string
          ran_at?: string
          risk_level?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          days?: number
          equity?: Json | null
          id?: string
          metrics?: Json
          portfolio_id?: string
          ran_at?: string
          risk_level?: string | null
          user_id?: string
        }
        Relationships: []
      }
      breakout_expectancy_runs: {
        Row: {
          as_of: string | null
          cells: Json
          computed_at: string
          diff: Json
          dropped_cells: string[]
          id: string
          reasons: string[]
          source: string
          status: string
          symbols: string[]
          total_trades: number
          triggered_by: string
          windows: Json
        }
        Insert: {
          as_of?: string | null
          cells?: Json
          computed_at?: string
          diff?: Json
          dropped_cells?: string[]
          id?: string
          reasons?: string[]
          source: string
          status: string
          symbols?: string[]
          total_trades?: number
          triggered_by?: string
          windows?: Json
        }
        Update: {
          as_of?: string | null
          cells?: Json
          computed_at?: string
          diff?: Json
          dropped_cells?: string[]
          id?: string
          reasons?: string[]
          source?: string
          status?: string
          symbols?: string[]
          total_trades?: number
          triggered_by?: string
          windows?: Json
        }
        Relationships: []
      }
      broker_account_key_audits: {
        Row: {
          account_count: number
          changed: boolean
          checked_at: string
          configured_key_masked: string | null
          created_at: string
          env: string
          id: string
          message: string | null
          mismatch: boolean
          portfolio_id: string | null
          portfolio_name: string | null
          previous_status: string | null
          resolved_key_masked: string | null
          status: string
          updated_at: string
        }
        Insert: {
          account_count?: number
          changed?: boolean
          checked_at?: string
          configured_key_masked?: string | null
          created_at?: string
          env: string
          id?: string
          message?: string | null
          mismatch?: boolean
          portfolio_id?: string | null
          portfolio_name?: string | null
          previous_status?: string | null
          resolved_key_masked?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          account_count?: number
          changed?: boolean
          checked_at?: string
          configured_key_masked?: string | null
          created_at?: string
          env?: string
          id?: string
          message?: string | null
          mismatch?: boolean
          portfolio_id?: string | null
          portfolio_name?: string | null
          previous_status?: string | null
          resolved_key_masked?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "broker_account_key_audits_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      broker_block_events: {
        Row: {
          broker: string
          created_at: string
          detail: string | null
          error_code: string | null
          first_block: boolean
          hit_count: number
          id: string
          order_id: string | null
          portfolio_id: string | null
          quantity: number | null
          reason: string
          recommended_action: string
          reject_reason: string | null
          side: string | null
          symbol: string
          symbol_key: string
          updated_at: string
          user_id: string
        }
        Insert: {
          broker?: string
          created_at?: string
          detail?: string | null
          error_code?: string | null
          first_block?: boolean
          hit_count?: number
          id?: string
          order_id?: string | null
          portfolio_id?: string | null
          quantity?: number | null
          reason: string
          recommended_action: string
          reject_reason?: string | null
          side?: string | null
          symbol: string
          symbol_key: string
          updated_at?: string
          user_id: string
        }
        Update: {
          broker?: string
          created_at?: string
          detail?: string | null
          error_code?: string | null
          first_block?: boolean
          hit_count?: number
          id?: string
          order_id?: string | null
          portfolio_id?: string | null
          quantity?: number | null
          reason?: string
          recommended_action?: string
          reject_reason?: string | null
          side?: string | null
          symbol?: string
          symbol_key?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      broker_instrument_blocks: {
        Row: {
          broker: string
          cleared_at: string | null
          created_at: string
          detail: string | null
          first_seen_at: string
          hit_count: number
          id: string
          last_seen_at: string
          portfolio_id: string | null
          reason: string
          reject_reason: string | null
          symbol: string
          symbol_key: string
          user_id: string
        }
        Insert: {
          broker?: string
          cleared_at?: string | null
          created_at?: string
          detail?: string | null
          first_seen_at?: string
          hit_count?: number
          id?: string
          last_seen_at?: string
          portfolio_id?: string | null
          reason: string
          reject_reason?: string | null
          symbol: string
          symbol_key: string
          user_id: string
        }
        Update: {
          broker?: string
          cleared_at?: string | null
          created_at?: string
          detail?: string | null
          first_seen_at?: string
          hit_count?: number
          id?: string
          last_seen_at?: string
          portfolio_id?: string | null
          reason?: string
          reject_reason?: string | null
          symbol?: string
          symbol_key?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "broker_instrument_blocks_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      broker_token_events: {
        Row: {
          created_at: string
          detail: string | null
          env: string
          id: string
          ok: boolean
          source: string
        }
        Insert: {
          created_at?: string
          detail?: string | null
          env: string
          id?: string
          ok: boolean
          source: string
        }
        Update: {
          created_at?: string
          detail?: string | null
          env?: string
          id?: string
          ok?: boolean
          source?: string
        }
        Relationships: []
      }
      calibration_snapshots: {
        Row: {
          as_of: string
          avg_conviction: number | null
          brier_score: number
          created_at: string
          global_size_mult: number
          hit_rate: number | null
          id: string
          notes: string | null
          portfolio_id: string
          samples: number
        }
        Insert: {
          as_of: string
          avg_conviction?: number | null
          brier_score: number
          created_at?: string
          global_size_mult?: number
          hit_rate?: number | null
          id?: string
          notes?: string | null
          portfolio_id: string
          samples: number
        }
        Update: {
          as_of?: string
          avg_conviction?: number | null
          brier_score?: number
          created_at?: string
          global_size_mult?: number
          hit_rate?: number | null
          id?: string
          notes?: string | null
          portfolio_id?: string
          samples?: number
        }
        Relationships: [
          {
            foreignKeyName: "calibration_snapshots_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      corporate_action_alert_settings: {
        Row: {
          created_at: string
          enabled: boolean
          threshold_hours: number[]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          threshold_hours?: number[]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          threshold_hours?: number[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      corporate_action_alerts_sent: {
        Row: {
          deadline: string | null
          event_id: string
          hours_remaining: number | null
          id: string
          portfolio_id: string | null
          sent_at: string
          suppressed: boolean
          threshold_hours: number
          user_id: string
        }
        Insert: {
          deadline?: string | null
          event_id: string
          hours_remaining?: number | null
          id?: string
          portfolio_id?: string | null
          sent_at?: string
          suppressed?: boolean
          threshold_hours: number
          user_id: string
        }
        Update: {
          deadline?: string | null
          event_id?: string
          hours_remaining?: number | null
          id?: string
          portfolio_id?: string | null
          sent_at?: string
          suppressed?: boolean
          threshold_hours?: number
          user_id?: string
        }
        Relationships: []
      }
      counterfactuals: {
        Row: {
          as_of: string
          block_category: string
          block_reason: string
          conviction: number | null
          created_at: string
          evaluated_at: string | null
          forward_return_5d: number | null
          hypothetical_price: number
          hypothetical_spend: number | null
          id: string
          portfolio_id: string
          side: string
          symbol: string
        }
        Insert: {
          as_of: string
          block_category: string
          block_reason: string
          conviction?: number | null
          created_at?: string
          evaluated_at?: string | null
          forward_return_5d?: number | null
          hypothetical_price: number
          hypothetical_spend?: number | null
          id?: string
          portfolio_id: string
          side: string
          symbol: string
        }
        Update: {
          as_of?: string
          block_category?: string
          block_reason?: string
          conviction?: number | null
          created_at?: string
          evaluated_at?: string | null
          forward_return_5d?: number | null
          hypothetical_price?: number
          hypothetical_spend?: number | null
          id?: string
          portfolio_id?: string
          side?: string
          symbol?: string
        }
        Relationships: [
          {
            foreignKeyName: "counterfactuals_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_budget_alerts: {
        Row: {
          alert_date: string
          budget_credits: number
          created_at: string
          detail: string | null
          id: string
          kind: string
          mtd_credits: number
          projected_month_credits: number
        }
        Insert: {
          alert_date: string
          budget_credits: number
          created_at?: string
          detail?: string | null
          id?: string
          kind: string
          mtd_credits: number
          projected_month_credits: number
        }
        Update: {
          alert_date?: string
          budget_credits?: number
          created_at?: string
          detail?: string | null
          id?: string
          kind?: string
          mtd_credits?: number
          projected_month_credits?: number
        }
        Relationships: []
      }
      credit_budget_settings: {
        Row: {
          credits_per_ai_call: number
          enabled: boolean
          id: boolean
          monthly_budget_credits: number
          updated_at: string
          warn_pct_mtd: number
          warn_pct_projection: number
        }
        Insert: {
          credits_per_ai_call?: number
          enabled?: boolean
          id?: boolean
          monthly_budget_credits?: number
          updated_at?: string
          warn_pct_mtd?: number
          warn_pct_projection?: number
        }
        Update: {
          credits_per_ai_call?: number
          enabled?: boolean
          id?: boolean
          monthly_budget_credits?: number
          updated_at?: string
          warn_pct_mtd?: number
          warn_pct_projection?: number
        }
        Relationships: []
      }
      daily_equity_changes: {
        Row: {
          change_date: string
          computed_at: string
          equity: number
          id: string
          net_flow: number
          pct: number
          pnl: number
          portfolio_id: string
          prev_date: string
          prev_equity: number
          raw_delta: number
        }
        Insert: {
          change_date: string
          computed_at?: string
          equity: number
          id?: string
          net_flow?: number
          pct: number
          pnl: number
          portfolio_id: string
          prev_date: string
          prev_equity: number
          raw_delta: number
        }
        Update: {
          change_date?: string
          computed_at?: string
          equity?: number
          id?: string
          net_flow?: number
          pct?: number
          pnl?: number
          portfolio_id?: string
          prev_date?: string
          prev_equity?: number
          raw_delta?: number
        }
        Relationships: [
          {
            foreignKeyName: "daily_equity_changes_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_models: {
        Row: {
          bucket_weights: Json
          coefficients: Json
          coverage: Json
          feature_keys: Json
          fitted_at: string
          horizon_days: number
          id: string
          lambda: number
          metrics: Json
          note: string
          usable: boolean
          user_id: string
        }
        Insert: {
          bucket_weights?: Json
          coefficients?: Json
          coverage?: Json
          feature_keys?: Json
          fitted_at?: string
          horizon_days: number
          id?: string
          lambda: number
          metrics?: Json
          note?: string
          usable?: boolean
          user_id: string
        }
        Update: {
          bucket_weights?: Json
          coefficients?: Json
          coverage?: Json
          feature_keys?: Json
          fitted_at?: string
          horizon_days?: number
          id?: string
          lambda?: number
          metrics?: Json
          note?: string
          usable?: boolean
          user_id?: string
        }
        Relationships: []
      }
      decision_playbooks: {
        Row: {
          brief: string
          coverage: Json
          created_at: string
          horizon_days: number
          id: string
          model: string
          playbook: Json
          user_id: string
        }
        Insert: {
          brief?: string
          coverage?: Json
          created_at?: string
          horizon_days?: number
          id?: string
          model: string
          playbook?: Json
          user_id: string
        }
        Update: {
          brief?: string
          coverage?: Json
          created_at?: string
          horizon_days?: number
          id?: string
          model?: string
          playbook?: Json
          user_id?: string
        }
        Relationships: []
      }
      decisions: {
        Row: {
          briefing: string
          created_at: string
          id: string
          instrument_ccy: string
          model: string | null
          portfolio_id: string
          portfolio_value: number | null
          rationale: string
          raw: Json | null
          run_date: string
        }
        Insert: {
          briefing?: string
          created_at?: string
          id?: string
          instrument_ccy?: string
          model?: string | null
          portfolio_id: string
          portfolio_value?: number | null
          rationale?: string
          raw?: Json | null
          run_date: string
        }
        Update: {
          briefing?: string
          created_at?: string
          id?: string
          instrument_ccy?: string
          model?: string | null
          portfolio_id?: string
          portfolio_value?: number | null
          rationale?: string
          raw?: Json | null
          run_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "decisions_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      earnings_cache: {
        Row: {
          confidence: string
          expires_at: string
          fetched_at: string
          next_earnings_date: string | null
          source: string
          symbol: string
        }
        Insert: {
          confidence?: string
          expires_at?: string
          fetched_at?: string
          next_earnings_date?: string | null
          source?: string
          symbol: string
        }
        Update: {
          confidence?: string
          expires_at?: string
          fetched_at?: string
          next_earnings_date?: string | null
          source?: string
          symbol?: string
        }
        Relationships: []
      }
      equity_intraday: {
        Row: {
          bucket_hour: string
          cash: number
          created_at: string
          holdings_value: number
          id: string
          portfolio_id: string
          total_value: number
        }
        Insert: {
          bucket_hour: string
          cash: number
          created_at?: string
          holdings_value: number
          id?: string
          portfolio_id: string
          total_value: number
        }
        Update: {
          bucket_hour?: string
          cash?: number
          created_at?: string
          holdings_value?: number
          id?: string
          portfolio_id?: string
          total_value?: number
        }
        Relationships: [
          {
            foreignKeyName: "equity_intraday_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      equity_snapshots: {
        Row: {
          cash: number
          holdings_value: number
          id: string
          portfolio_id: string
          provenance: Json | null
          snapshot_date: string
          source: string | null
          total_value: number
        }
        Insert: {
          cash: number
          holdings_value: number
          id?: string
          portfolio_id: string
          provenance?: Json | null
          snapshot_date: string
          source?: string | null
          total_value: number
        }
        Update: {
          cash?: number
          holdings_value?: number
          id?: string
          portfolio_id?: string
          provenance?: Json | null
          snapshot_date?: string
          source?: string | null
          total_value?: number
        }
        Relationships: [
          {
            foreignKeyName: "equity_snapshots_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      exec_post_events: {
        Row: {
          base_price: number | null
          created_at: string
          executive_id: string
          executive_name: string
          headline: string
          id: string
          max_adverse_pct: number | null
          post_date: string
          ret_1d: number | null
          ret_3d: number | null
          ret_5d: number | null
          sentiment: number | null
          source: string | null
          symbol: string
          updated_at: string
          url: string | null
          user_id: string
        }
        Insert: {
          base_price?: number | null
          created_at?: string
          executive_id: string
          executive_name: string
          headline: string
          id?: string
          max_adverse_pct?: number | null
          post_date: string
          ret_1d?: number | null
          ret_3d?: number | null
          ret_5d?: number | null
          sentiment?: number | null
          source?: string | null
          symbol: string
          updated_at?: string
          url?: string | null
          user_id: string
        }
        Update: {
          base_price?: number | null
          created_at?: string
          executive_id?: string
          executive_name?: string
          headline?: string
          id?: string
          max_adverse_pct?: number | null
          post_date?: string
          ret_1d?: number | null
          ret_3d?: number | null
          ret_5d?: number | null
          sentiment?: number | null
          source?: string | null
          symbol?: string
          updated_at?: string
          url?: string | null
          user_id?: string
        }
        Relationships: []
      }
      exec_post_lessons: {
        Row: {
          active: boolean
          coefficients: Json
          created_at: string
          generated_at: string
          id: string
          lessons: Json
          model: string | null
          narrative: string | null
          sample_size: number
          stats: Json
          updated_at: string
          user_id: string
          window_days: number
        }
        Insert: {
          active?: boolean
          coefficients?: Json
          created_at?: string
          generated_at?: string
          id?: string
          lessons?: Json
          model?: string | null
          narrative?: string | null
          sample_size?: number
          stats?: Json
          updated_at?: string
          user_id: string
          window_days?: number
        }
        Update: {
          active?: boolean
          coefficients?: Json
          created_at?: string
          generated_at?: string
          id?: string
          lessons?: Json
          model?: string | null
          narrative?: string | null
          sample_size?: number
          stats?: Json
          updated_at?: string
          user_id?: string
          window_days?: number
        }
        Relationships: []
      }
      execution_calibrations: {
        Row: {
          adv_notional_20d: number | null
          adv_notional_60d: number | null
          adv_shares_20d: number | null
          as_of: string
          asset_class: string
          atr_pct_14d: number | null
          currency: string | null
          half_spread_bps_est: number | null
          impact_coeff_est: number | null
          max_half_spread_bps_est: number | null
          max_impact_bps_est: number | null
          notes: string | null
          realized_vol_daily: number | null
          sample_days: number
          spread_pct_est: number | null
          symbol: string
          updated_at: string
          vol_widening_coeff_bps_est: number | null
        }
        Insert: {
          adv_notional_20d?: number | null
          adv_notional_60d?: number | null
          adv_shares_20d?: number | null
          as_of: string
          asset_class: string
          atr_pct_14d?: number | null
          currency?: string | null
          half_spread_bps_est?: number | null
          impact_coeff_est?: number | null
          max_half_spread_bps_est?: number | null
          max_impact_bps_est?: number | null
          notes?: string | null
          realized_vol_daily?: number | null
          sample_days: number
          spread_pct_est?: number | null
          symbol: string
          updated_at?: string
          vol_widening_coeff_bps_est?: number | null
        }
        Update: {
          adv_notional_20d?: number | null
          adv_notional_60d?: number | null
          adv_shares_20d?: number | null
          as_of?: string
          asset_class?: string
          atr_pct_14d?: number | null
          currency?: string | null
          half_spread_bps_est?: number | null
          impact_coeff_est?: number | null
          max_half_spread_bps_est?: number | null
          max_impact_bps_est?: number | null
          notes?: string | null
          realized_vol_daily?: number | null
          sample_days?: number
          spread_pct_est?: number | null
          symbol?: string
          updated_at?: string
          vol_widening_coeff_bps_est?: number | null
        }
        Relationships: []
      }
      fundamentals_cache: {
        Row: {
          currency: string | null
          data: Json
          expires_at: string
          fetched_at: string
          financial_currency: string | null
          next_earnings_date: string | null
          source: string
          symbol: string
        }
        Insert: {
          currency?: string | null
          data: Json
          expires_at?: string
          fetched_at?: string
          financial_currency?: string | null
          next_earnings_date?: string | null
          source?: string
          symbol: string
        }
        Update: {
          currency?: string | null
          data?: Json
          expires_at?: string
          fetched_at?: string
          financial_currency?: string | null
          next_earnings_date?: string | null
          source?: string
          symbol?: string
        }
        Relationships: []
      }
      headline_translation_cache: {
        Row: {
          confidence: number | null
          created_at: string
          expires_at: string
          language: string | null
          norm_key: string | null
          source_headline: string
          translation: string | null
          updated_at: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          expires_at?: string
          language?: string | null
          norm_key?: string | null
          source_headline: string
          translation?: string | null
          updated_at?: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          expires_at?: string
          language?: string | null
          norm_key?: string | null
          source_headline?: string
          translation?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      hedge_fallback_events: {
        Row: {
          applied: boolean
          applied_notional: number
          candidates: Json
          chosen_symbol: string | null
          created_at: string
          currency: string
          decision_id: string | null
          id: string
          portfolio_id: string
          primary_symbol: string
          reason_code: string
          reason_detail: string
          run_date: string
          side: string
          target_notional: number
          user_id: string
        }
        Insert: {
          applied?: boolean
          applied_notional?: number
          candidates?: Json
          chosen_symbol?: string | null
          created_at?: string
          currency?: string
          decision_id?: string | null
          id?: string
          portfolio_id: string
          primary_symbol: string
          reason_code: string
          reason_detail: string
          run_date: string
          side: string
          target_notional?: number
          user_id: string
        }
        Update: {
          applied?: boolean
          applied_notional?: number
          candidates?: Json
          chosen_symbol?: string | null
          created_at?: string
          currency?: string
          decision_id?: string | null
          id?: string
          portfolio_id?: string
          primary_symbol?: string
          reason_code?: string
          reason_detail?: string
          run_date?: string
          side?: string
          target_notional?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hedge_fallback_events_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      holdings: {
        Row: {
          asset_class: Database["public"]["Enums"]["asset_class"]
          avg_cost: number
          high_water_mark: number | null
          id: string
          instrument_ccy: string
          opened_at: string
          portfolio_id: string
          quantity: number
          symbol: string
          updated_at: string
        }
        Insert: {
          asset_class: Database["public"]["Enums"]["asset_class"]
          avg_cost?: number
          high_water_mark?: number | null
          id?: string
          instrument_ccy?: string
          opened_at?: string
          portfolio_id: string
          quantity?: number
          symbol: string
          updated_at?: string
        }
        Update: {
          asset_class?: Database["public"]["Enums"]["asset_class"]
          avg_cost?: number
          high_water_mark?: number | null
          id?: string
          instrument_ccy?: string
          opened_at?: string
          portfolio_id?: string
          quantity?: number
          symbol?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "holdings_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      hyperparam_history: {
        Row: {
          created_at: string
          id: string
          kelly_cap: number
          n_symbols: number
          notes: string | null
          oos_score: number | null
          portfolio_id: string
          rsi_period: number
          sma_fast: number
          sma_slow: number
          train_score: number | null
          tuned_at: string
          window_days: number
        }
        Insert: {
          created_at?: string
          id?: string
          kelly_cap: number
          n_symbols?: number
          notes?: string | null
          oos_score?: number | null
          portfolio_id: string
          rsi_period: number
          sma_fast: number
          sma_slow: number
          train_score?: number | null
          tuned_at: string
          window_days?: number
        }
        Update: {
          created_at?: string
          id?: string
          kelly_cap?: number
          n_symbols?: number
          notes?: string | null
          oos_score?: number | null
          portfolio_id?: string
          rsi_period?: number
          sma_fast?: number
          sma_slow?: number
          train_score?: number | null
          tuned_at?: string
          window_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "hyperparam_history_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          completed_at: string | null
          created_at: string
          endpoint: string
          expires_at: string
          id: string
          idempotency_key: string
          request_hash: string
          response: Json | null
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          endpoint: string
          expires_at?: string
          id?: string
          idempotency_key: string
          request_hash: string
          response?: Json | null
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          endpoint?: string
          expires_at?: string
          id?: string
          idempotency_key?: string
          request_hash?: string
          response?: Json | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      insider_dealing_events: {
        Row: {
          ai_confidence: number | null
          ai_nudge: number | null
          ai_rationale: string | null
          ai_scanned_at: string | null
          ai_verdict: string | null
          company: string
          created_at: string
          direction: string
          event_date: string | null
          fetched_at: string
          flavour: string
          headline: string
          id: string
          person: string | null
          role: string | null
          sentiment_nudge: number
          severity: number
          shares: number | null
          source: string | null
          summary: string | null
          symbol: string
          url: string | null
          value: number | null
        }
        Insert: {
          ai_confidence?: number | null
          ai_nudge?: number | null
          ai_rationale?: string | null
          ai_scanned_at?: string | null
          ai_verdict?: string | null
          company: string
          created_at?: string
          direction?: string
          event_date?: string | null
          fetched_at?: string
          flavour?: string
          headline: string
          id?: string
          person?: string | null
          role?: string | null
          sentiment_nudge?: number
          severity?: number
          shares?: number | null
          source?: string | null
          summary?: string | null
          symbol: string
          url?: string | null
          value?: number | null
        }
        Update: {
          ai_confidence?: number | null
          ai_nudge?: number | null
          ai_rationale?: string | null
          ai_scanned_at?: string | null
          ai_verdict?: string | null
          company?: string
          created_at?: string
          direction?: string
          event_date?: string | null
          fetched_at?: string
          flavour?: string
          headline?: string
          id?: string
          person?: string | null
          role?: string | null
          sentiment_nudge?: number
          severity?: number
          shares?: number | null
          source?: string | null
          summary?: string | null
          symbol?: string
          url?: string | null
          value?: number | null
        }
        Relationships: []
      }
      insider_scan_runs: {
        Row: {
          ai_scored: number
          alerted: number
          created_at: string
          detected: number
          duration_ms: number | null
          error: string | null
          id: string
          mechanical: number
          model: string | null
          noise: number
          signals: number
          stored: number
          targets: number
          trigger: string
        }
        Insert: {
          ai_scored?: number
          alerted?: number
          created_at?: string
          detected?: number
          duration_ms?: number | null
          error?: string | null
          id?: string
          mechanical?: number
          model?: string | null
          noise?: number
          signals?: number
          stored?: number
          targets?: number
          trigger?: string
        }
        Update: {
          ai_scored?: number
          alerted?: number
          created_at?: string
          detected?: number
          duration_ms?: number | null
          error?: string | null
          id?: string
          mechanical?: number
          model?: string | null
          noise?: number
          signals?: number
          stored?: number
          targets?: number
          trigger?: string
        }
        Relationships: []
      }
      lesson_overrides: {
        Row: {
          action: string
          created_at: string
          feedback_score: number | null
          helpful_count: number
          id: string
          original_text: string
          reason: string | null
          replacement_text: string | null
          unhelpful_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          feedback_score?: number | null
          helpful_count?: number
          id?: string
          original_text: string
          reason?: string | null
          replacement_text?: string | null
          unhelpful_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          feedback_score?: number | null
          helpful_count?: number
          id?: string
          original_text?: string
          reason?: string | null
          replacement_text?: string | null
          unhelpful_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      live_broker_log: {
        Row: {
          broker: string
          created_at: string
          env: string
          error: string | null
          id: string
          method: string
          path: string
          portfolio_id: string | null
          request: Json | null
          response: Json | null
          status: number | null
          user_id: string
        }
        Insert: {
          broker?: string
          created_at?: string
          env?: string
          error?: string | null
          id?: string
          method: string
          path: string
          portfolio_id?: string | null
          request?: Json | null
          response?: Json | null
          status?: number | null
          user_id: string
        }
        Update: {
          broker?: string
          created_at?: string
          env?: string
          error?: string | null
          id?: string
          method?: string
          path?: string
          portfolio_id?: string | null
          request?: Json | null
          response?: Json | null
          status?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_broker_log_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      live_fills: {
        Row: {
          broker_fill_id: string | null
          broker_trade_id: string | null
          created_at: string
          currency: string
          fee: number
          fee_commission: number | null
          fee_exchange: number | null
          fee_other: number | null
          fee_source: string
          fee_sync_attempted_at: string | null
          fee_sync_reason: string | null
          fee_sync_status: string
          fee_synced_at: string | null
          fee_tax: number | null
          fill_price: number
          filled_at: string
          id: string
          order_id: string
          portfolio_id: string
          quantity: number
          side: string
          symbol: string
          user_id: string
        }
        Insert: {
          broker_fill_id?: string | null
          broker_trade_id?: string | null
          created_at?: string
          currency?: string
          fee?: number
          fee_commission?: number | null
          fee_exchange?: number | null
          fee_other?: number | null
          fee_source?: string
          fee_sync_attempted_at?: string | null
          fee_sync_reason?: string | null
          fee_sync_status?: string
          fee_synced_at?: string | null
          fee_tax?: number | null
          fill_price: number
          filled_at?: string
          id?: string
          order_id: string
          portfolio_id: string
          quantity: number
          side: string
          symbol: string
          user_id: string
        }
        Update: {
          broker_fill_id?: string | null
          broker_trade_id?: string | null
          created_at?: string
          currency?: string
          fee?: number
          fee_commission?: number | null
          fee_exchange?: number | null
          fee_other?: number | null
          fee_source?: string
          fee_sync_attempted_at?: string | null
          fee_sync_reason?: string | null
          fee_sync_status?: string
          fee_synced_at?: string | null
          fee_tax?: number | null
          fill_price?: number
          filled_at?: string
          id?: string
          order_id?: string
          portfolio_id?: string
          quantity?: number
          side?: string
          symbol?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_fills_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "live_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_fills_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      live_orders: {
        Row: {
          broker: string
          broker_order_id: string | null
          client_order_id: string | null
          conviction: number | null
          created_at: string
          decision_id: string | null
          id: string
          instrument_ccy: string
          limit_price: number | null
          order_type: string
          portfolio_id: string
          quantity: number
          reject_reason: string | null
          side: string
          status: string
          submitted_at: string | null
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          broker?: string
          broker_order_id?: string | null
          client_order_id?: string | null
          conviction?: number | null
          created_at?: string
          decision_id?: string | null
          id?: string
          instrument_ccy: string
          limit_price?: number | null
          order_type?: string
          portfolio_id: string
          quantity: number
          reject_reason?: string | null
          side: string
          status?: string
          submitted_at?: string | null
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          broker?: string
          broker_order_id?: string | null
          client_order_id?: string | null
          conviction?: number | null
          created_at?: string
          decision_id?: string | null
          id?: string
          instrument_ccy?: string
          limit_price?: number | null
          order_type?: string
          portfolio_id?: string
          quantity?: number
          reject_reason?: string | null
          side?: string
          status?: string
          submitted_at?: string | null
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_orders_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_orders_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      live_reconciliation: {
        Row: {
          as_of: string
          broker_cash: number | null
          broker_positions: Json | null
          created_at: string
          drift_flag: boolean
          drift_notes: string | null
          id: string
          local_cash: number | null
          local_positions: Json | null
          portfolio_id: string
          user_id: string
        }
        Insert: {
          as_of?: string
          broker_cash?: number | null
          broker_positions?: Json | null
          created_at?: string
          drift_flag?: boolean
          drift_notes?: string | null
          id?: string
          local_cash?: number | null
          local_positions?: Json | null
          portfolio_id: string
          user_id: string
        }
        Update: {
          as_of?: string
          broker_cash?: number | null
          broker_positions?: Json | null
          created_at?: string
          drift_flag?: boolean
          drift_notes?: string | null
          id?: string
          local_cash?: number | null
          local_positions?: Json | null
          portfolio_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_reconciliation_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      macro_lessons: {
        Row: {
          active: boolean
          created_at: string
          drawdown_rules: Json
          episodes: number
          event_lessons: Json
          event_reel: Json | null
          generated_at: string
          id: string
          lessons: Json
          model: string | null
          narrative: string
          news_window_days: number
          playbook: Json
          stats: Json
          user_id: string
          years_covered: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          drawdown_rules?: Json
          episodes?: number
          event_lessons?: Json
          event_reel?: Json | null
          generated_at?: string
          id?: string
          lessons?: Json
          model?: string | null
          narrative?: string
          news_window_days?: number
          playbook?: Json
          stats?: Json
          user_id: string
          years_covered?: number
        }
        Update: {
          active?: boolean
          created_at?: string
          drawdown_rules?: Json
          episodes?: number
          event_lessons?: Json
          event_reel?: Json | null
          generated_at?: string
          id?: string
          lessons?: Json
          model?: string | null
          narrative?: string
          news_window_days?: number
          playbook?: Json
          stats?: Json
          user_id?: string
          years_covered?: number
        }
        Relationships: []
      }
      market_events: {
        Row: {
          created_at: string
          event_date: string
          id: string
          impact: string
          kind: string
          notes: string | null
          symbol: string | null
          title: string
        }
        Insert: {
          created_at?: string
          event_date: string
          id?: string
          impact?: string
          kind: string
          notes?: string | null
          symbol?: string | null
          title: string
        }
        Update: {
          created_at?: string
          event_date?: string
          id?: string
          impact?: string
          kind?: string
          notes?: string | null
          symbol?: string | null
          title?: string
        }
        Relationships: []
      }
      market_open_alerts_sent: {
        Row: {
          alert_date: string
          sent_at: string
          venue: string
        }
        Insert: {
          alert_date: string
          sent_at?: string
          venue: string
        }
        Update: {
          alert_date?: string
          sent_at?: string
          venue?: string
        }
        Relationships: []
      }
      market_regimes: {
        Row: {
          as_of: string
          confidence: number
          created_at: string
          id: string
          notes: string | null
          previous_regime: string | null
          regime: string
          signals: Json
          transitioned: boolean
        }
        Insert: {
          as_of: string
          confidence?: number
          created_at?: string
          id?: string
          notes?: string | null
          previous_regime?: string | null
          regime: string
          signals?: Json
          transitioned?: boolean
        }
        Update: {
          as_of?: string
          confidence?: number
          created_at?: string
          id?: string
          notes?: string | null
          previous_regime?: string | null
          regime?: string
          signals?: Json
          transitioned?: boolean
        }
        Relationships: []
      }
      market_signal_strength: {
        Row: {
          computed_at: string
          dates: number
          from_date: string | null
          hit_rate: number | null
          horizon_days: number
          ic: number | null
          id: string
          market: string
          mean_net_bps: number | null
          samples: number
          session: string
          strength: number
          t_stat: number | null
          to_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          computed_at?: string
          dates?: number
          from_date?: string | null
          hit_rate?: number | null
          horizon_days?: number
          ic?: number | null
          id?: string
          market: string
          mean_net_bps?: number | null
          samples?: number
          session: string
          strength?: number
          t_stat?: number | null
          to_date?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          computed_at?: string
          dates?: number
          from_date?: string | null
          hit_rate?: number | null
          horizon_days?: number
          ic?: number | null
          id?: string
          market?: string
          mean_net_bps?: number | null
          samples?: number
          session?: string
          strength?: number
          t_stat?: number | null
          to_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      news_backfill_jobs: {
        Row: {
          created_at: string
          created_by: string | null
          cursor_date: string | null
          days_done: number
          days_total: number
          end_date: string
          finished_at: string | null
          headlines_inserted: number
          id: string
          last_error: string | null
          new_sources: Json
          requested_days: number
          start_date: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          cursor_date?: string | null
          days_done?: number
          days_total: number
          end_date: string
          finished_at?: string | null
          headlines_inserted?: number
          id?: string
          last_error?: string | null
          new_sources?: Json
          requested_days: number
          start_date: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          cursor_date?: string | null
          days_done?: number
          days_total?: number
          end_date?: string
          finished_at?: string | null
          headlines_inserted?: number
          id?: string
          last_error?: string | null
          new_sources?: Json
          requested_days?: number
          start_date?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      news_cache: {
        Row: {
          entities: Json | null
          fetched_at: string
          headline: string
          id: string
          news_date: string
          original_headline: string | null
          original_language: string | null
          relevance_reason: string | null
          relevance_score: number | null
          relevance_tags: Json | null
          sentiment: string | null
          source: string | null
          source_weight: number | null
          summary: string | null
          translation_confidence: number | null
          url: string | null
        }
        Insert: {
          entities?: Json | null
          fetched_at?: string
          headline: string
          id?: string
          news_date: string
          original_headline?: string | null
          original_language?: string | null
          relevance_reason?: string | null
          relevance_score?: number | null
          relevance_tags?: Json | null
          sentiment?: string | null
          source?: string | null
          source_weight?: number | null
          summary?: string | null
          translation_confidence?: number | null
          url?: string | null
        }
        Update: {
          entities?: Json | null
          fetched_at?: string
          headline?: string
          id?: string
          news_date?: string
          original_headline?: string | null
          original_language?: string | null
          relevance_reason?: string | null
          relevance_score?: number | null
          relevance_tags?: Json | null
          sentiment?: string | null
          source?: string | null
          source_weight?: number | null
          summary?: string | null
          translation_confidence?: number | null
          url?: string | null
        }
        Relationships: []
      }
      news_relevance_runs: {
        Row: {
          batch_failures: number
          batches: number
          created_at: string
          failure_reasons: Json
          fallback_items: number
          fallback_reason: string | null
          id: string
          items: number
          latency_ms_max: number
          latency_ms_p50: number
          latency_ms_total: number
          llm_scored: number
          news_date: string
          trigger: string
        }
        Insert: {
          batch_failures?: number
          batches?: number
          created_at?: string
          failure_reasons?: Json
          fallback_items?: number
          fallback_reason?: string | null
          id?: string
          items?: number
          latency_ms_max?: number
          latency_ms_p50?: number
          latency_ms_total?: number
          llm_scored?: number
          news_date: string
          trigger?: string
        }
        Update: {
          batch_failures?: number
          batches?: number
          created_at?: string
          failure_reasons?: Json
          fallback_items?: number
          fallback_reason?: string | null
          id?: string
          items?: number
          latency_ms_max?: number
          latency_ms_p50?: number
          latency_ms_total?: number
          llm_scored?: number
          news_date?: string
          trigger?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          category: string
          created_at: string
          details: Json
          id: string
          portfolio_id: string | null
          read_at: string | null
          severity: string
          slice_id: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string | null
          category?: string
          created_at?: string
          details?: Json
          id?: string
          portfolio_id?: string | null
          read_at?: string | null
          severity?: string
          slice_id?: string | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string | null
          category?: string
          created_at?: string
          details?: Json
          id?: string
          portfolio_id?: string | null
          read_at?: string | null
          severity?: string
          slice_id?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      observed_quote_currency: {
        Row: {
          id: string
          observed_at: string
          quote_currency: string
          sample_price: number | null
          source: string | null
          symbol: string
        }
        Insert: {
          id?: string
          observed_at?: string
          quote_currency: string
          sample_price?: number | null
          source?: string | null
          symbol: string
        }
        Update: {
          id?: string
          observed_at?: string
          quote_currency?: string
          sample_price?: number | null
          source?: string | null
          symbol?: string
        }
        Relationships: []
      }
      order_batch_queue: {
        Row: {
          conviction: number | null
          created_at: string
          expires_at: string
          first_seen_at: string
          id: string
          notional_base: number
          portfolio_id: string
          price: number
          quantity: number
          side: string
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          conviction?: number | null
          created_at?: string
          expires_at: string
          first_seen_at?: string
          id?: string
          notional_base: number
          portfolio_id: string
          price: number
          quantity: number
          side?: string
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          conviction?: number | null
          created_at?: string
          expires_at?: string
          first_seen_at?: string
          id?: string
          notional_base?: number
          portfolio_id?: string
          price?: number
          quantity?: number
          side?: string
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_batch_queue_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      order_explanations: {
        Row: {
          created_at: string
          decision_id: string
          explanation: string
          id: string
          model: string | null
          order_key: string
          prompt_hash: string
        }
        Insert: {
          created_at?: string
          decision_id: string
          explanation: string
          id?: string
          model?: string | null
          order_key: string
          prompt_hash: string
        }
        Update: {
          created_at?: string
          decision_id?: string
          explanation?: string
          id?: string
          model?: string | null
          order_key?: string
          prompt_hash?: string
        }
        Relationships: []
      }
      order_reconcile_events: {
        Row: {
          age_ms: number | null
          avg_fill_price: number | null
          broker: string
          broker_order_id: string | null
          created_at: string
          env: string
          filled_quantity: number
          id: string
          new_status: string
          occurred_at: string
          order_id: string
          order_type: string | null
          outcome: string
          portfolio_id: string
          previous_status: string
          reason: string | null
          reason_code: string
          saxo_filled_at: string | null
          saxo_reason: string | null
          saxo_response: Json | null
          saxo_status: string | null
          side: string | null
          source: string
          submitted_at: string | null
          symbol: string
          user_id: string
        }
        Insert: {
          age_ms?: number | null
          avg_fill_price?: number | null
          broker?: string
          broker_order_id?: string | null
          created_at?: string
          env?: string
          filled_quantity?: number
          id?: string
          new_status: string
          occurred_at?: string
          order_id: string
          order_type?: string | null
          outcome: string
          portfolio_id: string
          previous_status: string
          reason?: string | null
          reason_code: string
          saxo_filled_at?: string | null
          saxo_reason?: string | null
          saxo_response?: Json | null
          saxo_status?: string | null
          side?: string | null
          source?: string
          submitted_at?: string | null
          symbol: string
          user_id: string
        }
        Update: {
          age_ms?: number | null
          avg_fill_price?: number | null
          broker?: string
          broker_order_id?: string | null
          created_at?: string
          env?: string
          filled_quantity?: number
          id?: string
          new_status?: string
          occurred_at?: string
          order_id?: string
          order_type?: string | null
          outcome?: string
          portfolio_id?: string
          previous_status?: string
          reason?: string | null
          reason_code?: string
          saxo_filled_at?: string | null
          saxo_reason?: string | null
          saxo_response?: Json | null
          saxo_status?: string | null
          side?: string | null
          source?: string
          submitted_at?: string | null
          symbol?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_reconcile_events_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "live_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_reconcile_events_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_slices: {
        Row: {
          adv_notional: number | null
          created_at: string
          decision_id: string | null
          expires_at: string
          id: string
          idempotency_key: string | null
          instrument_ccy: string
          limit_price: number | null
          next_at: string
          notes: string | null
          portfolio_id: string
          remaining_qty: number
          schedule_json: Json | null
          side: string
          slice_count: number
          slice_qty: number
          slices_done: number
          status: string
          strategy: string
          symbol: string
          total_qty: number
          updated_at: string
        }
        Insert: {
          adv_notional?: number | null
          created_at?: string
          decision_id?: string | null
          expires_at: string
          id?: string
          idempotency_key?: string | null
          instrument_ccy?: string
          limit_price?: number | null
          next_at?: string
          notes?: string | null
          portfolio_id: string
          remaining_qty: number
          schedule_json?: Json | null
          side: string
          slice_count?: number
          slice_qty: number
          slices_done?: number
          status?: string
          strategy?: string
          symbol: string
          total_qty: number
          updated_at?: string
        }
        Update: {
          adv_notional?: number | null
          created_at?: string
          decision_id?: string | null
          expires_at?: string
          id?: string
          idempotency_key?: string | null
          instrument_ccy?: string
          limit_price?: number | null
          next_at?: string
          notes?: string | null
          portfolio_id?: string
          remaining_qty?: number
          schedule_json?: Json | null
          side?: string
          slice_count?: number
          slice_qty?: number
          slices_done?: number
          status?: string
          strategy?: string
          symbol?: string
          total_qty?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_slices_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_slices_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_lessons: {
        Row: {
          as_of: string
          created_at: string
          id: string
          lessons: Json
          portfolio_id: string | null
          regime: string | null
          stats: Json
          user_id: string
          window_days: number
        }
        Insert: {
          as_of: string
          created_at?: string
          id?: string
          lessons?: Json
          portfolio_id?: string | null
          regime?: string | null
          stats?: Json
          user_id: string
          window_days?: number
        }
        Update: {
          as_of?: string
          created_at?: string
          id?: string
          lessons?: Json
          portfolio_id?: string | null
          regime?: string | null
          stats?: Json
          user_id?: string
          window_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_lessons_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolios: {
        Row: {
          broker: string | null
          broker_account_id: string | null
          cash_by_ccy: Json
          circuit_breaker: Json
          concentration_autotrim: boolean
          concentration_cap_pct: number | null
          created_at: string
          currency: string
          current_cash: number
          fx_enabled: boolean
          fx_execution_mode: string
          holding_dd_autoclose: boolean
          holding_dd_budget_pct: number | null
          hyperparams: Json
          id: string
          last_run_date: string | null
          live_activated_at: string | null
          live_paused: boolean
          loss_cooldowns: Json
          mode: Database["public"]["Enums"]["portfolio_mode"]
          name: string
          risk_config: Json
          risk_level: Database["public"]["Enums"]["risk_level"]
          starting_cash: number
          status: Database["public"]["Enums"]["portfolio_status"]
          universe: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          broker?: string | null
          broker_account_id?: string | null
          cash_by_ccy?: Json
          circuit_breaker?: Json
          concentration_autotrim?: boolean
          concentration_cap_pct?: number | null
          created_at?: string
          currency?: string
          current_cash?: number
          fx_enabled?: boolean
          fx_execution_mode?: string
          holding_dd_autoclose?: boolean
          holding_dd_budget_pct?: number | null
          hyperparams?: Json
          id?: string
          last_run_date?: string | null
          live_activated_at?: string | null
          live_paused?: boolean
          loss_cooldowns?: Json
          mode?: Database["public"]["Enums"]["portfolio_mode"]
          name?: string
          risk_config?: Json
          risk_level?: Database["public"]["Enums"]["risk_level"]
          starting_cash?: number
          status?: Database["public"]["Enums"]["portfolio_status"]
          universe?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          broker?: string | null
          broker_account_id?: string | null
          cash_by_ccy?: Json
          circuit_breaker?: Json
          concentration_autotrim?: boolean
          concentration_cap_pct?: number | null
          created_at?: string
          currency?: string
          current_cash?: number
          fx_enabled?: boolean
          fx_execution_mode?: string
          holding_dd_autoclose?: boolean
          holding_dd_budget_pct?: number | null
          hyperparams?: Json
          id?: string
          last_run_date?: string | null
          live_activated_at?: string | null
          live_paused?: boolean
          loss_cooldowns?: Json
          mode?: Database["public"]["Enums"]["portfolio_mode"]
          name?: string
          risk_config?: Json
          risk_level?: Database["public"]["Enums"]["risk_level"]
          starting_cash?: number
          status?: Database["public"]["Enums"]["portfolio_status"]
          universe?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      price_cache: {
        Row: {
          close: number
          fetched_at: string
          high: number | null
          low: number | null
          open: number | null
          price_date: string
          symbol: string
          volume: number | null
        }
        Insert: {
          close: number
          fetched_at?: string
          high?: number | null
          low?: number | null
          open?: number | null
          price_date: string
          symbol: string
          volume?: number | null
        }
        Update: {
          close?: number
          fetched_at?: string
          high?: number | null
          low?: number | null
          open?: number | null
          price_date?: string
          symbol?: string
          volume?: number | null
        }
        Relationships: []
      }
      price_intraday: {
        Row: {
          bucket_hour: string
          created_at: string
          price: number
          source: string
          symbol: string
        }
        Insert: {
          bucket_hour: string
          created_at?: string
          price: number
          source?: string
          symbol: string
        }
        Update: {
          bucket_hour?: string
          created_at?: string
          price?: number
          source?: string
          symbol?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_used_at: string | null
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_used_at?: string | null
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_used_at?: string | null
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      rate_limit_buckets: {
        Row: {
          key: string
          refilled_at: string
          tokens: number
          updated_at: string
        }
        Insert: {
          key: string
          refilled_at?: string
          tokens: number
          updated_at?: string
        }
        Update: {
          key?: string
          refilled_at?: string
          tokens?: number
          updated_at?: string
        }
        Relationships: []
      }
      retrain_settings: {
        Row: {
          cadence_days: number
          created_at: string
          enabled: boolean
          last_run_at: string | null
          last_run_error: string | null
          last_run_status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cadence_days?: number
          created_at?: string
          enabled?: boolean
          last_run_at?: string | null
          last_run_error?: string | null
          last_run_status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cadence_days?: number
          created_at?: string
          enabled?: boolean
          last_run_at?: string | null
          last_run_error?: string | null
          last_run_status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      risk_halt_overrides: {
        Row: {
          created_at: string
          expires_at: string
          halt_snapshot: Json | null
          id: string
          portfolio_id: string
          reason: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          halt_snapshot?: Json | null
          id?: string
          portfolio_id: string
          reason?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          halt_snapshot?: Json | null
          id?: string
          portfolio_id?: string
          reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "risk_halt_overrides_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      run_locks: {
        Row: {
          acquired_at: string
          expires_at: string | null
          name: string
          owner: string | null
        }
        Insert: {
          acquired_at?: string
          expires_at?: string | null
          name: string
          owner?: string | null
        }
        Update: {
          acquired_at?: string
          expires_at?: string | null
          name?: string
          owner?: string | null
        }
        Relationships: []
      }
      run_metrics: {
        Row: {
          budget_exceeded_count: number
          budget_ms: number | null
          created_at: string
          duration_ms: number
          error: string | null
          id: string
          news_headlines: number
          phases: Json | null
          portfolios_error: number
          portfolios_ok: number
          portfolios_total: number
          preflight_budget_pct: number | null
          preflight_ms: number | null
          price_errors: number
          prices_refreshed: number
          saxo_calls_error: number
          saxo_calls_ok: number
          saxo_calls_total: number
          saxo_retries_429: number
          success: boolean
          triggered_by: string
        }
        Insert: {
          budget_exceeded_count?: number
          budget_ms?: number | null
          created_at?: string
          duration_ms: number
          error?: string | null
          id?: string
          news_headlines?: number
          phases?: Json | null
          portfolios_error?: number
          portfolios_ok?: number
          portfolios_total?: number
          preflight_budget_pct?: number | null
          preflight_ms?: number | null
          price_errors?: number
          prices_refreshed?: number
          saxo_calls_error?: number
          saxo_calls_ok?: number
          saxo_calls_total?: number
          saxo_retries_429?: number
          success: boolean
          triggered_by: string
        }
        Update: {
          budget_exceeded_count?: number
          budget_ms?: number | null
          created_at?: string
          duration_ms?: number
          error?: string | null
          id?: string
          news_headlines?: number
          phases?: Json | null
          portfolios_error?: number
          portfolios_ok?: number
          portfolios_total?: number
          preflight_budget_pct?: number | null
          preflight_ms?: number | null
          price_errors?: number
          prices_refreshed?: number
          saxo_calls_error?: number
          saxo_calls_ok?: number
          saxo_calls_total?: number
          saxo_retries_429?: number
          success?: boolean
          triggered_by?: string
        }
        Relationships: []
      }
      saxo_instrument_cache: {
        Row: {
          asset_type: string
          currency: string | null
          env: string
          exchange_id: string | null
          raw: Json | null
          refreshed_at: string
          symbol: string
          tick_size: number | null
          uic: number
        }
        Insert: {
          asset_type: string
          currency?: string | null
          env?: string
          exchange_id?: string | null
          raw?: Json | null
          refreshed_at?: string
          symbol: string
          tick_size?: number | null
          uic: number
        }
        Update: {
          asset_type?: string
          currency?: string | null
          env?: string
          exchange_id?: string | null
          raw?: Json | null
          refreshed_at?: string
          symbol?: string
          tick_size?: number | null
          uic?: number
        }
        Relationships: []
      }
      saxo_oauth_tokens: {
        Row: {
          access_token: string
          env: string
          expires_at: string
          refresh_expires_at: string | null
          refresh_token: string
          token_type: string
          updated_at: string
        }
        Insert: {
          access_token: string
          env: string
          expires_at: string
          refresh_expires_at?: string | null
          refresh_token: string
          token_type?: string
          updated_at?: string
        }
        Update: {
          access_token?: string
          env?: string
          expires_at?: string
          refresh_expires_at?: string | null
          refresh_token?: string
          token_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      sector_scores: {
        Row: {
          as_of: string
          etf_symbol: string
          id: string
          momentum_30d: number | null
          momentum_90d: number | null
          rank: number | null
          score: number | null
          sector: string
          updated_at: string
        }
        Insert: {
          as_of: string
          etf_symbol: string
          id?: string
          momentum_30d?: number | null
          momentum_90d?: number | null
          rank?: number | null
          score?: number | null
          sector: string
          updated_at?: string
        }
        Update: {
          as_of?: string
          etf_symbol?: string
          id?: string
          momentum_30d?: number | null
          momentum_90d?: number | null
          rank?: number | null
          score?: number | null
          sector?: string
          updated_at?: string
        }
        Relationships: []
      }
      security_alert_settings: {
        Row: {
          cooldown_minutes: number
          created_at: string
          enabled: boolean
          event_type: string
          last_notified_at: string | null
          last_notified_count: number | null
          threshold: number
          updated_at: string
          user_id: string
          window_minutes: number
        }
        Insert: {
          cooldown_minutes?: number
          created_at?: string
          enabled?: boolean
          event_type?: string
          last_notified_at?: string | null
          last_notified_count?: number | null
          threshold?: number
          updated_at?: string
          user_id: string
          window_minutes?: number
        }
        Update: {
          cooldown_minutes?: number
          created_at?: string
          enabled?: boolean
          event_type?: string
          last_notified_at?: string | null
          last_notified_count?: number | null
          threshold?: number
          updated_at?: string
          user_id?: string
          window_minutes?: number
        }
        Relationships: []
      }
      security_audit_log: {
        Row: {
          actor_user_id: string | null
          created_at: string
          details: Json
          event: string
          id: string
          op: string | null
          portfolio_id: string | null
          reason: string | null
          slice_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json
          event: string
          id?: string
          op?: string | null
          portfolio_id?: string | null
          reason?: string | null
          slice_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json
          event?: string
          id?: string
          op?: string | null
          portfolio_id?: string | null
          reason?: string | null
          slice_id?: string | null
        }
        Relationships: []
      }
      setup_scan_runs: {
        Row: {
          duration_ms: number
          errors: Json
          id: string
          matches: Json
          near_misses: Json
          ran_at: string
          rate_limited: boolean
          scanned: number
          source: string
        }
        Insert: {
          duration_ms?: number
          errors?: Json
          id?: string
          matches?: Json
          near_misses?: Json
          ran_at?: string
          rate_limited?: boolean
          scanned?: number
          source?: string
        }
        Update: {
          duration_ms?: number
          errors?: Json
          id?: string
          matches?: Json
          near_misses?: Json
          ran_at?: string
          rate_limited?: boolean
          scanned?: number
          source?: string
        }
        Relationships: []
      }
      shadow_decisions: {
        Row: {
          agreement: number | null
          created_at: string
          decision_id: string | null
          divergences: Json
          id: string
          portfolio_id: string
          primary_order_count: number
          primary_summary: Json
          run_date: string
          shadow_order_count: number
          shadow_summary: Json
          variant_name: string
        }
        Insert: {
          agreement?: number | null
          created_at?: string
          decision_id?: string | null
          divergences?: Json
          id?: string
          portfolio_id: string
          primary_order_count?: number
          primary_summary: Json
          run_date: string
          shadow_order_count?: number
          shadow_summary: Json
          variant_name?: string
        }
        Update: {
          agreement?: number | null
          created_at?: string
          decision_id?: string | null
          divergences?: Json
          id?: string
          portfolio_id?: string
          primary_order_count?: number
          primary_summary?: Json
          run_date?: string
          shadow_order_count?: number
          shadow_summary?: Json
          variant_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "shadow_decisions_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shadow_decisions_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      signal_performance: {
        Row: {
          as_of: string
          avg_edge_bps: number | null
          hit_rate: number | null
          hits: number
          id: string
          portfolio_id: string
          samples: number
          signal_name: string
          updated_at: string
          weight_avg: number | null
          window_days: number
        }
        Insert: {
          as_of: string
          avg_edge_bps?: number | null
          hit_rate?: number | null
          hits?: number
          id?: string
          portfolio_id: string
          samples?: number
          signal_name: string
          updated_at?: string
          weight_avg?: number | null
          window_days?: number
        }
        Update: {
          as_of?: string
          avg_edge_bps?: number | null
          hit_rate?: number | null
          hits?: number
          id?: string
          portfolio_id?: string
          samples?: number
          signal_name?: string
          updated_at?: string
          weight_avg?: number | null
          window_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "signal_performance_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      signal_weight_history: {
        Row: {
          as_of: string
          base_weight: number
          created_at: string
          effective_weight: number
          id: string
          model_kind: string
          multiplier: number
          portfolio_id: string
          reason: string | null
          regime: string
        }
        Insert: {
          as_of: string
          base_weight: number
          created_at?: string
          effective_weight: number
          id?: string
          model_kind: string
          multiplier: number
          portfolio_id: string
          reason?: string | null
          regime?: string
        }
        Update: {
          as_of?: string
          base_weight?: number
          created_at?: string
          effective_weight?: number
          id?: string
          model_kind?: string
          multiplier?: number
          portfolio_id?: string
          reason?: string | null
          regime?: string
        }
        Relationships: [
          {
            foreignKeyName: "signal_weight_history_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      sim_fund_events: {
        Row: {
          amount: number
          balance_after: number
          created_at: string
          currency: string
          id: string
          portfolio_id: string
          user_id: string
        }
        Insert: {
          amount: number
          balance_after: number
          created_at?: string
          currency: string
          id?: string
          portfolio_id: string
          user_id: string
        }
        Update: {
          amount?: number
          balance_after?: number
          created_at?: string
          currency?: string
          id?: string
          portfolio_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sim_fund_events_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      slice_fills: {
        Row: {
          created_at: string
          filled_qty: number
          id: string
          idempotency_key: string
          note: string | null
          portfolio_id: string
          slice_id: string
        }
        Insert: {
          created_at?: string
          filled_qty: number
          id?: string
          idempotency_key: string
          note?: string | null
          portfolio_id: string
          slice_id: string
        }
        Update: {
          created_at?: string
          filled_qty?: number
          id?: string
          idempotency_key?: string
          note?: string | null
          portfolio_id?: string
          slice_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "slice_fills_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slice_fills_slice_id_fkey"
            columns: ["slice_id"]
            isOneToOne: false
            referencedRelation: "pending_slices"
            referencedColumns: ["id"]
          },
        ]
      }
      symbol_execution_costs: {
        Row: {
          buy_bps: number
          computed_at: string
          created_at: string
          fee_bps: number | null
          fills: number
          first_fill_at: string | null
          id: string
          invoiced_fills: number
          last_fill_at: string | null
          measured: boolean
          round_trip_bps: number
          sell_bps: number
          slippage_bps: number | null
          symbol: string
          symbol_key: string
          tickets: number
          updated_at: string
          user_id: string
        }
        Insert: {
          buy_bps: number
          computed_at?: string
          created_at?: string
          fee_bps?: number | null
          fills?: number
          first_fill_at?: string | null
          id?: string
          invoiced_fills?: number
          last_fill_at?: string | null
          measured?: boolean
          round_trip_bps: number
          sell_bps: number
          slippage_bps?: number | null
          symbol: string
          symbol_key: string
          tickets?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          buy_bps?: number
          computed_at?: string
          created_at?: string
          fee_bps?: number | null
          fills?: number
          first_fill_at?: string | null
          id?: string
          invoiced_fills?: number
          last_fill_at?: string | null
          measured?: boolean
          round_trip_bps?: number
          sell_bps?: number
          slippage_bps?: number | null
          symbol?: string
          symbol_key?: string
          tickets?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      symbol_risk_overrides: {
        Row: {
          created_at: string
          id: string
          max_position_pct: number | null
          min_signal_strength: number | null
          note: string | null
          paused: boolean
          stop_loss_pct: number | null
          symbol: string
          take_profit_pct: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          max_position_pct?: number | null
          min_signal_strength?: number | null
          note?: string | null
          paused?: boolean
          stop_loss_pct?: number | null
          symbol: string
          take_profit_pct?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          max_position_pct?: number | null
          min_signal_strength?: number | null
          note?: string | null
          paused?: boolean
          stop_loss_pct?: number | null
          symbol?: string
          take_profit_pct?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      symbol_signal_strength: {
        Row: {
          computed_at: string
          dates: number
          from_date: string | null
          hit_rate: number | null
          horizon_days: number
          ic: number | null
          id: string
          mean_net_bps: number | null
          samples: number
          strength: number
          symbol: string
          symbol_key: string
          t_stat: number | null
          to_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          computed_at?: string
          dates?: number
          from_date?: string | null
          hit_rate?: number | null
          horizon_days?: number
          ic?: number | null
          id?: string
          mean_net_bps?: number | null
          samples?: number
          strength?: number
          symbol: string
          symbol_key: string
          t_stat?: number | null
          to_date?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          computed_at?: string
          dates?: number
          from_date?: string | null
          hit_rate?: number | null
          horizon_days?: number
          ic?: number | null
          id?: string
          mean_net_bps?: number | null
          samples?: number
          strength?: number
          symbol?: string
          symbol_key?: string
          t_stat?: number | null
          to_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ticker_watch_alerts: {
        Row: {
          alert_date: string
          created_at: string
          details: Json
          id: string
          price: number | null
          symbol: string
          trigger_code: string
          user_id: string
          watch_id: string
        }
        Insert: {
          alert_date?: string
          created_at?: string
          details?: Json
          id?: string
          price?: number | null
          symbol: string
          trigger_code: string
          user_id: string
          watch_id: string
        }
        Update: {
          alert_date?: string
          created_at?: string
          details?: Json
          id?: string
          price?: number | null
          symbol?: string
          trigger_code?: string
          user_id?: string
          watch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticker_watch_alerts_watch_id_fkey"
            columns: ["watch_id"]
            isOneToOne: false
            referencedRelation: "ticker_watches"
            referencedColumns: ["id"]
          },
        ]
      }
      ticker_watches: {
        Row: {
          active: boolean
          buy_above: number | null
          created_at: string
          drop_below: number | null
          id: string
          label: string | null
          max_vol_pct: number
          oversold_rsi: number
          symbol: string
          thesis: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          buy_above?: number | null
          created_at?: string
          drop_below?: number | null
          id?: string
          label?: string | null
          max_vol_pct?: number
          oversold_rsi?: number
          symbol: string
          thesis?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          buy_above?: number | null
          created_at?: string
          drop_below?: number | null
          id?: string
          label?: string | null
          max_vol_pct?: number
          oversold_rsi?: number
          symbol?: string
          thesis?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trade_strategies: {
        Row: {
          asset_class: Database["public"]["Enums"]["asset_class"]
          created_at: string
          enabled: boolean
          entered_at: string | null
          entry_mode: string
          entry_price: number
          exit_reason: string | null
          exited_at: string | null
          id: string
          instrument_ccy: string
          last_error: string | null
          last_evaluated_at: string | null
          portfolio_id: string
          quantity: number
          status: string
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asset_class?: Database["public"]["Enums"]["asset_class"]
          created_at?: string
          enabled?: boolean
          entered_at?: string | null
          entry_mode?: string
          entry_price: number
          exit_reason?: string | null
          exited_at?: string | null
          id?: string
          instrument_ccy?: string
          last_error?: string | null
          last_evaluated_at?: string | null
          portfolio_id: string
          quantity: number
          status?: string
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asset_class?: Database["public"]["Enums"]["asset_class"]
          created_at?: string
          enabled?: boolean
          entered_at?: string | null
          entry_mode?: string
          entry_price?: number
          exit_reason?: string | null
          exited_at?: string | null
          id?: string
          instrument_ccy?: string
          last_error?: string | null
          last_evaluated_at?: string | null
          portfolio_id?: string
          quantity?: number
          status?: string
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_strategies_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      trades: {
        Row: {
          asset_class: Database["public"]["Enums"]["asset_class"]
          conviction: number | null
          executed_at: string
          id: string
          instrument_ccy: string
          portfolio_id: string
          price: number
          quantity: number
          reason: string | null
          side: Database["public"]["Enums"]["trade_side"]
          symbol: string
          trade_date: string
          value: number
        }
        Insert: {
          asset_class: Database["public"]["Enums"]["asset_class"]
          conviction?: number | null
          executed_at?: string
          id?: string
          instrument_ccy?: string
          portfolio_id: string
          price: number
          quantity: number
          reason?: string | null
          side: Database["public"]["Enums"]["trade_side"]
          symbol: string
          trade_date: string
          value: number
        }
        Update: {
          asset_class?: Database["public"]["Enums"]["asset_class"]
          conviction?: number | null
          executed_at?: string
          id?: string
          instrument_ccy?: string
          portfolio_id?: string
          price?: number
          quantity?: number
          reason?: string | null
          side?: Database["public"]["Enums"]["trade_side"]
          symbol?: string
          trade_date?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "trades_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      trading_controls: {
        Row: {
          base_currency: string
          cost_hurdle_multiple: number
          daily_notional_limit: number
          halt_reason: string | null
          id: boolean
          trading_enabled: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          base_currency?: string
          cost_hurdle_multiple?: number
          daily_notional_limit?: number
          halt_reason?: string | null
          id?: boolean
          trading_enabled?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          base_currency?: string
          cost_hurdle_multiple?: number
          daily_notional_limit?: number
          halt_reason?: string | null
          id?: boolean
          trading_enabled?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      valuation_write_rejections: {
        Row: {
          attempted: Json | null
          created_at: string
          id: string
          portfolio_id: string
          reason: string
          snapshot_date: string
          source: string | null
          violations: Json | null
        }
        Insert: {
          attempted?: Json | null
          created_at?: string
          id?: string
          portfolio_id: string
          reason: string
          snapshot_date: string
          source?: string | null
          violations?: Json | null
        }
        Update: {
          attempted?: Json | null
          created_at?: string
          id?: string
          portfolio_id?: string
          reason?: string
          snapshot_date?: string
          source?: string | null
          violations?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "valuation_write_rejections_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      wallet_snapshots: {
        Row: {
          base_ccy: string
          base_total: number
          cash_by_ccy: Json
          created_at: string
          id: string
          portfolio_id: string
          snapshot_date: string
        }
        Insert: {
          base_ccy: string
          base_total?: number
          cash_by_ccy?: Json
          created_at?: string
          id?: string
          portfolio_id: string
          snapshot_date: string
        }
        Update: {
          base_ccy?: string
          base_total?: number
          cash_by_ccy?: Json
          created_at?: string
          id?: string
          portfolio_id?: string
          snapshot_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallet_snapshots_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      portfolio_latest_totals: {
        Row: {
          cash: number | null
          holdings_value: number | null
          portfolio_id: string | null
          snapshot_date: string | null
          total_value: number | null
        }
        Relationships: [
          {
            foreignKeyName: "equity_snapshots_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      consume_rate_limit: {
        Args: {
          _capacity: number
          _cost?: number
          _key: string
          _refill_per_sec: number
        }
        Returns: {
          allowed: boolean
          remaining: number
          retry_after: number
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      prune_live_broker_log: { Args: never; Returns: undefined }
      purge_expired_idempotency_keys: { Args: never; Returns: number }
      sweep_expired_run_locks: { Args: never; Returns: number }
    }
    Enums: {
      algo_regime_tune_status:
        | "pending"
        | "accepted"
        | "rolled_back"
        | "superseded"
      app_role: "admin" | "moderator" | "user"
      asset_class: "stock" | "etf" | "crypto" | "commodity" | "fx"
      portfolio_mode: "backtest" | "paper" | "live_sim" | "live_prod"
      portfolio_status: "active" | "paused" | "complete"
      risk_level: "conservative" | "balanced" | "aggressive"
      trade_side: "buy" | "sell"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      algo_regime_tune_status: [
        "pending",
        "accepted",
        "rolled_back",
        "superseded",
      ],
      app_role: ["admin", "moderator", "user"],
      asset_class: ["stock", "etf", "crypto", "commodity", "fx"],
      portfolio_mode: ["backtest", "paper", "live_sim", "live_prod"],
      portfolio_status: ["active", "paused", "complete"],
      risk_level: ["conservative", "balanced", "aggressive"],
      trade_side: ["buy", "sell"],
    },
  },
} as const
