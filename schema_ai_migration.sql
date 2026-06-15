-- ================================================================
-- Pet Hub CRM — Migração AI Intelligence Module
-- Execute este script no SQL Editor do Supabase para adicionar
-- os campos de IA à tabela de leads.
-- ================================================================

-- Campos de qualificação avançada (score 0-100, temperatura, resumo, motivo)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS ai_score        INTEGER         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_temperatura  TEXT            DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_resumo       TEXT            DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_motivo       TEXT            DEFAULT NULL,

  -- Próxima ação sugerida pela IA
  ADD COLUMN IF NOT EXISTS proxima_acao    TEXT            DEFAULT NULL,

  -- Rastreamento de contato para follow-up automático
  ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS follow_up_count INTEGER         DEFAULT 0,

  -- Análise da última conversa (JSON)
  ADD COLUMN IF NOT EXISTS conversation_analysis TEXT      DEFAULT NULL;

-- Índice para busca por temperatura (quente/morno/frio)
CREATE INDEX IF NOT EXISTS idx_leads_ai_temperatura ON leads (ai_temperatura);

-- Índice para follow-up scheduler (busca leads por status + contato)
CREATE INDEX IF NOT EXISTS idx_leads_followup
  ON leads (status, last_contact_at, follow_up_count)
  WHERE status IN ('Abordado', 'Em conversa');

-- Confirma
SELECT 'Migração AI Intelligence Module aplicada com sucesso!' AS resultado;
