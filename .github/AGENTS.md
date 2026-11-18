# AGENTS.md — Guidelines for AI Agents / Contributors

This file defines coding conventions, architecture rules, and workflow
guidelines for the TicketScan repository.

---

## 📦 Project Overview

- **Name**: TicketScan (Pizzería La Esquina)
- **Type**: Monorepo (frontend static + FastAPI backend)
- **Architecture**: Multi-agent orchestration (Intake → Validator → Clarifier → Confirmer)
- **Language**: TypeScript/JavaScript (frontend), Python (backend)

---

## 🏗 Architecture

### Frontend
- **Static files**: `index.html`, `app.js`, `styles.css`
- **No build step**: served directly via HTTP
- **Communication**: WebSocket → `ws://localhost:8080/ws` (backend)

### Backend
- **FastAPI** + **WebSocket** (`backend/main.py`)
- **Agents**: `backend/agents/{intake,validator,clarifier,confirmer}_agent.py`
- **Orchestrator**: `backend/orchestrator/handoff.py`
- **Skills**: `backend/skills/catalog.py`

### Multi-agent flow
1. Orquestador recibe pedido → `orchestrator_decision`
2. Activación de agente → `agent_activate`
3. Skills ejecutadas → `skill_call` → `skill_result`
4. Handoff → siguiente agente
5. Resultado final → `confirmer` confirma pedido

---

## 📖 Coding Conventions

### Python (backend)
- **Style**: PEP 8
- **Linter**: `black` / `ruff` (optional)
- **Type hints**: recommended
- **Imports**:
  - Standard: `from typing import ...`
  - Third-party: `import fastapi`, `import pydantic`
  - Local: `from backend.agents.base import AgentBase`

### JavaScript (frontend)
- **Style**: no build, no framework, vanilla JS
- **Modules**: IIFE or plain script inclusion
- **No `import`**: files are loaded via `<script>` tags

---

## 📝 Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org):

```
feat: add new skill for order handling
fix: correct handoff logic in clarifier
docs: update development guide
test: add tests for menu service
```

---

## 🧹 Pull Request Checklist

- [ ] Code passes local tests
- [ ] Commits follow conventional commits
- [ ] No secrets or API keys
- [ ] Documentation updated if needed
- [ ] No `__pycache__` or `.pyc` files in commit
- [ ] No `node_modules` or other large directories

---

## 🔐 Secrets & Keys

- Never commit secrets to the repository
- Use `.env.example` as a template
- Keys should be stored in environment variables or a secrets manager

---

## 🚀 Deployment

- **Docker**: `docker/docker-compose.yml`
- **Branches**: `main` → production
- **Env vars**: `BUILD_APP`, `BACKEND_URL`, etc.

---

*Last updated: 2026-11-18*
