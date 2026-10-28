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
      businesses: {
        Row: {
          address: string | null
          created_at: string
          id: string
          name: string
          phone: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          name: string
          phone: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          name?: string
          phone?: string
          updated_at?: string
        }
        Relationships: []
      }
      customer_tracking_sessions: {
        Row: {
          activated_at: string | null
          business_id: string
          created_at: string
          expires_at: string
          id: string
          job_id: string
          revocation_reason: string | null
          revoked_at: string | null
          token_hash: string
          worker_id: string | null
        }
        Insert: {
          activated_at?: string | null
          business_id: string
          created_at?: string
          expires_at: string
          id?: string
          job_id: string
          revocation_reason?: string | null
          revoked_at?: string | null
          token_hash: string
          worker_id?: string | null
        }
        Update: {
          activated_at?: string | null
          business_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          job_id?: string
          revocation_reason?: string | null
          revoked_at?: string | null
          token_hash?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_tracking_sessions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_tracking_sessions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_tracking_sessions_worker_business"
            columns: ["worker_id", "business_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "business_id"]
          }
        ]
      }
      device_tokens: {
        Row: {
          app_version: string | null
          business_id: string
          created_at: string
          device_name: string | null
          device_platform: string
          expo_push_token: string
          id: string
          is_active: boolean
          last_used_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_version?: string | null
          business_id: string
          created_at?: string
          device_name?: string | null
          device_platform?: string
          expo_push_token: string
          id?: string
          is_active?: boolean
          last_used_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_version?: string | null
          business_id?: string
          created_at?: string
          device_name?: string | null
          device_platform?: string
          expo_push_token?: string
          id?: string
          is_active?: boolean
          last_used_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_tokens_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          }
        ]
      }
      job_events: {
        Row: {
          actor_id: string | null
          actor_role: string
          business_id: string
          created_at: string
          event_type: string
          id: string
          job_id: string
          metadata: Json
          new_status: string | null
          previous_status: string | null
        }
        Insert: {
          actor_id?: string | null
          actor_role: string
          business_id: string
          created_at?: string
          event_type: string
          id?: string
          job_id: string
          metadata?: Json
          new_status?: string | null
          previous_status?: string | null
        }
        Update: {
          actor_id?: string | null
          actor_role?: string
          business_id?: string
          created_at?: string
          event_type?: string
          id?: string
          job_id?: string
          metadata?: Json
          new_status?: string | null
          previous_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          accepted_at: string | null
          address: string
          arrived_at: string | null
          assigned_at: string | null
          business_id: string
          cancellation_reason: string | null
          cancelled_at: string | null
          completed_at: string | null
          created_at: string
          customer_name: string
          customer_phone: string
          id: string
          latitude: number | null
          longitude: number | null
          notes: string | null
          scheduled_at: string | null
          service: string
          started_at: string | null
          status: string
          tracking_token: string
          travelling_at: string | null
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          accepted_at?: string | null
          address: string
          arrived_at?: string | null
          assigned_at?: string | null
          business_id: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          customer_name: string
          customer_phone: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          notes?: string | null
          scheduled_at?: string | null
          service: string
          started_at?: string | null
          status?: string
          tracking_token?: string
          travelling_at?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          accepted_at?: string | null
          address?: string
          arrived_at?: string | null
          assigned_at?: string | null
          business_id?: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          customer_name?: string
          customer_phone?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          notes?: string | null
          scheduled_at?: string | null
          service?: string
          started_at?: string | null
          status?: string
          tracking_token?: string
          travelling_at?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_jobs_worker_business"
            columns: ["worker_id", "business_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "jobs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          accuracy: number | null
          created_at: string
          id: string
          job_id: string | null
          latitude: number
          longitude: number
          worker_id: string
        }
        Insert: {
          accuracy?: number | null
          created_at?: string
          id?: string
          job_id?: string | null
          latitude: number
          longitude: number
          worker_id: string
        }
        Update: {
          accuracy?: number | null
          created_at?: string
          id?: string
          job_id?: string | null
          latitude?: number
          longitude?: number
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locations_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          business_id: string
          created_at: string
          email: string
          full_name: string
          id: string
          is_active: boolean
          phone: string | null
          role: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          business_id: string
          created_at?: string
          email: string
          full_name: string
          id: string
          is_active?: boolean
          phone?: string | null
          role: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          business_id?: string
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          business_id: string
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          trial_end: string | null
          trial_start: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string
        }
        Update: {
          business_id?: string
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_deliveries: {
        Row: {
          business_id: string
          created_at: string
          delivered_at: string | null
          device_tokens_count: number
          error_message: string | null
          expo_ticket_ids: Json
          id: string
          idempotency_key: string
          job_event_id: string
          notification_type: string
          recipient_user_id: string
          status: string
        }
        Insert: {
          business_id: string
          created_at?: string
          delivered_at?: string | null
          device_tokens_count?: number
          error_message?: string | null
          expo_ticket_ids?: Json
          id?: string
          idempotency_key: string
          job_event_id: string
          notification_type: string
          recipient_user_id: string
          status?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          delivered_at?: string | null
          device_tokens_count?: number
          error_message?: string | null
          expo_ticket_ids?: Json
          id?: string
          idempotency_key?: string
          job_event_id?: string
          notification_type?: string
          recipient_user_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_deliveries_job_event_id_fkey"
            columns: ["job_event_id"]
            isOneToOne: false
            referencedRelation: "job_events"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_invitations: {
        Row: {
          business_id: string
          created_at: string
          email: string | null
          expires_at: string
          id: string
          invite_code: string
          invited_by: string
          is_used: boolean
          updated_at: string
          used_by: string | null
        }
        Insert: {
          business_id: string
          created_at?: string
          email?: string | null
          expires_at?: string
          id?: string
          invite_code: string
          invited_by: string
          is_used?: boolean
          updated_at?: string
          used_by?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string
          email?: string | null
          expires_at?: string
          id?: string
          invite_code?: string
          invited_by?: string
          is_used?: boolean
          updated_at?: string
          used_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "worker_invitations_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_job: {
        Args: {
          p_customer_name: string
          p_customer_phone: string
          p_service: string
          p_address: string
          p_scheduled_at: string
          p_notes?: string | null
          p_worker_id?: string | null
          p_latitude?: number | null
          p_longitude?: number | null
        }
        Returns: Database["public"]["Tables"]["jobs"]["Row"]
      }
      provision_business: {
        Args: {
          p_name: string
          p_phone: string
          p_address?: string | null
          p_owner_full_name?: string | null
        }
        Returns: string
      }
      assign_job_worker: {
        Args: {
          p_job_id: string
          p_worker_id?: string | null
          p_expected_current_status?: string | null
        }
        Returns: Database["public"]["Tables"]["jobs"]["Row"]
      }
      cancel_job: {
        Args: {
          p_job_id: string
          p_cancellation_reason: string
          p_expected_current_status?: string | null
        }
        Returns: Database["public"]["Tables"]["jobs"]["Row"]
      }
      advance_job_status: {
        Args: {
          p_job_id: string
          p_target_status: string
          p_expected_current_status?: string | null
        }
        Returns: Database["public"]["Tables"]["jobs"]["Row"]
      }
      decline_job_assignment: {
        Args: {
          p_job_id: string
          p_decline_reason?: string | null
          p_expected_current_status?: string | null
        }
        Returns: Database["public"]["Tables"]["jobs"]["Row"]
      }
      get_customer_tracking_job: {
        Args: {
          p_tracking_token: string
        }
        Returns: Json
      }
      record_worker_location: {
        Args: {
          p_job_id: string
          p_latitude: number
          p_longitude: number
          p_accuracy?: number | null
        }
        Returns: Database["public"]["Tables"]["locations"]["Row"]
      }
      get_owner_active_locations: {
        Args: Record<PropertyKey, never>
        Returns: {
          accuracy: number | null
          destination_latitude: number | null
          destination_longitude: number | null
          job_address: string
          job_id: string
          job_service: string
          job_status: string
          location_id: string
          recorded_at: string
          worker_avatar_url: string | null
          worker_id: string
          worker_latitude: number
          worker_longitude: number
          worker_name: string
        }[]
      }
      generate_customer_tracking_session: {
        Args: {
          p_job_id: string
          p_duration_hours?: number
        }
        Returns: {
          created_at: string
          expires_at: string
          is_activated: boolean
          job_id: string
          raw_token: string
          session_id: string
          tracking_url: string
        }[]
      }
      revoke_customer_tracking_session: {
        Args: {
          p_job_id: string
          p_reason?: string
        }
        Returns: boolean
      }
      get_customer_tracking_session_job: {
        Args: {
          p_token: string
        }
        Returns: Json
      }
      register_device_token: {
        Args: {
          p_expo_push_token: string
          p_device_platform?: string
          p_device_name?: string | null
          p_app_version?: string | null
        }
        Returns: Database["public"]["Tables"]["device_tokens"]["Row"]
      }
      deactivate_device_token: {
        Args: {
          p_expo_push_token: string
        }
        Returns: boolean
      }
      claim_notification_delivery: {
        Args: {
          p_job_event_id: string
          p_recipient_user_id: string
          p_business_id: string
          p_notification_type: string
          p_idempotency_key: string
        }
        Returns: string
      }
      create_worker_invitation: {
        Args: {
          p_email?: string | null
        }
        Returns: Json
      }
      verify_worker_invitation: {
        Args: {
          p_invite_code: string
        }
        Returns: Json
      }
      join_business_team: {
        Args: {
          p_invite_code: string
          p_full_name: string
          p_phone?: string | null
        }
        Returns: string
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
