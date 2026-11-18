import json
import os
from typing import Dict, Any, Optional


class MenuService:
    def __init__(self):
        self._menu: Optional[Dict] = None
        # En Docker, el archivo está en /app/data/menu.json
        # En desarrollo, está en ../data/menu.json relativo al archivo
        docker_path = "/app/data/menu.json"
        dev_path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "menu.json")
        self._menu_path = docker_path if os.path.exists(docker_path) else dev_path
    
    def load(self) -> Dict:
        if self._menu is None:
            self._menu = self.load_sync()
        return self._menu
    
    def load_sync(self) -> Dict:
        with open(self._menu_path, "r", encoding="utf-8") as f:
            self._menu = json.load(f)
        return self._menu
    
    def get_menu(self) -> Dict:
        return self.load()
    
    def get_item(self, item_id: str) -> Optional[Dict]:
        menu = self.get_menu()
        return next((item for item in menu.get("items", []) if item["id"] == item_id), None)
    
    def get_extras(self) -> list:
        menu = self.get_menu()
        return menu.get("extras", [])