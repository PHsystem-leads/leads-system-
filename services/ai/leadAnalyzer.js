/**
 * Lead Analyzer — Pet Hub CRM
 * Funções de IA para qualificação, análise de conversas,
 * geração de mensagens e follow-ups automáticos.
 */

import { callAI, parseJSON, hasAIKeys } from './openrouter.js';

const PIPELINE_STAGES = ['Descoberto', 'Qualificado', 'Abordado', 'Para humano', 'Convertido', 'Em conversa'];

// ─── QUALIFICAÇÃO AVANÇADA ────────────────────────────────────────────────────
/**
 * Qualifica um lead com IA, retornando campos enriquecidos.
 * Retorna: { score (0-10), ai_score (0-100), ai_temperatura, ai_resumo, ai_motivo,
 *            claude_analysis, suggested_message }
 */
export async function qualifyLead(lead) {
  if (!hasAIKeys()) throw new Error('Sem chaves de IA configuradas');

  const systemPrompt = `Você é a IA de vendas da Pet Hub, plataforma SaaS de automação de CRM e marketing para o setor pet brasileiro. Analise leads B2B e responda sempre em JSON puro, sem texto adicional.`;

  const prompt = `Analise este lead e retorne exatamente este JSON:
{
  "score": <inteiro 0-100 representando potencial de conversão>,
  "temperatura": <"quente" | "morno" | "frio">,
  "segmento": <"segmento principal do negócio">,
  "resumo": <"resumo executivo em 1 frase curta">,
  "motivo": <"principal motivo do score em 1 frase">,
  "claude_analysis": <"análise de dor e oportunidade em 2-3 frases">,
  "suggested_message": <"mensagem de abordagem WhatsApp ULTRA-personalizada em português, mínimo 3 parágrafos, usa nome do estabelecimento e dados específicos">
}

DADOS DO LEAD:
- Nome: "${lead.name}"
- Plataforma: "${lead.platform}"
- Segmento: "${lead.segment}"
- Handle/Localização: "${lead.handle || 'N/A'}"
- Seguidores Instagram: ${lead.followers || 'N/A'}
- Avaliação Google: ${lead.rating ? `${lead.rating}★ (${lead.reviews || 0} reviews)` : 'N/A'}
- Telefone: "${lead.phone || 'N/A'}"
- Email: "${lead.email || 'N/A'}"
- Endereço: "${lead.address || 'N/A'}"
- Bio/Descrição: "${lead.bio || 'N/A'}"

Retorne APENAS o JSON. Não adicione texto antes ou depois.`;

  const { content } = await callAI({
    messages:    [{ role: 'user', content: prompt }],
    systemPrompt,
    temperature: 0.6,
    maxTokens:   1400
  });

  const result = parseJSON(content);

  // Normaliza score para 0-100
  let aiScore = Number(result.score) || 50;
  if (aiScore <= 10) aiScore = aiScore * 10;
  aiScore = Math.min(100, Math.max(0, Math.round(aiScore)));

  // Score legado 0-10 para compatibilidade com UI existente
  const legacyScore = Math.round(aiScore / 10);

  // Garante temperatura válida
  const validTemps = ['quente', 'morno', 'frio'];
  const temperatura = validTemps.includes(result.temperatura)
    ? result.temperatura
    : aiScore >= 70 ? 'quente' : aiScore >= 40 ? 'morno' : 'frio';

  return {
    score:           legacyScore,
    ai_score:        aiScore,
    ai_temperatura:  temperatura,
    ai_segmento:     result.segmento || lead.segment,
    ai_resumo:       result.resumo || '',
    ai_motivo:       result.motivo || '',
    claude_analysis: result.claude_analysis || result.resumo || '',
    suggested_message: result.suggested_message || ''
  };
}

// ─── GERAR MENSAGEM DE ABORDAGEM ──────────────────────────────────────────────
/**
 * Gera uma mensagem de primeira abordagem personalizada.
 * Nunca gera mensagens genéricas.
 * @param {object} lead - Dados do lead
 * @param {Array}  [conversationHistory] - Histórico de mensagens (opcional)
 * @returns {Promise<string>} - Mensagem gerada
 */
export async function generateApproachMessage(lead, conversationHistory = []) {
  if (!hasAIKeys()) throw new Error('Sem chaves de IA configuradas');

  const systemPrompt = `Você é especialista em vendas consultivas B2B para o setor pet brasileiro. Crie mensagens de abordagem extremamente personalizadas. Nunca use templates genéricos. Use sempre o nome do estabelecimento e dados específicos do negócio.`;

  const historyCtx = conversationHistory.length > 0
    ? `\n\nHistórico de interações anteriores:\n${
        conversationHistory.slice(-5).map(m =>
          `${m.direction === 'out' ? '[Pet Hub]' : '[Lead]'}: ${m.content}`
        ).join('\n')
      }`
    : '';

  const ctx = [
    lead.rating   ? `Avaliação Google: ${lead.rating}★ (${lead.reviews} avaliações)` : null,
    lead.followers ? `Seguidores Instagram: ${lead.followers.toLocaleString('pt-BR')}` : null,
    lead.bio      ? `Descrição: ${lead.bio.slice(0, 120)}` : null,
    lead.address  ? `Localização: ${lead.address}` : null
  ].filter(Boolean).join('\n');

  const prompt = `Crie uma mensagem de abordagem WhatsApp para este lead pet:

Estabelecimento: ${lead.name}
Segmento: ${lead.segment}
${ctx}${historyCtx}

Regras obrigatórias:
1. Use o nome "${lead.name}" de forma natural no início
2. Mencione pelo menos 1 dado específico do perfil (avaliação, seguidores, ou trecho da bio)
3. Apresente 1 funcionalidade da Pet Hub que resolve o problema principal deste segmento
4. Proponha uma demonstração de 10 minutos SEM compromisso
5. Tom: profissional, caloroso, direto
6. 3-4 parágrafos curtos
7. Termine com pergunta aberta

Retorne APENAS a mensagem, sem introduções.`;

  const { content } = await callAI({
    messages:    [{ role: 'user', content: prompt }],
    systemPrompt,
    temperature: 0.75,
    maxTokens:   700
  });

  return content.trim();
}

// ─── ANÁLISE DE CONVERSA ──────────────────────────────────────────────────────
/**
 * Analisa uma conversa de WhatsApp e determina próximos passos.
 * @param {object} lead     - Dados do lead
 * @param {Array}  messages - Mensagens da conversa
 * @returns {Promise<object>} - Análise completa
 */
export async function analyzeConversation(lead, messages) {
  const fallback = {
    sentimento:  'neutro',
    interesse:   'desconhecido',
    urgencia:    'baixa',
    proximaAcao: 'Aguardar resposta do lead',
    resumo:      'Sem dados suficientes para análise',
    pedidoDemo:  false,
    pedidoPreco: false,
    querFechar:  false,
    objecao:     null,
    shouldMove:  false,
    newStage:    null
  };

  if (!hasAIKeys()) return fallback;
  if (!messages || messages.length === 0) return fallback;

  const systemPrompt = `Você analisa conversas de vendas B2B para um CRM pet. Identifica sinais de compra, objeções e decide se o lead deve avançar na pipeline. Responda em JSON puro.`;

  const convText = messages
    .slice(-25)
    .map(m => `${m.direction === 'out' ? '[Pet Hub]' : '[Lead]'}: ${m.content}`)
    .join('\n');

  const prompt = `Analise esta conversa de vendas B2B e retorne exatamente este JSON:
{
  "sentimento": <"positivo" | "neutro" | "negativo" | "ansioso" | "desinteressado">,
  "interesse": <"alto" | "medio" | "baixo" | "sem interesse">,
  "urgencia": <"alta" | "media" | "baixa">,
  "proximaAcao": <"ação específica recomendada ao vendedor, máximo 8 palavras">,
  "resumo": <"resumo executivo da conversa em 1 frase">,
  "pedidoDemo": <true se pediu demonstração>,
  "pedidoPreco": <true se perguntou sobre preço/planos>,
  "querFechar": <true se demonstrou intenção clara de contratar>,
  "objecao": <"principal objeção levantada" ou null>,
  "shouldMove": <true se deve mover de etapa na pipeline>,
  "newStage": <"Para humano" | "Convertido" | null>
}

Lead: ${lead.name} (${lead.segment})
Status atual na pipeline: ${lead.status}

Conversa:
${convText}

Retorne APENAS o JSON.`;

  try {
    const { content } = await callAI({
      messages:    [{ role: 'user', content: prompt }],
      systemPrompt,
      temperature: 0.3,
      maxTokens:   500
    });

    const result = parseJSON(content);

    // Valida que newStage é uma etapa existente da pipeline
    if (result.newStage && !PIPELINE_STAGES.includes(result.newStage)) {
      result.newStage  = null;
      result.shouldMove = false;
    }

    // Se pediu demo ou preço, sugere mover para humano
    if ((result.pedidoDemo || result.pedidoPreco || result.querFechar) && !result.shouldMove) {
      result.shouldMove = true;
      result.newStage   = 'Para humano';
    }

    return { ...fallback, ...result };
  } catch (e) {
    console.error('[leadAnalyzer] analyzeConversation:', e.message);
    return fallback;
  }
}

// ─── FOLLOW-UP AUTOMÁTICO ─────────────────────────────────────────────────────
/**
 * Gera mensagem de follow-up personalizada baseada no histórico.
 * @param {object} lead           - Dados do lead
 * @param {number} [attempt]      - Número da tentativa (1, 2 ou 3)
 * @param {Array}  [history]      - Histórico de mensagens
 * @returns {Promise<string>}
 */
export async function generateFollowUp(lead, attempt = 1, history = []) {
  if (!hasAIKeys()) {
    const msgs = [
      `Olá! Sou da equipe Pet Hub. Passando para verificar se você recebeu nossa mensagem sobre automação para ${lead.segment?.toLowerCase() || 'seu negócio pet'}. Há algum momento disponível esta semana para uma conversa rápida?`,
      `Oi, tudo bem? Estou tentando contato novamente da Pet Hub. Sabemos que a rotina de ${lead.segment?.toLowerCase() || 'um negócio pet'} é corrida! Temos uma solução que pode economizar horas por semana na gestão de clientes. Vale 10 minutos?`,
      `Olá! Esta é nossa última tentativa de contato. Se não for o momento certo agora, sem problemas! Fica à vontade para entrar em contato quando quiser. Estaremos aqui. Bons negócios para o ${lead.name}!`
    ];
    return msgs[Math.min(attempt - 1, 2)];
  }

  const systemPrompt = `Você escreve follow-ups de vendas B2B para o setor pet. Mensagens curtas, respeitosas e com valor real. Retorne apenas a mensagem.`;

  const attemptLabel  = attempt === 1 ? 'primeiro' : attempt === 2 ? 'segundo' : 'terceiro e último';
  const sinceLabel    = attempt === 1 ? '1 dia'    : attempt === 2 ? '3 dias'  : '7 dias';
  const isLastAttempt = attempt >= 3;

  const historyCtx = history.length > 0
    ? `\nÚltimas mensagens:\n${history.slice(-3).map(m => `${m.direction === 'out' ? 'Nós' : 'Lead'}: ${m.content.slice(0, 80)}`).join('\n')}`
    : '';

  const prompt = `Crie o ${attemptLabel} follow-up de reengajamento para este lead que não respondeu há ${sinceLabel}:

Lead: ${lead.name} (${lead.segment})${lead.bio ? `\nBio: ${lead.bio.slice(0, 80)}` : ''}${historyCtx}

${isLastAttempt
  ? 'Esta é a ÚLTIMA tentativa. Seja respeitoso, mencione que é o último contato e deixe a porta aberta para o futuro.'
  : 'Reforce brevemente o valor principal. Proponha data/horário específico para conversa de 10 min.'
}

Máximo 2 parágrafos. Retorne APENAS a mensagem.`;

  const { content } = await callAI({
    messages:    [{ role: 'user', content: prompt }],
    systemPrompt,
    temperature: 0.7,
    maxTokens:   350
  });

  return content.trim();
}

// ─── PRÓXIMA AÇÃO ─────────────────────────────────────────────────────────────
/**
 * Determina a próxima ação recomendada para um lead.
 * Usa análise da conversa se disponível, senão usa regras baseadas em status.
 */
export function suggestNextAction(lead, conversationAnalysis = null) {
  if (conversationAnalysis?.proximaAcao &&
      conversationAnalysis.proximaAcao !== 'Aguardar resposta do lead') {
    return conversationAnalysis.proximaAcao;
  }

  const byStatus = {
    'Descoberto':  'Qualificar com IA para gerar abordagem personalizada',
    'Qualificado': 'Enviar primeira mensagem via WhatsApp',
    'Abordado':    'Aguardar resposta — follow-up automático em 24h se sem retorno',
    'Para humano': 'Contato direto para agendar demonstração ou fechar contrato',
    'Em conversa': 'Responder e aprofundar interesse detectado na conversa',
    'Convertido':  'Iniciar onboarding e integração ao Pet Hub'
  };

  return byStatus[lead.status] || 'Verificar status do lead';
}
