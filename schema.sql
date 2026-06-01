-- ==========================================================
-- 🐾 PET HUB - ESTRUTURA DE BANCO DE DADOS SUPABASE
-- ----------------------------------------------------------
-- Instruções: Copie este script e execute-o no menu
-- "SQL Editor" do seu painel Supabase para criar a tabela.
-- ==========================================================

-- 1. Criação da Tabela de Leads
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT,
  platform TEXT NOT NULL,
  segment TEXT NOT NULL,
  score INT DEFAULT 5,
  status TEXT DEFAULT 'Descoberto',
  phone TEXT,
  email TEXT,
  address TEXT,
  bio TEXT,
  followers INT,
  rating DECIMAL,
  reviews INT,
  claude_analysis TEXT,
  suggested_message TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Habilitar RLS (Row Level Security) para Segurança
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- 3. Criar Políticas de Acesso
-- Para este painel B2B privado, criamos uma política que permite 
-- leitura, escrita, atualização e exclusão usando a chave anônima/serviço.
CREATE POLICY "Allow full access to leads table" ON leads
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- 4. Inserir leads iniciais para testes (Opcional - caso queira iniciar populado no Supabase)
-- Se quiser começar com a base de dados populada diretamente em nuvem,
-- você pode executar os inserts abaixo:

INSERT INTO leads (id, name, handle, platform, segment, score, status, phone, email, bio, claude_analysis, suggested_message, updated_at)
VALUES 
(
  'lead-1', 
  'Clínica Veterinária Patas & Pelos 24h', 
  '@patasepelosvet', 
  'Instagram', 
  'Clínica Veterinária', 
  9, 
  'Para humano', 
  '+55 11 98765-4321', 
  'clinica@patasepelos.com.br', 
  'Referência em cuidados veterinários 24h na Zona Sul. Especialistas em cirurgia, exames e carinho de sobra para seu melhor amigo! 🐶🐱 SP.',
  'Clínica de alto padrão com excelente engajamento orgânico no Instagram (15.4k seguidores) e postagens diárias. No entanto, não utilizam agendamento online automático nem campanhas de retenção ativa para vacinas e retornos. Apresenta grande interesse em otimizar a captação de novos tutores e fidelizar a base atual através do Pet Hub.',
  'Olá Equipe Patas & Pelos! Tudo bem? Acompanho o trabalho impecável de vocês aqui na Zona Sul e vejo como tratam cada pet com tanto carinho. Notei que vocês têm uma comunidade super ativa no Instagram! Aqui na Pet Hub, ajudamos clínicas veterinárias de grande porte a automatizarem lembretes de vacinas e consultas de retorno via WhatsApp de forma ultra-personalizada, aumentando o faturamento em até 28% sem demandar tempo da recepção. Gostariam de receber uma demonstração gratuita de como isso funcionaria para os tutores da Patas & Pelos? Abraços!',
  NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO leads (id, name, handle, platform, segment, score, status, rating, reviews, phone, email, address, bio, claude_analysis, suggested_message, updated_at)
VALUES 
(
  'lead-2', 
  'Banho e Tosa Estrela Pet', 
  'Pinheiros, São Paulo', 
  'Google Maps', 
  'Banho e Tosa', 
  8, 
  'Descoberto', 
  4.8, 
  142, 
  '+55 11 99999-8888', 
  'contato@estrelapet.com.br', 
  'Rua dos Pinheiros, 450 - Pinheiros, São Paulo - SP',
  'Banho e tosa premium com produtos hipoalergênicos. Estética animal especializada e táxi dog.',
  'Alta avaliação no Google Maps (4.8 estrelas com 142 avaliações), demonstrando excelência no serviço e clientes leais. A localização em Pinheiros é nobre e tem alto tíquete médio. Podem se beneficiar absurdamente da Pet Hub para criar uma agenda recorrente automática de banho e tosa (clube de assinatura), garantindo previsibilidade de receita.',
  'Olá pessoal da Estrela Pet! Parabéns pelas incríveis 142 avaliações com nota 4.8 no Google, é visível que os clientes de Pinheiros amam o serviço de vocês! Vi que vocês oferecem táxi dog e banho premium. Nós criamos uma solução que transforma o banho e tosa avulso em um Clube de Assinatura Recorrente para os tutores. Isso garante que o pet venha toda semana ou quinzena e debita o valor automaticamente no cartão, gerando receita previsível para vocês e fidelizando o tutor. Posso te enviar um breve vídeo de 2 minutos mostrando como funciona o nosso painel de assinaturas?',
  NOW()
) ON CONFLICT (id) DO NOTHING;
