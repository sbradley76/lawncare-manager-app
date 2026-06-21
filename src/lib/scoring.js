import { normalizeServices } from './format';

const LOCAL_AREAS = ['fort walton beach', 'fwb', 'shalimar', 'cinco bayou', 'mary esther', 'destin'];

export function scoreLead(lead) {
  const reasons = [];
  let score = 0;
  const services = normalizeServices(lead.services_requested);
  const frequency = String(lead.requested_frequency || '').toLowerCase();
  const propertyType = String(lead.property_type || '').toLowerCase();
  const condition = String(lead.yard_condition || '').toLowerCase();
  const city = String(lead.city || '').toLowerCase();
  const notes = [lead.additional_notes, lead.gate_or_pet_notes].filter(Boolean).join(' ');

  if (frequency.includes('weekly')) {
    score += 30;
    reasons.push('Recurring weekly work');
  } else if (frequency.includes('bi') || frequency.includes('every_2')) {
    score += 25;
    reasons.push('Recurring bi-weekly work');
  } else if (frequency.includes('monthly')) {
    score += 15;
    reasons.push('Monthly route potential');
  } else if (frequency.includes('one')) {
    score += 10;
    reasons.push('One-time service');
  }

  if (services.some((service) => ['mow_weedeat_edge_blow', 'mowing', 'mow'].includes(service))) {
    score += 25;
    reasons.push('Core lawn service requested');
  }
  if (services.some((service) => service.includes('overgrown') || service.includes('cleanup'))) {
    score += 20;
    reasons.push('Cleanup need');
  }
  ['mulch', 'planting', 'sod'].forEach((serviceName) => {
    if (services.some((service) => service.includes(serviceName))) {
      score += 10;
      reasons.push(`${serviceName[0].toUpperCase()}${serviceName.slice(1)} upsell`);
    }
  });

  if (condition === 'maintained') {
    score += 20;
    reasons.push('Maintained yard');
  } else if (condition === 'a_little_tall') {
    score += 15;
    reasons.push('Manageable tall grass');
  } else if (condition === 'overgrown') {
    score += 10;
    reasons.push('Overgrown but workable');
  } else if (condition === 'very_overgrown') {
    score += 5;
    score -= 10;
    reasons.push('Very overgrown; price carefully');
  }

  if (propertyType === 'small_yard_townhome') {
    score += 15;
    reasons.push('Small/townhome route fit');
  } else if (propertyType === 'medium_residence') {
    score += 10;
    reasons.push('Medium residential job');
  } else if (propertyType === 'larger_residence') {
    score += 5;
    reasons.push('Larger job');
  }

  if (notes.length > 12) {
    score += 10;
    reasons.push('Helpful customer notes');
  }
  if (lead.gate_or_pet_notes) {
    score += 10;
    reasons.push('Gate/pet details included');
  }
  if (['text', 'any'].includes(String(lead.preferred_contact || '').toLowerCase())) {
    score += 10;
    reasons.push('Easy text follow-up');
  }
  if (LOCAL_AREAS.some((area) => city.includes(area))) {
    score += 10;
    reasons.push('Inside core service area');
  } else if (city) {
    score -= 20;
    reasons.push('May be outside route area');
  }
  if (!lead.zip_code) {
    score -= 10;
    reasons.push('Missing ZIP');
  }
  if (!services.length) {
    score -= 15;
    reasons.push('Service request is vague');
  }

  score = Math.max(0, Math.min(100, score));

  let tier = 'Low Priority';
  if (score >= 80) tier = 'Hot Lead';
  else if (score >= 55) tier = 'Good Lead';
  else if (score >= 30) tier = 'Normal Lead';

  return {
    score,
    tier,
    reasons: reasons.slice(0, 5),
  };
}
