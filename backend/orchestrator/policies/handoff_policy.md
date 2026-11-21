# handoff_policy.md — Política de transferencias entre agentes

## Matriz de handoffs permitidos

| Origen → Destino | Tipo | Condición |
|------------------|------|-----------|
| Main → Intake | Discrete | Nuevo mensaje del cliente |
| Intake → Validator | Discrete | Items parseados completos (con tamaño) |
| Intake → Clarifier | Announced | Falta tamaño o ítem desconocido |
| Validator → Confirmer | Discrete | Stock OK y total calculado |
| Validator → Clarifier | Announced | Stock insuficiente o problema en total |
| Clarifier → Intake | Announced | Cliente respondió la aclaración |
| Clarifier → Validator | Discrete | Aclaración resuelve problema de stock |

## Reglas específicas
1. **Intake no puede hacer handoff a Confirmer** — Debe pasar por Validator primero.
2. **Validator no puede hacer handoff a Intake** — Solo a Confirmer o Clarifier.
3. **Confirmer no tiene handoffs de salida** — Es el terminal del pipeline.
4. **Clarifier siempre vuelve a Intake** — Después de que el cliente responde, el flujo se reinicia desde Intake.

## Trace de handoff
Cada handoff debe registrar:
- from_agent, to_agent
- reason (motivo textual)
- handoff_type (announced/discrete)
- timestamp
- contexto resumido (items_parsed, total_calculated, etc.)
