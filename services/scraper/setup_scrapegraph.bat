@echo off
echo ========================================================
echo   Configurando ambiente Python para ScrapeGraphAI
echo ========================================================

cd /d "%~dp0"

echo [1/4] Verificando versao do Python...
python --version
if errorlevel 1 (
    echo [ERRO] Python nao foi encontrado no PATH. Por favor instale o Python 3.10+ e tente novamente.
    exit /b 1
)

echo [2/4] Criando ambiente virtual Python (.venv)...
if not exist ".venv" (
    python -m venv .venv
)

echo [3/4] Instalando dependencias do requirements.txt...
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt

echo [4/4] Instalando navegadores Playwright (Chromium)...
playwright install chromium

echo ========================================================
echo   ScrapeGraphAI configurado com sucesso!
echo ========================================================
