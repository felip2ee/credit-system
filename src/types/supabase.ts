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
      ai_reports: {
        Row: {
          action_plan: Json | null
          aptitude_status: string
          consultant_notes: string | null
          created_at: string
          crm_client_id: string | null
          executive_summary: string | null
          generated_at: string | null
          generation_error: string | null
          full_report: Json | null
          id: string
          model_used: string | null
          positive_points: Json | null
          prompt_version: string | null
          query_id: string
          report_markdown: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          risk_points: Json | null
          status: string
          suggested_limit: number | null
          suggested_limit_notes: string | null
          suggested_products: Json | null
          updated_at: string
        }
        Insert: {
          action_plan?: Json | null
          aptitude_status?: string
          consultant_notes?: string | null
          created_at?: string
          crm_client_id?: string | null
          executive_summary?: string | null
          generated_at?: string | null
          full_report?: Json | null
          generation_error?: string | null
          id?: string
          model_used?: string | null
          positive_points?: Json | null
          prompt_version?: string | null
          query_id: string
          report_markdown?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          risk_points?: Json | null
          status?: string
          suggested_limit?: number | null
          suggested_limit_notes?: string | null
          suggested_products?: Json | null
          updated_at?: string
        }
        Update: {
          action_plan?: Json | null
          aptitude_status?: string
          consultant_notes?: string | null
          created_at?: string
          crm_client_id?: string | null
          executive_summary?: string | null
          generated_at?: string | null
          full_report?: Json | null
          generation_error?: string | null
          id?: string
          model_used?: string | null
          positive_points?: Json | null
          prompt_version?: string | null
          query_id?: string
          report_markdown?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          risk_points?: Json | null
          status?: string
          suggested_limit?: number | null
          suggested_limit_notes?: string | null
          suggested_products?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_reports_crm_client_id_fkey"
            columns: ["crm_client_id"]
            isOneToOne: false
            referencedRelation: "crm_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_reports_query_id_fkey"
            columns: ["query_id"]
            isOneToOne: true
            referencedRelation: "queries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      company_reports: {
        Row: {
          action_plan: Json | null
          aptitude_status: string
          batch_id: string
          created_at: string
          created_by: string | null
          executive_summary: string | null
          full_report: Json | null
          generated_at: string | null
          generation_error: string | null
          id: string
          model_used: string | null
          positive_points: Json | null
          prompt_version: string | null
          report_markdown: string | null
          risk_points: Json | null
          status: string
          suggested_limit: number | null
          suggested_limit_notes: string | null
          suggested_products: Json | null
          updated_at: string
        }
        Insert: {
          action_plan?: Json | null
          aptitude_status?: string
          batch_id: string
          created_at?: string
          created_by?: string | null
          executive_summary?: string | null
          full_report?: Json | null
          generated_at?: string | null
          generation_error?: string | null
          id?: string
          model_used?: string | null
          positive_points?: Json | null
          prompt_version?: string | null
          report_markdown?: string | null
          risk_points?: Json | null
          status?: string
          suggested_limit?: number | null
          suggested_limit_notes?: string | null
          suggested_products?: Json | null
          updated_at?: string
        }
        Update: {
          action_plan?: Json | null
          aptitude_status?: string
          batch_id?: string
          created_at?: string
          created_by?: string | null
          executive_summary?: string | null
          full_report?: Json | null
          generated_at?: string | null
          generation_error?: string | null
          id?: string
          model_used?: string | null
          positive_points?: Json | null
          prompt_version?: string | null
          report_markdown?: string | null
          risk_points?: Json | null
          status?: string
          suggested_limit?: number | null
          suggested_limit_notes?: string | null
          suggested_products?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_reports_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: true
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_reports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          id: string
          ip_address: unknown
          new_data: Json | null
          old_data: Json | null
          record_id: string | null
          table_name: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          ip_address?: unknown
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          ip_address?: unknown
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      authorizations: {
        Row: {
          action: Database["public"]["Enums"]["authorization_action"] | null
          created_at: string
          expires_at: string | null
          id: string
          is_urgent: boolean
          justification: string | null
          query_id: string
          requested_by: string
          reviewed_at: string | null
          reviewed_by: string | null
          updated_at: string
        }
        Insert: {
          action?: Database["public"]["Enums"]["authorization_action"] | null
          created_at?: string
          expires_at?: string | null
          id?: string
          is_urgent?: boolean
          justification?: string | null
          query_id: string
          requested_by: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          updated_at?: string
        }
        Update: {
          action?: Database["public"]["Enums"]["authorization_action"] | null
          created_at?: string
          expires_at?: string | null
          id?: string
          is_urgent?: boolean
          justification?: string | null
          query_id?: string
          requested_by?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "authorizations_query_id_fkey"
            columns: ["query_id"]
            isOneToOne: true
            referencedRelation: "queries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authorizations_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authorizations_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      batches: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string
          document: string | null
          error_items: number
          file_name: string | null
          file_path: string | null
          id: string
          name: string | null
          processed_items: number
          product: string | null
          report_path: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["batch_status"]
          success_items: number
          total_items: number
          type: Database["public"]["Enums"]["query_type"]
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by: string
          document?: string | null
          error_items?: number
          file_name?: string | null
          file_path?: string | null
          id?: string
          name?: string | null
          processed_items?: number
          product?: string | null
          report_path?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["batch_status"]
          success_items?: number
          total_items?: number
          type: Database["public"]["Enums"]["query_type"]
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string
          document?: string | null
          error_items?: number
          file_name?: string | null
          file_path?: string | null
          id?: string
          name?: string | null
          processed_items?: number
          product?: string | null
          report_path?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["batch_status"]
          success_items?: number
          total_items?: number
          type?: Database["public"]["Enums"]["query_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          cnpj: string | null
          cpf: string | null
          created_at: string
          created_by: string
          data_nascimento: string | null
          email: string | null
          id: string
          is_active: boolean
          nome_completo: string | null
          nome_fantasia: string | null
          observacoes: string | null
          razao_social: string | null
          telefone: string | null
          type: Database["public"]["Enums"]["query_type"]
          updated_at: string
          user_id: string | null
        }
        Insert: {
          cnpj?: string | null
          cpf?: string | null
          created_at?: string
          created_by: string
          data_nascimento?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          nome_completo?: string | null
          nome_fantasia?: string | null
          observacoes?: string | null
          razao_social?: string | null
          telefone?: string | null
          type: Database["public"]["Enums"]["query_type"]
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          cnpj?: string | null
          cpf?: string | null
          created_at?: string
          created_by?: string
          data_nascimento?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          nome_completo?: string | null
          nome_fantasia?: string | null
          observacoes?: string | null
          razao_social?: string | null
          telefone?: string | null
          type?: Database["public"]["Enums"]["query_type"]
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clients_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_products: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          type: Database["public"]["Enums"]["query_type"]
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          type: Database["public"]["Enums"]["query_type"]
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          type?: Database["public"]["Enums"]["query_type"]
        }
        Relationships: []
      }
      crm_client_documents: {
        Row: {
          client_id: string
          created_at: string
          document: string
          id: string
          is_primary: boolean
          label: string | null
          type: Database["public"]["Enums"]["query_type"]
        }
        Insert: {
          client_id: string
          created_at?: string
          document: string
          id?: string
          is_primary?: boolean
          label?: string | null
          type: Database["public"]["Enums"]["query_type"]
        }
        Update: {
          client_id?: string
          created_at?: string
          document?: string
          id?: string
          is_primary?: boolean
          label?: string | null
          type?: Database["public"]["Enums"]["query_type"]
        }
        Relationships: [
          {
            foreignKeyName: "crm_client_documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "crm_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_client_relations: {
        Row: {
          client_id: string
          created_at: string
          id: string
          percentage: number | null
          related_id: string
          relation_type: string
          role: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          percentage?: number | null
          related_id: string
          relation_type: string
          role?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          percentage?: number | null
          related_id?: string
          relation_type?: string
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_client_relations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "crm_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_client_relations_related_id_fkey"
            columns: ["related_id"]
            isOneToOne: false
            referencedRelation: "crm_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_clients: {
        Row: {
          address: string | null
          address_complement: string | null
          address_number: string | null
          assigned_to: string | null
          city: string | null
          created_at: string
          created_by: string
          document: string | null
          email: string | null
          id: string
          name: string
          neighborhood: string | null
          notes: string | null
          phone: string | null
          state: string | null
          status: string
          type: Database["public"]["Enums"]["query_type"]
          updated_at: string
          user_id: string | null
          zip_code: string | null
        }
        Insert: {
          address?: string | null
          address_complement?: string | null
          address_number?: string | null
          assigned_to?: string | null
          city?: string | null
          created_at?: string
          created_by: string
          document?: string | null
          email?: string | null
          id?: string
          name: string
          neighborhood?: string | null
          notes?: string | null
          phone?: string | null
          state?: string | null
          status?: string
          type: Database["public"]["Enums"]["query_type"]
          updated_at?: string
          user_id?: string | null
          zip_code?: string | null
        }
        Update: {
          address?: string | null
          address_complement?: string | null
          address_number?: string | null
          assigned_to?: string | null
          city?: string | null
          created_at?: string
          created_by?: string
          document?: string | null
          email?: string | null
          id?: string
          name?: string
          neighborhood?: string | null
          notes?: string | null
          phone?: string | null
          state?: string | null
          status?: string
          type?: Database["public"]["Enums"]["query_type"]
          updated_at?: string
          user_id?: string | null
          zip_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_clients_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_clients_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_clients_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_notes: {
        Row: {
          content: string
          created_at: string
          created_by: string
          entity_id: string
          entity_type: Database["public"]["Enums"]["timeline_entity_type"]
          id: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          created_by: string
          entity_id: string
          entity_type: Database["public"]["Enums"]["timeline_entity_type"]
          id?: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string
          entity_id?: string
          entity_type?: Database["public"]["Enums"]["timeline_entity_type"]
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          is_read: boolean
          related_id: string | null
          title: string
          type: string | null
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          related_id?: string | null
          title: string
          type?: string | null
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          related_id?: string | null
          title?: string
          type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunities: {
        Row: {
          address: string | null
          address_complement: string | null
          address_number: string | null
          ai_report_id: string | null
          approved_amount: number | null
          assigned_to: string | null
          city: string | null
          cnpj: string | null
          commission_amount: number | null
          commission_rate: number | null
          created_at: string
          created_by: string
          credit_product_id: string | null
          credit_purpose: string | null
          crm_client_id: string
          id: string
          monthly_revenue: number | null
          neighborhood: string | null
          notes: string | null
          partner_name: string | null
          partner_notes: string | null
          pf_extra_data: Json | null
          query_id: string | null
          rejection_reason: string | null
          requested_amount: number | null
          responsible_birth_date: string | null
          responsible_cpf: string | null
          responsible_email: string | null
          responsible_mother_name: string | null
          responsible_name: string | null
          responsible_phone: string | null
          state: string | null
          status: string
          updated_at: string
          zip_code: string | null
        }
        Insert: {
          address?: string | null
          address_complement?: string | null
          address_number?: string | null
          ai_report_id?: string | null
          approved_amount?: number | null
          assigned_to?: string | null
          city?: string | null
          cnpj?: string | null
          commission_amount?: number | null
          commission_rate?: number | null
          created_at?: string
          created_by: string
          credit_product_id?: string | null
          credit_purpose?: string | null
          crm_client_id: string
          id?: string
          monthly_revenue?: number | null
          neighborhood?: string | null
          notes?: string | null
          partner_name?: string | null
          partner_notes?: string | null
          pf_extra_data?: Json | null
          query_id?: string | null
          rejection_reason?: string | null
          requested_amount?: number | null
          responsible_birth_date?: string | null
          responsible_cpf?: string | null
          responsible_email?: string | null
          responsible_mother_name?: string | null
          responsible_name?: string | null
          responsible_phone?: string | null
          state?: string | null
          status?: string
          updated_at?: string
          zip_code?: string | null
        }
        Update: {
          address?: string | null
          address_complement?: string | null
          address_number?: string | null
          ai_report_id?: string | null
          approved_amount?: number | null
          assigned_to?: string | null
          city?: string | null
          cnpj?: string | null
          commission_amount?: number | null
          commission_rate?: number | null
          created_at?: string
          created_by?: string
          credit_product_id?: string | null
          credit_purpose?: string | null
          crm_client_id?: string
          id?: string
          monthly_revenue?: number | null
          neighborhood?: string | null
          notes?: string | null
          partner_name?: string | null
          partner_notes?: string | null
          pf_extra_data?: Json | null
          query_id?: string | null
          rejection_reason?: string | null
          requested_amount?: number | null
          responsible_birth_date?: string | null
          responsible_cpf?: string | null
          responsible_email?: string | null
          responsible_mother_name?: string | null
          responsible_name?: string | null
          responsible_phone?: string | null
          state?: string | null
          status?: string
          updated_at?: string
          zip_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "opportunities_ai_report_id_fkey"
            columns: ["ai_report_id"]
            isOneToOne: false
            referencedRelation: "ai_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunities_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunities_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunities_credit_product_id_fkey"
            columns: ["credit_product_id"]
            isOneToOne: false
            referencedRelation: "credit_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunities_crm_client_id_fkey"
            columns: ["crm_client_id"]
            isOneToOne: false
            referencedRelation: "crm_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunities_query_id_fkey"
            columns: ["query_id"]
            isOneToOne: false
            referencedRelation: "queries"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunity_documents: {
        Row: {
          created_at: string
          doc_type: string
          file_mime: string | null
          file_name: string | null
          file_path: string | null
          file_size: number | null
          id: string
          label: string
          opportunity_id: string
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
          uploaded_at: string | null
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          doc_type: string
          file_mime?: string | null
          file_name?: string | null
          file_path?: string | null
          file_size?: number | null
          id?: string
          label: string
          opportunity_id: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          uploaded_at?: string | null
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          doc_type?: string
          file_mime?: string | null
          file_name?: string | null
          file_path?: string | null
          file_size?: number | null
          id?: string
          label?: string
          opportunity_id?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          uploaded_at?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "opportunity_documents_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_documents_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunity_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string
          id: string
          is_active: boolean
          mfa_enabled: boolean
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name: string
          id: string
          is_active?: boolean
          mfa_enabled?: boolean
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          mfa_enabled?: boolean
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: []
      }
      queries: {
        Row: {
          api_version: number | null
          batch_id: string | null
          client_id: string | null
          consulted_at: string | null
          created_at: string
          created_by: string
          crm_client_id: string | null
          document: string
          document_name: string | null
          error_message: string | null
          historico_consulta_id: string | null
          id: string
          is_partial: boolean | null
          observations: string | null
          product: string | null
          product_version: string | null
          requires_auth: boolean
          scr_email: string | null
          share_link: string | null
          status: Database["public"]["Enums"]["query_status"]
          type: Database["public"]["Enums"]["query_type"]
          updated_at: string
        }
        Insert: {
          api_version?: number | null
          batch_id?: string | null
          client_id?: string | null
          consulted_at?: string | null
          created_at?: string
          created_by: string
          crm_client_id?: string | null
          document: string
          document_name?: string | null
          error_message?: string | null
          historico_consulta_id?: string | null
          id?: string
          is_partial?: boolean | null
          observations?: string | null
          product?: string | null
          product_version?: string | null
          requires_auth?: boolean
          scr_email?: string | null
          share_link?: string | null
          status?: Database["public"]["Enums"]["query_status"]
          type: Database["public"]["Enums"]["query_type"]
          updated_at?: string
        }
        Update: {
          api_version?: number | null
          batch_id?: string | null
          client_id?: string | null
          consulted_at?: string | null
          created_at?: string
          created_by?: string
          crm_client_id?: string | null
          document?: string
          document_name?: string | null
          error_message?: string | null
          historico_consulta_id?: string | null
          id?: string
          is_partial?: boolean | null
          observations?: string | null
          product?: string | null
          product_version?: string | null
          requires_auth?: boolean
          scr_email?: string | null
          share_link?: string | null
          status?: Database["public"]["Enums"]["query_status"]
          type?: Database["public"]["Enums"]["query_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "queries_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "queries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "queries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "queries_crm_client_id_fkey"
            columns: ["crm_client_id"]
            isOneToOne: false
            referencedRelation: "crm_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      query_results_pf: {
        Row: {
          acoes_judiciais_data_primeiro: string | null
          acoes_judiciais_message: string | null
          acoes_judiciais_ocorrencias: Json | null
          acoes_judiciais_success: boolean | null
          acoes_judiciais_total: number | null
          acoes_judiciais_valor_total: number | null
          analise_risco: Json | null
          bairro: string | null
          cep: string | null
          cheques_alertas: Json | null
          cheques_devolvidos_outros: Json | null
          cheques_devolvidos_sem_fundo: Json | null
          cheques_informados_usuario: Json | null
          cheques_possui_informacao: boolean | null
          cheques_sustados: Json | null
          cidade: string | null
          codigo_controle_receita: string | null
          complemento: string | null
          comportamental: Json | null
          comportamental_consumo: Json | null
          comportamental_pagamento: Json | null
          comportamental_resumido: Json | null
          consultas_90_dias_mais: number | null
          consultas_detalhadas: Json | null
          consultas_detalhes: Json | null
          consultas_success: boolean | null
          consultas_ultimos_15_dias: number | null
          consultas_ultimos_30_dias: number | null
          consultas_ultimos_31_60_dias: number | null
          consultas_ultimos_61_90_dias: number | null
          contatos_preferenciais: Json | null
          cpf: string | null
          created_at: string
          data_hora_receita: string | null
          data_inscricao: string | null
          data_nascimento: string | null
          deps_ia: Json | null
          emails: Json | null
          endereco: string | null
          escolaridade: string | null
          falencias_recuperacao: Json | null
          gasto_estimado: number | null
          grupo_componentes: Json | null
          id: string
          idade: number | null
          identidade: string | null
          indicadores: Json | null
          indicadores_boleto: Json | null
          is_grupo: boolean | null
          nacionalidade: string | null
          nome: string | null
          nome_mae: string | null
          numero: string | null
          obito: boolean | null
          outros_enderecos: Json | null
          participacao_empresa_data: Json | null
          participacao_empresa_message: string | null
          participacao_empresa_success: boolean | null
          pendencias_data_primeiro: string | null
          pendencias_message: string | null
          pendencias_nivel: string | null
          pendencias_ocorrencias: Json | null
          pendencias_success: boolean | null
          pendencias_total: number | null
          pendencias_total_credores: number | null
          pendencias_valor_primeiro: number | null
          pendencias_valor_total: number | null
          politicamente_exposta: boolean | null
          protestos_data: Json | null
          protestos_message: string | null
          protestos_success: boolean | null
          query_id: string
          raw_response: Json | null
          rede_relacionamento_socio: Json | null
          relacao_empresa_socio_data: Json | null
          relacao_empresa_socio_message: string | null
          relacao_empresa_socio_success: boolean | null
          renda_possui_gasto_estimado: boolean | null
          renda_presumida_descricao: string | null
          renda_presumida_valor: number | null
          renda_presumida_valor_maximo: number | null
          renda_presumida_valor_minimo: number | null
          restricao: string | null
          score_boleto: number | null
          score_descricao: string | null
          score_descricao_pagamento: string | null
          score_motivos: Json | null
          score_probabilidade_pagamento: number | null
          score_risco: string | null
          score_valor: number | null
          scr_a_vencer_itens: Json | null
          scr_a_vencer_percentual: string | null
          scr_a_vencer_total: number | null
          scr_carteira_ativa: number | null
          scr_limite_credito: number | null
          scr_message: string | null
          scr_por_modalidade: Json | null
          scr_risco_total: number | null
          scr_success: boolean | null
          scr_vencido_itens: Json | null
          scr_vencido_percentual: string | null
          scr_vencido_total: number | null
          scr_vencimentos_info_consulta: Json | null
          share: Json | null
          sintegra: Json | null
          situacao_cadastral: string | null
          smart_classificacao: Json | null
          smart_dados_complementares: Json | null
          smart_erros_metricas: Json | null
          smart_historico_classificacao: Json | null
          smart_message: string | null
          smart_negativas: Json | null
          smart_parecer: Json | null
          smart_positivas: Json | null
          smart_success: boolean | null
          smart_todas_classificacoes: Json | null
          uf: string | null
          vinculo_empregaticio: Json | null
        }
        Insert: {
          acoes_judiciais_data_primeiro?: string | null
          acoes_judiciais_message?: string | null
          acoes_judiciais_ocorrencias?: Json | null
          acoes_judiciais_success?: boolean | null
          acoes_judiciais_total?: number | null
          acoes_judiciais_valor_total?: number | null
          analise_risco?: Json | null
          bairro?: string | null
          cep?: string | null
          cheques_alertas?: Json | null
          cheques_devolvidos_outros?: Json | null
          cheques_devolvidos_sem_fundo?: Json | null
          cheques_informados_usuario?: Json | null
          cheques_possui_informacao?: boolean | null
          cheques_sustados?: Json | null
          cidade?: string | null
          codigo_controle_receita?: string | null
          complemento?: string | null
          comportamental?: Json | null
          comportamental_consumo?: Json | null
          comportamental_pagamento?: Json | null
          comportamental_resumido?: Json | null
          consultas_90_dias_mais?: number | null
          consultas_detalhadas?: Json | null
          consultas_detalhes?: Json | null
          consultas_success?: boolean | null
          consultas_ultimos_15_dias?: number | null
          consultas_ultimos_30_dias?: number | null
          consultas_ultimos_31_60_dias?: number | null
          consultas_ultimos_61_90_dias?: number | null
          contatos_preferenciais?: Json | null
          cpf?: string | null
          created_at?: string
          data_hora_receita?: string | null
          data_inscricao?: string | null
          data_nascimento?: string | null
          deps_ia?: Json | null
          emails?: Json | null
          endereco?: string | null
          escolaridade?: string | null
          falencias_recuperacao?: Json | null
          gasto_estimado?: number | null
          grupo_componentes?: Json | null
          id?: string
          idade?: number | null
          identidade?: string | null
          indicadores?: Json | null
          indicadores_boleto?: Json | null
          is_grupo?: boolean | null
          nacionalidade?: string | null
          nome?: string | null
          nome_mae?: string | null
          numero?: string | null
          obito?: boolean | null
          outros_enderecos?: Json | null
          participacao_empresa_data?: Json | null
          participacao_empresa_message?: string | null
          participacao_empresa_success?: boolean | null
          pendencias_data_primeiro?: string | null
          pendencias_message?: string | null
          pendencias_nivel?: string | null
          pendencias_ocorrencias?: Json | null
          pendencias_success?: boolean | null
          pendencias_total?: number | null
          pendencias_total_credores?: number | null
          pendencias_valor_primeiro?: number | null
          pendencias_valor_total?: number | null
          politicamente_exposta?: boolean | null
          protestos_data?: Json | null
          protestos_message?: string | null
          protestos_success?: boolean | null
          query_id: string
          raw_response?: Json | null
          rede_relacionamento_socio?: Json | null
          relacao_empresa_socio_data?: Json | null
          relacao_empresa_socio_message?: string | null
          relacao_empresa_socio_success?: boolean | null
          renda_possui_gasto_estimado?: boolean | null
          renda_presumida_descricao?: string | null
          renda_presumida_valor?: number | null
          renda_presumida_valor_maximo?: number | null
          renda_presumida_valor_minimo?: number | null
          restricao?: string | null
          score_boleto?: number | null
          score_descricao?: string | null
          score_descricao_pagamento?: string | null
          score_motivos?: Json | null
          score_probabilidade_pagamento?: number | null
          score_risco?: string | null
          score_valor?: number | null
          scr_a_vencer_itens?: Json | null
          scr_a_vencer_percentual?: string | null
          scr_a_vencer_total?: number | null
          scr_carteira_ativa?: number | null
          scr_limite_credito?: number | null
          scr_message?: string | null
          scr_por_modalidade?: Json | null
          scr_risco_total?: number | null
          scr_success?: boolean | null
          scr_vencido_itens?: Json | null
          scr_vencido_percentual?: string | null
          scr_vencido_total?: number | null
          scr_vencimentos_info_consulta?: Json | null
          share?: Json | null
          sintegra?: Json | null
          situacao_cadastral?: string | null
          smart_classificacao?: Json | null
          smart_dados_complementares?: Json | null
          smart_erros_metricas?: Json | null
          smart_historico_classificacao?: Json | null
          smart_message?: string | null
          smart_negativas?: Json | null
          smart_parecer?: Json | null
          smart_positivas?: Json | null
          smart_success?: boolean | null
          smart_todas_classificacoes?: Json | null
          uf?: string | null
          vinculo_empregaticio?: Json | null
        }
        Update: {
          acoes_judiciais_data_primeiro?: string | null
          acoes_judiciais_message?: string | null
          acoes_judiciais_ocorrencias?: Json | null
          acoes_judiciais_success?: boolean | null
          acoes_judiciais_total?: number | null
          acoes_judiciais_valor_total?: number | null
          analise_risco?: Json | null
          bairro?: string | null
          cep?: string | null
          cheques_alertas?: Json | null
          cheques_devolvidos_outros?: Json | null
          cheques_devolvidos_sem_fundo?: Json | null
          cheques_informados_usuario?: Json | null
          cheques_possui_informacao?: boolean | null
          cheques_sustados?: Json | null
          cidade?: string | null
          codigo_controle_receita?: string | null
          complemento?: string | null
          comportamental?: Json | null
          comportamental_consumo?: Json | null
          comportamental_pagamento?: Json | null
          comportamental_resumido?: Json | null
          consultas_90_dias_mais?: number | null
          consultas_detalhadas?: Json | null
          consultas_detalhes?: Json | null
          consultas_success?: boolean | null
          consultas_ultimos_15_dias?: number | null
          consultas_ultimos_30_dias?: number | null
          consultas_ultimos_31_60_dias?: number | null
          consultas_ultimos_61_90_dias?: number | null
          contatos_preferenciais?: Json | null
          cpf?: string | null
          created_at?: string
          data_hora_receita?: string | null
          data_inscricao?: string | null
          data_nascimento?: string | null
          deps_ia?: Json | null
          emails?: Json | null
          endereco?: string | null
          escolaridade?: string | null
          falencias_recuperacao?: Json | null
          gasto_estimado?: number | null
          grupo_componentes?: Json | null
          id?: string
          idade?: number | null
          identidade?: string | null
          indicadores?: Json | null
          indicadores_boleto?: Json | null
          is_grupo?: boolean | null
          nacionalidade?: string | null
          nome?: string | null
          nome_mae?: string | null
          numero?: string | null
          obito?: boolean | null
          outros_enderecos?: Json | null
          participacao_empresa_data?: Json | null
          participacao_empresa_message?: string | null
          participacao_empresa_success?: boolean | null
          pendencias_data_primeiro?: string | null
          pendencias_message?: string | null
          pendencias_nivel?: string | null
          pendencias_ocorrencias?: Json | null
          pendencias_success?: boolean | null
          pendencias_total?: number | null
          pendencias_total_credores?: number | null
          pendencias_valor_primeiro?: number | null
          pendencias_valor_total?: number | null
          politicamente_exposta?: boolean | null
          protestos_data?: Json | null
          protestos_message?: string | null
          protestos_success?: boolean | null
          query_id?: string
          raw_response?: Json | null
          rede_relacionamento_socio?: Json | null
          relacao_empresa_socio_data?: Json | null
          relacao_empresa_socio_message?: string | null
          relacao_empresa_socio_success?: boolean | null
          renda_possui_gasto_estimado?: boolean | null
          renda_presumida_descricao?: string | null
          renda_presumida_valor?: number | null
          renda_presumida_valor_maximo?: number | null
          renda_presumida_valor_minimo?: number | null
          restricao?: string | null
          score_boleto?: number | null
          score_descricao?: string | null
          score_descricao_pagamento?: string | null
          score_motivos?: Json | null
          score_probabilidade_pagamento?: number | null
          score_risco?: string | null
          score_valor?: number | null
          scr_a_vencer_itens?: Json | null
          scr_a_vencer_percentual?: string | null
          scr_a_vencer_total?: number | null
          scr_carteira_ativa?: number | null
          scr_limite_credito?: number | null
          scr_message?: string | null
          scr_por_modalidade?: Json | null
          scr_risco_total?: number | null
          scr_success?: boolean | null
          scr_vencido_itens?: Json | null
          scr_vencido_percentual?: string | null
          scr_vencido_total?: number | null
          scr_vencimentos_info_consulta?: Json | null
          share?: Json | null
          sintegra?: Json | null
          situacao_cadastral?: string | null
          smart_classificacao?: Json | null
          smart_dados_complementares?: Json | null
          smart_erros_metricas?: Json | null
          smart_historico_classificacao?: Json | null
          smart_message?: string | null
          smart_negativas?: Json | null
          smart_parecer?: Json | null
          smart_positivas?: Json | null
          smart_success?: boolean | null
          smart_todas_classificacoes?: Json | null
          uf?: string | null
          vinculo_empregaticio?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "query_results_pf_query_id_fkey"
            columns: ["query_id"]
            isOneToOne: true
            referencedRelation: "queries"
            referencedColumns: ["id"]
          },
        ]
      }
      query_results_pj: {
        Row: {
          acoes_judiciais_data: Json | null
          acoes_judiciais_message: string | null
          acoes_judiciais_success: boolean | null
          analise_risco: Json | null
          bairro: string | null
          capital_social: number | null
          capital_social_matriz: number | null
          cep: string | null
          cheques_alertas: Json | null
          cheques_devolvidos_outros: Json | null
          cheques_devolvidos_sem_fundo: Json | null
          cheques_informados_usuario: Json | null
          cheques_possui_informacao: boolean | null
          cheques_sustados: Json | null
          cnae_principal: string | null
          cnaes_secundarios: Json | null
          cnpj: string | null
          cnpj_matriz: string | null
          complemento: string | null
          comportamental: Json | null
          comportamental_consumo: Json | null
          comportamental_pagamento: Json | null
          comportamental_resumido: Json | null
          consultas_anteriores_data: Json | null
          consultas_anteriores_message: string | null
          consultas_anteriores_success: boolean | null
          consultas_detalhadas: Json | null
          contatos_preferenciais: Json | null
          created_at: string
          data_exclusao_opcao_simples: string | null
          data_inicio_atividade: string | null
          data_inicio_atividade_matriz: string | null
          data_opcao_pelo_simples: string | null
          data_situacao_cadastral: string | null
          data_situacao_especial: string | null
          deps_ia: Json | null
          emails: Json | null
          endereco: string | null
          falencias_recuperacao: Json | null
          faturamento_presumido_data: Json | null
          faturamento_presumido_message: string | null
          faturamento_presumido_success: boolean | null
          gasto_estimado: Json | null
          grupo_componentes: Json | null
          id: string
          indicadores: Json | null
          indicadores_boleto: Json | null
          is_grupo: boolean | null
          motivo_situacao_cadastral: string | null
          municipio: string | null
          municipio_codigo_ibge: string | null
          natureza_juridica: string | null
          nire: string | null
          nome_ente_federativo: string | null
          nome_fantasia: string | null
          numero: string | null
          opcao_mei: string | null
          opcao_pelo_simples: string | null
          outros_enderecos: Json | null
          participacao_empresa_data: Json | null
          participacao_empresa_message: string | null
          participacao_empresa_success: boolean | null
          pendencias_data: Json | null
          pendencias_message: string | null
          pendencias_success: boolean | null
          porte: string | null
          protestos_data: Json | null
          protestos_message: string | null
          protestos_success: boolean | null
          quadro_societario_com_participacao: boolean | null
          quadro_societario_socios: Json | null
          qualificacao_responsavel: string | null
          quantidade_filiais: number | null
          quantidade_funcionarios: number | null
          query_id: string
          raw_response: Json | null
          razao_social: string | null
          rede_relacionamento_socio: Json | null
          relacao_empresa_socio_data: Json | null
          relacao_empresa_socio_message: string | null
          relacao_empresa_socio_success: boolean | null
          renda_presumida: Json | null
          restricao: string | null
          score_boleto: number | null
          score_descricao: string | null
          score_descricao_pagamento: string | null
          score_motivos: Json | null
          score_probabilidade_pagamento: number | null
          score_risco: string | null
          score_valor: number | null
          scr_data: Json | null
          scr_message: string | null
          scr_success: boolean | null
          share: Json | null
          sintegra: Json | null
          situacao_cadastral: string | null
          situacao_especial: string | null
          smart_classificacao: Json | null
          smart_dados_complementares: Json | null
          smart_erros_metricas: Json | null
          smart_historico_classificacao: Json | null
          smart_message: string | null
          smart_negativas: Json | null
          smart_parecer: Json | null
          smart_positivas: Json | null
          smart_success: boolean | null
          smart_todas_classificacoes: Json | null
          suframa: Json | null
          tipo_unidade: string | null
          uf: string | null
          vinculo_empregaticio: Json | null
        }
        Insert: {
          acoes_judiciais_data?: Json | null
          acoes_judiciais_message?: string | null
          acoes_judiciais_success?: boolean | null
          analise_risco?: Json | null
          bairro?: string | null
          capital_social?: number | null
          capital_social_matriz?: number | null
          cep?: string | null
          cheques_alertas?: Json | null
          cheques_devolvidos_outros?: Json | null
          cheques_devolvidos_sem_fundo?: Json | null
          cheques_informados_usuario?: Json | null
          cheques_possui_informacao?: boolean | null
          cheques_sustados?: Json | null
          cnae_principal?: string | null
          cnaes_secundarios?: Json | null
          cnpj?: string | null
          cnpj_matriz?: string | null
          complemento?: string | null
          comportamental?: Json | null
          comportamental_consumo?: Json | null
          comportamental_pagamento?: Json | null
          comportamental_resumido?: Json | null
          consultas_anteriores_data?: Json | null
          consultas_anteriores_message?: string | null
          consultas_anteriores_success?: boolean | null
          consultas_detalhadas?: Json | null
          contatos_preferenciais?: Json | null
          created_at?: string
          data_exclusao_opcao_simples?: string | null
          data_inicio_atividade?: string | null
          data_inicio_atividade_matriz?: string | null
          data_opcao_pelo_simples?: string | null
          data_situacao_cadastral?: string | null
          data_situacao_especial?: string | null
          deps_ia?: Json | null
          emails?: Json | null
          endereco?: string | null
          falencias_recuperacao?: Json | null
          faturamento_presumido_data?: Json | null
          faturamento_presumido_message?: string | null
          faturamento_presumido_success?: boolean | null
          gasto_estimado?: Json | null
          grupo_componentes?: Json | null
          id?: string
          indicadores?: Json | null
          indicadores_boleto?: Json | null
          is_grupo?: boolean | null
          motivo_situacao_cadastral?: string | null
          municipio?: string | null
          municipio_codigo_ibge?: string | null
          natureza_juridica?: string | null
          nire?: string | null
          nome_ente_federativo?: string | null
          nome_fantasia?: string | null
          numero?: string | null
          opcao_mei?: string | null
          opcao_pelo_simples?: string | null
          outros_enderecos?: Json | null
          participacao_empresa_data?: Json | null
          participacao_empresa_message?: string | null
          participacao_empresa_success?: boolean | null
          pendencias_data?: Json | null
          pendencias_message?: string | null
          pendencias_success?: boolean | null
          porte?: string | null
          protestos_data?: Json | null
          protestos_message?: string | null
          protestos_success?: boolean | null
          quadro_societario_com_participacao?: boolean | null
          quadro_societario_socios?: Json | null
          qualificacao_responsavel?: string | null
          quantidade_filiais?: number | null
          quantidade_funcionarios?: number | null
          query_id: string
          raw_response?: Json | null
          razao_social?: string | null
          rede_relacionamento_socio?: Json | null
          relacao_empresa_socio_data?: Json | null
          relacao_empresa_socio_message?: string | null
          relacao_empresa_socio_success?: boolean | null
          renda_presumida?: Json | null
          restricao?: string | null
          score_boleto?: number | null
          score_descricao?: string | null
          score_descricao_pagamento?: string | null
          score_motivos?: Json | null
          score_probabilidade_pagamento?: number | null
          score_risco?: string | null
          score_valor?: number | null
          scr_data?: Json | null
          scr_message?: string | null
          scr_success?: boolean | null
          share?: Json | null
          sintegra?: Json | null
          situacao_cadastral?: string | null
          situacao_especial?: string | null
          smart_classificacao?: Json | null
          smart_dados_complementares?: Json | null
          smart_erros_metricas?: Json | null
          smart_historico_classificacao?: Json | null
          smart_message?: string | null
          smart_negativas?: Json | null
          smart_parecer?: Json | null
          smart_positivas?: Json | null
          smart_success?: boolean | null
          smart_todas_classificacoes?: Json | null
          suframa?: Json | null
          tipo_unidade?: string | null
          uf?: string | null
          vinculo_empregaticio?: Json | null
        }
        Update: {
          acoes_judiciais_data?: Json | null
          acoes_judiciais_message?: string | null
          acoes_judiciais_success?: boolean | null
          analise_risco?: Json | null
          bairro?: string | null
          capital_social?: number | null
          capital_social_matriz?: number | null
          cep?: string | null
          cheques_alertas?: Json | null
          cheques_devolvidos_outros?: Json | null
          cheques_devolvidos_sem_fundo?: Json | null
          cheques_informados_usuario?: Json | null
          cheques_possui_informacao?: boolean | null
          cheques_sustados?: Json | null
          cnae_principal?: string | null
          cnaes_secundarios?: Json | null
          cnpj?: string | null
          cnpj_matriz?: string | null
          complemento?: string | null
          comportamental?: Json | null
          comportamental_consumo?: Json | null
          comportamental_pagamento?: Json | null
          comportamental_resumido?: Json | null
          consultas_anteriores_data?: Json | null
          consultas_anteriores_message?: string | null
          consultas_anteriores_success?: boolean | null
          consultas_detalhadas?: Json | null
          contatos_preferenciais?: Json | null
          created_at?: string
          data_exclusao_opcao_simples?: string | null
          data_inicio_atividade?: string | null
          data_inicio_atividade_matriz?: string | null
          data_opcao_pelo_simples?: string | null
          data_situacao_cadastral?: string | null
          data_situacao_especial?: string | null
          deps_ia?: Json | null
          emails?: Json | null
          endereco?: string | null
          falencias_recuperacao?: Json | null
          faturamento_presumido_data?: Json | null
          faturamento_presumido_message?: string | null
          faturamento_presumido_success?: boolean | null
          gasto_estimado?: Json | null
          grupo_componentes?: Json | null
          id?: string
          indicadores?: Json | null
          indicadores_boleto?: Json | null
          is_grupo?: boolean | null
          motivo_situacao_cadastral?: string | null
          municipio?: string | null
          municipio_codigo_ibge?: string | null
          natureza_juridica?: string | null
          nire?: string | null
          nome_ente_federativo?: string | null
          nome_fantasia?: string | null
          numero?: string | null
          opcao_mei?: string | null
          opcao_pelo_simples?: string | null
          outros_enderecos?: Json | null
          participacao_empresa_data?: Json | null
          participacao_empresa_message?: string | null
          participacao_empresa_success?: boolean | null
          pendencias_data?: Json | null
          pendencias_message?: string | null
          pendencias_success?: boolean | null
          porte?: string | null
          protestos_data?: Json | null
          protestos_message?: string | null
          protestos_success?: boolean | null
          quadro_societario_com_participacao?: boolean | null
          quadro_societario_socios?: Json | null
          qualificacao_responsavel?: string | null
          quantidade_filiais?: number | null
          quantidade_funcionarios?: number | null
          query_id?: string
          raw_response?: Json | null
          razao_social?: string | null
          rede_relacionamento_socio?: Json | null
          relacao_empresa_socio_data?: Json | null
          relacao_empresa_socio_message?: string | null
          relacao_empresa_socio_success?: boolean | null
          renda_presumida?: Json | null
          restricao?: string | null
          score_boleto?: number | null
          score_descricao?: string | null
          score_descricao_pagamento?: string | null
          score_motivos?: Json | null
          score_probabilidade_pagamento?: number | null
          score_risco?: string | null
          score_valor?: number | null
          scr_data?: Json | null
          scr_message?: string | null
          scr_success?: boolean | null
          share?: Json | null
          sintegra?: Json | null
          situacao_cadastral?: string | null
          situacao_especial?: string | null
          smart_classificacao?: Json | null
          smart_dados_complementares?: Json | null
          smart_erros_metricas?: Json | null
          smart_historico_classificacao?: Json | null
          smart_message?: string | null
          smart_negativas?: Json | null
          smart_parecer?: Json | null
          smart_positivas?: Json | null
          smart_success?: boolean | null
          smart_todas_classificacoes?: Json | null
          suframa?: Json | null
          tipo_unidade?: string | null
          uf?: string | null
          vinculo_empregaticio?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "query_results_pj_query_id_fkey"
            columns: ["query_id"]
            isOneToOne: true
            referencedRelation: "queries"
            referencedColumns: ["id"]
          },
        ]
      }
      scr_authorizations: {
        Row: {
          authorized_at: string | null
          created_at: string
          crm_client_id: string | null
          document: string
          email: string | null
          expires_at: string | null
          id: string
          last_checked_at: string | null
          name: string | null
          query_id: string | null
          requested_at: string
          requested_by: string | null
          status: Database["public"]["Enums"]["scr_status"]
          type: Database["public"]["Enums"]["query_type"]
          updated_at: string
        }
        Insert: {
          authorized_at?: string | null
          created_at?: string
          crm_client_id?: string | null
          document: string
          email?: string | null
          expires_at?: string | null
          id?: string
          last_checked_at?: string | null
          name?: string | null
          query_id?: string | null
          requested_at?: string
          requested_by?: string | null
          status?: Database["public"]["Enums"]["scr_status"]
          type: Database["public"]["Enums"]["query_type"]
          updated_at?: string
        }
        Update: {
          authorized_at?: string | null
          created_at?: string
          crm_client_id?: string | null
          document?: string
          email?: string | null
          expires_at?: string | null
          id?: string
          last_checked_at?: string | null
          name?: string | null
          query_id?: string | null
          requested_at?: string
          requested_by?: string | null
          status?: Database["public"]["Enums"]["scr_status"]
          type?: Database["public"]["Enums"]["query_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scr_authorizations_crm_client_id_fkey"
            columns: ["crm_client_id"]
            isOneToOne: false
            referencedRelation: "crm_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scr_authorizations_query_id_fkey"
            columns: ["query_id"]
            isOneToOne: false
            referencedRelation: "queries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scr_authorizations_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      timeline_events: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          entity_id: string
          entity_type: Database["public"]["Enums"]["timeline_entity_type"]
          event_type: string
          id: string
          metadata: Json | null
          title: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          entity_id: string
          entity_type: Database["public"]["Enums"]["timeline_entity_type"]
          event_type: string
          id?: string
          metadata?: Json | null
          title: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          entity_id?: string
          entity_type?: Database["public"]["Enums"]["timeline_entity_type"]
          event_type?: string
          id?: string
          metadata?: Json | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "timeline_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      auth_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
    }
    Enums: {
      authorization_action: "approved" | "rejected" | "info_requested"
      batch_status:
        | "pending"
        | "processing"
        | "completed"
        | "completed_with_errors"
        | "cancelled"
      query_status:
        | "pending_authorization"
        | "authorized"
        | "processing"
        | "completed"
        | "error"
        | "rejected"
      query_type: "PF" | "PJ"
      scr_status: "pending" | "authorized" | "not_authorized" | "expired"
      timeline_entity_type: "crm_client" | "opportunity" | "query"
      user_role: "admin" | "consultant" | "client"
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
      authorization_action: ["approved", "rejected", "info_requested"],
      batch_status: [
        "pending",
        "processing",
        "completed",
        "completed_with_errors",
        "cancelled",
      ],
      query_status: [
        "pending_authorization",
        "authorized",
        "processing",
        "completed",
        "error",
        "rejected",
      ],
      query_type: ["PF", "PJ"],
      scr_status: ["pending", "authorized", "not_authorized", "expired"],
      timeline_entity_type: ["crm_client", "opportunity", "query"],
      user_role: ["admin", "consultant", "client"],
    },
  },
} as const
