from typing import Dict, List, Any, Optional
from agents.base import Agent, AgentConfig, SkillRegistry, ConversationContext, SkillResult, HandoffType
from skills.catalog import buscar_en_catalogo, pedir_aclaracion
import json


SYSTEM_PROMPT = """Sos el AGENTE INTAKE (Receptor) de "Pizzería La Esquina".

Tu trabajo: convertir el texto libre del cliente en items estructurados del catálogo.

REGLAS:
1. Usá buscar_en_catalogo para cada item que detectés (tolerá alias: "muzza", "napo", "birra", "fugazzeta").
2. Si el cliente pide pizza SIN tamaño → pedí aclaración con pedir_aclaracion ("¿Chica, mediana o grande?").
3. Si no entendés un item o es ambiguo → pedí aclaración.
4. NO verifiques stock, NO calculés totales, NO confirmés. Eso lo hacen otros agentes.
5. Salida: lista de items detectados con {item_id, cantidad, variante_id?, extras[]} lista para el Validador.

EJEMPLOS:
- "dos muzza medianas y una coca" → 2x muzza (mediana), 1x coca
- "una fugazzeta grande con extra queso" → 1x fugazzeta (grande), extra: queso
- "quiero algo rico" → pedir_aclaracion("¿Qué te gustaría? Tenemos pizzas, empanadas, bebidas...")

HANDOFFS:
- Si items parseados OK → handoff a "validator"
- Si falta tamaño/stock/items desconocidos → handoff a "clarifier" con reason específico
"""


def norm(s: str) -> str:
    return s.lower().strip()


def parsear_pedido(texto: str, menu: Dict) -> List[Dict]:
    """Parsea pedido usando matching tolerante (versión simplificada para demo)"""
    t = " " + norm(texto) + " "
    lineas = []
    
    for item in menu.get("items", []):
        nombres = [item["nombre"]] + item.get("alias", [])
        nombres_norm = [norm(n) for n in nombres]
        
        for nombre in nombres_norm:
            if nombre in t:
                # Buscar variante si es pizza
                variante_id = None
                if item.get("variantes"):
                    if "grande" in t or "familiar" in t or "12 porciones" in t:
                        variante_id = "grande"
                    elif "mediana" in t or "8 porciones" in t:
                        variante_id = "mediana"
                    elif "chica" in t or "chiquita" in t or "6 porciones" in t:
                        variante_id = "chica"
                
                # Detectar cantidad
                import re
                cantidad_match = re.search(rf"(\d+)\s*(?:x\s*)?\s*{nombre}", t)
                cantidad = int(cantidad_match.group(1)) if cantidad_match else 1
                
                # Detectar extras
                extras = []
                for ext in item.get("extrasPermitidos", []):
                    ext_item = next((e for e in menu.get("extras", []) if e["id"] == ext), None)
                    if ext_item and ext_item["nombre"].lower() in t:
                        extras.append(ext)
                
                lineas.append({
                    "item_id": item["id"],
                    "item": item,
                    "cantidad": cantidad,
                    "variante_id": variante_id,
                    "extras": extras,
                    "plural": False,
                    "cantidad_explicita": True
                })
                break  # Solo una mención por item
    
    return lineas


def detectar_desconocidos(texto: str, menu: Dict) -> List[str]:
    """Detecta items mencionados pero no en catálogo"""
    # Simplificado para demo
    return []


def detectar_cliente(texto: str) -> Optional[str]:
    import re
    m = re.search(r"(?:a nombre de|soy)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+)?)", texto, re.IGNORECASE)
    return m.group(1).strip() if m else None


class IntakeAgent(Agent):
    
    def __init__(self, config: AgentConfig, skill_registry: SkillRegistry, bus):
        super().__init__(config, skill_registry, bus)
    
    async def on_activate(self, context: ConversationContext, args: Dict = None):
        if args and args.get("items_parsed"):
            self.context.items_parsed = args["items_parsed"]
            await self._validate_and_handoff()
    
    async def on_deactivate(self):
        pass
    
    async def process_turn(self, user_input: str) -> SkillResult:
        if not self.active:
            return SkillResult(success=False, error="Agente no activo")
        
        self.context.transcript.append({"role": "user", "content": user_input})
        
        menu = self.context.menu or {}
        lineas = parsear_pedido(user_input, menu)
        
        # Detectar cliente
        cliente = detectar_cliente(user_input)
        if cliente:
            self.context.cliente_info["nombre"] = cliente
        
        if not lineas:
            return await self._ask_clarification("No pude identificar qué querés. ¿Me repetís los platos y cantidades?")
        
        self.context.items_parsed = lineas
        return await self._validate_and_handoff()
    
    async def _validate_and_handoff(self) -> SkillResult:
        sin_tamanio = [l for l in self.context.items_parsed 
                      if l.get("item", {}).get("variantes") and not l.get("variante_id")]
        
        if sin_tamanio:
            reason = f"Falta tamaño para: {', '.join(l['item']['nombre'] for l in sin_tamanio)}"
            self.context.last_handoff_reason = reason
            await self.handoff_to(
                "clarifier",
                reason,
                HandoffType.ANNOUNCED
            )
            return SkillResult(success=True, data={"next_agent": "clarifier"}, terminates_turn=True)
        
        await self.handoff_to(
            "validator",
            f"Items parseados: {len(self.context.items_parsed)} items listos para validar",
            HandoffType.DISCRETE
        )
        return SkillResult(success=True, data={"items_parsed": self.context.items_parsed, "next_agent": "validator"}, terminates_turn=True)
    
    async def _ask_clarification(self, pregunta: str) -> SkillResult:
        result = await self.execute_skill("pedir_aclaracion", {"pregunta": pregunta}, self.context)
        self.context.aclaracion_pendiente = pregunta
        return result