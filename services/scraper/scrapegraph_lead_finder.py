"""
Script de Prospecção em Lote de Pet Shops com ScrapeGraphAI para Pet Hub System.

Uso via CLI:
    # Busca em Lote por palavra-chave / cidade na web:
    python scrapegraph_lead_finder.py --mode search --query "Pet Shop" --location "São Paulo - SP" --limit 5

    # Extração de URL individual:
    python scrapegraph_lead_finder.py --mode url --url "https://petpaulista.com.br"

    # Extração de Lote de URLs:
    python scrapegraph_lead_finder.py --mode batch_urls --json '{"urls": ["https://petpaulista.com.br", "https://bbpetzone.com.br"]}'
"""

import sys
import os
import argparse
import json
from dotenv import load_dotenv

# Carrega variáveis de ambiente do .env da raiz do projeto se existir
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
dotenv_path = os.path.join(root_dir, ".env")
if os.path.exists(dotenv_path):
    load_dotenv(dotenv_path)
else:
    load_dotenv()

# Patch de compatibilidade para ScrapeGraphAI + LangChain Community
try:
    import langchain_community.chat_models
    try:
        from langchain_ollama import ChatOllama
        sys.modules['langchain_community.chat_models'].ChatOllama = ChatOllama
    except Exception:
        class DummyChatOllama: pass
        sys.modules['langchain_community.chat_models'].ChatOllama = DummyChatOllama
except Exception:
    pass

DEFAULT_PROMPT = """
Extraia todas as informações disponíveis sobre os estabelecimentos e empresas pet nesta busca/página.
Retorne um objeto com os seguintes campos para cada lead/empresa pet encontrada:
- name: Nome do negócio ou pet shop
- phone: Telefone ou número de WhatsApp para contato
- email: E-mail comercial de contato (se houver)
- address: Endereço físico completo da loja ou clínica (se houver)
- city: Cidade e Estado (ex: São Paulo - SP)
- instagram: Perfil ou link do Instagram (ex: @loja_pet ou URL)
- segment: Categoria exata (escolha uma: "Pet Shop", "Clínica Veterinária", "Banho e Tosa", "Creche Canina", "Adestrador", ou "Outros")
- services: Lista curta dos serviços oferecidos (ex: ["Banho", "Tosa", "Consultas", "Rações"])
- bio_description: Breve descrição das atividades ou slogan do estabelecimento
- sales_notes: Observação curta para abordagem comercial de venda de software de gestão Pet Hub (ex: indica agendamento via WhatsApp, possui banho e tosa próprio, etc)

Caso um campo não esteja disponível, defina como null.
"""

def get_llm():
    """Configura o modelo de linguagem (OpenRouter, OpenAI ou Anthropic)"""
    openrouter_key = os.getenv("OPENROUTER_API_KEY")
    openai_key = os.getenv("OPENAI_API_KEY")
    model_name = os.getenv("OPENROUTER_MODEL", "openrouter/free").strip()

    if openrouter_key:
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model_name,
            api_key=openrouter_key,
            base_url="https://openrouter.ai/api/v1",
            temperature=0,
        )
    elif openai_key:
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model="gpt-4o-mini",
            api_key=openai_key,
            temperature=0,
        )
    else:
        raise ValueError("Nenhuma chave de API de IA encontrada (OPENROUTER_API_KEY ou OPENAI_API_KEY no .env)")

def extract_single_url(url: str, custom_prompt: str = None) -> dict:
    """Extrai informações de uma única URL usando SmartScraperGraph"""
    from scrapegraphai.graphs import SmartScraperGraph

    llm = get_llm()
    prompt = custom_prompt if custom_prompt else DEFAULT_PROMPT

    graph_config = {
        "llm": {
            "model_instance": llm,
            "model_tokens": 128000,
        },
        "verbose": False,
        "headless": True,
    }

    scraper = SmartScraperGraph(
        prompt=prompt,
        source=url,
        config=graph_config
    )

    result = scraper.run()
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except Exception:
            result = {"raw_response": result}

    if isinstance(result, dict):
        result["_source_url"] = url

    return result

def search_batch_web(query: str, location: str, limit: int = 5, custom_prompt: str = None) -> list:
    """Realiza busca inteligente de pet shops na web em lote usando SearchGraph"""
    from scrapegraphai.graphs import SearchGraph

    llm = get_llm()
    search_prompt = f"""
    Pesquise na web por estabelecimentos do segmento '{query or 'Pet Shop'}' localizados em '{location or 'Brasil'}'.
    Encontre {limit} estabelecimentos diferentes e extraia para cada um:
    - name: nome da loja / empresa pet
    - phone: telefone ou whatsapp
    - email: email de contato
    - address: endereço completo
    - city: cidade e estado ({location or 'Brasil'})
    - instagram: instagram / rede social
    - segment: categoria pet
    - services: lista de serviços oferecidos
    - bio_description: resumo da loja
    - sales_notes: observações comerciais para vender sistema Pet Hub
    """
    if custom_prompt:
        search_prompt += f"\n\nInstruções adicionais: {custom_prompt}"

    graph_config = {
        "llm": {
            "model_instance": llm,
            "model_tokens": 128000,
        },
        "max_results": limit,
        "verbose": False,
        "headless": True,
    }

    try:
        search_graph = SearchGraph(
            prompt=search_prompt,
            config=graph_config
        )
        raw_result = search_graph.run()

        if isinstance(raw_result, str):
            try:
                raw_result = json.loads(raw_result)
            except Exception:
                raw_result = [raw_result]

        # Normaliza formato retornado
        if isinstance(raw_result, dict):
            # Procura chaves como 'pet_shops', 'leads', 'results', ou lista de valores
            for k, v in raw_result.items():
                if isinstance(v, list) and len(v) > 0:
                    return v
            return [raw_result]
        elif isinstance(raw_result, list):
            return raw_result
        return []
    except Exception as e:
        sys.stderr.write(f"SearchGraph error: {e}\n")
        raise e

def scrape_batch_urls(urls: list, custom_prompt: str = None) -> list:
    """Raspagem paralela ou sequencial de uma lista de URLs usando ScrapeGraphAI"""
    results = []
    for u in urls:
        try:
            res = extract_single_url(u, custom_prompt)
            results.append(res)
        except Exception as e:
            results.append({"_source_url": u, "error": str(e), "name": f"Erro ({u})"})
    return results

def main():
    parser = argparse.ArgumentParser(description="ScrapeGraphAI Batch Pet Shop Lead Finder")
    parser.add_argument("--mode", type=str, choices=["url", "batch_urls", "search"], default="url", help="Modo de execução")
    parser.add_argument("--url", type=str, help="URL individual")
    parser.add_argument("--query", type=str, help="Segmento / palavra-chave pet")
    parser.add_argument("--location", type=str, help="Cidade / localização")
    parser.add_argument("--limit", type=int, default=5, help="Quantidade limite no lote")
    parser.add_argument("--prompt", type=str, help="Prompt de extração customizado")
    parser.add_argument("--json", type=str, help="JSON com entrada completa")

    args = parser.parse_args()

    try:
        mode = args.mode
        prompt = args.prompt

        if args.json:
            input_data = json.loads(args.json)
            mode = input_data.get("mode", mode)
            prompt = input_data.get("prompt", prompt)

            if mode == "search":
                query = input_data.get("query", args.query or "Pet Shop")
                location = input_data.get("location", args.location or "São Paulo - SP")
                limit = int(input_data.get("limit", args.limit or 5))
                leads = search_batch_web(query, location, limit, prompt)
                print(json.dumps({"success": True, "mode": "search", "results": leads}, ensure_ascii=False))
            elif mode == "batch_urls":
                urls = input_data.get("urls", [])
                if isinstance(urls, str):
                    urls = [urls]
                results = scrape_batch_urls(urls, prompt)
                print(json.dumps({"success": True, "mode": "batch_urls", "results": results}, ensure_ascii=False))
            else:
                url = input_data.get("url", args.url)
                if not url:
                    raise ValueError("URL não especificada para modo 'url'.")
                lead = extract_single_url(url, prompt)
                print(json.dumps({"success": True, "mode": "url", "lead": lead}, ensure_ascii=False))

        elif mode == "search":
            query = args.query or "Pet Shop"
            location = args.location or "São Paulo - SP"
            limit = args.limit or 5
            leads = search_batch_web(query, location, limit, prompt)
            print(json.dumps({"success": True, "mode": "search", "results": leads}, ensure_ascii=False))

        elif mode == "batch_urls" and args.url:
            urls = [u.strip() for u in args.url.split(",") if u.strip()]
            results = scrape_batch_urls(urls, prompt)
            print(json.dumps({"success": True, "mode": "batch_urls", "results": results}, ensure_ascii=False))

        elif args.url:
            lead = extract_single_url(args.url, prompt)
            print(json.dumps({"success": True, "mode": "url", "lead": lead}, ensure_ascii=False))

        else:
            # Fallback stdin JSON
            stdin_data = sys.stdin.read().strip()
            if stdin_data:
                input_data = json.loads(stdin_data)
                mode = input_data.get("mode", "url")
                prompt = input_data.get("prompt", DEFAULT_PROMPT)

                if mode == "search":
                    query = input_data.get("query", "Pet Shop")
                    location = input_data.get("location", "São Paulo - SP")
                    limit = int(input_data.get("limit", 5))
                    leads = search_batch_web(query, location, limit, prompt)
                    print(json.dumps({"success": True, "mode": "search", "results": leads}, ensure_ascii=False))
                elif mode == "batch_urls":
                    urls = input_data.get("urls", [])
                    results = scrape_batch_urls(urls, prompt)
                    print(json.dumps({"success": True, "mode": "batch_urls", "results": results}, ensure_ascii=False))
                else:
                    url = input_data.get("url")
                    if not url:
                        raise ValueError("URL não especificada no payload JSON.")
                    lead = extract_single_url(url, prompt)
                    print(json.dumps({"success": True, "mode": "url", "lead": lead}, ensure_ascii=False))
            else:
                parser.print_help()
                sys.exit(1)

    except Exception as e:
        error_res = {
            "success": False,
            "error": str(e)
        }
        print(json.dumps(error_res, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
