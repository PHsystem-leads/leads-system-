/**
 * Lead Analyzer — Pet Hub CRM
 * Funções de IA para qualificação, análise de conversas,
 * geração de mensagens e follow-ups automáticos.
 */

import { callAI, parseJSON, hasAIKeys } from './openrouter.js';

const PIPELINE_STAGES = ['Descoberto', 'Qualificado', 'Abordado', 'Para humano', 'Convertido', 'Em conversa'];

// ─── CONTEXTO DE PRODUTO (injetado em todos os prompts de abordagem) ─────────

const HUBIA_SISTEMA = `Você é a HubIA, a inteligência artificial do ecossistema Pet Hub — plataforma SaaS de automação de CRM e marketing para negócios pet brasileiros. Seu papel é ajudar a equipe de vendas a abordar estabelecimentos pet de forma ultra-personalizada, mostrando como o Pet Hub resolve problemas reais do dia a dia deles.`;

const PRODUTO_CONTEXTO = `
## SOBRE O PET HUB E A HUBIA
A HubIA é o módulo de IA do Pet Hub, que automatiza CRM, marketing e operações para qualquer negócio pet. Ao apresentar o produto, refira-se sempre como "Pet Hub com HubIA" ou "nossa plataforma com HubIA".

## FUNCIONALIDADE TÁXI DOG — USE SEMPRE NAS ABORDAGENS
O Táxi Dog é o módulo de gestão logística integrado ao CRM Pet Hub. Ele resolve completamente a dor de coordenar rotas, motoristas e comunicação com tutores. Apresente-o como diferencial competitivo concreto:

**1. Automação WhatsApp em Tempo Real (via HubIA)**
A HubIA dispara mensagens automáticas e personalizadas para o tutor em cada etapa:
- Saída do motorista: "Olá [nome]! O [pet] é o próximo. Nosso motorista está a caminho — chegará em ~15 min. Deixe-o com a coleira! 🐶"
- Chegada no pet: "O [pet] chegou com segurança! Já está indo para o banho. 🛁"
- Retorno: "O [pet] ficou pronto e cheiroso! Já entrou no Táxi Dog voltando para casa. Previsão: 20 min."
Resultado: zero ligações de "cadê meu pet?" na recepção.

**2. Clube Leva e Traz (Assinaturas Recorrentes)**
Pacotes mensais (ex: 4 Banhos + 4 Táxi Dogs) cobrados automaticamente no cartão do tutor via CRM. Receita previsível todo mês + fidelização automática dos clientes.

**3. Otimização Inteligente de Rotas**
A HubIA agrupa coletas e entregas por bairro/proximidade e calcula a sequência ideal para o motorista — menos combustível, mais corridas por dia, melhor uso dos kennels.

**4. Controle de Ocupação e Segurança**
Registro de qual kennel o pet está, check-in digital pelo motorista, histórico de horários de entrada/saída no veículo — transparência total para o estabelecimento e para o tutor.
`;

// Segmentos que se beneficiam mais do Táxi Dog (para personalizar ênfase)
const SEGMENTOS_TAXI = ['pet shop', 'banho', 'tosa', 'clínica', 'veterinário', 'hotel', 'hotelzinho', 'day care', 'daycare'];

// ─── QUALIFICAÇÃO AVANÇADA ────────────────────────────────────────────────────
/**
 * Qualifica um lead com IA, retornando campos enriquecidos.
 * Retorna: { score (0-10), ai_score (0-100), ai_temperatura, ai_resumo, ai_motivo,
 *            claude_analysis, suggested_message }
 */
export async function qualifyLead(lead) {
  if (!hasAIKeys()) throw new Error('Sem chaves de IA configuradas');

  const systemPrompt = `${HUBIA_SISTEMA} Analise leads B2B pet e responda sempre em JSON puro, sem texto adicional.`;

  // Verifica se o segmento tem fit alto com Táxi Dog para personalizar a análise
  const segLower = (lead.segment || '').toLowerCase();
  const taxiDogFit = SEGMENTOS_TAXI.some(s => segLower.includes(s));

  const prompt = `${PRODUTO_CONTEXTO}

Analise este lead pet e retorne exatamente este JSON:
{
  "score": <inteiro 0-100 representando potencial de conversão com a plataforma Pet Hub + HubIA>,
  "temperatura": <"quente" | "morno" | "frio">,
  "segmento": <"segmento principal do negócio">,
  "resumo": <"resumo executivo em 1 frase curta sobre o estabelecimento">,
  "motivo": <"principal motivo do score em 1 frase — relate ao fit com Pet Hub / HubIA / Táxi Dog">,
  "claude_analysis": <"análise de dor e oportunidade em 2-3 frases: que problema operacional eles enfrentam hoje e como HubIA + Táxi Dog resolve">,
  "suggested_message": <"mensagem de abordagem WhatsApp ULTRA-personalizada, mínimo 3 parágrafos, usa nome do estabelecimento e dados específicos do perfil, menciona a HubIA e o Táxi Dog como solução concreta para dores deste tipo de negócio${taxiDogFit ? ' — enfatize o Táxi Dog como diferencial principal' : ''}">
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

  const systemPrompt = `${HUBIA_SISTEMA} Crie mensagens de abordagem extremamente personalizadas. Nunca use templates genéricos. Use sempre o nome do estabelecimento e dados reais do perfil.`;

  const historyCtx = conversationHistory.length > 0
    ? `\n\nHistórico de interações anteriores:\n${
        conversationHistory.slice(-5).map(m =>
          `${m.direction === 'out' ? '[Pet Hub]' : '[Lead]'}: ${m.content}`
        ).join('\n')
      }`
    : '';

  const ctx = [
    lead.rating    ? `Avaliação Google: ${lead.rating}★ (${lead.reviews} avaliações)` : null,
    lead.followers ? `Seguidores Instagram: ${lead.followers.toLocaleString('pt-BR')}` : null,
    lead.bio       ? `Descrição: ${lead.bio.slice(0, 120)}` : null,
    lead.address   ? `Localização: ${lead.address}` : null
  ].filter(Boolean).join('\n');

  const segLower = (lead.segment || '').toLowerCase();
  const taxiDogFit = SEGMENTOS_TAXI.some(s => segLower.includes(s));

  const prompt = `${PRODUTO_CONTEXTO}

Crie uma mensagem de primeira abordagem via WhatsApp para este estabelecimento pet:

Estabelecimento: ${lead.name}
Segmento: ${lead.segment}
${ctx}${historyCtx}

REGRAS OBRIGATÓRIAS:
1. Use o nome "${lead.name}" de forma natural no início (sem "Olá, [Nome]!" genérico)
2. Mencione pelo menos 1 dado específico e real do perfil acima (avaliação, seguidores, bio ou localização)
3. Apresente a HubIA como solução de automação e CRM para o problema principal deste segmento
4. ${taxiDogFit
    ? 'Destaque o TÁXI DOG como diferencial principal — descreva pelo menos 2 das 4 funcionalidades (WhatsApp automático, Clube Leva e Traz, rotas, controle de kennels) aplicadas ao dia a dia deste negócio'
    : 'Mencione o Táxi Dog como exemplo de como a HubIA automatiza operações complexas do setor pet'}
5. Proponha uma demonstração de 10 minutos SEM compromisso — seja específico ("que tal amanhã às 10h?")
6. Tom: consultivo, caloroso, direto — como um parceiro que conhece o setor, não um vendedor genérico
7. 3-4 parágrafos curtos, linguagem de WhatsApp (não formal demais)
8. Termine com pergunta aberta que convide a resposta

Retorne APENAS a mensagem pronta para envio, sem introduções ou comentários.`;

  const { content } = await callAI({
    messages:    [{ role: 'user', content: prompt }],
    systemPrompt,
    temperature: 0.75,
    maxTokens:   800
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

  const systemPrompt = `${HUBIA_SISTEMA} Você analisa conversas de vendas B2B do setor pet. Identifica sinais de compra, objeções e decide se o lead deve avançar na pipeline. Conhece a fundo a funcionalidade Táxi Dog e como ela resolve dores logísticas pet. Responda em JSON puro.`;

  const convText = messages
    .slice(-25)
    .map(m => `${m.direction === 'out' ? '[Pet Hub]' : '[Lead]'}: ${m.content}`)
    .join('\n');

  const prompt = `${PRODUTO_CONTEXTO}

Analise esta conversa de vendas B2B (Pet Hub + HubIA) e retorne exatamente este JSON:
{
  "sentimento": <"positivo" | "neutro" | "negativo" | "ansioso" | "desinteressado">,
  "interesse": <"alto" | "medio" | "baixo" | "sem interesse">,
  "urgencia": <"alta" | "media" | "baixa">,
  "proximaAcao": <"ação específica recomendada ao vendedor em máximo 8 palavras — se há objeção, sugira como contorná-la com HubIA/Táxi Dog">,
  "resumo": <"resumo executivo da conversa em 1 frase">,
  "pedidoDemo": <true se pediu demonstração ou agendamento>,
  "pedidoPreco": <true se perguntou sobre preço, planos ou custo>,
  "querFechar": <true se demonstrou intenção clara de contratar>,
  "objecao": <"principal objeção levantada (preço, complexidade, tempo, etc.)" ou null>,
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
  const segLower = (lead.segment || '').toLowerCase();
  const taxiDogFit = SEGMENTOS_TAXI.some(s => segLower.includes(s));

  if (!hasAIKeys()) {
    const taxiDogHint = taxiDogFit
      ? `nosso Táxi Dog automatiza o leva e traz com WhatsApp automático para os tutores`
      : `nossa HubIA automatiza CRM e comunicação com tutores via WhatsApp`;
    const msgs = [
      `Oi! Sou da equipe Pet Hub. Passando para ver se recebeu nossa mensagem sobre ${taxiDogHint}. Há algum momento disponível esta semana para uma conversa de 10 minutos?`,
      `Oi, tudo bem? Tentando contato novamente da Pet Hub. Sabemos que a rotina de ${lead.segment?.toLowerCase() || 'negócio pet'} é corrida! Para te dar uma ideia do que entregamos: ${taxiDogHint} — clientes economizam horas toda semana. Vale 10 min?`,
      `Olá! Esta é nossa última tentativa de contato. Se não for o momento agora, tudo bem — fica à vontade para nos chamar quando fizer sentido. Estaremos aqui! Sucesso para o ${lead.name}! 🐾`
    ];
    return msgs[Math.min(attempt - 1, 2)];
  }

  const systemPrompt = `${HUBIA_SISTEMA} Você escreve follow-ups de reengajamento B2B para o setor pet. Mensagens curtas, respeitosas e com valor concreto sobre a HubIA e o Táxi Dog. Retorne apenas a mensagem.`;

  const attemptLabel  = attempt === 1 ? 'primeiro' : attempt === 2 ? 'segundo' : 'terceiro e último';
  const sinceLabel    = attempt === 1 ? '1 dia'    : attempt === 2 ? '3 dias'  : '7 dias';
  const isLastAttempt = attempt >= 3;

  const historyCtx = history.length > 0
    ? `\nÚltimas mensagens trocadas:\n${history.slice(-3).map(m => `${m.direction === 'out' ? 'Nós' : 'Lead'}: ${m.content.slice(0, 80)}`).join('\n')}`
    : '';

  const taxiDogInstruction = taxiDogFit
    ? `Este estabelecimento tem fit alto com o Táxi Dog. No follow-up, mencione 1 benefício concreto e novo (que não foi dito antes) do Táxi Dog — pode ser o Clube Leva e Traz, a otimização de rotas, ou o controle de kennels.`
    : `Mencione a HubIA como automação de CRM e WhatsApp para o segmento deles.`;

  const prompt = `Crie o ${attemptLabel} follow-up de reengajamento para este lead que não respondeu há ${sinceLabel}:

Lead: ${lead.name} (${lead.segment})${lead.bio ? `\nBio: ${lead.bio.slice(0, 80)}` : ''}${historyCtx}

${taxiDogInstruction}

${isLastAttempt
  ? 'ÚLTIMA tentativa: seja respeitoso e definitivo — mencione que é o último contato e deixe a porta aberta de forma genuína, sem pressão.'
  : 'Reforce 1 benefício concreto novo. Proponha horário específico para conversa de 10 min (ex: "que tal amanhã às 14h?").'
}

Máximo 2 parágrafos curtos. Tom WhatsApp (direto, humano). Retorne APENAS a mensagem.`;

  const { content } = await callAI({
    messages:    [{ role: 'user', content: prompt }],
    systemPrompt,
    temperature: 0.7,
    maxTokens:   380
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
