import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import fsSync from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
let _ws; try { _ws = _require('ws'); } catch (_) { _ws = undefined; }
import { qualifyLead, generateApproachMessage, analyzeConversation, generateFollowUp, suggestNextAction } from './services/ai/leadAnalyzer.js';
import { getAIStats, hasAIKeys } from './services/ai/openrouter.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serves root static files including index.html

const LEADS_FILE = path.join(__dirname, 'leads.json');

// --- SUPABASE CLIENT INITIALIZATION ---
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;


let supabase = null;
if (supabaseUrl && supabaseAnonKey) {
  console.log('[Supabase] Credenciais detectadas. Inicializando cliente...');
  const supabaseOpts = _ws ? { realtime: { transport: _ws } } : {};
  supabase = createClient(supabaseUrl, supabaseAnonKey, supabaseOpts);
} else {
  console.log('[Supabase] Sem credenciais no .env. Utilizando leads.json local para persistência.');
}

// --- DATABASE OPERATIONS ---

// Helper to read leads list
async function readLeads() {
  if (supabase) {
    try {
      console.log('[Supabase] Buscando leads do banco de dados em nuvem...');
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .order('updated_at', { ascending: false });
      
      if (error) throw error;
      
      // Map Supabase snake_case fields to frontend camelCase if necessary
      return (data || []).map(l => ({
        id: l.id,
        name: l.name,
        handle: l.handle,
        platform: l.platform,
        segment: l.segment,
        score: l.score,
        status: l.status,
        phone: l.phone,
        email: l.email,
        address: l.address,
        bio: l.bio,
        followers: l.followers,
        rating: l.rating ? parseFloat(l.rating) : null,
        reviews: l.reviews,
        claude_analysis: l.claude_analysis,
        suggested_message: l.suggested_message,
        ai_score: l.ai_score,
        ai_temperatura: l.ai_temperatura,
        ai_resumo: l.ai_resumo,
        ai_motivo: l.ai_motivo,
        proxima_acao: l.proxima_acao,
        last_contact_at: l.last_contact_at,
        follow_up_count: l.follow_up_count || 0,
        conversation_analysis: l.conversation_analysis,
        updatedAt: l.updated_at
      }));
    } catch (e) {
      console.error('[Supabase Error] Falha ao ler do Supabase, recorrendo ao banco local:', e.message);
    }
  }

  // Fallback to local leads.json
  try {
    const data = await fs.readFile(LEADS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

// Helper to write to local cache (only used in fallback mode)
async function writeLocalLeads(leads) {
  await fs.writeFile(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
}

// Helper centralizado de atualização de lead (Supabase ou JSON)
async function updateLeadInDB(id, fields) {
  const timestamp = new Date().toISOString();
  const updateData = { ...fields };
  if (!updateData.updated_at) updateData.updated_at = timestamp;
  // Remove undefined
  Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);

  if (supabase) {
    const { data, error } = await supabase
      .from('leads')
      .update(updateData)
      .eq('id', id)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return null;
    return { ...data[0], updatedAt: data[0].updated_at };
  } else {
    const leads = await readLeads();
    const idx = leads.findIndex(l => l.id === id);
    if (idx === -1) return null;
    leads[idx] = { ...leads[idx], ...updateData, updatedAt: timestamp };
    await writeLocalLeads(leads);
    return leads[idx];
  }
}

// --- API STATUS ENDPOINT ---
app.get('/api/status', (req, res) => {
  const venvPython = path.join(__dirname, 'services', 'scraper', '.venv', 'Scripts', 'python.exe');
  const hasScrapegraphEnv = fsSync.existsSync(venvPython) || fsSync.existsSync(path.join(__dirname, 'services', 'scraper', 'scrapegraph_lead_finder.py'));

  res.json({
    apify: !!process.env.APIFY_API_KEY,
    claude: !!process.env.CLAUDE_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY,
    openrouterModel: (process.env.OPENROUTER_MODEL || 'openrouter/free').trim().replace(/\.+$/, ''),
    supabase: !!supabase,
    evolutionApi: !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.EVOLUTION_INSTANCE),
    scrapegraph: hasScrapegraphEnv,
    port: PORT
  });
});

// --- EVOLUTION API (WHATSAPP) INTEGRATION ---
const evolutionBaseUrl = process.env.EVOLUTION_API_URL || '';
const evolutionApiKey  = process.env.EVOLUTION_API_KEY  || '';
const evolutionInstance = process.env.EVOLUTION_INSTANCE || 'pethub';

// Sanitize phone number to international format (55XXXXXXXXXXX)
function sanitizePhone(phone) {
  if (!phone) return null;
  // Remove all non-digits
  let digits = phone.replace(/\D/g, '');
  // If starts with 0, strip it
  if (digits.startsWith('0')) digits = digits.slice(1);
  // If doesn't start with country code 55, prepend it
  if (!digits.startsWith('55')) digits = '55' + digits;
  // Must have at least 12 digits (55 + DDD + 9 digits)
  if (digits.length < 12) return null;
  return digits;
}

async function sendWhatsAppMessage(phone, message) {
  if (!evolutionBaseUrl || !evolutionApiKey) {
    console.log('[Evolution API] N\u00e3o configurada, pulando envio de WhatsApp.');
    return { skipped: true, reason: 'Evolution API n\u00e3o configurada.' };
  }

  const sanitized = sanitizePhone(phone);
  if (!sanitized) {
    console.warn('[Evolution API] N\u00famero inv\u00e1lido, pulando envio:', phone);
    return { skipped: true, reason: 'N\u00famero de telefone inv\u00e1lido.' };
  }

  const url = `${evolutionBaseUrl}/message/sendText/${evolutionInstance}`;
  console.log(`[Evolution API] Enviando WhatsApp para ${sanitized}...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': evolutionApiKey
    },
    body: JSON.stringify({
      number: sanitized,
      text: message
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Evolution API erro ${res.status}: ${errText}`);
  }

  const data = await res.json();
  console.log(`[Evolution API] Mensagem enviada com sucesso para ${sanitized}!`);
  return data;
}

// Get Evolution API QR Code for connection
app.get('/api/whatsapp/qr', async (req, res) => {
  if (!evolutionBaseUrl || !evolutionApiKey) {
    return res.status(400).json({ error: 'Evolution API n\u00e3o configurada no .env.' });
  }
  try {
    const r = await fetch(`${evolutionBaseUrl}/instance/connect/${evolutionInstance}`, {
      headers: { 'apikey': evolutionApiKey }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Evolution API connection status
app.get('/api/whatsapp/status', async (req, res) => {
  if (!evolutionBaseUrl || !evolutionApiKey) {
    return res.json({ connected: false, reason: 'N\u00e3o configurado' });
  }
  try {
    const r = await fetch(`${evolutionBaseUrl}/instance/connectionState/${evolutionInstance}`, {
      headers: { 'apikey': evolutionApiKey }
    });
    const data = await r.json();
    const connected = data?.instance?.state === 'open';
    res.json({ connected, state: data?.instance?.state, data });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// Send test WhatsApp message
app.post('/api/whatsapp/test', async (req, res) => {
  const { phone, message } = req.body;
  try {
    const result = await sendWhatsAppMessage(phone, message || 'Teste do Pet Hub Leads! \uD83D\uDC3E');
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- WHATSAPP INBOX: MESSAGE STORAGE ---
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

async function readMessages() {
  try {
    const data = await fs.readFile(MESSAGES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeMessages(messages) {
  await fs.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf-8');
}

async function saveMessage(msg) {
  const messages = await readMessages();
  messages.unshift(msg);
  await writeMessages(messages);
  return msg;
}

// Webhook: receives incoming messages from Evolution API
app.post('/api/whatsapp/webhook', async (req, res) => {
  try {
    // Valida token de segurança se configurado
    const webhookToken = process.env.EVOLUTION_WEBHOOK_TOKEN;
    if (webhookToken) {
      const incoming = req.headers['apikey'] || req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
      if (incoming !== webhookToken) {
        console.warn('[Webhook] Token inválido recebido:', incoming?.slice(0, 8) + '...');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const body = req.body;
    const event = body.event;

    if (event !== 'messages.upsert') return res.json({ ok: true });

    const msgData = body.data;
    if (!msgData) return res.json({ ok: true });

    const fromMe = msgData.key?.fromMe || false;
    if (fromMe) return res.json({ ok: true });

    const remoteJid = msgData.key?.remoteJid || '';
    if (remoteJid.endsWith('@g.us')) return res.json({ ok: true }); // ignore groups

    const phone = remoteJid.replace('@s.whatsapp.net', '');
    const pushName = msgData.pushName || phone;
    const content = msgData.message?.conversation
      || msgData.message?.extendedTextMessage?.text
      || msgData.message?.imageMessage?.caption
      || '[M\u00EDdia recebida]';
    const timestamp = msgData.messageTimestamp
      ? new Date(msgData.messageTimestamp * 1000).toISOString()
      : new Date().toISOString();

    const msg = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      phone,
      name: pushName,
      direction: 'in',
      content,
      timestamp
    };

    await saveMessage(msg);
    console.log(`[WhatsApp Inbox] Recebido de ${pushName} (${phone}): ${content.slice(0, 60)}`);

    // Análise de conversa em background (não bloqueia o webhook)
    triggerConversationAnalysis(phone).catch(e =>
      console.error('[Webhook Analysis Error]', e.message)
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('[Webhook Error]', e.message);
    res.json({ ok: true });
  }
});

// List conversations grouped by phone (last message per contact)
app.get('/api/whatsapp/conversations', async (req, res) => {
  const [messages, leads] = await Promise.all([readMessages(), readLeads()]);

  const byPhone = {};
  for (const m of messages) {
    if (!byPhone[m.phone]) {
      byPhone[m.phone] = { phone: m.phone, name: m.name, messages: [] };
    }
    byPhone[m.phone].messages.push(m);
  }

  const conversations = Object.values(byPhone).map(c => {
    const sorted = [...c.messages].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const lead = leads.find(l => sanitizePhone(l.phone) === sanitizePhone(c.phone));
    const unread = c.messages.filter(m => m.direction === 'in').length;
    return {
      phone: c.phone,
      name: lead?.name || c.name,
      segment: lead?.segment || null,
      status: lead?.status || null,
      leadId: lead?.id || null,
      lastMessage: sorted[0]?.content || '',
      lastAt: sorted[0]?.timestamp || '',
      unread
    };
  }).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  res.json(conversations);
});

// Get all messages for a specific phone number
app.get('/api/whatsapp/conversations/:phone', async (req, res) => {
  const messages = await readMessages();
  const phone = req.params.phone;
  const conv = messages
    .filter(m => m.phone === phone)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  res.json(conv);
});

// Send reply from the inbox
app.post('/api/whatsapp/reply', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message s\u00E3o obrigat\u00F3rios.' });

  try {
    const result = await sendWhatsAppMessage(phone, message);
    const msg = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      phone,
      name: 'Pet Hub',
      direction: 'out',
      content: message,
      timestamp: new Date().toISOString()
    };
    await saveMessage(msg);
    res.json({ success: true, result, msg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- CRM REST ENDPOINTS ---

// Fetch all leads
app.get('/api/leads', async (req, res) => {
  try {
    const leads = await readLeads();
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao obter os leads da base.' });
  }
});

// Create lead manually
app.post('/api/leads', async (req, res) => {
  try {
    const { name, handle, platform, segment, score, phone, email, bio, address } = req.body;
    if (!name || !platform) {
      return res.status(400).json({ error: 'Nome e plataforma são obrigatórios.' });
    }

    const timestamp = new Date().toISOString();
    const newLead = {
      id: `lead-${Date.now()}`,
      name,
      handle: handle || (platform === 'Google Maps' ? 'Localização' : '@semhandle'),
      platform,
      segment: segment || 'Outros',
      score: score || 5,
      status: 'Descoberto',
      phone: phone || '',
      email: email || '',
      bio: bio || '',
      address: address || '',
      claude_analysis: 'Lead inserido manualmente no CRM.',
      suggested_message: 'Mensagem sugerida indisponível. Clique em "Qualificar com IA" para gerar.',
      updatedAt: timestamp
    };

    if (supabase) {
      console.log('[Supabase] Gravando novo lead no banco em nuvem...');
      const { data, error } = await supabase
        .from('leads')
        .insert([{
          id: newLead.id,
          name: newLead.name,
          handle: newLead.handle,
          platform: newLead.platform,
          segment: newLead.segment,
          score: newLead.score,
          status: newLead.status,
          phone: newLead.phone,
          email: newLead.email,
          address: newLead.address,
          bio: newLead.bio,
          claude_analysis: newLead.claude_analysis,
          suggested_message: newLead.suggested_message,
          updated_at: timestamp
        }])
        .select();

      if (error) throw error;
      res.status(201).json({
        ...data[0],
        updatedAt: data[0].updated_at
      });
    } else {
      const leads = await readLeads();
      leads.unshift(newLead);
      await writeLocalLeads(leads);
      res.status(201).json(newLead);
    }
  } catch (error) {
    console.error('[Create Lead Error]', error);
    res.status(500).json({ error: `Erro ao salvar o lead: ${error.message}` });
  }
});

// Update lead status/details
app.put('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateFields = req.body;
    const timestamp = new Date().toISOString();

    if (supabase) {
      console.log(`[Supabase] Atualizando lead ${id} no banco em nuvem...`);
      
      const dbUpdate = {
        name: updateFields.name,
        handle: updateFields.handle,
        platform: updateFields.platform,
        segment: updateFields.segment,
        score: updateFields.score,
        status: updateFields.status,
        phone: updateFields.phone,
        email: updateFields.email,
        address: updateFields.address,
        bio: updateFields.bio,
        followers: updateFields.followers,
        rating: updateFields.rating,
        reviews: updateFields.reviews,
        claude_analysis: updateFields.claude_analysis,
        suggested_message: updateFields.suggested_message,
        updated_at: timestamp
      };

      // Remove undefined values to avoid overwriting database fields
      Object.keys(dbUpdate).forEach(key => dbUpdate[key] === undefined && delete dbUpdate[key]);

      const { data, error } = await supabase
        .from('leads')
        .update(dbUpdate)
        .eq('id', id)
        .select();

      if (error) throw error;
      if (!data || data.length === 0) {
        return res.status(404).json({ error: 'Lead não encontrado no Supabase.' });
      }

      res.json({
        ...data[0],
        updatedAt: data[0].updated_at
      });
    } else {
      const leads = await readLeads();
      const idx = leads.findIndex(l => l.id === id);

      if (idx === -1) {
        return res.status(404).json({ error: 'Lead não encontrado.' });
      }

      leads[idx] = {
        ...leads[idx],
        ...updateFields,
        updatedAt: timestamp
      };

      await writeLocalLeads(leads);
      res.json(leads[idx]);
    }
  } catch (error) {
    console.error('[Update Lead Error]', error);
    res.status(500).json({ error: `Erro ao atualizar o lead: ${error.message}` });
  }
});

// Delete lead
app.delete('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (supabase) {
      console.log(`[Supabase] Excluindo lead ${id} no banco em nuvem...`);
      const { error } = await supabase
        .from('leads')
        .delete()
        .eq('id', id);

      if (error) throw error;
      res.json({ success: true, message: 'Lead excluído com sucesso do Supabase.' });
    } else {
      const leads = await readLeads();
      const filteredLeads = leads.filter(l => l.id !== id);

      if (leads.length === filteredLeads.length) {
        return res.status(404).json({ error: 'Lead não encontrado.' });
      }

      await writeLocalLeads(filteredLeads);
      res.json({ success: true, message: 'Lead excluído com sucesso.' });
    }
  } catch (error) {
    console.error('[Delete Lead Error]', error);
    res.status(500).json({ error: `Erro ao excluir o lead: ${error.message}` });
  }
});

// --- SCRAPEGRAPHAI SCRAPER INTEGRATION ---
async function runScrapeGraphAI(url, customPrompt) {
  return new Promise((resolve, reject) => {
    const venvPython = path.join(__dirname, 'services', 'scraper', '.venv', 'Scripts', 'python.exe');
    const pythonCmd = fsSync.existsSync(venvPython) 
      ? venvPython 
      : (process.env.SCRAPEGRAPH_PYTHON_PATH || 'python');

    const scriptPath = path.join(__dirname, 'services', 'scraper', 'scrapegraph_lead_finder.py');
    const args = ['--url', url];
    if (customPrompt) {
      args.push('--prompt', customPrompt);
    }

    console.log(`[ScrapeGraphAI] Executando scraper na URL: ${url} usando ${pythonCmd}...`);
    const child = spawn(pythonCmd, [scriptPath, ...args], {
      cwd: path.join(__dirname, 'services', 'scraper'),
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0 && !stdout) {
        return reject(new Error(`Processo ScrapeGraphAI falhou com código ${code}: ${stderr || 'Sem saída'}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.success === false) {
          return reject(new Error(parsed.error || 'Erro desconhecido na extração ScrapeGraphAI'));
        }
        resolve(parsed.lead || parsed);
      } catch (err) {
        console.error('[ScrapeGraphAI Parse Error] Output bruto:', stdout);
        reject(new Error(`Falha ao ler JSON retornado pelo ScrapeGraphAI: ${err.message}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Não foi possível iniciar o Python: ${err.message}`));
    });
  });
}

// Endpoint para raspagem individual via ScrapeGraphAI
app.post('/api/leads/scrape-url', async (req, res) => {
  const { url, prompt, autoSave = true } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'A URL do site é obrigatória.' });
  }

  try {
    const rawData = await runScrapeGraphAI(url, prompt);
    const timestamp = new Date().toISOString();

    const name = rawData.name || rawData.nome || 'Lead ScrapeGraph';
    const handle = rawData.instagram || `@${name.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
    const phone = rawData.phone || rawData.telefone || '';
    const email = rawData.email || '';
    const address = rawData.address || rawData.endereco || (rawData.city ? rawData.city : '');
    const bio = rawData.bio_description || rawData.servicos || 'Extraído com ScrapeGraphAI';
    const segment = rawData.segment || 'Pet Shop';
    const salesNotes = rawData.sales_notes || rawData.observacoes || 'Extraído via IA ScrapeGraphAI.';

    const newLead = {
      id: `scrape-${Date.now()}`,
      name,
      handle,
      platform: 'ScrapeGraphAI',
      segment,
      score: 8,
      status: 'Descoberto',
      phone,
      email,
      address,
      bio: typeof bio === 'object' ? JSON.stringify(bio) : String(bio),
      claude_analysis: salesNotes,
      suggested_message: `Olá ${name}! Vi seu site e notei que oferecem serviços pet incríveis. O Pet Hub System pode ajudar a automatizar agendamentos e vendas no seu negócio. Podemos conversar?`,
      updatedAt: timestamp
    };

    if (autoSave) {
      if (supabase) {
        const { error } = await supabase.from('leads').insert([{
          id: newLead.id,
          name: newLead.name,
          handle: newLead.handle,
          platform: newLead.platform,
          segment: newLead.segment,
          score: newLead.score,
          status: newLead.status,
          phone: newLead.phone,
          email: newLead.email,
          address: newLead.address,
          bio: newLead.bio,
          claude_analysis: newLead.claude_analysis,
          suggested_message: newLead.suggested_message,
          updated_at: timestamp
        }]);

        if (error) console.error('[Supabase Insert Error]', error.message);
      } else {
        const leads = await readLeads();
        leads.unshift(newLead);
        await writeLocalLeads(leads);
      }
    }

    res.json({
      success: true,
      message: `Lead "${name}" extraído com sucesso via ScrapeGraphAI!`,
      lead: newLead,
      raw: rawData
    });
  } catch (error) {
    console.error('[ScrapeGraphAI API Error]', error);
    res.status(500).json({ error: `Erro na extração ScrapeGraphAI: ${error.message}` });
  }
});

// Endpoint para raspagem em lote (batch) via ScrapeGraphAI
app.post('/api/leads/scrape-batch', async (req, res) => {
  const { urls, prompt, autoSave = true } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Uma lista de URLs (urls) é obrigatória.' });
  }

  const results = [];
  const errors = [];

  for (const url of urls) {
    try {
      const rawData = await runScrapeGraphAI(url, prompt);
      const timestamp = new Date().toISOString();
      const name = rawData.name || rawData.nome || 'Lead ScrapeGraph';
      const handle = rawData.instagram || `@${name.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
      const phone = rawData.phone || rawData.telefone || '';
      const email = rawData.email || '';
      const address = rawData.address || rawData.endereco || '';
      const bio = rawData.bio_description || 'Extraído com ScrapeGraphAI';
      const segment = rawData.segment || 'Pet Shop';
      const salesNotes = rawData.sales_notes || rawData.observacoes || 'Extraído via IA ScrapeGraphAI.';

      const leadObj = {
        id: `scrape-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        name,
        handle,
        platform: 'ScrapeGraphAI',
        segment,
        score: 8,
        status: 'Descoberto',
        phone,
        email,
        address,
        bio: typeof bio === 'object' ? JSON.stringify(bio) : String(bio),
        claude_analysis: salesNotes,
        suggested_message: `Olá ${name}! Vi seu site e notei os serviços oferecidos. O Pet Hub System é o sistema ideal para organizar seus atendimentos pet. Quer conhecer mais?`,
        updatedAt: timestamp
      };

      if (autoSave) {
        if (supabase) {
          await supabase.from('leads').insert([{
            id: leadObj.id,
            name: leadObj.name,
            handle: leadObj.handle,
            platform: leadObj.platform,
            segment: leadObj.segment,
            score: leadObj.score,
            status: leadObj.status,
            phone: leadObj.phone,
            email: leadObj.email,
            address: leadObj.address,
            bio: leadObj.bio,
            claude_analysis: leadObj.claude_analysis,
            suggested_message: leadObj.suggested_message,
            updated_at: timestamp
          }]);
        }
      }

      results.push({ url, lead: leadObj, raw: rawData });
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }

  if (!supabase && autoSave && results.length > 0) {
    const leads = await readLeads();
    const newLeads = results.map(r => r.lead);
    await writeLocalLeads([...newLeads, ...leads]);
  }

  res.json({
    success: true,
    totalScraped: results.length,
    totalErrors: errors.length,
    leads: results.map(r => r.lead),
    details: results,
    errors
  });
});

// --- APIFY CAPTURE IA ENDPOINT ---
app.post('/api/leads/search', async (req, res) => {
  const { platform, query, location, hashtag, limit = 5 } = req.body;

  if (!platform) {
    return res.status(400).json({ error: 'Plataforma de busca é obrigatória.' });
  }

  const apifyKey = process.env.APIFY_API_KEY;

  if (!apifyKey) {
    // --- SIMULATION MODE ---
    console.log(`[Apify Simulator] Executando busca de leads pet na plataforma ${platform}...`);
    await new Promise(resolve => setTimeout(resolve, 3500));

    const simulatedLeads = [];
    const normalizedQuery = (query || hashtag || 'Pet Shop').toLowerCase();
    
    let segment = 'Pet Shop';
    if (normalizedQuery.includes('vet') || normalizedQuery.includes('clinic')) segment = 'Clínica Veterinária';
    else if (normalizedQuery.includes('banho') || normalizedQuery.includes('tosa') || normalizedQuery.includes('estet')) segment = 'Banho e Tosa';
    else if (normalizedQuery.includes('adestr') || normalizedQuery.includes('trein')) segment = 'Adestrador';
    else if (normalizedQuery.includes('creche') || normalizedQuery.includes('hotel') || normalizedQuery.includes('hosped')) segment = 'Creche Canina';

    const city = location || 'São Paulo - SP';

    if (platform === 'Google Maps') {
      const places = [
        { name: 'Pet Center Patinhas', phone: '+55 11 91234-5678', rating: 4.7, reviews: 78, address: `Rua do Centro, 100 - ${city}` },
        { name: 'Veterinária Amigo Fiel', phone: '+55 11 98888-2222', rating: 4.9, reviews: 112, address: `Av. Principal, 500 - ${city}` },
        { name: 'Estética Animal Pelos & Caretas', phone: '+55 11 97777-3333', rating: 4.5, reviews: 45, address: `Al. dos Anjos, 24 - ${city}` },
        { name: 'Hotel & Creche Cão Feliz', phone: '+55 11 96666-4444', rating: 4.8, reviews: 92, address: `Rua das Chácaras, 1200 - ${city}` },
        { name: 'Doutor Vet Clínica Veterinária', phone: '+55 11 95555-5555', rating: 4.6, reviews: 67, address: `Av. dos Autônomos, 888 - ${city}` }
      ];

      for (let i = 0; i < Math.min(limit, places.length); i++) {
        const place = places[i];
        simulatedLeads.push({
          id: `maps-${Date.now()}-${i}`,
          name: place.name,
          handle: place.address.split(' - ')[0],
          platform: 'Google Maps',
          segment,
          score: Math.floor(Math.random() * 4) + 6,
          status: 'Descoberto',
          rating: place.rating,
          reviews: place.reviews,
          phone: place.phone,
          email: `contato@${place.name.toLowerCase().replace(/[^a-z]/g, '')}.com.br`,
          address: place.address,
          bio: `${segment} focado em oferecer os melhores serviços de ${segment.toLowerCase()} para cães e gatos em ${city.split(' - ')[0]}.`,
          claude_analysis: 'Aguardando qualificação detalhada da IA.',
          suggested_message: 'Mensagem sugerida indisponível. Clique em "Qualificar com IA" para gerar.',
          updatedAt: new Date().toISOString()
        });
      }
    } else {
      const accounts = [
        { handle: '@patinhasfelizespet', followers: 12400, bio: 'Banho & Tosa com carinho! Pet shop completo, rações premium e os melhores brinquedos. Atendimento em domicílio. 🐾' },
        { handle: '@clinicavetvital', followers: 23100, bio: 'Veterinário com amor. Consultas, vacinação, exames laboratoriais e cirurgias. Agende por direct ou whats!' },
        { handle: '@adestradormax', followers: 5800, bio: 'Especialista em comportamento canino. Adestramento positivo para filhotes e cães adultos. 🐕 Eduque com amor!' },
        { handle: '@crechecaompanheiro', followers: 9800, bio: 'Daycare 100% livre. Enriquecimento ambiental, piscina e recreação monitorada. Seu cão no melhor dia da semana! Rio.' },
        { handle: '@esteticacaninavip', followers: 8200, bio: 'Estética de alto padrão para cães de todas as raças. Tosa bebê, hidratação e ozonioterapia. Agende agora! ✨' }
      ];

      for (let i = 0; i < Math.min(limit, accounts.length); i++) {
        const acc = accounts[i];
        simulatedLeads.push({
          id: `insta-${Date.now()}-${i}`,
          name: acc.handle.slice(1).split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          handle: acc.handle,
          platform: 'Instagram',
          segment,
          score: Math.floor(Math.random() * 5) + 5,
          status: 'Descoberto',
          followers: acc.followers,
          phone: `+55 11 9${Math.floor(10000000 + Math.random() * 90000000)}`,
          email: `contato@${acc.handle.slice(1)}.com.br`,
          bio: acc.bio,
          claude_analysis: 'Aguardando qualificação detalhada da IA.',
          suggested_message: 'Mensagem sugerida indisponível. Clique em "Qualificar com IA" para gerar.',
          updatedAt: new Date().toISOString()
        });
      }
    }

    // Save newly simulated leads list
    const currentLeads = await readLeads();
    const filteredSimulated = simulatedLeads.filter(sim => !currentLeads.some(cur => cur.handle === sim.handle));

    if (supabase) {
      console.log(`[Supabase] Batch-inserindo ${filteredSimulated.length} leads no banco em nuvem...`);
      const insertData = filteredSimulated.map(l => ({
        id: l.id,
        name: l.name,
        handle: l.handle,
        platform: l.platform,
        segment: l.segment,
        score: l.score,
        status: l.status,
        phone: l.phone,
        email: l.email,
        address: l.address,
        bio: l.bio,
        followers: l.followers,
        rating: l.rating,
        reviews: l.reviews,
        claude_analysis: l.claude_analysis,
        suggested_message: l.suggested_message,
        updated_at: l.updatedAt
      }));

      if (insertData.length > 0) {
        const { error } = await supabase.from('leads').insert(insertData);
        if (error) throw error;
      }
    } else {
      const updatedLeads = [...filteredSimulated, ...currentLeads];
      await writeLocalLeads(updatedLeads);
    }

    return res.json({
      success: true,
      message: `${filteredSimulated.length} novos leads pet capturados com sucesso em ${platform} (Simulação).`,
      leads: filteredSimulated
    });
  }

  // --- REAL APIFY INTEGRATION ---
  try {
    console.log(`[Apify API] Iniciando busca real no Apify para ${platform}...`);
    let actorId = '';
    let input = {};

    if (platform === 'Google Maps') {
      actorId = 'compass~crawler-google-places';
      const searchStringsArray = [`${query || 'Pet Shop'} em ${location || 'São Paulo'}`];
      input = {
        searchStringsArray,
        maxCrawledPlacesPerSearch: limit,
        language: 'pt-BR',
        exportPlaceUrls: false,
        includeReviews: false
      };
    } else {
      actorId = 'apify~instagram-scraper';
      input = {
        search: hashtag || query || 'petshop',
        searchType: 'hashtag',
        resultsLimit: limit
      };
    }

    const runUrl = `https://api.apify.com/v2/actors/${actorId}/runs?token=${apifyKey}`;
    const startRes = await fetch(runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });

    if (!startRes.ok) {
      const errorText = await startRes.text();
      throw new Error(`Erro ao iniciar ator do Apify: ${errorText}`);
    }

    const runData = await startRes.json();
    const runId = runData.data.id;

    let finished = false;
    let attempts = 0;
    const maxAttempts = 12;
    
    while (!finished && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
      
      const checkUrl = `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyKey}`;
      const statusRes = await fetch(checkUrl);
      
      if (statusRes.ok) {
        const checkData = await statusRes.json();
        const status = checkData.data.status;
        if (status === 'SUCCEEDED') {
          finished = true;
        } else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
          throw new Error(`Ator do Apify falhou com status: ${status}`);
        }
      }
    }

    if (!finished) {
      return res.status(202).json({
        success: true,
        message: 'A busca foi iniciada no Apify. Recarregue a página em alguns instantes para carregar os leads raspados.',
        leads: []
      });
    }

    const datasetUrl = `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${apifyKey}`;
    const datasetRes = await fetch(datasetUrl);
    
    if (!datasetRes.ok) {
      throw new Error('Falha ao obter resultados do dataset do Apify.');
    }

    const items = await datasetRes.json();
    const formattedLeads = [];
    const currentLeads = await readLeads();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let name = '';
      let handle = '';
      let phone = '';
      let email = '';
      let bio = '';
      let address = '';
      let rating = null;
      let reviews = null;
      let followers = null;

      if (platform === 'Google Maps') {
        name = item.title || item.name || 'Estabelecimento Pet';
        address = item.address || item.street || `${location || 'São Paulo'}`;
        handle = address.split(',')[0];
        phone = item.phone || item.internationalPhone || '';
        email = item.email || '';
        rating = item.totalScore || item.stars || null;
        reviews = item.reviewsCount || null;
        bio = item.categoryName || 'Pet Shop / Veterinária';
      } else {
        handle = item.username ? `@${item.username}` : '@perfil_pet';
        name = item.fullName || handle.slice(1);
        followers = item.followersCount || null;
        bio = item.biography || 'Perfil pet no Instagram.';
        phone = item.phone || '';
        email = item.email || '';
      }

      const checkText = `${name} ${bio}`.toLowerCase();
      let segment = 'Pet Shop';
      if (checkText.includes('vet') || checkText.includes('clinic')) segment = 'Clínica Veterinária';
      else if (checkText.includes('banho') || checkText.includes('tosa') || checkText.includes('estet')) segment = 'Banho e Tosa';
      else if (checkText.includes('adestr') || checkText.includes('trein')) segment = 'Adestrador';
      else if (checkText.includes('creche') || checkText.includes('hotel') || checkText.includes('hosped')) segment = 'Creche Canina';

      if (currentLeads.some(cur => cur.handle === handle)) {
        continue;
      }

      formattedLeads.push({
        id: `${platform === 'Google Maps' ? 'maps' : 'insta'}-${Date.now()}-${i}`,
        name,
        handle,
        platform,
        segment,
        score: 5,
        status: 'Descoberto',
        rating,
        reviews,
        followers,
        phone,
        email,
        address,
        bio,
        claude_analysis: 'Aguardando qualificação detalhada da IA.',
        suggested_message: 'Mensagem sugerida indisponível. Clique em "Qualificar com IA" para gerar.',
        updatedAt: new Date().toISOString()
      });
    }

    if (supabase) {
      console.log(`[Supabase] Gravando ${formattedLeads.length} leads obtidos via Apify no banco...`);
      const insertData = formattedLeads.map(l => ({
        id: l.id,
        name: l.name,
        handle: l.handle,
        platform: l.platform,
        segment: l.segment,
        score: l.score,
        status: l.status,
        phone: l.phone,
        email: l.email,
        address: l.address,
        bio: l.bio,
        followers: l.followers,
        rating: l.rating,
        reviews: l.reviews,
        claude_analysis: l.claude_analysis,
        suggested_message: l.suggested_message,
        updated_at: l.updatedAt
      }));

      if (insertData.length > 0) {
        const { error } = await supabase.from('leads').insert(insertData);
        if (error) throw error;
      }
    } else {
      const updatedLeads = [...formattedLeads, ...currentLeads];
      await writeLocalLeads(updatedLeads);
    }

    res.json({
      success: true,
      message: `${formattedLeads.length} novos leads pet capturados via Apify com sucesso!`,
      leads: formattedLeads
    });

  } catch (error) {
    console.error('[Apify API Error]', error);
    res.status(500).json({ error: `Erro na integração com o Apify: ${error.message}` });
  }
});

// Helper to qualify a lead by ID using the configured AI key (Claude or OpenRouter)
async function qualifyLeadById(leadId) {
  const leads = await readLeads();
  const idx = leads.findIndex(l => l.id === leadId);

  if (idx === -1) {
    throw new Error('Lead não encontrado na base.');
  }

  const lead = leads[idx];
  const claudeKey = process.env.CLAUDE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const openrouterModel = (process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat').trim().replace(/\.+$/, '');

  let qualifiedFields = {};

  if (!claudeKey && !openrouterKey) {
    // --- SIMULATION MODE ---
    console.log(`[Claude Simulator] Qualificando lead pet: ${lead.name}...`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    let simulatedScore = 7;
    let simulatedAnalysis = '';
    let simulatedMsg = '';

    if (lead.segment === 'Clínica Veterinária') {
      simulatedScore = lead.followers && lead.followers > 10000 ? 9 : 8;
      simulatedAnalysis = `Clínica veterinária estruturada com boa presença (${lead.platform}). Possui grande potencial para automatizar processos de agendamento e lembretes recorrentes de vacinas/retornos via WhatsApp. A automatização do Pet Hub reduzirá drasticamente o no-show e poupará horas da equipe de atendimento.`;
      simulatedMsg = `Olá Equipe da ${lead.name}! Tudo bem? Acompanho o trabalho essencial de vocês no atendimento veterinário e vejo que oferecem um serviço de altíssima qualidade. Sei que manter a agenda de consultas preventivas e vacinas em dia exige um esforço grande da recepção. Com o Pet Hub, nós ajudamos clínicas de referência a automatizarem lembretes de vacinas inteligentes via WhatsApp que já oferecem o link de agendamento em 1 clique para o tutor. Isso recupera até 30% de vacinações atrasadas com zero esforço operacional. Gostariam de ver uma rápida demonstração sem compromisso de como isso funcionaria para seus clientes? Grande abraço!`;
    } else if (lead.segment === 'Banho e Tosa') {
      simulatedScore = lead.rating && lead.rating >= 4.7 ? 8 : 7;
      simulatedAnalysis = `Negócio com excelente nível de satisfação (nota ${lead.rating || '4.8'} estrelas). Banho e tosa possuem alta frequência de consumo. O Pet Hub ajudará este lead a converter clientes esporádicos em assinantes mensais recorrentes (Clube de Estética Pet), garantindo faturamento estável e otimizando o fluxo da agenda semanal.`;
      simulatedMsg = `Olá, tudo bem com vocês da ${lead.name}? Parabéns pela fantástica recepção e avaliações que vocês recebem de seus clientes! É visível o amor que dedicam a cada pet. Nós desenvolvemos uma solução focada em estética pet que ajuda a transformar clientes avulsos em planos de assinatura mensal recorrente (o famoso Clube do Banho). Nosso sistema cobra o tutor mensalmente no cartão e automatiza o agendamento da semana, preenchendo as vagas ociosas da sua tosa e gerando caixa previsível. Topa conhecer como outros parceiros aumentaram o lucro mensal em 25% com isso?`;
    } else if (lead.segment === 'Creche Canina') {
      simulatedScore = 9;
      simulatedAnalysis = `Creche/Daycare pet representa um público de altíssimo tíquete médio e fidelidade. O hotel pet em feriados sofre com picos de lotação e sazonalidade. O Pet Hub agregará valor automatizando a cobrança mensal das creches por recorrência de crédito e abrindo campanhas direcionadas pré-feriados para garantir lotação máxima da hotelaria com meses de antecedência.`;
      simulatedMsg = `Olá pessoal do ${lead.name}! Que trabalho incrível vocês fazem na socialização e bem-estar dos cães, a estrutura de daycare é fantástica! Sei que gerenciar pacotes mensais de creche, controle de vacinas obrigatórias na entrada e reservas de hotelaria exige um controle minucioso. O Pet Hub automatiza todo o financeiro recorrente da creche e cria disparos automáticos inteligentes de reservas para feriados, garantindo que o seu hotel lote semanas antes das férias. Que tal agendarmos uma demonstração rápida de 10 minutos para mostrarmos o painel em ação?`;
    } else {
      simulatedScore = 7;
      simulatedAnalysis = `Pet shop com forte apelo a rações e acessórios. Enfrenta a forte concorrência de grandes e-commerces pet. A solução do Pet Hub ajudará o estabelecimento a reter clientes locais criando disparos inteligentes pós-venda (ex: alertar o cliente quando a ração que ele comprou está perto de acabar e sugerir reposição rápida por WhatsApp com entrega local).`;
      simulatedMsg = `Olá! Tudo bem no ${lead.name}? Parabéns pela belíssima variedade de produtos pet que vocês oferecem aos tutores! Sabemos que a competição com os grandes e-commerces pet é difícil. Por isso, criamos o Pet Hub: um sistema que monitora a compra de ração do seu cliente de bairro e envia um lembrete automático de recompra rápida pelo WhatsApp exatamente 25 dias depois, com entrega expressa da sua loja. Isso blinda seus clientes contra a concorrência e recupera vendas perdidas. Toparia fazer um teste gratuito de 7 dias com nosso sistema?`;
    }

    const _aiScore = simulatedScore * 10;
    qualifiedFields = {
      score: simulatedScore,
      ai_score: _aiScore,
      ai_temperatura: _aiScore >= 70 ? 'quente' : _aiScore >= 40 ? 'morno' : 'frio',
      ai_resumo: `${lead.name} — potencial ${_aiScore >= 70 ? 'alto' : _aiScore >= 40 ? 'médio' : 'baixo'} de conversão`,
      ai_motivo: `Lead ${lead.segment.toLowerCase()} com perfil compatível para automação Pet Hub`,
      proxima_acao: 'Enviar mensagem de abordagem personalizada via WhatsApp',
      claude_analysis: simulatedAnalysis,
      suggested_message: simulatedMsg,
      status: 'Qualificado',
      updatedAt: new Date().toISOString()
    };
  } else {
    // --- REAL AI MODE via serviço centralizado (OpenRouter ou Claude) ---
    try {
      console.log(`[AI Service] Qualificando lead "${lead.name}"...`);

      const aiResult = await qualifyLead(lead);
      const proximaAcao = suggestNextAction(lead);
      qualifiedFields = {
        score:             aiResult.score,
        ai_score:          aiResult.ai_score,
        ai_temperatura:    aiResult.ai_temperatura,
        ai_resumo:         aiResult.ai_resumo,
        ai_motivo:         aiResult.ai_motivo,
        claude_analysis:   aiResult.claude_analysis,
        suggested_message: aiResult.suggested_message,
        proxima_acao:      proximaAcao,
        status:            'Qualificado',
        updatedAt:         new Date().toISOString()
      };

    } catch (e) {
      console.error('[AI Service Error]', e);
      throw new Error(`Erro na IA: ${e.message}`);
    }
  }

  // Update in Database or local cache
  if (supabase) {
    console.log(`[Supabase] Salvando qualificação do lead ${leadId} em nuvem...`);
    const { data, error } = await supabase
      .from('leads')
      .update({
        score:             qualifiedFields.score,
        ai_score:          qualifiedFields.ai_score,
        ai_temperatura:    qualifiedFields.ai_temperatura,
        ai_resumo:         qualifiedFields.ai_resumo,
        ai_motivo:         qualifiedFields.ai_motivo,
        claude_analysis:   qualifiedFields.claude_analysis,
        suggested_message: qualifiedFields.suggested_message,
        proxima_acao:      qualifiedFields.proxima_acao,
        status:            qualifiedFields.status,
        updated_at:        qualifiedFields.updatedAt
      })
      .eq('id', leadId)
      .select();

    if (error) throw error;
    
    return {
      ...data[0],
      updatedAt: data[0].updated_at
    };
  } else {
    leads[idx] = {
      ...lead,
      ...qualifiedFields
    };
    await writeLocalLeads(leads);
    return leads[idx];
  }
}

// Qualify lead endpoint
app.post('/api/leads/qualify', async (req, res) => {
  const { leadId } = req.body;

  if (!leadId) {
    return res.status(400).json({ error: 'ID do lead é obrigatório.' });
  }

  try {
    const result = await qualifyLeadById(leadId);
    res.json(result);
  } catch (error) {
    console.error('[Qualify Endpoint Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// --- APPROACH LEAD HELPER ---
// Marks a Qualificado lead as Abordado AND sends the WhatsApp message via Evolution API
async function approachLeadById(leadId) {
  const leads = await readLeads();
  const idx = leads.findIndex(l => l.id === leadId);
  if (idx === -1) throw new Error('Lead não encontrado.');

  const lead = leads[idx];
  if (lead.status !== 'Qualificado') throw new Error('Lead não está na etapa Qualificado.');

  const timestamp = new Date().toISOString();
  console.log(`[Autopilot] Abordando lead "${lead.name}" via WhatsApp...`);

  // Send WhatsApp message if phone is available
  let whatsappSent = false;
  let whatsappError = null;
  if (lead.phone && lead.suggested_message && !lead.suggested_message.includes('Mensagem sugerida indisponível')) {
    try {
      const sendResult = await sendWhatsAppMessage(lead.phone, lead.suggested_message);
      whatsappSent = !sendResult.skipped;
      console.log(`[Evolution API] Status envio para ${lead.name}: ${whatsappSent ? 'ENVIADO' : 'PULADO'}`);
    } catch (e) {
      whatsappError = e.message;
      console.error(`[Evolution API] Falha ao enviar para ${lead.name}:`, e.message);
    }
  } else {
    console.log(`[Autopilot] Lead "${lead.name}" sem telefone ou mensagem gerada, apenas marcando como Abordado.`);
  }

  const updatedFields = {
    status: 'Abordado',
    updated_at: timestamp,
    updatedAt: timestamp
  };

  if (supabase) {
    const { data, error } = await supabase
      .from('leads')
      .update({ status: 'Abordado', updated_at: timestamp, last_contact_at: timestamp, follow_up_count: 0 })
      .eq('id', leadId)
      .select();
    if (error) throw error;
    return { ...data[0], updatedAt: data[0].updated_at, whatsappSent, whatsappError };
  } else {
    leads[idx] = { ...lead, ...updatedFields, last_contact_at: timestamp, follow_up_count: 0 };
    await writeLocalLeads(leads);
    return leads[idx];
  }
}

// Approach lead endpoint
app.post('/api/leads/approach', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'ID do lead é obrigatório.' });
  try {
    const result = await approachLeadById(leadId);
    res.json(result);
  } catch (error) {
    console.error('[Approach Endpoint Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// --- MOVE TO HUMAN HELPER ---
// Moves Abordado leads to "Para humano" so a real person can close the deal
async function moveToHumanById(leadId) {
  const leads = await readLeads();
  const idx = leads.findIndex(l => l.id === leadId);
  if (idx === -1) throw new Error('Lead não encontrado.');

  const lead = leads[idx];
  if (lead.status !== 'Abordado') throw new Error('Lead não está na etapa Abordado.');

  const timestamp = new Date().toISOString();
  console.log(`[Autopilot] Movendo lead "${lead.name}" para "Para humano" — pronto para fechamento!`);

  if (supabase) {
    const { data, error } = await supabase
      .from('leads')
      .update({ status: 'Para humano', updated_at: timestamp })
      .eq('id', leadId)
      .select();
    if (error) throw error;
    return { ...data[0], updatedAt: data[0].updated_at };
  } else {
    leads[idx] = { ...lead, status: 'Para humano', updated_at: timestamp, updatedAt: timestamp };
    await writeLocalLeads(leads);
    return leads[idx];
  }
}

// --- AUTOPILOT AI CONFIGS & BACKGROUND TIMER ---
let autopilotActive = false;

app.get('/api/config/autopilot', (req, res) => {
  res.json({ active: autopilotActive });
});

app.post('/api/config/autopilot', (req, res) => {
  const { active } = req.body;
  if (typeof active === 'boolean') {
    autopilotActive = active;
    console.log(`[Autopilot] Estado alterado para: ${autopilotActive ? 'ATIVO' : 'INATIVO'}`);
  }
  res.json({ active: autopilotActive });
});

// Autopilot Interval Worker — Full pipeline: Descoberto → Qualificado → Abordado → Para humano
setInterval(async () => {
  if (!autopilotActive) return;
  try {
    const leads = await readLeads();

    // STAGE 1: Qualify up to 20 Descoberto leads in parallel
    const toQualify = leads.filter(l => l.status === 'Descoberto').slice(0, 20);
    if (toQualify.length > 0) {
      console.log(`[Autopilot] STAGE 1 — Qualificando ${toQualify.length} leads...`);
      await Promise.all(toQualify.map(l => qualifyLeadById(l.id).catch(err =>
        console.error(`[Autopilot] Falha qualificação ${l.name}:`, err.message)
      )));
    }

    // Reload leads after stage 1 mutations
    const leads2 = await readLeads();

    // STAGE 2: Approach up to 20 Qualificado leads in parallel
    const toApproach = leads2.filter(l => l.status === 'Qualificado').slice(0, 20);
    if (toApproach.length > 0) {
      console.log(`[Autopilot] STAGE 2 — Abordando ${toApproach.length} leads...`);
      await Promise.all(toApproach.map(l => approachLeadById(l.id).catch(err =>
        console.error(`[Autopilot] Falha abordagem ${l.name}:`, err.message)
      )));
    }

    // Reload leads after stage 2 mutations
    const leads3 = await readLeads();

    // STAGE 3: Move up to 20 Abordado leads to "Para humano" (human closes the deal)
    const toHuman = leads3.filter(l => l.status === 'Abordado').slice(0, 20);
    if (toHuman.length > 0) {
      console.log(`[Autopilot] STAGE 3 — Movendo ${toHuman.length} leads para "Para humano"...`);
      await Promise.all(toHuman.map(l => moveToHumanById(l.id).catch(err =>
        console.error(`[Autopilot] Falha mover para humano ${l.name}:`, err.message)
      )));
    }

  } catch (e) {
    console.error('[Autopilot Backend Error]', e.message);
  }
}, 60000);

// ─── AI INTELLIGENCE MODULE ─────────────────────────────────────────────────

// Analisa conversa do WhatsApp em background após nova mensagem recebida
async function triggerConversationAnalysis(phone) {
  if (!hasAIKeys()) return; // Sem chaves de IA, pula análise
  const [leads, messages] = await Promise.all([readLeads(), readMessages()]);
  const lead = leads.find(l => l.phone && sanitizePhone(l.phone) === sanitizePhone(phone));
  if (!lead) return;

  const convMsgs = messages
    .filter(m => sanitizePhone(m.phone) === sanitizePhone(phone))
    .slice(0, 30);

  const analysis = await analyzeConversation(lead, convMsgs);
  const updates  = {
    conversation_analysis: JSON.stringify(analysis),
    proxima_acao:         analysis.proximaAcao,
    last_contact_at:      new Date().toISOString()
  };

  if (analysis.shouldMove && analysis.newStage) {
    updates.status = analysis.newStage;
    console.log(`[AI] Auto-movendo "${lead.name}" → "${analysis.newStage}" (análise de conversa)`);
  }

  await updateLeadInDB(lead.id, updates);
}

// POST /api/leads/generate-message — Gera primeira mensagem personalizada
app.post('/api/leads/generate-message', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'leadId é obrigatório.' });

  try {
    const leads = await readLeads();
    const lead  = leads.find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });

    let message;
    if (!hasAIKeys()) {
      // Modo simulação: retorna mensagem sugerida existente ou default
      message = lead.suggested_message && !lead.suggested_message.includes('indisponível')
        ? lead.suggested_message
        : `Olá, equipe do ${lead.name}! Somos da Pet Hub, plataforma de automação para ${lead.segment.toLowerCase()}. Gostariam de conhecer como ajudamos negócios pet a automatizarem agendamentos e comunicação com tutores via WhatsApp? Uma rápida demonstração de 10 minutos pode transformar a gestão do seu negócio!`;
    } else {
      const messages = await readMessages();
      const history  = lead.phone
        ? messages.filter(m => sanitizePhone(m.phone) === sanitizePhone(lead.phone))
        : [];
      message = await generateApproachMessage(lead, history);
    }

    // Salva mensagem gerada no lead
    await updateLeadInDB(leadId, { suggested_message: message });

    res.json({ success: true, message });
  } catch (e) {
    console.error('[Generate Message Error]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/qr — Retorna QR code da instância Evolution para conexão
app.get('/api/whatsapp/qr', async (req, res) => {
  if (!evolutionBaseUrl || !evolutionApiKey) {
    return res.status(503).json({ error: 'Evolution API não configurada.' });
  }
  try {
    const r = await fetch(`${evolutionBaseUrl}/instance/connect/${evolutionInstance}`, {
      headers: { 'apikey': evolutionApiKey }
    });
    const data = await r.json();

    // Já conectado
    if (data.instance?.state === 'open' || data.state === 'open') {
      return res.json({ status: 'connected', number: data.instance?.ownerJid || null });
    }

    // QR como base64 (Evolution v1)
    if (data.base64) return res.json({ status: 'qr', qr: data.base64 });

    // QR como code string (Evolution v2) — devolve o texto puro para o frontend renderizar
    if (data.code) return res.json({ status: 'qr', code: data.code });

    res.json({ status: data.instance?.state || 'unknown' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/status — Status da conexão WhatsApp
app.get('/api/whatsapp/status', async (req, res) => {
  if (!evolutionBaseUrl || !evolutionApiKey) {
    return res.json({ connected: false, reason: 'não configurado' });
  }
  try {
    const r = await fetch(`${evolutionBaseUrl}/instance/connectionState/${evolutionInstance}`, {
      headers: { 'apikey': evolutionApiKey }
    });
    const data = await r.json();
    const state = data.instance?.state || data.state || 'unknown';
    res.json({ connected: state === 'open', state, number: data.instance?.ownerJid || null });
  } catch (e) {
    res.status(500).json({ connected: false, error: e.message });
  }
});

// POST /api/whatsapp/analyze — Analisa conversa e retorna insights + move lead
app.post('/api/whatsapp/analyze', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone é obrigatório.' });

  try {
    const [leads, messages] = await Promise.all([readLeads(), readMessages()]);
    const lead = leads.find(l => l.phone && sanitizePhone(l.phone) === sanitizePhone(phone));
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado para este número.' });

    const convMsgs = messages
      .filter(m => sanitizePhone(m.phone) === sanitizePhone(phone))
      .slice(0, 30);

    const analysis = await analyzeConversation(lead, convMsgs);
    const updates  = {
      conversation_analysis: JSON.stringify(analysis),
      proxima_acao:         analysis.proximaAcao
    };

    if (analysis.shouldMove && analysis.newStage) {
      updates.status = analysis.newStage;
    }

    const updated = await updateLeadInDB(lead.id, updates);
    res.json({ analysis, lead: updated });
  } catch (e) {
    console.error('[Analyze Error]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai/stats — Métricas de uso da IA + distribuição de temperatura
app.get('/api/ai/stats', async (req, res) => {
  try {
    const [aiStats, leads] = await Promise.all([
      Promise.resolve(getAIStats()),
      readLeads()
    ]);

    const analyzed   = leads.filter(l => l.ai_temperatura).length;
    const quentes    = leads.filter(l => l.ai_temperatura === 'quente').length;
    const mornos     = leads.filter(l => l.ai_temperatura === 'morno').length;
    const frios      = leads.filter(l => l.ai_temperatura === 'frio').length;
    const converted  = leads.filter(l => l.status === 'Convertido').length;
    const followedUp = leads.filter(l => (l.follow_up_count || 0) > 0).length;
    const taxaResposta = analyzed > 0
      ? Math.round((leads.filter(l => l.conversation_analysis).length / analyzed) * 100)
      : 0;

    res.json({
      ...aiStats,
      leads: { analyzed, quentes, mornos, frios, converted, followedUp, taxaResposta }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FOLLOW-UP AUTOMÁTICO (verifica a cada 30 minutos) ──────────────────────
setInterval(async () => {
  if (!autopilotActive || !hasAIKeys()) return;
  try {
    const leads = await readLeads();
    const now   = new Date();

    const eligible = leads.filter(l =>
      (l.status === 'Abordado' || l.status === 'Em conversa') &&
      l.last_contact_at &&
      (l.follow_up_count || 0) < 3 &&
      l.phone
    );

    for (const lead of eligible) {
      const lastContact  = new Date(lead.last_contact_at);
      const hoursSince   = (now - lastContact) / (1000 * 60 * 60);
      const followupDone = lead.follow_up_count || 0;

      let doFollowUp = false;
      const nextAttempt = followupDone + 1;

      if      (followupDone === 0 && hoursSince >= 24)  doFollowUp = true;
      else if (followupDone === 1 && hoursSince >= 72)  doFollowUp = true;
      else if (followupDone === 2 && hoursSince >= 168) doFollowUp = true;

      if (!doFollowUp) continue;

      try {
        const allMsgs  = await readMessages();
        const history  = allMsgs.filter(m => sanitizePhone(m.phone) === sanitizePhone(lead.phone));
        const followMsg = await generateFollowUp(lead, nextAttempt, history);

        await sendWhatsAppMessage(lead.phone, followMsg);
        await saveMessage({
          id:        `msg-${Date.now()}-fu${nextAttempt}`,
          phone:     sanitizePhone(lead.phone) || lead.phone,
          name:      'Pet Hub',
          direction: 'out',
          content:   followMsg,
          timestamp: now.toISOString()
        });

        await updateLeadInDB(lead.id, {
          follow_up_count: nextAttempt,
          last_contact_at: now.toISOString()
        });

        console.log(`[Follow-up] #${nextAttempt} enviado para "${lead.name}"`);
      } catch (e) {
        console.error(`[Follow-up Error] ${lead.name}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Follow-up Scheduler Error]', e.message);
  }
}, 30 * 60 * 1000);

// --- LOAD CLIENT APPLICATION ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Port listener
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🐾 Pet Hub - Leads rodando com sucesso na porta ${PORT}!`);
  console.log(`🔗 Acesse no navegador: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
