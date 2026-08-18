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
      alert_decisions: {
        Row: {
          created_at: string
          decision: string
          eligible: boolean
          fingerprint: string
          id: string
          published_at: string | null
          radar_id: string
          reason: string
          run_id: string | null
          title: string | null
          url: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          decision: string
          eligible: boolean
          fingerprint: string
          id?: string
          published_at?: string | null
          radar_id: string
          reason: string
          run_id?: string | null
          title?: string | null
          url?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          decision?: string
          eligible?: boolean
          fingerprint?: string
          id?: string
          published_at?: string | null
          radar_id?: string
          reason?: string
          run_id?: string | null
          title?: string | null
          url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_decisions_radar_id_fkey"
            columns: ["radar_id"]
            isOneToOne: false
            referencedRelation: "radars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alert_decisions_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "monitor_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      alerts: {
        Row: {
          anomaly_score: number | null
          baseline: Json
          confidence: number
          created_at: string
          event_type: string | null
          feedback: string | null
          id: string
          importance: string
          opened_at: string | null
          opportunity_score: number | null
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
          anomaly_score?: number | null
          baseline?: Json
          confidence?: number
          created_at?: string
          event_type?: string | null
          feedback?: string | null
          id?: string
          importance?: string
          opened_at?: string | null
          opportunity_score?: number | null
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
          anomaly_score?: number | null
          baseline?: Json
          confidence?: number
          created_at?: string
          event_type?: string | null
          feedback?: string | null
          id?: string
          importance?: string
          opened_at?: string | null
          opportunity_score?: number | null
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
      finding_changes: {
        Row: {
          attribute: string
          changed_at: string
          finding_id: string | null
          fingerprint: string
          id: string
          new_raw: string | null
          new_value: string | null
          previous_raw: string | null
          previous_value: string | null
          radar_id: string
          run_id: string | null
          user_id: string
        }
        Insert: {
          attribute: string
          changed_at?: string
          finding_id?: string | null
          fingerprint: string
          id?: string
          new_raw?: string | null
          new_value?: string | null
          previous_raw?: string | null
          previous_value?: string | null
          radar_id: string
          run_id?: string | null
          user_id: string
        }
        Update: {
          attribute?: string
          changed_at?: string
          finding_id?: string | null
          fingerprint?: string
          id?: string
          new_raw?: string | null
          new_value?: string | null
          previous_raw?: string | null
          previous_value?: string | null
          radar_id?: string
          run_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "finding_changes_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finding_changes_radar_id_fkey"
            columns: ["radar_id"]
            isOneToOne: false
            referencedRelation: "radars"
            referencedColumns: ["id"]
          },
        ]
      }
      findings: {
        Row: {
          anomaly_score: number | null
          attributes: Json
          availability: string | null
          baseline: Json
          baseline_computed_at: string | null
          baseline_confidence: number | null
          baseline_status: string
          currency: string | null
          detail_fetched_at: string | null
          detail_status: string
          discovery_url: string | null
          entity: string | null
          event_date: string | null
          fingerprint: string
          first_seen_at: string
          id: string
          last_changed_at: string | null
          last_run_id: string | null
          last_seen_at: string
          numeric_value: number | null
          opportunity_score: number | null
          origin: string
          primary_url: string | null
          published_at: string | null
          radar_id: string
          retrieved_at: string | null
          secondary_sources: Json
          snapshot: Json
          source_updated_at: string | null
          title: string
          url: string | null
          user_id: string
        }
        Insert: {
          anomaly_score?: number | null
          attributes?: Json
          availability?: string | null
          baseline?: Json
          baseline_computed_at?: string | null
          baseline_confidence?: number | null
          baseline_status?: string
          currency?: string | null
          detail_fetched_at?: string | null
          detail_status?: string
          discovery_url?: string | null
          entity?: string | null
          event_date?: string | null
          fingerprint: string
          first_seen_at?: string
          id?: string
          last_changed_at?: string | null
          last_run_id?: string | null
          last_seen_at?: string
          numeric_value?: number | null
          opportunity_score?: number | null
          origin?: string
          primary_url?: string | null
          published_at?: string | null
          radar_id: string
          retrieved_at?: string | null
          secondary_sources?: Json
          snapshot?: Json
          source_updated_at?: string | null
          title: string
          url?: string | null
          user_id: string
        }
        Update: {
          anomaly_score?: number | null
          attributes?: Json
          availability?: string | null
          baseline?: Json
          baseline_computed_at?: string | null
          baseline_confidence?: number | null
          baseline_status?: string
          currency?: string | null
          detail_fetched_at?: string | null
          detail_status?: string
          discovery_url?: string | null
          entity?: string | null
          event_date?: string | null
          fingerprint?: string
          first_seen_at?: string
          id?: string
          last_changed_at?: string | null
          last_run_id?: string | null
          last_seen_at?: string
          numeric_value?: number | null
          opportunity_score?: number | null
          origin?: string
          primary_url?: string | null
          published_at?: string | null
          radar_id?: string
          retrieved_at?: string | null
          secondary_sources?: Json
          snapshot?: Json
          source_updated_at?: string | null
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
      markets: {
        Row: {
          active: boolean
          code: string
          country_codes: string[]
          created_at: string
          currency: string
          locale: string
          name: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          code: string
          country_codes?: string[]
          created_at?: string
          currency: string
          locale?: string
          name: string
          sort_order?: number
        }
        Update: {
          active?: boolean
          code?: string
          country_codes?: string[]
          created_at?: string
          currency?: string
          locale?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      monitor_runs: {
        Row: {
          alerts_created: number
          ambiguous_price_joins: number
          attributes_extracted: number
          attributes_missing: number
          baseline_findings: number
          baselines_backfilled: number
          baselines_computed: number
          baselines_insufficient: number
          blocked_pages: number
          candidates_discovered: number
          candidates_selected: number
          comparable_coverage: number
          comparable_observations: number
          cost_ceiling: number
          cost_estimate: number
          detail_cost_estimate: number
          detail_fetch_budget: number
          detail_fetches_attempted: number
          detail_fetches_failed: number
          detail_fetches_ok: number
          detail_fetches_skipped_backoff: number
          duplicates_removed: number
          error: string | null
          extractions_failed: number
          extractions_ok: number
          finished_at: string | null
          id: string
          incremental_findings: number
          index_pages_expanded: number
          index_pages_fetched: number
          index_prices_joined: number
          items_found: number
          items_merged: number
          matching_listings: number
          monitoring_transition: boolean
          new_items: number
          provider: string | null
          radar_id: string
          run_type: string
          scan_phase: string
          search_failures: number
          search_requests: number
          search_successes: number
          sources_retrieved: number
          started_at: string
          status: string
          suppressed_baseline: number
          suppressed_duplicate: number
          suppressed_recency: number
          suppressed_relevance: number
          unknown_prices: number
          usable_comparables: number
          user_id: string
        }
        Insert: {
          alerts_created?: number
          ambiguous_price_joins?: number
          attributes_extracted?: number
          attributes_missing?: number
          baseline_findings?: number
          baselines_backfilled?: number
          baselines_computed?: number
          baselines_insufficient?: number
          blocked_pages?: number
          candidates_discovered?: number
          candidates_selected?: number
          comparable_coverage?: number
          comparable_observations?: number
          cost_ceiling?: number
          cost_estimate?: number
          detail_cost_estimate?: number
          detail_fetch_budget?: number
          detail_fetches_attempted?: number
          detail_fetches_failed?: number
          detail_fetches_ok?: number
          detail_fetches_skipped_backoff?: number
          duplicates_removed?: number
          error?: string | null
          extractions_failed?: number
          extractions_ok?: number
          finished_at?: string | null
          id?: string
          incremental_findings?: number
          index_pages_expanded?: number
          index_pages_fetched?: number
          index_prices_joined?: number
          items_found?: number
          items_merged?: number
          matching_listings?: number
          monitoring_transition?: boolean
          new_items?: number
          provider?: string | null
          radar_id: string
          run_type?: string
          scan_phase?: string
          search_failures?: number
          search_requests?: number
          search_successes?: number
          sources_retrieved?: number
          started_at?: string
          status?: string
          suppressed_baseline?: number
          suppressed_duplicate?: number
          suppressed_recency?: number
          suppressed_relevance?: number
          unknown_prices?: number
          usable_comparables?: number
          user_id: string
        }
        Update: {
          alerts_created?: number
          ambiguous_price_joins?: number
          attributes_extracted?: number
          attributes_missing?: number
          baseline_findings?: number
          baselines_backfilled?: number
          baselines_computed?: number
          baselines_insufficient?: number
          blocked_pages?: number
          candidates_discovered?: number
          candidates_selected?: number
          comparable_coverage?: number
          comparable_observations?: number
          cost_ceiling?: number
          cost_estimate?: number
          detail_cost_estimate?: number
          detail_fetch_budget?: number
          detail_fetches_attempted?: number
          detail_fetches_failed?: number
          detail_fetches_ok?: number
          detail_fetches_skipped_backoff?: number
          duplicates_removed?: number
          error?: string | null
          extractions_failed?: number
          extractions_ok?: number
          finished_at?: string | null
          id?: string
          incremental_findings?: number
          index_pages_expanded?: number
          index_pages_fetched?: number
          index_prices_joined?: number
          items_found?: number
          items_merged?: number
          matching_listings?: number
          monitoring_transition?: boolean
          new_items?: number
          provider?: string | null
          radar_id?: string
          run_type?: string
          scan_phase?: string
          search_failures?: number
          search_requests?: number
          search_successes?: number
          sources_retrieved?: number
          started_at?: string
          status?: string
          suppressed_baseline?: number
          suppressed_duplicate?: number
          suppressed_recency?: number
          suppressed_relevance?: number
          unknown_prices?: number
          usable_comparables?: number
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
      plan_prices: {
        Row: {
          active: boolean
          amount_minor: number
          billing_interval: string
          created_at: string
          currency: string
          id: string
          market_code: string
          plan_key: string
          stripe_price_id: string
        }
        Insert: {
          active?: boolean
          amount_minor: number
          billing_interval: string
          created_at?: string
          currency: string
          id?: string
          market_code: string
          plan_key: string
          stripe_price_id: string
        }
        Update: {
          active?: boolean
          amount_minor?: number
          billing_interval?: string
          created_at?: string
          currency?: string
          id?: string
          market_code?: string
          plan_key?: string
          stripe_price_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_prices_market_code_fkey"
            columns: ["market_code"]
            isOneToOne: false
            referencedRelation: "markets"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "plan_prices_plan_key_fkey"
            columns: ["plan_key"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["key"]
          },
        ]
      }
      plans: {
        Row: {
          active: boolean
          created_at: string
          currency: string
          detail_fetch_level: string
          features: Json
          history_days: number
          interval: string
          key: string
          max_alerts_per_month: number | null
          max_detail_fetches: number
          max_radars: number
          min_check_interval_minutes: number
          name: string
          price_amount: number
          price_amount_yearly: number
          priority_processing: boolean
          sort_order: number
          stripe_price_id: string | null
          stripe_price_id_yearly: string | null
          stripe_product_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          currency?: string
          detail_fetch_level?: string
          features?: Json
          history_days?: number
          interval?: string
          key: string
          max_alerts_per_month?: number | null
          max_detail_fetches?: number
          max_radars?: number
          min_check_interval_minutes?: number
          name: string
          price_amount?: number
          price_amount_yearly?: number
          priority_processing?: boolean
          sort_order?: number
          stripe_price_id?: string | null
          stripe_price_id_yearly?: string | null
          stripe_product_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          currency?: string
          detail_fetch_level?: string
          features?: Json
          history_days?: number
          interval?: string
          key?: string
          max_alerts_per_month?: number | null
          max_detail_fetches?: number
          max_radars?: number
          min_check_interval_minutes?: number
          name?: string
          price_amount?: number
          price_amount_yearly?: number
          priority_processing?: boolean
          sort_order?: number
          stripe_price_id?: string | null
          stripe_price_id_yearly?: string | null
          stripe_product_id?: string | null
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
          is_internal: boolean
          market_code: string | null
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
          is_internal?: boolean
          market_code?: string | null
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
          is_internal?: boolean
          market_code?: string | null
          notification_email?: boolean
          onboarding_done?: boolean
          plan_key?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_market_code_fkey"
            columns: ["market_code"]
            isOneToOne: false
            referencedRelation: "markets"
            referencedColumns: ["code"]
          },
        ]
      }
      radars: {
        Row: {
          allow_broad_comparison: boolean
          baseline_completed: boolean
          baseline_completed_at: string | null
          category: string
          config: Json
          created_at: string
          frequency: string
          id: string
          initial_listings_count: number
          initial_scan_completed_at: string | null
          initial_scan_started_at: string | null
          is_test: boolean
          last_run_at: string | null
          last_successful_sweep_at: string | null
          max_detail_fetches: number
          max_sweep_cost: number
          memory: Json
          min_comparables: number
          monitoring_window: string
          name: string
          next_run_at: string | null
          raw_request: string
          recency_days: number
          recency_source: string
          scan_state: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          allow_broad_comparison?: boolean
          baseline_completed?: boolean
          baseline_completed_at?: string | null
          category?: string
          config?: Json
          created_at?: string
          frequency?: string
          id?: string
          initial_listings_count?: number
          initial_scan_completed_at?: string | null
          initial_scan_started_at?: string | null
          is_test?: boolean
          last_run_at?: string | null
          last_successful_sweep_at?: string | null
          max_detail_fetches?: number
          max_sweep_cost?: number
          memory?: Json
          min_comparables?: number
          monitoring_window?: string
          name: string
          next_run_at?: string | null
          raw_request: string
          recency_days?: number
          recency_source?: string
          scan_state?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          allow_broad_comparison?: boolean
          baseline_completed?: boolean
          baseline_completed_at?: string | null
          category?: string
          config?: Json
          created_at?: string
          frequency?: string
          id?: string
          initial_listings_count?: number
          initial_scan_completed_at?: string | null
          initial_scan_started_at?: string | null
          is_test?: boolean
          last_run_at?: string | null
          last_successful_sweep_at?: string | null
          max_detail_fetches?: number
          max_sweep_cost?: number
          memory?: Json
          min_comparables?: number
          monitoring_window?: string
          name?: string
          next_run_at?: string | null
          raw_request?: string
          recency_days?: number
          recency_source?: string
          scan_state?: string
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
          first_seen_at: string
          id: string
          last_seen_at: string
          provider: string
          published_at: string | null
          publisher: string | null
          query: string | null
          radar_id: string
          retrieved_at: string
          run_id: string | null
          snippet: string
          source_updated_at: string | null
          title: string
          url: string
          user_id: string
        }
        Insert: {
          created_at?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          provider?: string
          published_at?: string | null
          publisher?: string | null
          query?: string | null
          radar_id: string
          retrieved_at?: string
          run_id?: string | null
          snippet?: string
          source_updated_at?: string | null
          title: string
          url: string
          user_id: string
        }
        Update: {
          created_at?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          provider?: string
          published_at?: string | null
          publisher?: string | null
          query?: string | null
          radar_id?: string
          retrieved_at?: string
          run_id?: string | null
          snippet?: string
          source_updated_at?: string | null
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
      source_fetch_stats: {
        Row: {
          attempts: number
          failures: number
          host: string
          id: string
          last_attempt_at: string | null
          last_failure_reason: string | null
          last_success_at: string | null
          successes: number
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          failures?: number
          host: string
          id?: string
          last_attempt_at?: string | null
          last_failure_reason?: string | null
          last_success_at?: string | null
          successes?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts?: number
          failures?: number
          host?: string
          id?: string
          last_attempt_at?: string | null
          last_failure_reason?: string | null
          last_success_at?: string | null
          successes?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          billing_interval: string
          cancel_at: string | null
          cancel_at_period_end: boolean
          created_at: string
          currency: string | null
          current_period_end: string | null
          environment: string
          id: string
          market_code: string | null
          pending_effective_at: string | null
          pending_plan_key: string | null
          plan_key: string
          price_id: string | null
          provider: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          billing_interval?: string
          cancel_at?: string | null
          cancel_at_period_end?: boolean
          created_at?: string
          currency?: string | null
          current_period_end?: string | null
          environment?: string
          id?: string
          market_code?: string | null
          pending_effective_at?: string | null
          pending_plan_key?: string | null
          plan_key: string
          price_id?: string | null
          provider?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          billing_interval?: string
          cancel_at?: string | null
          cancel_at_period_end?: boolean
          created_at?: string
          currency?: string | null
          current_period_end?: string | null
          environment?: string
          id?: string
          market_code?: string | null
          pending_effective_at?: string | null
          pending_plan_key?: string | null
          plan_key?: string
          price_id?: string | null
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
      url_fetch_state: {
        Row: {
          consecutive_failures: number
          host: string
          id: string
          last_attempt_at: string | null
          last_reason: string | null
          last_success_at: string | null
          next_attempt_at: string | null
          updated_at: string
          url: string
          user_id: string
        }
        Insert: {
          consecutive_failures?: number
          host: string
          id?: string
          last_attempt_at?: string | null
          last_reason?: string | null
          last_success_at?: string | null
          next_attempt_at?: string | null
          updated_at?: string
          url: string
          user_id: string
        }
        Update: {
          consecutive_failures?: number
          host?: string
          id?: string
          last_attempt_at?: string | null
          last_reason?: string | null
          last_success_at?: string | null
          next_attempt_at?: string | null
          updated_at?: string
          url?: string
          user_id?: string
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      alerts_this_month: { Args: never; Returns: number }
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
