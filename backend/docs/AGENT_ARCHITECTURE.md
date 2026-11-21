# AGENT_ARCHITECTURE.md — Arquitectura de Agentes

## Patrón de diseño
Pipeline con handoffs controlados por un orquestador central (`DynamicPlanner` + `HandoffService`).

## Flujo de procesamiento de un pedido

```
Cliente → Main (STT/TTS) → Intake → Validator → Confirmer → Cliente
                                      ↑              ↓
                                    Clarifier ←─────┘
```

### Paso 1: Intake (Receptor)
- Parsea texto libre en items estructurados
- Handoff a Validator (si items completos) o Clarifier (si falta info)

### Paso 2: Validator (Validador)
- Verifica stock y calcula total
- Handoff a Confirmer (si todo OK) o Clarifier (si problemas)

### Paso 3: Confirmer (Confirmador)
- Confirma pedido, genera número, registra analytics
- Publica `confirmation_ready` en el bus

### Paso 4: Clarifier (Aclarador) — opcional
- Entra cuando falta información crítica
- Vuelve a Intake después de la respuesta del cliente

## Componentes clave

| Componente | Archivo | Responsabilidad |
|------------|---------|-----------------|
| HandoffService | `orchestrator/handoff.py` | Gestiona transferencias entre agentes |
| DynamicPlanner | `orchestrator/planner.py` | Decide próximo agente |
| EligibilityRules | `orchestrator/eligibility.py` | Evalúa reglas de activación |
| MessageBus | `agents/base.py` | Pub/sub interno de eventos |
| MemoryService | `services/memory_service.py` | Persistencia de contexto |

## Tipos de agentes

| Tipo | Descripción | Agentes |
|------|-------------|---------|
| PIPELINE_WORKER | Puente de transporte | Main |
| LLM_CONTEXT_WORKER | Procesa contexto con LLM | Intake, Validator, Confirmer, Clarifier |
