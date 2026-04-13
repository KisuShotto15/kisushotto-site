export function toggle(header) {
  const body = header.nextElementSibling;
  const chevron = header.querySelector('.chevron');
  const isOpen = body.classList.contains('open');

  document.querySelectorAll('.meal-body').forEach(b => b.classList.remove('open'));
  document.querySelectorAll('.chevron').forEach(c => c.classList.remove('open'));

  if (!isOpen) {
    body.classList.add('open');
    chevron.classList.add('open');
  }
}

// Expose to HTML onclick handlers
window.toggle = toggle;
