# global_rules.md — Políticas globales del Orquestador

## Alcance
Estas reglas aplican a TODOS los agentes del pipeline (Intake, Validator, Confirmer, Clarifier, Main).

## Reglas de handoff
1. **Un solo agente activo a la vez** — El orquestador desactiva al origen antes de activar al destino.
2. **No hay handoffs circulares** — Un agente no puede hacer handoff a sí mismo ni crear ciclos infinitos.
3. **Máximo 6 handoffs por sesión** — Si se excede, el orquestador finaliza con error.
4. **Handoff anunciado vs discreto** — Los handoffs a Clarifier deben ser anunciados (TTS al cliente). Los demás son discretos.

## Reglas de activación
1. Un agente solo puede activarse si cumple TODAS sus `eligibility_rules`.
2. Si un agente está `enabled: false` en su config, no puede activarse aunque cumpla las reglas.
3. El `DynamicPlanner` decide el próximo agente usando reglas de prioridad fija antes de recurrir a LLM.

## Reglas de traces
1. Cada handoff debe emitir un `TraceEvent` de tipo `orchestrator_decision`.
2. Los traces se envían al frontend vía WebSocket para visualización en el panel "Agencia".
3. Máximo 100 eventos de traza por sesión.

## Límites de tiempo
1. Timeout de 30 segundos por turno de agente.
2. Si un agente no responde en 30s, el orquestador marca error y notifica al cliente.

## Reglas de memoria
1. El contexto de sesión se guarda al finalizar cada turno.
2. Las sesiones se persisten en `data/sessions/` como archivos JSON.
3. Una sesión inactiva por más de 24h puede ser eliminada.
