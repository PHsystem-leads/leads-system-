# 🐾 Pet Hub - Detalhes do Projeto e Identidade Visual

Este documento serve como a principal fonte da verdade para o **Pet Hub**, detalhando sua essência, arquitetura visual e posicionamento de marca. Ele foi projetado para instruir modelos de IA (como Claude) na geração de ideias, estratégias de marketing, social media, redação e design.

---

## 🚀 O Projeto

**Nome:** Pet Hub
**Modelo de Negócios:** SaaS (Software as a Service) B2B.
**Público-alvo:** Pet Shops, Clínicas Veterinárias, Hospitais Veterinários e profissionais do nicho pet.

### A Proposta de Valor
O Pet Hub não é apenas um sistema de gestão; é o núcleo operacional de negócios do setor pet. Ele transforma processos analógicos e difusos em uma operação elegante, eficiente e digital.

**Planos de Assinatura:**
- **Hub Basic**: Focado em operações em crescimento, recursos essenciais.
- **Hub Pro**: Focado em operações completas (clínicas/hospitais), recursos avançados.

---

## 🪐 Identidade Visual e UI/UX

A estética do Pet Hub é propositalmente projetada para se afastar dos sistemas cinzas e monótonos do passado. A interface não é apenas uma ferramenta, é uma experiência premium, psicologicamente engajadora e "viciante".

### 1. Sistema de Cores
A paleta principal baseia-se em tons profundos e vibrantes de roxo, proporcionando uma sensação imediata de modernidade, tecnologia e qualidade premium.

**Cor Primária (Brand):**
- Principal: `#5B2E88` (Roxo denso e elegante)
- Alternativa/Hover: `#6A3B99`
- Fundo Escuro (Dark Mode): `#0e0d21` a `#08071a` (Espaço sideral profundo)

**Cores de Status (Feedback Visual):**
- Sucesso: `#16A34A` (Verde)
- Aviso: `#D97706` (Laranja)
- Perigo / Erro: `#DC2626` (Vermelho)

### 2. Tipografia
Usamos fontes modernas do Google Fonts que equilibram legibilidade de dados com impacto de marca:
- **Fontes de Marca/Headings (`font-brand`):** `Outfit` — usada para títulos, h1, h2, h3, garantindo um visual contemporâneo e arredondado/tecnológico.
- **Fontes de Interface (`font-sans`):** `Inter` — usada para inputs, tabelas, dashboards e textos longos por sua legibilidade excepcional.

### 3. Estética do Produto (Diretrizes de Design)
- **Glassmorphism (Efeito Vidro):** Uso de cartões com fundo translúcido (ex: `bg-white/70` no light mode, `bg-[#12112d]/70` no dark mode), backdrop filters e bordas suaves (`border-white/20`).
- **High-Intensity UI:** O design foge do cinza neutro. Interfaces possuem presença vibrante.
- **Neon e Glow:** Uso de bordas permanentes com cores neon e contêineres coloridos com alta saturação (25-45% de opacidade) combinados com glows (brilhos) externos para destacar métricas e funcionalidades.
- **Dark Mode First:** Toda a identidade foi pensada para brilhar no modo escuro, conferindo um ar luxuoso, de "painel de controle do futuro".

---

## 📱 Marketing e Social Media (Instruções para o Claude)

Ao gerar conteúdo para o Pet Hub, você deve focar nos seguintes pilares:

### Tom de Voz
- **Autoridade e Sofisticação:** Comunicação inteligente, direta, sem usar clichês infantis do mundo pet (evitar excessos de "au au", "miau"). Fale de negócios, crescimento e controle.
- **Tecnologia e Futuro:** Posicionar o Pet Hub como uma revolução no mercado B2B veterinário. A plataforma é avançada, o marketing deve soar avançado.
- **Engajador e Minimalista:** Textos curtos, com excelente ritmo, voltados para conversão e percepção de alto valor.

### Diretrizes Criativas para Automação
A arquitetura do Pet Hub inclui um pipeline para a geração automática de peças de Social Media a partir de carrosséis em HTML (usando renderização via *headless browser*).
- **Consistência:** Todo o material gerado precisa espelhar a UI do produto: uso da fonte *Outfit*, cores escuras de fundo (`#08071a`), e detalhes texturizados ou em neon no roxo da marca (`#5B2E88`).
- **Design Ready:** Postagens focam em mostrar o "ecossistema" Pet Hub (ex: dashboards voando, painéis estatísticos brilhando).

### O "Cheat Sheet" do Prompter
*Quando pedir algo para o Claude sobre o Pet Hub, contextualize com:*
> "Aja como o Diretor de Marketing do Pet Hub, um SaaS Premium para Clínicas Veterinárias. O layout usa Glassmorphism, Dark Mode forte e tons roxos (#5B2E88). Crie a cópia para..."
