// Stick-figure avatars, whiteboard style.
//
// There is no customizer for now (that's a future TODO). Instead each athlete
// gets a stable, distinct figure derived from their name, so the board stays
// fun and recognisable. Earning an achievement can unlock cosmetic extras
// (e.g. the gripper jersey).

const HAIR = ['none', 'short', 'spiky', 'long', 'afro', 'mohawk'];
const FACIAL = ['none', 'beard', 'mustache', 'goatee', 'fullBeard'];
const OUTFIT = ['basic', 'tank', 'hoodie'];

// Simple stable string hash -> non-negative int.
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

// Derive a deterministic look from the athlete's name + earned achievements.
function configFor(athlete) {
  const h = hash(athlete.name || '');
  const achievements = athlete.achievements || [];
  const hasGripper = achievements.includes('gripper90kg');
  return {
    hair: HAIR[h % HAIR.length],
    facialHair: FACIAL[Math.floor(h / 7) % FACIAL.length],
    outfit: hasGripper ? 'gripper' : OUTFIT[Math.floor(h / 13) % OUTFIT.length],
    badge: hasGripper,
  };
}

function renderHair(style) {
  switch (style) {
    case 'short':
      return `<path d="M 35 15 Q 35 9 50 9 Q 65 9 65 15" fill="#3d3d3d" stroke="#2c3e50" stroke-width="1.5" stroke-linejoin="round"/>`;
    case 'spiky':
      return `
        <line x1="40" y1="12" x2="37" y2="3" stroke="#3d3d3d" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="50" y1="10" x2="50" y2="1" stroke="#3d3d3d" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="60" y1="12" x2="63" y2="3" stroke="#3d3d3d" stroke-width="2.5" stroke-linecap="round"/>`;
    case 'long':
      return `
        <path d="M 35 15 Q 35 9 50 9 Q 65 9 65 15" fill="#3d3d3d" stroke="#2c3e50" stroke-width="1.5"/>
        <path d="M 35 16 L 32 38" stroke="#3d3d3d" stroke-width="4" stroke-linecap="round"/>
        <path d="M 65 16 L 68 38" stroke="#3d3d3d" stroke-width="4" stroke-linecap="round"/>`;
    case 'afro':
      return `<circle cx="50" cy="16" r="17" fill="#3d3d3d" opacity="0.85"/>`;
    case 'mohawk':
      return `<path d="M 50 2 L 44 12 L 56 12 Z" fill="#ef4444" stroke="#b91c1c" stroke-width="1" stroke-linejoin="round"/>`;
    default:
      return '';
  }
}

function renderFacialHair(style) {
  switch (style) {
    case 'beard':
      return `<path d="M 40 30 Q 50 39 60 30" fill="#3d3d3d" stroke="#2c3e50" stroke-width="1"/>`;
    case 'mustache':
      return `<path d="M 42 29 Q 50 32 58 29" fill="none" stroke="#3d3d3d" stroke-width="2.5" stroke-linecap="round"/>`;
    case 'goatee':
      return `<path d="M 46 31 Q 50 37 54 31" fill="#3d3d3d" stroke="#2c3e50" stroke-width="1"/>`;
    case 'fullBeard':
      return `
        <path d="M 42 29 Q 50 32 58 29" fill="none" stroke="#3d3d3d" stroke-width="2" stroke-linecap="round"/>
        <path d="M 37 27 Q 50 44 63 27" fill="#3d3d3d" stroke="#2c3e50" stroke-width="1"/>`;
    default:
      return '';
  }
}

function renderOutfit(style) {
  switch (style) {
    case 'tank':
      return `<path d="M 43 43 L 57 43 L 56 67 L 44 67 Z" fill="#3b82f6" stroke="#1e40af" stroke-width="1.5" stroke-linejoin="round"/>`;
    case 'hoodie':
      return `
        <path d="M 40 43 L 60 43 L 58 70 L 42 70 Z" fill="#ef4444" stroke="#b91c1c" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M 50 43 L 50 56" stroke="#b91c1c" stroke-width="1.5"/>`;
    case 'gripper':
      return `
        <path d="M 40 43 L 60 43 L 58 70 L 42 70 Z" fill="#f59e0b" stroke="#b45309" stroke-width="1.5" stroke-linejoin="round"/>
        <text x="50" y="60" font-size="13" text-anchor="middle">💪</text>`;
    default:
      return '';
  }
}

// Escape text for safe interpolation into an HTML/SVG attribute.
function escapeAttr(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Public: returns an inline SVG string for an athlete.
window.renderAvatar = function renderAvatar(athlete, size = 100) {
  const c = configFor(athlete);
  const stroke = '#2c3e50';
  return `
    <svg class="avatar-svg" viewBox="0 0 100 124" width="${size}" height="${size * 1.24}"
         xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeAttr(athlete.name || 'athlete')} avatar">
      <g stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" fill="none" filter="url(#roughen)">
        <!-- head -->
        <circle cx="50" cy="24" r="15" fill="#fff"/>
        <!-- torso / arms / legs -->
        <path d="M 50 39 L 50 78"/>
        <path d="M 50 50 L 31 66"/>
        <path d="M 50 50 L 69 66"/>
        <path d="M 50 78 L 35 112"/>
        <path d="M 50 78 L 65 112"/>
        <path d="M 35 112 L 26 113"/>
        <path d="M 65 112 L 74 113"/>
      </g>
      <!-- face -->
      <circle cx="45" cy="23" r="2" fill="${stroke}"/>
      <circle cx="55" cy="23" r="2" fill="${stroke}"/>
      <path d="M 44 30 Q 50 34 56 30" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
      ${renderFacialHair(c.facialHair)}
      ${renderHair(c.hair)}
      ${renderOutfit(c.outfit)}
      ${c.badge ? `<circle cx="68" cy="58" r="6" fill="#f59e0b" stroke="#b45309" stroke-width="1"/><text x="68" y="61.5" font-size="7" text-anchor="middle">💪</text>` : ''}
    </svg>`;
};
