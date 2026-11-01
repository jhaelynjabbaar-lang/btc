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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      network_snapshots: {
        Row: {
          avg_fee_sats: number | null
          block_height: number | null
          btc_price_usd: number | null
          difficulty: number | null
          fee_window_blocks: number | null
          fetched_at: string
          field_errors: Json
          id: string
          network_hashrate_hs: number | null
          price_source: string | null
          price_time: string | null
          raw: Json
          source: string
          subsidy_sats: number | null
          trigger: string
        }
        Insert: {
          avg_fee_sats?: number | null
          block_height?: number | null
          btc_price_usd?: number | null
          difficulty?: number | null
          fee_window_blocks?: number | null
          fetched_at?: string
          field_errors?: Json
          id?: string
          network_hashrate_hs?: number | null
          price_source?: string | null
          price_time?: string | null
          raw?: Json
          source: string
          subsidy_sats?: number | null
          trigger?: string
        }
        Update: {
          avg_fee_sats?: number | null
          block_height?: number | null
          btc_price_usd?: number | null
          difficulty?: number | null
          fee_window_blocks?: number | null
          fetched_at?: string
          field_errors?: Json
          id?: string
          network_hashrate_hs?: number | null
          price_source?: string | null
          price_time?: string | null
          raw?: Json
          source?: string
          subsidy_sats?: number | null
          trigger?: string
        }
        Relationships: []
      }
      profit_settings: {
        Row: {
          default_watts_per_worker: number | null
          electricity_usd_per_kwh: number | null
          owner_id: string
          pool_fee_pct_override: number | null
          updated_at: string
          updated_by: string | null
          worker_watts: Json
        }
        Insert: {
          default_watts_per_worker?: number | null
          electricity_usd_per_kwh?: number | null
          owner_id: string
          pool_fee_pct_override?: number | null
          updated_at?: string
          updated_by?: string | null
          worker_watts?: Json
        }
        Update: {
          default_watts_per_worker?: number | null
          electricity_usd_per_kwh?: number | null
          owner_id?: string
          pool_fee_pct_override?: number | null
          updated_at?: string
          updated_by?: string | null
          worker_watts?: Json
        }
        Relationships: []
      }
      ai_recommendations: {
        Row: {
          created_at: string
          dedupe_key: string | null
          decided_at: string | null
          decided_by: string | null
          explanation: string
          id: string
          inputs: Json
          kind: string
          job: string | null
          run_id: string | null
          severity: string
          suggested_action: Json
          title: string | null
          model: string | null
          owner_id: string
          status: string
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          created_at?: string
          dedupe_key?: string | null
          decided_at?: string | null
          decided_by?: string | null
          explanation: string
          id?: string
          inputs?: Json
          kind?: string
          job?: string | null
          run_id?: string | null
          severity?: string
          suggested_action?: Json
          title?: string | null
          model?: string | null
          owner_id: string
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          created_at?: string
          dedupe_key?: string | null
          decided_at?: string | null
          decided_by?: string | null
          explanation?: string
          id?: string
          inputs?: Json
          kind?: string
          job?: string | null
          run_id?: string | null
          severity?: string
          suggested_action?: Json
          title?: string | null
          model?: string | null
          owner_id?: string
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_recommendations_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor: string
          details: Json
          entity_id: string | null
          entity_type: string | null
          id: number
          occurred_at: string
          request_id: string | null
        }
        Insert: {
          action: string
          actor: string
          details?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: never
          occurred_at?: string
          request_id?: string | null
        }
        Update: {
          action?: string
          actor?: string
          details?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: never
          occurred_at?: string
          request_id?: string | null
        }
        Relationships: []
      }
      cloud_controls: {
        Row: {
          changed_at: string
          changed_by: string | null
          kill_switch_engaged: boolean
          owner_id: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          kill_switch_engaged?: boolean
          owner_id: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          kill_switch_engaged?: boolean
          owner_id?: string
        }
        Relationships: []
      }
      cloud_providers: {
        Row: {
          adapter: string
          conditions_acknowledged_at: string | null
          last_verified_on: string | null
          mining_policy: string
          notes: string | null
          policy_quote: string | null
          policy_url: string | null
          pricing_url: string | null
          slug: string | null
          written_permission_ref: string | null
          created_at: string
          id: string
          mining_allowed_quote: string | null
          name: string
          terms_url: string | null
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          adapter?: string
          conditions_acknowledged_at?: string | null
          last_verified_on?: string | null
          mining_policy?: string
          notes?: string | null
          policy_quote?: string | null
          policy_url?: string | null
          pricing_url?: string | null
          slug?: string | null
          written_permission_ref?: string | null
          created_at?: string
          id?: string
          mining_allowed_quote?: string | null
          name: string
          terms_url?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          adapter?: string
          conditions_acknowledged_at?: string | null
          last_verified_on?: string | null
          mining_policy?: string
          notes?: string | null
          policy_quote?: string | null
          policy_url?: string | null
          pricing_url?: string | null
          slug?: string | null
          written_permission_ref?: string | null
          created_at?: string
          id?: string
          mining_allowed_quote?: string | null
          name?: string
          terms_url?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      cloud_resources: {
        Row: {
          adapter: string
          cost_known: boolean
          decided_at: string | null
          decided_by: string | null
          label: string | null
          price_note: string | null
          price_source_url: string | null
          request_kind: string
          requested_by: string | null
          state: string
          state_changed_at: string
          authorization_status: string
          authorized_at: string | null
          capacity: Json
          created_at: string
          hourly_price_usd: number
          id: string
          instance_id: string
          owner_id: string
          provider_id: string
          status: string
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          adapter?: string
          cost_known?: boolean
          decided_at?: string | null
          decided_by?: string | null
          label?: string | null
          price_note?: string | null
          price_source_url?: string | null
          request_kind?: string
          requested_by?: string | null
          state?: string
          state_changed_at?: string
          authorization_status?: string
          authorized_at?: string | null
          capacity?: Json
          created_at?: string
          hourly_price_usd: number
          id?: string
          instance_id: string
          owner_id: string
          provider_id: string
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          adapter?: string
          cost_known?: boolean
          decided_at?: string | null
          decided_by?: string | null
          label?: string | null
          price_note?: string | null
          price_source_url?: string | null
          request_kind?: string
          requested_by?: string | null
          state?: string
          state_changed_at?: string
          authorization_status?: string
          authorized_at?: string | null
          capacity?: Json
          created_at?: string
          hourly_price_usd?: number
          id?: string
          instance_id?: string
          owner_id?: string
          provider_id?: string
          status?: string
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cloud_resources_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "cloud_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cloud_resources_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger: {
        Row: {
          amount_sats: number | null
          amount_usd: number | null
          cloud_resource_id: string | null
          created_at: string
          id: string
          kind: string
          note: string | null
          occurred_at: string
          owner_id: string
          payout_address_id: string | null
          pool_id: string | null
          ref: string | null
          source: string
          updated_at: string
        }
        Insert: {
          amount_sats?: number | null
          amount_usd?: number | null
          cloud_resource_id?: string | null
          created_at?: string
          id?: string
          kind: string
          note?: string | null
          occurred_at: string
          owner_id: string
          payout_address_id?: string | null
          pool_id?: string | null
          ref?: string | null
          source: string
          updated_at?: string
        }
        Update: {
          amount_sats?: number | null
          amount_usd?: number | null
          cloud_resource_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          note?: string | null
          occurred_at?: string
          owner_id?: string
          payout_address_id?: string | null
          pool_id?: string | null
          ref?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_cloud_resource_id_fkey"
            columns: ["cloud_resource_id"]
            isOneToOne: false
            referencedRelation: "cloud_resources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_payout_address_id_fkey"
            columns: ["payout_address_id"]
            isOneToOne: false
            referencedRelation: "payout_addresses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "pools"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_addresses: {
        Row: {
          address: string
          created_at: string
          id: string
          label: string | null
          network: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          address: string
          created_at?: string
          id?: string
          label?: string | null
          network?: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          address?: string
          created_at?: string
          id?: string
          label?: string | null
          network?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      pool_stats: {
        Row: {
          balance_sats: number | null
          fetched_at: string
          hashrate_hs: number | null
          id: string
          paid_sats: number | null
          payout_address_id: string | null
          period_end: string
          period_start: string
          pool_id: string
          raw: Json | null
          shares_accepted: number | null
          shares_rejected: number | null
          workers_count: number | null
        }
        Insert: {
          balance_sats?: number | null
          fetched_at?: string
          hashrate_hs?: number | null
          id?: string
          paid_sats?: number | null
          payout_address_id?: string | null
          period_end: string
          period_start: string
          pool_id: string
          raw?: Json | null
          shares_accepted?: number | null
          shares_rejected?: number | null
          workers_count?: number | null
        }
        Update: {
          balance_sats?: number | null
          fetched_at?: string
          hashrate_hs?: number | null
          id?: string
          paid_sats?: number | null
          payout_address_id?: string | null
          period_end?: string
          period_start?: string
          pool_id?: string
          raw?: Json | null
          shares_accepted?: number | null
          shares_rejected?: number | null
          workers_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pool_stats_payout_address_id_fkey"
            columns: ["payout_address_id"]
            isOneToOne: false
            referencedRelation: "payout_addresses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pool_stats_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "pools"
            referencedColumns: ["id"]
          },
        ]
      }
      pools: {
        Row: {
          created_at: string
          fee_pct: number
          id: string
          is_active: boolean
          name: string
          payout_method: string
          protocol: string
          stats_api_url: string | null
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          fee_pct?: number
          id?: string
          is_active?: boolean
          name: string
          payout_method: string
          protocol: string
          stats_api_url?: string | null
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          fee_pct?: number
          id?: string
          is_active?: boolean
          name?: string
          payout_method?: string
          protocol?: string
          stats_api_url?: string | null
          updated_at?: string
          url?: string
        }
        Relationships: []
      }
      spend_limits: {
        Row: {
          created_at: string
          enabled: boolean
          hard_stop: boolean
          id: string
          limit_usd: number
          owner_id: string
          period: string
          provider_id: string | null
          scope: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          hard_stop?: boolean
          id?: string
          limit_usd: number
          owner_id: string
          period: string
          provider_id?: string | null
          scope?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          hard_stop?: boolean
          id?: string
          limit_usd?: number
          owner_id?: string
          period?: string
          provider_id?: string | null
          scope?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "spend_limits_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "cloud_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      telemetry_1m: {
        Row: {
          accepted: number
          avg_hashrate_hs: number
          bucket_start: string
          difficulty: number | null
          pool_id: string | null
          rejected: number
          temperature_c: number | null
          worker_id: string
        }
        Insert: {
          accepted?: number
          avg_hashrate_hs: number
          bucket_start: string
          difficulty?: number | null
          pool_id?: string | null
          rejected?: number
          temperature_c?: number | null
          worker_id: string
        }
        Update: {
          accepted?: number
          avg_hashrate_hs?: number
          bucket_start?: string
          difficulty?: number | null
          pool_id?: string | null
          rejected?: number
          temperature_c?: number | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "telemetry_1m_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "pools"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemetry_1m_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_commands: {
        Row: {
          acked_at: string | null
          command: string
          created_at: string
          created_by: string
          expires_at: string
          first_delivered_at: string | null
          id: string
          owner_id: string
          status: string
          worker_id: string
        }
        Insert: {
          acked_at?: string | null
          command: string
          created_at?: string
          created_by: string
          expires_at?: string
          first_delivered_at?: string | null
          id?: string
          owner_id: string
          status?: string
          worker_id: string
        }
        Update: {
          acked_at?: string | null
          command?: string
          created_at?: string
          created_by?: string
          expires_at?: string
          first_delivered_at?: string | null
          id?: string
          owner_id?: string
          status?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_commands_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_credentials: {
        Row: {
          created_at: string
          id: string
          public_key: string | null
          revoked_at: string | null
          token_hash: string | null
          worker_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          public_key?: string | null
          revoked_at?: string | null
          token_hash?: string | null
          worker_id: string
        }
        Update: {
          created_at?: string
          id?: string
          public_key?: string | null
          revoked_at?: string | null
          token_hash?: string | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_credentials_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_enrollment_codes: {
        Row: {
          code_hash: string
          created_at: string
          expires_at: string
          id: string
          owner_id: string
          used_at: string | null
          used_by_worker_id: string | null
        }
        Insert: {
          code_hash: string
          created_at?: string
          expires_at: string
          id?: string
          owner_id: string
          used_at?: string | null
          used_by_worker_id?: string | null
        }
        Update: {
          code_hash?: string
          created_at?: string
          expires_at?: string
          id?: string
          owner_id?: string
          used_at?: string | null
          used_by_worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "worker_enrollment_codes_used_by_worker_id_fkey"
            columns: ["used_by_worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      workers: {
        Row: {
          authorized_at: string | null
          created_at: string
          current_hashrate_hs: number
          hardware: Json
          hardware_type: string
          id: string
          last_seen_at: string | null
          name: string
          os: string | null
          owner_id: string
          software_version: string | null
          status: string
          updated_at: string
          uptime_s: number
        }
        Insert: {
          authorized_at?: string | null
          created_at?: string
          current_hashrate_hs?: number
          hardware?: Json
          hardware_type?: string
          id?: string
          last_seen_at?: string | null
          name: string
          os?: string | null
          owner_id: string
          software_version?: string | null
          status?: string
          updated_at?: string
          uptime_s?: number
        }
        Update: {
          authorized_at?: string | null
          created_at?: string
          current_hashrate_hs?: number
          hardware?: Json
          hardware_type?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          os?: string | null
          owner_id?: string
          software_version?: string | null
          status?: string
          updated_at?: string
          uptime_s?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      profit_save_settings: {
        Args: { p_actor: string; p_default_watts: number; p_fee_override: number; p_kwh: number; p_owner: string; p_worker_watts: Json }
        Returns: Json
      }
      profit_worker_hashrate: {
        Args: { p_hours: number; p_now: string }
        Returns: Json
      }
      ai_decide_recommendation: {
        Args: { p_actor: string; p_confirm: boolean; p_decision: string; p_id: string; p_owner: string }
        Returns: Json
      }
      ai_worker_aggregates: {
        Args: { p_baseline_days: number; p_now: string; p_recent_minutes: number }
        Returns: Json
      }
      ack_worker_commands: {
        Args: { p_ids: string[]; p_worker_id: string }
        Returns: Json
      }
      claim_worker_commands: {
        Args: { p_limit: number; p_worker_id: string }
        Returns: Json
      }
      cloud_request_resource: {
        Args: {
          p_actor: string
          p_capacity: Json
          p_cost_known: boolean
          p_hourly: number | null
          p_instance_id: string | null
          p_label: string | null
          p_owner: string
          p_price_note: string | null
          p_price_source_url: string | null
          p_provider: string
          p_request_kind: string
        }
        Returns: Json
      }
      cloud_set_kill_switch: {
        Args: { p_actor: string; p_engage: boolean; p_owner: string }
        Returns: Json
      }
      cloud_set_provider_attestation: {
        Args: { p_acknowledge: boolean; p_actor: string; p_permission_ref: string | null; p_provider: string }
        Returns: Json
      }
      cloud_set_spend_limit: {
        Args: { p_actor: string; p_limit: number; p_owner: string; p_period: string; p_provider: string | null; p_scope: string }
        Returns: Json
      }
      cloud_transition: {
        Args: { p_actor: string; p_event: string; p_id: string; p_note: string | null }
        Returns: Json
      }
      enroll_worker: {
        Args: {
          p_code_hash: string
          p_hardware: Json
          p_hardware_type: string
          p_name: string
          p_os: string
          p_public_key: string
          p_software_version: string
        }
        Returns: Json
      }
      ingest_telemetry: {
        Args: {
          p_rows: Json
          p_software_version: string
          p_uptime_s: number
          p_worker_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
