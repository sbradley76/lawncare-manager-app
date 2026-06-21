export function centsToDollars(cents) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(cents) / 100);
}

export function dollarsToCents(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  if (Number.isNaN(parsed)) return null;
  return Math.round(parsed * 100);
}

export function labelize(value) {
  if (!value) return 'Not sure';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatDate(value) {
  if (!value) return 'Unscheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function normalizeServices(services) {
  if (!services) return [];
  if (Array.isArray(services)) return services.filter(Boolean);
  if (typeof services === 'string') {
    return services
      .replace(/[{}]/g, '')
      .split(',')
      .map((item) => item.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return [];
}

export function getFullName(lead) {
  return [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || 'Unnamed lead';
}

export function buildAddress(leadOrJob) {
  return [leadOrJob?.street_address, leadOrJob?.city, leadOrJob?.zip_code]
    .filter(Boolean)
    .join(', ');
}

export function mapsUrl(leadOrJob) {
  const address = buildAddress(leadOrJob);
  return address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : '#';
}
