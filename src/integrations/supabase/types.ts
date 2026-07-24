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
      decisions: {
        Row: {
          briefing: string
          created_at: string
          id: string
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
      equity_snapshots: {
        Row: {
          cash: number
          holdings_value: number
          id: string
          portfolio_id: string
          snapshot_date: string
          total_value: number
        }
        Insert: {
          cash: number
          holdings_value: number
          id?: string
          portfolio_id: string
          snapshot_date: string
          total_value: number
        }
        Update: {
          cash?: number
          holdings_value?: number
          id?: string
          portfolio_id?: string
          snapshot_date?: string
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
      headline_translation_cache: {
        Row: {
          confidence: number | null
          created_at: string
          expires_at: string
          language: string | null
          source_headline: string
          translation: string | null
          updated_at: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          expires_at?: string
          language?: string | null
          source_headline: string
          translation?: string | null
          updated_at?: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          expires_at?: string
          language?: string | null
          source_headline?: string
          translation?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      holdings: {
        Row: {
          asset_class: Database["public"]["Enums"]["asset_class"]
          avg_cost: number
          high_water_mark: number | null
          id: string
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
          created_at: string
          currency: string
          fee: number
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
          created_at?: string
          currency?: string
          fee?: number
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
          created_at?: string
          currency?: string
          fee?: number
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
          created_at: string
          decision_id: string | null
          id: string
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
          created_at?: string
          decision_id?: string | null
          id?: string
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
          created_at?: string
          decision_id?: string | null
          id?: string
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
      news_cache: {
        Row: {
          entities: Json | null
          fetched_at: string
          headline: string
          id: string
          news_date: string
          original_headline: string | null
          original_language: string | null
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
          sentiment?: string | null
          source?: string | null
          source_weight?: number | null
          summary?: string | null
          translation_confidence?: number | null
          url?: string | null
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
      pending_slices: {
        Row: {
          created_at: string
          decision_id: string | null
          expires_at: string
          id: string
          idempotency_key: string | null
          limit_price: number | null
          next_at: string
          notes: string | null
          portfolio_id: string
          remaining_qty: number
          side: string
          slice_count: number
          slice_qty: number
          slices_done: number
          status: string
          symbol: string
          total_qty: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          decision_id?: string | null
          expires_at: string
          id?: string
          idempotency_key?: string | null
          limit_price?: number | null
          next_at?: string
          notes?: string | null
          portfolio_id: string
          remaining_qty: number
          side: string
          slice_count?: number
          slice_qty: number
          slices_done?: number
          status?: string
          symbol: string
          total_qty: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          decision_id?: string | null
          expires_at?: string
          id?: string
          idempotency_key?: string | null
          limit_price?: number | null
          next_at?: string
          notes?: string | null
          portfolio_id?: string
          remaining_qty?: number
          side?: string
          slice_count?: number
          slice_qty?: number
          slices_done?: number
          status?: string
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
          circuit_breaker: Json
          created_at: string
          currency: string
          current_cash: number
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
          circuit_breaker?: Json
          created_at?: string
          currency?: string
          current_cash?: number
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
          circuit_breaker?: Json
          created_at?: string
          currency?: string
          current_cash?: number
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
      run_locks: {
        Row: {
          acquired_at: string
          name: string
          owner: string | null
        }
        Insert: {
          acquired_at?: string
          name: string
          owner?: string | null
        }
        Update: {
          acquired_at?: string
          name?: string
          owner?: string | null
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
      trades: {
        Row: {
          asset_class: Database["public"]["Enums"]["asset_class"]
          executed_at: string
          id: string
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
          executed_at?: string
          id?: string
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
          executed_at?: string
          id?: string
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
    }
    Enums: {
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      asset_class: ["stock", "etf", "crypto", "commodity", "fx"],
      portfolio_mode: ["backtest", "paper", "live_sim", "live_prod"],
      portfolio_status: ["active", "paused", "complete"],
      risk_level: ["conservative", "balanced", "aggressive"],
      trade_side: ["buy", "sell"],
    },
  },
} as const
