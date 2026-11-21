# SKILL.md — Agente Clarifier (Aclarador)

## ¿Qué hace?
Resuelve ambigüedades y pregunta al cliente cuando falta información crítica para continuar el pipeline.

## ¿Cuándo se activa?
- Cuando falta tamaño en un ítem (`missing_size`).
- Cuando hay stock insuficiente (`stock_insufficient`).
- Cuando hay un ítem desconocido (`unknown_item`).
- Cuando hay problemas en el cálculo del total (`total_problems`).

## Paso a paso de resolución

1. **Recibir el problema**: Contexto del problema (qué falta, qué opciones hay).
2. **Formular pregunta**: Pregunta clara y corta en español rioplatense.
3. **Ejecutar aclaración**: Llamar `pedir_aclaracion` con la pregunta formulada.
4. **Terminar turno**: El orquestador detiene el flujo y espera respuesta del cliente.
5. **Reanudar**: Cuando el cliente responde, el orquestador re-ejecuta con `intake`.

## Tipos de aclaración

| Tipo | Ejemplo de pregunta |
|------|---------------------|
| missing_size | "La muzza: ¿la querés chica, mediana o grande?" |
| missing_quantity | "¿Cuántas pizzas muzza querés?" |
| stock_low | "De muzza quedan 2 y pediste 5. ¿Ajustamos a 2?" |
| unknown_item | "No tenemos X. ¿Quizás Y (que es similar)?" |
| total_problems | "Problema en total: [detalle]. ¿Cómo lo resolvemos?" |

## Entrada esperada
```json
{
  "problema": "missing_size",
  "item": "muzza",
  "opciones": ["chica", "mediana", "grande"],
  "contexto_anterior": { ... }
}
```

## Salida esperada
```json
{
  "pregunta": "La muzza: ¿la querés chica, mediana o grande?",
  "tipo_aclaracion": "missing_size",
  "next_agent": null
}
```

## Handoffs permitidos
- **intake** (announced): Después de que el cliente responde, reanudar con Intake.
- **validator** (discrete): Cuando la aclaración resuelve un problema de stock y se puede continuar validando.
