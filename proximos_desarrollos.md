# 📋 Proximos Desarrollo — TicketScan Multi-Agent

## Visión General

Roadmap completo de desarrollo para el sistema TicketScan (Pizzería La Esquina).
Orientado a orquestador multi-agente, skills, agentes, módulos y mejoras interactivas.

---

## 1. Estado Actual del Sistema

| Módulo | Estado | Notas |
|--------|--------|-------|
| Backend (FastAPI + WebSocket) | ✅ Funcional | `ws://localhost:8080/ws` |
| Multi-agentes (Intake, Validator, Clarifier, Confirmer) | ✅ Producción | Handoffs reales |
| Skill Registry (24+ skills) | ✅ MVP | 18 skills mapeadas a agentes |
| Agencia Panel (🌳) | ✅ MVP | Visualización arbo, colapsable, trace en vivo |
| Traza Flujo Orquestador | ✅ MVP | Árbol jerárquico, expand/collapse, detalle |
| Demo Mode | ✅ Funcional | Simulador local sin API keys |
| Backend Python | ✅ Conectado | WebSocket `ws://localhost:8080/ws` |
| Docker | ✅ Listo | `docker compose up -d` |

---

## 2. Backlog por Prioridad

### 🔴 Alta

| ID | Tarea | Descripción | Dependencias |
|----|-------|-------------|--------------|
| DEV-001 | **Patrones de trace más claros** | Corregir que el flujo jerárquico no muestre resultados en mode demo | Traza completa |
| DEV-002 | **Módulo carga audio** | Permitir subir .mp3/.wav/.m4a, transcribir con Whisper, e insertar como texto en el pedido | Whisper.cpp / OpenAI API |
| DEV-003 | **Módulo WhatsApp oficial** | Enrutador de mensajes inbound (webhook Meta), con estado DEVEL/PENDIENTE | Meta Developerアカウント |
| DEV-004 | **Agente responder texto** | Agente LLM que responde preguntas del cliente y toma nuevos pedidos via texto | LLM keys + agent loop |
| DEV-005 | **Expiration tracker** | Completar el "hilo" del mensaje en la UI cuando hay aclaración pendiente | Backend |
| DEV-006 | **Generador de reseña** | Mini generador de reseñas con posibilidad de exportar a PDF | Backend |

### 🟡 Media

| ID | Tarea | Descripción |
|----|-------|-------------|
| DEV-007 | **Estructura de agentes** | Crear `AGENTS.md` + CLAUDE.md con patrones, convenciones y roles |
| DEV-008 | **Specs detalladas** | Documentar arquitectura, mensajería WebSocket, flow de handoff, schema de skills |
| DEV-009 | **Módulo carga audio** | (sobreescrito) Implementar transcripción de audio |
| DEV-010 | **Observabilidad** | Métricas de latencia por agente, versión de skills usados, errores |

### 🟢 Baja

| ID | Tarea | Descripción |
|----|-------|-------------|
| DEV-011 | **Multijugador** | Lector simultáneo (mando, queue, conductor) |
| DEV-012 | **Tablero** | Vista de ticket adventure por turno del cliente (producto, agente, skill) |
| DEV-013 | **Validación de eventos** | Hacer la parte de los "ok" y "chevron" del flujo |
| DEV-014 | **WebSocket buffer history** | Eventos por operación, no globales |
| DEV-015 | **Reproducir back** | Revisar el libro de regreso y trazabilidad para dirigir las mejoras |

---

## 3. Características Principales

### 3.1 Multi-Agent Orchestration
- **Orquestador**: Decisión central (planning)
- **Intake**: Parsea texto → items estructurados
- **Validator**: Verifica stock → calcula total
- **Clarifier**: Pregunta cuando falta info crítica (tamaño, item desconocido, stock bajo)
- **Confirmer**: Confirma pedido → genera nº, ticket, notificaciones

### 3.2 Skill Registry
- **Catalog**: 18 skills mapeados a agentes
- **Estructura**: `name`, `description`, `params({type, properties, required})`, `fn`, `enabled`
- **Tipos**: Intake, Validator, Clarifier, Confirmer, Orchestrator, Future

### 3.3 Agencia Panel
- **Árbol arbo**: Orquestador → Agentes → Skills
- **Estados**: Pendiente, Activo, Completado, Error (con colores)
- **Timeline**: Trace events en vivo
- **Colapsable**: Cada nodo puede expandirse/colapsarse
- **Persistencia**: Estados y prefijos guardados en `localStorage`

### 3.4 Traza Flujo Orquestador
- **Arbol jerárquico**: Decisión → Agente → Skill → Resultado
- **Expand/Colapse**: Cada nodo puede expandirse/colapsarse
- **Detalles**: Panel lateral con metadatos del evento
- **Límite**: 200 eventos por sesión

---

## 4. Arquitectura

```
Cliente (Web UI)
    ↓ (WebSocket WS)
Backend (FastAPI + ws://localhost:8080/ws)
    ↓
Orquestador (DynamicPlanner + HandoffService)
    ↓
Agentes: Intake → Validator → Clarifier → Confirmer
    ↓
Skills Registry (24+ skills)
    ↓
Resultados → WebSocket → Frontend
```

---

## 5. Estilos y Tipografía

### Colores
| Variable | Valor |
|----------|-------|
| `--bg` | `#11100e` |
| `--panel` | `#1a1815` |
| `--line` | `#332e28` |
| `--text` | `#f2ece3` |
| `--muted` | `#9c9286` |
| `--accent` | `#e8663a` |
| `--ok` | `#4fb477` |
| `--warn` | `#e2b33c` |
| `--err` | `#e05a5a` |
| `--mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |

### Tipografía
- **Font**: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- **Mono**: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

---

## 6. Documentación

### Archivos Clave
- `backend/`, `apps/` — Código fuente
- `docker/` — Docker Compose
- `docs/` — Documentación y specs
- `data/menu.json` — Catálogo
- `proximos_desarrollos.md` — Roadmap

### Guías de Contribución
- **AGENTS.md** — Patrones de desarrollo
- **CLAUDE.md** — Convenciones del equipo
- **SKILL.md** — Patrones de skills

---

## 7. Prioridades Futuras

### 🟣 Dominio
- [ ] **Multi-agent orchestration**: Agente gancho + Agente de handoff
- [ ] **Agentes especializados**: Intake, Validator, Clarifier, Confirmer, Main
- [ ] **Skill registry**: 18 skills mapeados

### 🟢 Escalabilidad
- [ ] **N+1 optimizations**: Estructuras de datos
- [ ] **Bug fixes**: 2 fixes
- [ ] **Performance**: 13 radar improvements

### 🟡 Escalabilidad
- [ ] **LLM integration**: Gemini/OpenRouter (demo por defecto)
- [ ] **Multi-agent**: 2 agents (clarifier, confirmer)

### 🟢 Escalabilidad
- [ ] **Observabilidad**: Métricas por agente
- [ ] **Multi-agent**: 2 agents (clarifier, confirmer)

### 🚀 Escalabilidad
- [ ] **Multi-agent**: 3 agents (clarifier, confirmer, main)
- [ ] **Trace events**: En tiempo real

---

## 8. Aspectos Técnicos

### Tecnologías
- **Backend**: FastAPI + WebSocket + Pydantic
- **Frontend**: HTML/CSS/JS vanilla (sin frameworks)
- **TTS**: Browser + Edge TTS + Piper + Coqui
- **Orquestación**: MessageBus + HandoffService + DynamicPlanner
- **Docker**: Compose + Dockerfile

### Patrones
- **Events**: Bus pub/sub para comunicación
- **Traza**: `TraceEvent` con `event_type`, `agent_id`, `timestamp`
- **Skil**: `SkillRegistry` con `name`, `description`, `params`, `fn`

---

## 9. Contacto y Soporte

- **Repo**: `ticket-scan` GitHub
- **Issues**: Trackear bugs y requests
- **Discussion**: Comunidad

---

*Última actualización: 2026-11-18*
