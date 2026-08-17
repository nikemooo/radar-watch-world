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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      alerts: {
        Row: {
          confidence: number
          created_at: string
          event_type: string | null
          feedback: string | null
          id: string
          importance: string
          opened_at: string | null
          potential_impact: string | null
          radar_id: string | null
          sources: Json
          status: string
          summary: string
          title: string
          user_id: string
          what_changed: string | null
          why_it_matters: string | null
        }
        Insert: {
          confidence?: number
          created_at?: string
          event_type?: string | null
          feedback?: string | null
          id?: string
          importance?: string
          opened_at?: string | null
          potential_impact?: string | null
          radar_id?: string | null
          sources?: Json
          status?: string
          summary: string
          title: string
          user_id: string
          what_changed?: string | null
          why_it_matters?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          event_type?: string | null
          feedback?: string | null
          id?: string
          importance?: string
          opened_at?: string | null
          potential_impact?: string | null
          radar_id?: string | null
          sources?: Json
          status?: string
          summary?: string
          title?: string
          user_id?: string
          what_changed?: string | null
          why_it_matters?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "alerts_radar_id_fkey"
            columns: ["radar_id"]
            isOneToOne: false
            referencedRelation: "radars"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_events: {
        Row: {
          created_at: string
          event: string
          id: string
          properties: Json
          user_id: string | null
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          properties?: Json
          user_id?: string | null
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          properties?: Json
          user_id?: string | null
        }
        Relationships: []
      }
      findings: {
        Row: {
          currency: string | null
          entity: string | null
          fingerprint: string
          first_seen_at: string
          id: string
          last_seen_at: string
          numeric_value: number | null
          radar_id: string
          snapshot: Json
          title: string
          url: string | null
          user_id: string
        }
        Insert: {
          currency?: string | null
          entity?: string | null
          fingerprint: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          numeric_value?: number | null
          radar_id: string
          snapshot?: Json
          title: string
          url?: string | null
          user_id: string
        }
        Update: {
          currency?: string | null
          entity?: string | null
          fingerprint?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          numeric_value?: number | null
          radar_id?: string
          snapshot?: Json
          title?: string
          url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "findings_radar_id_fkey"
            columns: ["radar_id"]
            isOneToOne: false
            referencedRelation: "radars"
            referencedColumns: ["id"]
          },
        ]
      }
      monitor_runs: {
        Row: {
          alerts_created: number
          cost_estimate: number
          error: string | null
          finished_at: string | null
          id: string
          items_found: number
          new_items: number
          provider: string | null
          radar_id: string
          search_failures: number
          search_requests: number
          search_successes: number
          sources_retrieved: number
          started_at: string
          status: string
          user_id: string
        }
        Insert: {
          alerts_created?: number
          cost_estimate?: number
          error?: string | null
          finished_at?: string | null
          id?: string
          items_found?: number
          new_items?: number
          provider?: string | null
          radar_id: string
          search_failures?: number
          search_requests?: number
          search_successes?: number
          sources_retrieved?: number
          started_at?: string
          status?: string
          user_id: string
        }
        Update: {
          alerts_created?: number
          cost_estimate?: number
          error?: string | null
          finished_at?: string | null
          id?: string
          items_found?: number
          new_items?: number
          provider?: string | null
          radar_id?: string
          search_failures?: number
          search_requests?: number
          search_successes?: number
          sources_retrieved?: number
          started_at?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "monitor_runs_radar_id_fkey"
            columns: ["radar_id"]
            isOneToOne: false
            referencedRelation: "radars"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          active: boolean
          created_at: string
          currency: string
          features: Json
          interval: string
          key: string
          max_radars: number
          min_check_interval_minutes: number
          name: string
          price_amount: number
          sort_order: number
          stripe_price_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          currency?: string
          features?: Json
          interval?: string
          key: string
          max_radars?: number
          min_check_interval_minutes?: number
          name: string
          price_amount?: number
          sort_order?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          currency?: string
          features?: Json
          interval?: string
          key?: string
          max_radars?: number
          min_check_interval_minutes?: number
          name?: string
          price_amount?: number
          sort_order?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          digest_hour: number
          display_name: string | null
          email: string | null
          id: string
          notification_email: boolean
          onboarding_done: boolean
          plan_key: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          digest_hour?: number
          display_name?: string | null
          email?: string | null
          id: string
          notification_email?: boolean
          onboarding_done?: boolean
          plan_key?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          digest_hour?: number
          display_name?: string | null
          email?: string | null
          id?: string
          notification_email?: boolean
          onboarding_done?: boolean
          plan_key?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      radars: {
        Row: {
          category: string
          config: Json
          created_at: string
          frequency: string
          id: string
          last_run_at: string | null
          memory: Json
          name: string
          next_run_at: string | null
          raw_request: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string
          config?: Json
          created_at?: string
          frequency?: string
          id?: string
          last_run_at?: string | null
          memory?: Json
          name: string
          next_run_at?: string | null
          raw_request: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          config?: Json
          created_at?: string
          frequency?: string
          id?: string
          last_run_at?: string | null
          memory?: Json
          name?: string
          next_run_at?: string | null
          raw_request?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reports: {
        Row: {
          content: Json
          created_at: string
          id: string
          kind: string
          period_end: string
          period_start: string
          user_id: string
        }
        Insert: {
          content?: Json
          created_at?: string
          id?: string
          kind?: string
          period_end: string
          period_start: string
          user_id: string
        }
        Update: {
          content?: Json
          created_at?: string
          id?: string
          kind?: string
          period_end?: string
          period_start?: string
          user_id?: string
        }
        Relationships: []
      }
      research_sources: {
        Row: {
          created_at: string
          id: string
          provider: string
          published_at: string | null
          publisher: string | null
          query: string | null
          radar_id: string
          retrieved_at: string
          run_id: string | null
          snippet: string
          title: string
          url: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          provider?: string
          published_at?: string | null
          publisher?: string | null
          query?: string | null
          radar_id: string
          retrieved_at?: string
          run_id?: string | null
          snippet?: string
          title: string
          url: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          provider?: string
          published_at?: string | null
          publisher?: string | null
          query?: string | null
          radar_id?: string
          retrieved_at?: string
          run_id?: string | null
          snippet?: string
          title?: string
          url?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "research_sources_radar_id_fkey"
            columns: ["radar_id"]
            isOneToOne: false
            referencedRelation: "radars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "research_sources_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "monitor_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          id: string
          plan_key: string
          provider: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          plan_key: string
          provider?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          plan_key?: string
          provider?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_key_fkey"
            columns: ["plan_key"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["key"]
          },
        ]
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "user"
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
      app_role: ["admin", "user"],
    },
  },
} as const
