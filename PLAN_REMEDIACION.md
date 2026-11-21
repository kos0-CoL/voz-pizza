# PLAN DE REMEDIACIÓN — Pizzería La Esquina (Orquestador Multi-Agente)

Este documento separa las funciones por **dominios** y describe qué se debe crear, modificar o eliminar para profesionalizar el sistema. Incluye la reestructuración de `agents/` con subagentes, políticas, SKILL.md, memoria, scripts, plantillas y configuración de herramientas.

---

## 1. DOMINIO: Agentes (`backend/agents/`)

### Estructura actual (plana)
```
backend/agents/
├── base.py
├── intake_agent.py
├── validator_agent.py
├── confirmer_agent.py
├── clarifier_agent.py
└── main_agent.py
```

### Estructura propuesta (con subagentes por carpeta)
```
backend/agents/
├── base.py                          # Clases base (Agent, SkillRegistry, MessageBus, ConversationContext, etc.)
├── config/                          # Configuraciones por agente (reemplaza config/agents.py)
│   ├── intake.yaml
│   ├── validator.yaml
│   ├── confirmer.yaml
│   ├── clarifier.yaml
│   └── main.yaml
├── intake/                          # Subagente: Receptor
│   ├── __init__.py
│   ├── agent.py                     # IntakeAgent
│   ├── skill.md                     # Instrucciones de habilidad (qué hace, cuándo activa, paso a paso)
│   └── rules.md                     # Políticas específicas del intake
├── validator/                       # Subagente: Validador
│   ├── __init__.py
│   ├── agent.py                     # ValidatorAgent
│   ├── skill.md
│   └── rules.md
├── confirmer/                       # Subagente: Confirmador
│   ├── __init__.py
│   ├── agent.py                     # ConfirmerAgent
│   ├── skill.md
│   └── rules.md
├── clarifier/                       # Subagente: Aclarador
│   ├── __init__.py
│   ├── agent.py                     # ClarifierAgent
│   ├── skill.md
│   └── rules.md
└── main/                            # Subagente: Principal (transporte STT/TTS)
    ├── __init__.py
    ├── agent.py                     # MainAgent
    ├── skill.md
    └── rules.md
```

### Funciones separadas por agente

| Agente | Responsabilidad | Input | Output | Handoff destino |
|--------|----------------|-------|--------|-----------------|
| **Intake** | Parsear texto libre → items estructurados | Texto del cliente + menú | `{items_parsed, cliente_info}` | `validator` o `clarifier` |
| **Validator** | Verificar stock + calcular total | `items_parsed` | `{total_calculated, lineas_validadas}` | `confirmer` o `clarifier` |
| **Confirmer** | Confirmar pedido + registrar analytics | `total_calculated` + datos cliente | `{confirmacion}` | (fin) |
| **Clarifier** | Preguntar al cliente cuando falta info | `last_handoff_reason` | `{question}` | `intake` (tras respuesta) |
| **Main** | Transporte STT/TTS + puente WebSocket | Audio / Texto | Texto / Audio | (coordina) |

---

## 2. DOMINIO: Orquestador (`backend/orchestrator/`)

### Estructura propuesta
```
backend/orchestrator/
├── __init__.py
├── handoff.py               # HandoffService + DynamicPlanner (ya existe)
├── planner.py               # Lógica de routing separada (extraído de handoff.py)
├── eligibility.py           # Reglas de elegibilidad (eval rules) separadas
├── memory.py                # Gestión de memoria/persistencia de contexto
├── policies/                # Políticas globales del orquestador
│   ├── global_rules.md
│   └── handoff_policy.md
└── traces/                  # Gestión de eventos de traza
    └── trace_bus.py
```

### Funciones del orquestador

| Componente | Función | Entrada | Salida |
|------------|---------|---------|--------|
| `HandoffService` | Solicitar transferencia entre agentes | `HandoffRequest` | `bool` (éxito/fallo) |
| `DynamicPlanner` | Decidir próximo agente | `ConversationContext` | `agent_id` |
| `EligibilityRules` | Evaluar si un agente puede activarse | `condicion_string` + `contexto` | `bool` |
| `Memory` | Guardar/recuperar contexto de sesión | `session_id` | `ConversationContext` |
| `Traces` | Emitir y enrutar eventos de traza | `TraceEvent` | WebSocket → frontend |

---

## 3. DOMINIO: Skills (`backend/skills/`)

### Estructura propuesta
```
backend/skills/
├── __init__.py
├── catalog.py               # Registro central de todas las skills (ya existe)
├── python/                  # Skills implementadas en Python
│   ├── buscar_en_catalogo.py
│   ├── verificar_stock.py
│   ├── calcular_total.py
│   ├── pedir_aclaracion.py
│   ├── confirmar_pedido.py
│   ├── extraer_items.py
│   ├── detectar_cantidad.py
│   ├── detectar_variante.py
│   ├── validar_pedido_completo.py
│   └── analytics_registrar_evento.py
├── placeholders/            # Skills deshabilitadas (whatsapp, push, email, cocina, cliente, config)
│   ├── whatsapp.py
│   ├── push.py
│   ├── email.py
│   ├── cocina.py
│   ├── cliente.py
│   └── config.py
└── definitions/             # SKILL_DEFINITIONS por categoría
    ├── catalog_definitions.py
    └── notification_definitions.py
```

### Funciones separadas por skill

| Skill | Función | Parámetros | Retorna |
|-------|---------|------------|---------|
| `buscar_en_catalogo` | Buscar item por nombre/alias | `{nombre}` | `{item_id, nombre, precio, variantes, extrasPermitidos}` |
| `verificar_stock` | Verificar disponibilidad | `{item_id, cantidad}` | `{disponible: bool, stock: int}` |
| `calcular_total` | Calcular total del pedido | `{lineas}` | `{total, moneda, lineas_detalle}` |
| `pedir_aclaracion` | Generar pregunta al cliente | `{pregunta}` | `{pregunta_enviada}` |
| `confirmar_pedido` | Confirmar y generar número de pedido | `{cliente_data}` | `{pedido, total, tiempo_estimado_min}` |
| `analytics_registrar_evento` | Registrar evento analítico | `{evento, propiedades, user_id}` | `{registrado: bool}` |

---

## 4. DOMINIO: Servicios (`backend/services/`)

### Estructura propuesta
```
backend/services/
├── __init__.py
├── menu_service.py          # Carga y consulta de data/menu.json (ya existe)
├── recibo_service.py        # Generación de recibos PDF (ya existe, nuevo)
├── memory_service.py        # Persistencia de contexto de sesión (NUEVO)
├── analytics_service.py     # Registro de eventos analytics (NUEVO)
└── notification_service.py  # Notificaciones push/email (placeholder)
```

### Funciones separadas por servicio

| Servicio | Función | Entrada | Salida |
|----------|---------|---------|--------|
| `menu_service` | `load()`, `get_menu()`, `buscar_item(id)` | archivo JSON | `Dict` |
| `recibo_service` | `generar_recibo_pdf(datos)` | datos del pedido | `bytes` (PDF) |
| `memory_service` | `save_context(session_id, ctx)`, `load_context(session_id)` | session_id | `ConversationContext` |
| `analytics_service` | `registrar_evento(evento, props)` | evento | `bool` |
| `notification_service` | `enviar_push`, `enviar_email` | datos | `bool` |

---

## 5. DOMINIO: Transporte (`backend/transport/`)

### Estructura propuesta
```
backend/transport/
├── __init__.py
├── webrtc_transport.py      # WebSocketTransport (ya existe)
├── websocket_handler.py     # Manejo de mensajes WebSocket (extraído de main.py)
├── stt/                     # Speech-to-Text (placeholder)
│   └── stt_client.py
└── tts/                     # Text-to-Speech (placeholder)
    └── tts_client.py
```

---

## 6. DOMINIO: Configuración (`backend/config/`)

### Estructura propuesta
```
backend/config/
├── __init__.py
├── agents.py                # load_agents_config() (ya existe)
├── agents.yaml              # Configuración YAML de todos los agentes (NUEVO)
├── skills.yaml              # Configuración de skills habilitadas/deshabilitadas (NUEVO)
├── orchestrator.yaml        # Configuración del orquestador (eligibilidad, timeouts) (NUEVO)
└── app.yaml                 # Configuración general del servidor (puerto, CORS, etc.) (NUEVO)
```

---

## 7. DOMINIO: Memoria y Persistencia

### Problema actual
No hay persistencia. `ConversationContext` vive solo en memoria durante el turno activo.

### Solución propuesta
Crear `backend/services/memory_service.py`:

```python
class MemoryService:
    def save_context(self, session_id: str, context: ConversationContext) -> None
    def load_context(self, session_id: str) -> Optional[ConversationContext]
    def list_sessions(self) -> List[str]
    def delete_session(self, session_id: str) -> None
```

Almacenamiento: archivo JSON por sesión en `data/sessions/` o base de datos SQLite.

---

## 8. DOMINIO: Políticas y Reglas (SKILL.md, rules.md, etc.)

### Archivos a crear

| Archivo | Ubicación | Contenido |
|---------|-----------|-----------|
| `SKILL.md` | `backend/agents/{agente}/skill.md` | Qué hace el agente, cuándo activa, paso a paso, ejemplos de entrada/salida |
| `rules.md` | `backend/agents/{agente}/rules.md` | Límites, tono, prohibiciones, estándares de calidad |
| `global_rules.md` | `backend/orchestrator/policies/global_rules.md` | Reglas globales del orquestador (quién puede hacer handoff a quién, timeouts, max turnos) |
| `handoff_policy.md` | `backend/orchestrator/policies/handoff_policy.md` | Política de transferencias entre agentes |
| `tools.yaml` | `backend/config/tools.yaml` | APIs externas, servidores, bases de datos a las que puede conectarse cada agente |

---

## 9. DOMINIO: Scripts

### Archivos a crear
```
backend/scripts/
├── init_db.py                # Inicializar base de datos de memoria
├── migrate_menu.py           # Migrar data/menu.json a formato nuevo
├── validate_agents.py        # Validar configuración de agentes
├── run_tests.py              # Ejecutar pruebas de los 10 casos de pedido
└── generate_recibo.py        # Script CLI para generar recibos PDF
```

---

## 10. DOMINIO: Referencias y Conocimiento

### Archivos a crear
```
backend/docs/
├── API.md                    # Documentación de endpoints REST y WebSocket
├── AGENT_ARCHITECTURE.md     # Arquitectura de agentes y flujo de handoff
├── MENU_SCHEMA.md            # Esquema de data/menu.json
└── TROUBLESHOOTING.md        # Guía de solución de problemas
```

---

## 11. DOMINIO: Plantillas y Recursos

### Archivos a crear
```
backend/templates/
├── recibo.html               # Plantilla HTML del recibo (opcional)
├── confirmation_message.txt  # Plantilla de mensaje de confirmación
└── clarification_templates.json  # Plantillas de preguntas de aclaración
```

---

## 12. CRONOGRAMA DE IMPLEMENTACIÓN

| Fase | Dominio | Tareas | Prioridad |
|------|---------|--------|-----------|
| 1 | Agentes | Reestructurar `agents/` en carpetas con subagentes | Alta |
| 1 | Orquestador | Extraer `planner.py`, `eligibility.py`, `memory.py` de `handoff.py` | Alta |
| 1 | Config | Crear `agents.yaml`, `skills.yaml`, `orchestrator.yaml` | Alta |
| 2 | Skills | Separar `catalog.py` en archivos individuales por skill | Media |
| 2 | Servicios | Crear `memory_service.py`, `analytics_service.py` | Media |
| 2 | Políticas | Crear `SKILL.md` y `rules.md` por agente | Media |
| 3 | Scripts | Crear scripts de utilidad (`init_db.py`, `validate_agents.py`, etc.) | Baja |
| 3 | Docs | Crear documentación técnica (`API.md`, `AGENT_ARCHITECTURE.md`) | Baja |
| 3 | Templates | Crear plantillas de respuesta | Baja |

---

## 13. NOTAS IMPORTANTES

1. **No romper funcionalidad existente**: Cada cambio debe mantener retrocompatibilidad con `main.py`, `app.js` y `index.html`.
2. **Comentarios reales (`#`)**: Todos los archivos nuevos y modificados deben incluir comentarios explicativos línea por sección.
3. **Pruebas**: Después de cada fase, ejecutar `docker build` y `docker run` para verificar que el servidor levanta correctamente.
4. **SKILL.md por agente**: Cada subagente debe tener su propio `skill.md` documentando su rol, activación y flujo de trabajo.
