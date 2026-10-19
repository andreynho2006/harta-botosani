// Keep card disclosure state separate from event data and preserve mounted form inputs.
export function createOperationsCards(panel) {
  const collapsed = new Map();
  let previous = new Set(), lastMarker = null;
  const keyFor = card => card.dataset.opsCard || card.id ||
    (card.classList.contains('ops-archive-bar') ? 'archive' : card.classList.contains('ops-intro') ? 'intro' : null);

  function refresh({ markerId = null } = {}) {
    const current = new Set();
    for (const card of panel.querySelectorAll('.ops-card')) {
      if (card.parentElement.closest('.ops-card')) continue;
      const key = keyFor(card);
      if (!key) continue;
      current.add(key);
      if (key === 'event' && !collapsed.has(key)) collapsed.set(key, true);
      if ((key === 'ops-marker' && markerId !== lastMarker) ||
          (['ops-marker', 'ops-itinerary'].includes(key) && !previous.has(key))) collapsed.set(key, false);
      let header = card.querySelector(':scope > .ops-card-title');
      if (!header) {
        const title = card.querySelector(':scope > h2, :scope > h3');
        if (!title) continue;
        header = panel.ownerDocument.createElement('div');
        header.className = 'ops-card-title';
        title.before(header); header.append(title);
      }
      header.classList.add('ops-card-header');
      let body = card.querySelector(':scope > .ops-card-body');
      if (!body) {
        body = panel.ownerDocument.createElement('div');
        body.className = 'ops-card-body';
        const fixed = key === 'event' ? [card.querySelector(':scope > .ops-top-actions'), card.querySelector(':scope > #ops-save-state')] : [];
        for (const node of [...card.childNodes]) if (node !== header && !fixed.includes(node)) body.append(node);
        card.append(body);
      }
      const bodyId = `ops-card-body-${key}`;
      body.id = bodyId;
      let toggle = header.querySelector('[data-ops-card-toggle]');
      if (!toggle) {
        toggle = panel.ownerDocument.createElement('button');
        toggle.type = 'button'; toggle.className = 'ops-card-toggle';
        toggle.dataset.opsCardToggle = key;
        header.append(toggle);
      }
      toggle.setAttribute('aria-controls', bodyId);
      const title = header.querySelector('h2, h3')?.textContent.trim() || 'Card';
      toggle.dataset.cardLabel = title;
      apply(card, toggle, body, Boolean(collapsed.get(key)));
      if (key === 'add') addMenu(body);
    }
    lastMarker = markerId;
    previous = current;
  }

  function apply(card, toggle, body, folded) {
    body.hidden = folded;
    card.classList.toggle('is-card-collapsed', folded);
    toggle.setAttribute('aria-expanded', String(!folded));
    toggle.setAttribute('aria-label', `${folded ? 'Arată' : 'Ascunde'} ${toggle.dataset.cardLabel}`);
    toggle.title = toggle.getAttribute('aria-label');
    toggle.textContent = folded ? '⌄' : '⌃';
  }

  function addMenu(body) {
    const grid = body.querySelector('.ops-tools-grid');
    if (!grid || grid.querySelector('[data-ops-add-action]')) return;
    const buttons = [...grid.querySelectorAll('button[data-action]')];
    const label = panel.ownerDocument.createElement('label');
    label.className = 'ops-add-menu';
    label.append(panel.ownerDocument.createTextNode('Ce adaugi pe hartă?'));
    const select = panel.ownerDocument.createElement('select');
    select.dataset.opsAddAction = '';
    select.setAttribute('aria-label', 'Alege acțiunea pentru hartă');
    const empty = panel.ownerDocument.createElement('option');
    empty.value = ''; empty.textContent = 'Alege o acțiune…'; select.append(empty);
    for (const button of buttons) {
      const option = panel.ownerDocument.createElement('option');
      option.value = [button.dataset.action, button.dataset.kind].filter(Boolean).join(':');
      option.textContent = button.textContent.trim();
      option.dataset.action = button.dataset.action;
      if (button.dataset.kind) option.dataset.kind = button.dataset.kind;
      select.append(option);
    }
    label.append(select);
    const hint = panel.ownerDocument.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Acțiunea pornește după selectare. Completează detaliile sau alege poziția pe hartă.';
    grid.replaceChildren(label, hint);
  }

  function handleClick(button) {
    const key = button?.dataset?.opsCardToggle;
    if (!key) return false;
    const card = button.closest('.ops-card'), body = card?.querySelector(':scope > .ops-card-body');
    if (!body) return true;
    const folded = !body.hidden;
    collapsed.set(key, folded);
    apply(card, button, body, folded);
    button.focus({ preventScroll: true });
    return true;
  }

  function handleChange(target) {
    if (!target?.matches?.('[data-ops-add-action]')) return false;
    const option = target.selectedOptions[0];
    if (!option?.dataset.action) return true;
    const button = panel.ownerDocument.createElement('button');
    button.type = 'button'; button.hidden = true;
    button.dataset.action = option.dataset.action;
    if (option.dataset.kind) button.dataset.kind = option.dataset.kind;
    // Reuse the existing delegated action handler instead of duplicating action logic.
    target.value = '';
    panel.append(button); button.click(); button.remove();
    return true;
  }
  return { refresh, handleClick, handleChange };
}
