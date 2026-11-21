# SKILL.md — Agente Validator (Validador)

## ¿Qué hace?
Verifica disponibilidad de stock para cada item del pedido y calcula el total exacto. Es el segundo agente del pipeline.

## ¿Cuándo se activa?
- Cuando hay `items_parsed` en el contexto (después de Intake).
- Requiere que `items_parsed` no esté vacío.

## Paso a paso de resolución

1. **Recibir items**: Lista de items parseados por Intake con `{item_id, cantidad, variante_id, extras}`.
2. **Verificar stock**: Para cada item, ejecutar `verificar_stock(item_id, cantidad)`.
3. **Manejar stock insuficiente**:
   - Si no hay stock suficiente → pedir aclaración al cliente (`pedir_aclaracion`).
   - Opciones: ajustar cantidad, elegir otro item, o cancelar.
4. **Calcular total**: Ejecutar `calcular_total(lineas)` para obtener el monto final.
5. **Validar esquema**: Confirmar que cada línea tenga precio_unitario, subtotal, y extras válidos.
6. **Handoff**:
   - Si todo validó OK → hacer handoff a **Confirmer** (discrete).
   - Si hay problemas de stock o total → hacer handoff a **Clarifier** (announced).

## Entrada esperada
```json
{
  "items_parsed": [...],
  "cliente_info": { ... },
  "menu": { ... }
}
```

## Salida esperada
```json
{
  "total_calculated": {
    "total": 5500,
    "moneda": "ARS",
    "lineas_detalle": [...]
  },
  "lineas_validadas": [...],
  "next_agent": "confirmer"
}
```

## Handoffs permitidos
- **confirmer** (discrete): Cuando stock y total están OK.
- **clarifier** (announced): Cuando hay problemas de stock o cálculo de total.
