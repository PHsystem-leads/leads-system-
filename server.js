import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

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
  supabase = createClient(supabaseUrl, supabaseAnonKey);
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

// --- API STATUS ENDPOINT ---
app.get('/api/status', (req, res) => {
  res.json({
    apify: !!process.env.APIFY_API_KEY,
    claude: !!process.env.CLAUDE_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY,
    openrouterModel: (process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat').trim().replace(/\.+$/, ''),
    supabase: !!supabase,
    evolutionApi: !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.EVOLUTION_INSTANCE),
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

    qualifiedFields = {
      score: simulatedScore,
      claude_analysis: simulatedAnalysis,
      suggested_message: simulatedMsg,
      status: 'Qualificado',
      updatedAt: new Date().toISOString()
    };
  } else if (openrouterKey) {
    // --- REAL OPENROUTER INTEGRATION ---
    try {
      console.log(`[OpenRouter API] Qualificando lead pet ${lead.name} via ${openrouterModel}...`);

      const prompt = `Você é a inteligência artificial da Pet Hub, uma plataforma SaaS de automação de marketing e CRM para empresas pet (clínicas veterinárias, pet shops, banho e tosa, creches, adestradores).
Seu objetivo é analisar as informações do seguinte lead e retornar:
1. Uma qualificação crítica de 0 a 10 de quão atraente este lead é para contratar a Pet Hub.
2. Uma análise sucinta de dor/oportunidade do negócio em português de até 3 frases.
3. Um script de mensagem de primeira abordagem (cold approach) no WhatsApp/Instagram em português extremamente personalizada, persuasiva, amigável e profissional. Use o nome do estabelecimento e os dados fornecidos (como número de avaliações, seguidores, bio, ou localização) para soar autêntico e natural. A mensagem deve focar em propor uma demonstração de 10 minutos ou teste gratuito, destacando uma funcionalidade chave que resolva o problema do segmento dele (Ex: lembrete de vacinas para clínicas; clube de assinatura recorrente para banho e tosa; recorrência de pacotes e reserva de hotel para creches; alerta de recompra automática de ração para pet shops de bairro).

DADOS DO LEAD PET:
- Nome do Estabelecimento: "${lead.name}"
- Plataforma de Origem: "${lead.platform}"
- Segmento Pet: "${lead.segment}"
- Instagram Handle / Localização: "${lead.handle}"
- Seguidores Instagram: ${lead.followers || 'Não informado'}
- Média Avaliação Google Maps: ${lead.rating || 'Não informado'}
- Número Avaliações Google Maps: ${lead.reviews || 'Não informado'}
- Telefone de Contato: "${lead.phone || 'Não informado'}"
- E-mail: "${lead.email || 'Não informado'}"
- Endereço / Cidade: "${lead.address || 'Não informado'}"
- Biografia / Descrição: "${lead.bio || 'Não informado'}"

FORMATO DA SUA RESPOSTA:
Sua resposta deve ser estruturada EXATAMENTE em formato JSON puro, sem blocos de código markdown (\`\`\`json ... \`\`\`), apenas o objeto JSON com as chaves "score" (inteiro de 0 a 10), "claude_analysis" (string com a análise em português) e "suggested_message" (string com a mensagem de cold approach em português).
Não adicione qualquer texto introdutório ou conclusivo.`;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://pethub-leads.vercel.app',
          'X-Title': 'Pet Hub Leads CRM'
        },
        body: JSON.stringify({
          model: openrouterModel,
          messages: [
            { role: 'user', content: prompt }
          ]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Erro na API do OpenRouter: ${errText}`);
      }

      const openrouterData = await response.json();
      const rawContent = openrouterData.choices[0].message.content;
      
      let parsedResult;
      try {
        let jsonString = rawContent;
        if (jsonString.includes('```json')) {
          jsonString = jsonString.split('```json')[1].split('```')[0].trim();
        } else if (jsonString.includes('```')) {
          jsonString = jsonString.split('```')[1].split('```')[0].trim();
        }
        parsedResult = JSON.parse(jsonString.trim());
      } catch (e) {
        const scoreMatch = rawContent.match(/"score":\s*(\d+)/);
        const analysisMatch = rawContent.match(/"claude_analysis":\s*"([^"]+)"/) || rawContent.match(/"analysis":\s*"([^"]+)"/);
        const messageMatch = rawContent.match(/"suggested_message":\s*"([^"]+)"/) || rawContent.match(/"message":\s*"([^"]+)"/);
        
        parsedResult = {
          score: scoreMatch ? parseInt(scoreMatch[1]) : 7,
          claude_analysis: analysisMatch ? analysisMatch[1].replace(/\\n/g, '\n') : 'Falha na formatação da análise.',
          suggested_message: messageMatch ? messageMatch[1].replace(/\\n/g, '\n') : 'Falha na formatação da abordagem.'
        };
      }

      qualifiedFields = {
        score: parsedResult.score || parsedResult.score === 0 ? parsedResult.score : 7,
        claude_analysis: parsedResult.claude_analysis || parsedResult.analysis || 'Qualificação realizada via OpenRouter.',
        suggested_message: parsedResult.suggested_message || parsedResult.message || 'Abordagem configurada via OpenRouter.',
        status: 'Qualificado',
        updatedAt: new Date().toISOString()
      };

    } catch (e) {
      console.error('[OpenRouter API Error]', e);
      throw new Error(`Erro na API do OpenRouter: ${e.message}`);
    }
  } else {
    // --- REAL CLAUDE INTEGRATION ---
    try {
      console.log(`[Claude API] Qualificando lead pet ${lead.name} via Anthropic...`);

      const prompt = `Você é a inteligência artificial da Pet Hub, uma plataforma SaaS de automação de marketing e CRM para empresas pet (clínicas veterinárias, pet shops, banho e tosa, creches, adestradores).
Seu objetivo é analisar as informações do seguinte lead e retornar:
1. Uma qualificação crítica de 0 a 10 de quão atraente este lead é para contratar a Pet Hub.
2. Uma análise sucinta de dor/oportunidade do negócio em português de até 3 frases.
3. Um script de mensagem de primeira abordagem (cold approach) no WhatsApp/Instagram em português extremamente personalizada, persuasiva, amigável e profissional. Use o nome do estabelecimento e os dados fornecidos (como número de avaliações, seguidores, bio, ou localização) para soar autêntico e natural. A mensagem deve focar em propor uma demonstração de 10 minutos ou teste gratuito, destacando uma funcionalidade chave que resolva o problema do segmento dele (Ex: lembrete de vacinas para clínicas; clube de assinatura recorrente para banho e tosa; recorrência de pacotes e reserva de hotel para creches; alerta de recompra automática de ração para pet shops de bairro).

DADOS DO LEAD PET:
- Nome do Estabelecimento: "${lead.name}"
- Plataforma de Origem: "${lead.platform}"
- Segmento Pet: "${lead.segment}"
- Instagram Handle / Localização: "${lead.handle}"
- Seguidores Instagram: ${lead.followers || 'Não informado'}
- Média Avaliação Google Maps: ${lead.rating || 'Não informado'}
- Número Avaliações Google Maps: ${lead.reviews || 'Não informado'}
- Telefone de Contato: "${lead.phone || 'Não informado'}"
- E-mail: "${lead.email || 'Não informado'}"
- Endereço / Cidade: "${lead.address || 'Não informado'}"
- Biografia / Descrição: "${lead.bio || 'Não informado'}"

FORMATO DA SUA RESPOSTA:
Sua resposta deve ser estruturada EXATAMENTE em formato JSON puro, sem blocos de código markdown (\`\`\`json ... \`\`\`), apenas o objeto JSON com as chaves "score" (inteiro de 0 a 10), "claude_analysis" (string com a análise em português) e "suggested_message" (string com a mensagem de cold approach em português).
Não adicione qualquer texto introdutório ou conclusivo.`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1200,
          messages: [
            { role: 'user', content: prompt }
          ]
        })
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        throw new Error(`Erro na API do Claude: ${errText}`);
      }

      const claudeData = await claudeRes.json();
      const rawContent = claudeData.content[0].text;
      
      let parsedResult;
      try {
        let jsonString = rawContent;
        if (jsonString.includes('```json')) {
          jsonString = jsonString.split('```json')[1].split('```')[0].trim();
        } else if (jsonString.includes('```')) {
          jsonString = jsonString.split('```')[1].split('```')[0].trim();
        }
        parsedResult = JSON.parse(jsonString.trim());
      } catch (e) {
        const scoreMatch = rawContent.match(/"score":\s*(\d+)/);
        const analysisMatch = rawContent.match(/"claude_analysis":\s*"([^"]+)"/);
        const messageMatch = rawContent.match(/"suggested_message":\s*"([^"]+)"/);
        
        parsedResult = {
          score: scoreMatch ? parseInt(scoreMatch[1]) : 7,
          claude_analysis: analysisMatch ? analysisMatch[1].replace(/\\n/g, '\n') : 'Falha na formatação da análise.',
          suggested_message: messageMatch ? messageMatch[1].replace(/\\n/g, '\n') : 'Falha na formatação da abordagem.'
        };
      }

      qualifiedFields = {
        score: parsedResult.score || 7,
        claude_analysis: parsedResult.claude_analysis || 'Qualificação realizada.',
        suggested_message: parsedResult.suggested_message || 'Abordagem configurada.',
        status: 'Qualificado',
        updatedAt: new Date().toISOString()
      };

    } catch (e) {
      console.error('[Claude API Error]', e);
      throw new Error(`Erro na API do Claude: ${e.message}`);
    }
  }

  // Update in Database or local cache
  if (supabase) {
    console.log(`[Supabase] Salvando qualificação do lead ${leadId} em nuvem...`);
    const { data, error } = await supabase
      .from('leads')
      .update({
        score: qualifiedFields.score,
        claude_analysis: qualifiedFields.claude_analysis,
        suggested_message: qualifiedFields.suggested_message,
        status: qualifiedFields.status,
        updated_at: qualifiedFields.updatedAt
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
      .update({ status: 'Abordado', updated_at: timestamp })
      .eq('id', leadId)
      .select();
    if (error) throw error;
    return { ...data[0], updatedAt: data[0].updated_at, whatsappSent, whatsappError };
  } else {
    leads[idx] = { ...lead, ...updatedFields };
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
