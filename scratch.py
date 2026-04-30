import re
import os

path = '/home/kisushotto/VSCode Github/kisushotto.site/notes/index.html'
with open(path, 'r') as f:
    html = f.read()

# 1. Add bottom bar for creating notes
bottom_bar = """
<div class="bottom-create-bar">
  <div class="bcb-input" onclick="window.NotesApp.openNew()">Crear una nota...</div>
  <div class="bcb-actions">
    <button class="btn-icon" id="btn-new-checklist" title="Nueva lista" onclick="window.NotesApp.openNew('checklist')"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg></button>
    <button class="btn-icon" id="btn-new-audio" title="Nueva nota de audio" onclick="window.NotesApp.openNew('audio')"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg></button>
    <button class="btn-icon" id="btn-new-image" title="Nueva nota con imagen" onclick="window.NotesApp.openNew('image')"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></button>
  </div>
</div>
"""
if '<div class="bottom-create-bar">' not in html:
    html = html.replace('</main>', '</main>\n' + bottom_bar)

# 2. Hide topbar + Nueva button (or remove it)
html = re.sub(r'<button class="btn-pri" id="btn-new" onclick="">\+ Nueva</button>', '', html)

# 3. Update editor toolbar
new_toolbar = """
    <div class="ed-toolbar">
      <button class="btn-icon" id="ed-close" data-close onclick="" title="Atrás"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"></path><polyline points="12 19 5 12 12 5"></polyline></svg></button>
      <span class="ed-status" id="ed-status"></span>
      <div class="ed-toolbar-right">
        <button class="btn-icon" id="ed-pin" title="Fijar" onclick=""><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg></button>
        <button class="btn-icon" id="ed-reminder" title="Recordatorio" onclick=""><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg></button>
        <button class="btn-icon" id="ed-color" title="Color" onclick=""><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg></button>
        <button class="btn-icon" id="ed-more" title="Más opciones" onclick=""><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg></button>
      </div>
    </div>
"""

old_toolbar_regex = re.compile(r'<div class="ed-toolbar">.*?</div>', re.DOTALL)
html = old_toolbar_regex.sub(new_toolbar.strip(), html)

# 4. Add bottom bar for editor
ed_bottom_bar = """
    <div class="ed-bottom-bar">
      <button class="btn-icon" id="ed-add" title="Agregar" onclick=""><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
      <div class="ed-undo-redo">
        <button class="btn-icon" id="ed-undo" title="Deshacer" onclick=""><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path></svg></button>
        <button class="btn-icon" id="ed-redo" title="Rehacer" onclick=""><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"></path><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"></path></svg></button>
      </div>
    </div>
"""
if '<div class="ed-bottom-bar">' not in html:
    html = html.replace('<div class="ed-attachments" id="ed-attachments"></div>', '<div class="ed-attachments" id="ed-attachments"></div>\n' + ed_bottom_bar)

# 5. Add popup for "More options" (Archive, Trash, Lock, Share)
popup_more = """
<!-- More options popup -->
<div class="popup" id="popup-more" hidden>
  <div class="popup-menu">
    <button class="popup-menu-item" id="ed-categories" onclick=""><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg> Categorías</button>
    <button class="popup-menu-item" id="ed-share" onclick=""><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg> Compartir</button>
    <button class="popup-menu-item" id="ed-lock" onclick=""><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Proteger</button>
    <button class="popup-menu-item" id="ed-archive" onclick=""><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg> Archivar</button>
    <button class="popup-menu-item" id="ed-delete" onclick=""><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Eliminar</button>
  </div>
</div>
"""
if 'id="popup-more"' not in html:
    html = html.replace('<!-- Color picker mini-popup -->', popup_more + '\n<!-- Color picker mini-popup -->')

# 6. Add popup for "Add" options
popup_add = """
<!-- Add options popup -->
<div class="popup" id="popup-add" hidden>
  <div class="popup-menu">
    <button class="popup-menu-item" id="ed-image" onclick=""><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg> Imagen</button>
    <button class="popup-menu-item" id="ed-audio" onclick=""><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg> Audio</button>
    <button class="popup-menu-item" id="ed-checklist" onclick=""><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg> Casillas de verificación</button>
  </div>
</div>
"""
if 'id="popup-add"' not in html:
    html = html.replace('<!-- Color picker mini-popup -->', popup_add + '\n<!-- Color picker mini-popup -->')


with open(path, 'w') as f:
    f.write(html)
