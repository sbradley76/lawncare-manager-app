import { normalizeServices } from './format';

const DEFAULTS = {
  small_base_cents: 6500,
  medium_base_cents: 9000,
  large_base_cents: 13500,
  weekly_discount_percent: 10,
  biweekly_discount_percent: 5,
};

function getNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function basePrice(propertyType, settings) {
  if (propertyType === 'larger_residence') return getNumber(settings?.large_base_cents, DEFAULTS.large_base_cents);
  if (propertyType === 'medium_residence') return getNumber(settings?.medium_base_cents, DEFAULTS.medium_base_cents);
  return getNumber(settings?.small_base_cents, DEFAULTS.small_base_cents);
}

function conditionAdd(condition, propertyType) {
  const isLarge = propertyType === 'larger_residence';
  const isMedium = propertyType === 'medium_residence';

  if (condition === 'a_little_tall') return isLarge ? 2000 : isMedium ? 1500 : 1000;
  if (condition === 'overgrown') return isLarge ? 4500 : isMedium ? 3500 : 2000;
  if (condition === 'very_overgrown') return isLarge ? 7500 : isMedium ? 5500 : 4000;
  return 0;
}

function discountForFrequency(frequency, settings) {
  const normalized = String(frequency || '').toLowerCase();
  if (normalized.includes('weekly')) return getNumber(settings?.weekly_discount_percent, DEFAULTS.weekly_discount_percent);
  if (normalized.includes('bi') || normalized.includes('every_2')) return getNumber(settings?.biweekly_discount_percent, DEFAULTS.biweekly_discount_percent);
  return 0;
}

export function estimateQuote(lead, settings) {
  const propertyType = lead?.property_type || 'small_yard_townhome';
  const condition = lead?.yard_condition || 'not_sure';
  const services = normalizeServices(lead?.services_requested);
  const frequency = lead?.requested_frequency || 'not_sure';

  let suggested = basePrice(propertyType, settings) + conditionAdd(condition, propertyType);
  const reasons = [];

  reasons.push(`Base price for ${propertyType.replaceAll('_', ' ')}`);
  if (condition && condition !== 'maintained' && condition !== 'not_sure') {
    reasons.push(`Adjusted for ${condition.replaceAll('_', ' ')} yard condition`);
  }

  const needsCleanup = services.some((service) => service.includes('cleanup') || service.includes('overgrown'));
  if (needsCleanup && condition !== 'very_overgrown') {
    suggested += 2000;
    reasons.push('Added light cleanup buffer');
  }

  const manualServices = services.filter((service) => ['mulch', 'planting', 'sod', 'other'].some((name) => service.includes(name)));
  if (manualServices.length) {
    reasons.push(`${manualServices.length} add-on service(s) need manual review`);
  }

  const discountPercent = discountForFrequency(frequency, settings);
  if (discountPercent > 0) {
    suggested = Math.round(suggested * (1 - discountPercent / 100));
    reasons.push(`${discountPercent}% recurring route discount applied`);
  }

  // Keep pricing fair and not predatory: provide a range around the suggested number.
  const min = Math.max(5000, Math.round(suggested * 0.88 / 500) * 500);
  const max = Math.round(suggested * 1.15 / 500) * 500;
  suggested = Math.round(suggested / 500) * 500;

  return {
    suggested_price_cents: suggested,
    min_price_cents: min,
    max_price_cents: max,
    frequency,
    quote_reason: reasons.join('. '),
  };
}
