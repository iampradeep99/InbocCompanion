const $ = selector => document.querySelector(selector);
const bookingFields = [
  ['reference', 'Booking reference / PNR'], ['operator', 'Operator / airline'], ['serviceNumber', 'Train / flight number'],
  ['travelClass', 'Travel class'], ['from', 'From'], ['to', 'To'], ['boardingPoint', 'Boarding point'],
  ['bookedAt', 'Booking date & time'], ['amount', 'Total amount paid'], ['currency', 'Currency'], ['paymentStatus', 'Payment status']
];
const passengerFields = [['name', 'Passenger name'], ['age', 'Age'], ['gender', 'Gender'], ['coach', 'Coach'],
  ['seat', 'Seat number'], ['berth', 'Berth type'], ['status', 'Booking / current status'], ['amount', 'Passenger fare']];
const typeLabels = { general: 'Personal event', travel: 'Travel & tickets', meeting: 'Meeting', appointment: 'Appointment', celebration: 'Celebration', custom: 'Something else' };
let changed = () => {};
function node(tag, className = '', text) {
  const el = document.createElement(tag); el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function field(key, label, value = '', prefix = 'details') {
  const wrapper = node('div', `detail-field detail-${key}`);
  const id = `${prefix}-${key}`;
  const caption = node('label', '', label); caption.htmlFor = id;
  const input = node('input'); input.id = id; input.dataset.field = key; input.value = value;
  input.maxLength = ({ value: 500, label: 80, age: 20, gender: 40, coach: 60, seat: 60, berth: 80, status: 120, currency: 20, amount: prefix.startsWith('passenger-') ? 80 : 200 })[key] || 200;
  input.placeholder = label === 'Passenger fare' ? 'Only if listed on ticket' : label;
  wrapper.append(caption, input); return wrapper;
}
function rowValues(row) {
  return Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.field, input.value.trim()]));
}
function addPassenger(data = {}) {
  const container = $('#passenger-list');
  if (container.children.length >= 12) return;
  const row = node('section', 'passenger-editor');
  const number = crypto.randomUUID();
  const heading = node('div', 'detail-row-heading');
  heading.append(node('strong', 'passenger-caption', 'Passenger'));
  const remove = node('button', 'quiet remove-detail', 'Remove'); remove.type = 'button';
  remove.addEventListener('click', () => { row.remove(); renumber(); changed(); });
  heading.append(remove); row.append(heading);
  const grid = node('div', 'detail-grid passenger-grid');
  for (const [key, label] of passengerFields) grid.append(field(key, label, data[key], `passenger-${number}`));
  row.append(grid); container.append(row); renumber();
}
function renumber() {
  [...$('#passenger-list').children].forEach((row, i) => {
    row.querySelector('.passenger-caption').textContent = `Passenger ${String(i + 1).padStart(2, '0')}`;
    row.querySelector('.remove-detail').setAttribute('aria-label', `Remove passenger ${i + 1}`);
  });
  $('#add-passenger').disabled = $('#passenger-list').children.length >= 12;
  $('#add-custom-detail').disabled = $('#custom-detail-list').children.length >= 20;
}
function addCustom(data = {}) {
  const container = $('#custom-detail-list');
  if (container.children.length >= 20) return;
  const row = node('div', 'custom-detail-editor');
  const prefix = `custom-${crypto.randomUUID()}`;
  row.append(field('label', 'Detail name', data.label, prefix), field('value', 'Detail value', data.value, prefix));
  const remove = node('button', 'quiet remove-detail', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove custom detail');
  remove.addEventListener('click', () => { row.remove(); renumber(); changed(); });
  row.append(remove); container.append(row); renumber();
}
export function mountEventDetails(onChange) {
  changed = onChange;
  for (const [key, label] of bookingFields) $('#booking-fields').append(field(key, label));
  $('#add-passenger').addEventListener('click', () => { addPassenger(); changed(); });
  $('#add-custom-detail').addEventListener('click', () => { addCustom(); changed(); });
  $('#event-kind').addEventListener('change', () => {
    $('#travel-details').hidden = $('#event-kind').value !== 'travel';
    if (!$('#custom-detail-list').children.length) {
      const presets = { meeting: ['Participants', 'Agenda', 'Meeting link'], appointment: ['With', 'Appointment reference', 'Preparation'],
        celebration: ['Host', 'Guests', 'Occasion'] };
      for (const label of presets[$('#event-kind').value] || []) addCustom({ label, value: '' });
    }
    changed();
  });
  $('#structured-details').addEventListener('input', changed);
}
export function fillEventDetails(details = {}) {
  $('#event-kind').value = details.type || 'general';
  $('#travel-details').hidden = details.type !== 'travel';
  for (const [key] of bookingFields) $(`#details-${key}`).value = details[key] || '';
  $('#passenger-list').replaceChildren(); $('#custom-detail-list').replaceChildren();
  for (const passenger of details.passengers || []) addPassenger(passenger);
  for (const detail of details.custom || []) addCustom(detail);
  renumber();
}
export function readEventDetails() {
  const travel = $('#event-kind').value === 'travel';
  const result = { type: $('#event-kind').value, passengers: [], custom: [] };
  for (const [key] of bookingFields) result[key] = travel ? $(`#details-${key}`).value.trim() : '';
  if (travel) result.passengers = [...$('#passenger-list').children].map(rowValues).filter(row => Object.values(row).some(Boolean));
  result.custom = [...$('#custom-detail-list').children].map(rowValues).filter(row => row.label || row.value);
  if (result.custom.some(row => !row.label)) throw new Error('Give each additional detail a name, or remove its empty row.');
  return result;
}
export function eventDetailsCard(details) {
  const card = node('section', 'event-detail-card');
  card.append(node('span', `event-kind-badge kind-${details.type}`, typeLabels[details.type] || 'Event details'));
  if (details.from || details.to) {
    const route = node('div', 'journey-route');
    route.append(node('strong', '', details.from || 'Departure'), node('span', 'route-arrow', '→'), node('strong', '', details.to || 'Arrival'));
    card.append(route);
  }
  const grid = node('dl', 'event-facts');
  for (const [key, label] of bookingFields) {
    if (!details[key] || ['from', 'to', 'currency'].includes(key)) continue;
    const fact = node('div'); fact.append(node('dt', '', label), node('dd', '', details[key] + (key === 'amount' && details.currency ? ` ${details.currency}` : ''))); grid.append(fact);
  }
  for (const { label, value } of details.custom || []) if (value) {
    const fact = node('div'); fact.append(node('dt', '', label), node('dd', '', value)); grid.append(fact);
  }
  if (grid.children.length) card.append(grid);
  for (const [i, passenger] of (details.passengers || []).entries()) {
    const person = node('div', 'passenger-display');
    const top = node('div', 'passenger-display-name');
    top.append(node('span', 'passenger-number', String(i + 1).padStart(2, '0')), node('strong', '', passenger.name || `Passenger ${i + 1}`));
    if (passenger.age || passenger.gender) top.append(node('span', '', [passenger.age && `${passenger.age} yrs`, passenger.gender].filter(Boolean).join(' · ')));
    person.append(top);
    const chips = node('div', 'passenger-chips');
    for (const [key, label] of passengerFields.slice(3)) if (passenger[key]) chips.append(node('span', '', `${label}: ${passenger[key]}`));
    if (chips.children.length) person.append(chips);
    card.append(person);
  }
  return card;
}
