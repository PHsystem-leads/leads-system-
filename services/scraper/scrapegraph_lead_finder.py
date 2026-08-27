"""
Script de Extração de Leads com ScrapeGraphAI para Pet Hub System.

Uso via CLI:
    python scrapegraph_lead_finder.py --url "https://petpaulista.com.br"
    python scrapegraph_lead_finder.py --json '{"urls": ["https://petpaulista.com.br"], "prompt": "..."}'
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
Extraia todas as informações disponíveis sobre a empresa / pet shop nesta página.
Retorne um objeto JSON contendo os seguintes campos:
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

Caso algum campo não esteja visível no site, defina como null.
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

def extract_lead(url: str, custom_prompt: str = None) -> dict:
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

    result["_source_url"] = url
    return result

def main():
    parser = argparse.ArgumentParser(description="ScrapeGraphAI Lead Finder")
    parser.add_argument("--url", type=str, help="URL do site para extração")
    parser.add_argument("--prompt", type=str, help="Prompt de extração customizado")
    parser.add_argument("--json", type=str, help="JSON de entrada com urls e prompt")

    args = parser.parse_args()

    try:
        if args.json:
            input_data = json.loads(args.json)
            urls = input_data.get("urls", [])
            if isinstance(urls, str):
                urls = [urls]
            prompt = input_data.get("prompt", DEFAULT_PROMPT)
            results = []
            for u in urls:
                res = extract_lead(u, prompt)
                results.append(res)
            print(json.dumps({"success": True, "results": results}, ensure_ascii=False))
        elif args.url:
            res = extract_lead(args.url, args.prompt)
            print(json.dumps({"success": True, "lead": res}, ensure_ascii=False))
        else:
            # Tentar ler da entrada padrão (stdin) se nada foi passado por flag
            stdin_data = sys.stdin.read().strip()
            if stdin_data:
                input_data = json.loads(stdin_data)
                url = input_data.get("url")
                prompt = input_data.get("prompt", DEFAULT_PROMPT)
                if not url:
                    raise ValueError("URL não especificada no payload JSON.")
                res = extract_lead(url, prompt)
                print(json.dumps({"success": True, "lead": res}, ensure_ascii=False))
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
