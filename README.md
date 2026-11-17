# Pizzería La Esquina — pedidos por voz

App estática (HTML + CSS + JS, sin build ni backend) para tomar pedidos dictados por micrófono, cotejarlos contra el catálogo y devolver la confirmación. El objetivo es **medir el comportamiento del orquestador y sus skills**, así que cada corrida deja una traza exportable con pasos, tool calls, latencias y tokens.

## Cómo correrla

Hace falta servir la carpeta por HTTP (el catálogo se carga con `fetch`; abrir `index.html` con doble clic no funciona).

```bash
cd pizzeria-agente
python -m http.server 8080
```

Abrir <http://localhost:8080>. Para dictar, usar **Chrome** o **Edge** (Web Speech API). En otros navegadores se puede escribir el pedido a mano.

## Modos

| Modo | Qué hace | Requiere clave |
| --- | --- | --- |
| **Simular modelo** (checkbox) | Orquestador por reglas locales que llama a las mismas skills. Sirve para probar el flujo y comparar contra el modelo. | No |
| **Gemini real** | Loop de *function calling*: el modelo decide qué skill llamar en cada paso. | Sí |

La clave se carga en **Configurar** y queda solo en `localStorage` de ese navegador; las llamadas van directo a `generativelanguage.googleapis.com` con el header `x-goog-api-key`. Se puede crear en <https://aistudio.google.com/apikey>. En el free tier Google puede usar los prompts para mejorar sus productos, así que no dictes datos reales de clientes.

Modelo por defecto: `gemini-3.5-flash-lite`. Alternativas en el selector (`3.5-flash`, `2.5-flash-lite`).

## Pipeline

1. **Dictado** con Web Speech API (`es-AR`, resultados parciales) → texto editable en el textarea.
2. **Orquestador**: hasta 8 pasos de `generateContent` con `tools`. En modelos Gemini 3+ los `thoughtSignature` del contenido del modelo se reenvían tal cual; si no, la API responde 400.
3. **Skills** (declaradas al modelo y también usables en modo simulado):

| Skill | Para qué |
| --- | --- |
| `buscar_en_catalogo` | Resuelve alias ("muzza", "napo", "birra") a ids con precios y stock. Tolera errores de transcripción. |
| `verificar_stock` | Comprueba disponibilidad para la cantidad pedida. |
| `calcular_total` | Valida tamaños, extras permitidos y stock; devuelve líneas y total. Obligatoria antes de confirmar. |
| `pedir_aclaracion` | Pregunta al cliente cuando falta un dato. Termina la corrida. |
| `confirmar_pedido` | Devuelve número de pedido y demora. Se niega si no hubo `calcular_total` exitoso. |

4. **Resultado**: ticket confirmado, pregunta de aclaración (con campo para responder y volver a correr) o error.

## Qué mide la traza

- Duración total y por paso.
- Cantidad de llamadas al modelo y de tool calls (incluidas las que fallaron).
- Tokens de entrada/salida (incluye tokens de pensamiento).
- Texto de razonamiento del modelo, argumentos y resultado de cada skill.
- Estado final: `confirmado`, `aclaracion`, `sin_confirmar`, `error`.

**Exportar JSON** / **Copiar** descargan la última corrida completa. El historial guarda las últimas 15 en `localStorage`.

## Evaluación: 10 pedidos difíciles

El panel **5 · Evaluación** corre el set de `data/pedidos-prueba.json`: ambigüedades, ítems inexistentes, cantidades habladas ("dos", "media docena", "veinte"), stock insuficiente y un pedido sin contenido. Cada caso trae el resultado esperado calculado contra el catálogo (estado, total y líneas con ítem, tamaño y extras).

El mismo texto pasa primero por el simulador y después por el modelo real, y la tabla muestra:

| Columna | Qué compara |
| --- | --- |
| simulador / modelo | Estado y resumen del resultado de cada uno. |
| ✓ | Acierto contra la expectativa. Si falla, muestra el motivo (`estado`, `total` o líneas distintas). |
| traza | Si coinciden estado, total y la secuencia exacta de skills entre los dos modos. |

Arriba quedan los contadores: aciertos del simulador, aciertos del modelo, mismo estado, misma secuencia de skills y tiempo total del modelo. **Exportar JSON** baja el set completo con las dos corridas (incluidos tokens y skills) para analizarlo fuera.

El botón cambia a **Detener** durante la corrida (útil con el modelo real, que hace hasta 8 llamadas por caso). Sin clave, se corre solo el simulador y la columna del modelo queda vacía.

## Estructura

```
index.html        UI (pedido, resultado, traza, historial, configuración)
styles.css        Estilos, sin dependencias
app.js            Skills, cliente Gemini, orquestador, simulador, traza
data/menu.json     Catálogo: ítems, alias, variantes, extras, stock
data/pedidos-prueba.json   Set de 10 casos con expectativas exactas
```

## Límites conocidos

- El dictado depende del navegador y de una conexión (el reconocimiento de Chrome es remoto). No se sube ningún archivo de audio.
- La clave de API en el navegador es aceptable para una demo local; para producción hace falta un backend que la esconda.
- El stock es un número fijo en el JSON: no se descuenta al confirmar.
- El modo simulado reconoce cantidades, tamaños y extras por reglas; no razona sobre frases muy libres. El modo Gemini sí.
- El set de 10 casos es chico y está pensado para comparar modos, no como benchmark: un caso nuevo puede requerir ampliar el JSON y, si el simulador falla, ajustar sus reglas.
