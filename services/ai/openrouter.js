/**
 * Centralized AI Provider — Pet Hub CRM
 * Suporta OpenRouter (primário) e Anthropic Claude (fallback).
 * Inclui retry, timeout, cache, logs e controle de custos.
 */

import fetch from 'node-fetch';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CLAUDE_URL     = 'https://api.anthropic.com/v1/messages';
const MAX_RETRIES    = 3;
const TIMEOUT_MS     = 30000;
const RETRY_DELAY_MS = 1200;

// In-memory cache com TTL de 5 minutos
const _cache   = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Estatísticas de uso
const _stats = { requests: 0, tokens: 0, errors: 0, cacheHits: 0, costEstimate: 0 };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── CORE FUNCTION ────────────────────────────────────────────────────────────
/**
 * Faz chamada à IA (OpenRouter ou Claude) com retry, timeout e cache.
 * @param {object} opts
 * @param {Array}  opts.messages       - Array de mensagens no formato [{role, content}]
 * @param {string} [opts.systemPrompt] - Prompt de sistema (opcional)
 * @param {number} [opts.temperature]  - Temperatura (0-1), default 0.7
 * @param {number} [opts.maxTokens]    - Máximo de tokens de saída, default 1200
 * @param {boolean}[opts.useCache]     - Habilitar cache, default false
 * @returns {Promise<{content: string, model: string, tokens: number}>}
 */
export async function callAI({ messages, systemPrompt = null, temperature = 0.7, maxTokens = 1200, useCache = false }) {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const claudeKey     = process.env.CLAUDE_API_KEY;

  if (!openrouterKey && !claudeKey) {
    throw new Error('Nenhuma chave de IA configurada (OPENROUTER_API_KEY ou CLAUDE_API_KEY)');
  }

  const model = (process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat').trim().replace(/\.+$/, '');

  // Cache key inclui mensagens + modelo
  const allMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  if (useCache) {
    const cacheKey = JSON.stringify({ allMessages, model });
    const cached   = _cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      _stats.cacheHits++;
      console.log('[AI] Cache hit');
      return cached.data;
    }
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = openrouterKey
        ? await _callOpenRouter({ allMessages, model, temperature, maxTokens, apiKey: openrouterKey })
        : await _callClaude({ messages, systemPrompt, temperature, maxTokens, apiKey: claudeKey });

      _stats.requests++;
      _stats.tokens += result.tokens || 0;
      // Estimativa de custo (DeepSeek ~$0.14/1M tokens)
      _stats.costEstimate += ((result.tokens || 0) / 1_000_000) * 0.14;

      if (useCache) {
        const cacheKey = JSON.stringify({ allMessages, model });
        _cache.set(cacheKey, { data: result, ts: Date.now() });
      }

      console.log(`[AI] OK attempt=${attempt}/${MAX_RETRIES} model=${result.model} tokens=${result.tokens}`);
      return result;

    } catch (err) {
      lastError = err;
      _stats.errors++;
      console.error(`[AI] Tentativa ${attempt}/${MAX_RETRIES} falhou: ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

// ─── OPENROUTER ───────────────────────────────────────────────────────────────
async function _callOpenRouter({ allMessages, model, temperature, maxTokens, apiKey }) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://pethub.com.br',
        'X-Title':       'Pet Hub CRM'
      },
      body: JSON.stringify({
        model,
        messages:   allMessages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenRouter HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data    = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Resposta vazia do OpenRouter');

    return {
      content,
      model:  data.model || model,
      tokens: data.usage?.total_tokens || 0
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── CLAUDE ───────────────────────────────────────────────────────────────────
async function _callClaude({ messages, systemPrompt, temperature, maxTokens, apiKey }) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const body = {
      model:      'claude-3-5-sonnet-20241022',
      max_tokens: maxTokens,
      messages,
      temperature
    };
    if (systemPrompt) body.system = systemPrompt;

    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Claude HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data    = await res.json();
    const content = data.content?.[0]?.text;
    if (!content) throw new Error('Resposta vazia do Claude');

    return {
      content,
      model:  'claude-3-5-sonnet-20241022',
      tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── UTILITÁRIOS ──────────────────────────────────────────────────────────────
/**
 * Extrai e parseia JSON de uma resposta de IA.
 * Lida com blocos markdown ```json``` e JSON embutido em texto.
 */
export function parseJSON(content) {
  let s = content.trim();
  // Remove markdown code blocks
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Extrai o primeiro objeto JSON válido
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

/** Verifica se há chaves de IA configuradas */
export function hasAIKeys() {
  return !!(process.env.OPENROUTER_API_KEY || process.env.CLAUDE_API_KEY);
}

/** Retorna estatísticas de uso do provider */
export function getAIStats() {
  return {
    ...Object.assign({}, _stats),
    costEstimateUSD: _stats.costEstimate.toFixed(4),
    cacheSize: _cache.size
  };
}
