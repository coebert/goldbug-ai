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
      holdings: {
        Row: {
          asset_class: Database["public"]["Enums"]["asset_class"]
          avg_cost: number
          id: string
          portfolio_id: string
          quantity: number
          symbol: string
          updated_at: string
        }
        Insert: {
          asset_class: Database["public"]["Enums"]["asset_class"]
          avg_cost?: number
          id?: string
          portfolio_id: string
          quantity?: number
          symbol: string
          updated_at?: string
        }
        Update: {
          asset_class?: Database["public"]["Enums"]["asset_class"]
          avg_cost?: number
          id?: string
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
      news_cache: {
        Row: {
          fetched_at: string
          headline: string
          id: string
          news_date: string
          sentiment: string | null
          source: string | null
          summary: string | null
          url: string | null
        }
        Insert: {
          fetched_at?: string
          headline: string
          id?: string
          news_date: string
          sentiment?: string | null
          source?: string | null
          summary?: string | null
          url?: string | null
        }
        Update: {
          fetched_at?: string
          headline?: string
          id?: string
          news_date?: string
          sentiment?: string | null
          source?: string | null
          summary?: string | null
          url?: string | null
        }
        Relationships: []
      }
      portfolios: {
        Row: {
          created_at: string
          currency: string
          current_cash: number
          id: string
          last_run_date: string | null
          mode: Database["public"]["Enums"]["portfolio_mode"]
          name: string
          risk_level: Database["public"]["Enums"]["risk_level"]
          starting_cash: number
          status: Database["public"]["Enums"]["portfolio_status"]
          universe: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          currency?: string
          current_cash?: number
          id?: string
          last_run_date?: string | null
          mode?: Database["public"]["Enums"]["portfolio_mode"]
          name?: string
          risk_level?: Database["public"]["Enums"]["risk_level"]
          starting_cash?: number
          status?: Database["public"]["Enums"]["portfolio_status"]
          universe?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          currency?: string
          current_cash?: number
          id?: string
          last_run_date?: string | null
          mode?: Database["public"]["Enums"]["portfolio_mode"]
          name?: string
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
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      asset_class: "stock" | "etf" | "crypto" | "commodity" | "fx"
      portfolio_mode: "backtest" | "paper"
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
      portfolio_mode: ["backtest", "paper"],
      portfolio_status: ["active", "paused", "complete"],
      risk_level: ["conservative", "balanced", "aggressive"],
      trade_side: ["buy", "sell"],
    },
  },
} as const
