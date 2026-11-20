/* Small geometric agent marks. A runtime agent ID determines one stable shape;
 * status updates never change its identity. Pure decorative markup: no assets,
 * requests, timers, listeners, or persistent state. The enclosing control owns
 * the accessible agent name, role, and status.
 */
(() => {
  'use strict';

  const ROLES = Object.freeze({ researcher: 'Scout', analyst: 'Pip', reviewer: 'Sage', writer: 'Quill' });
  const ROLE_ALIASES = Object.freeze({ scout: 'researcher', pip: 'analyst', sage: 'reviewer', quill: 'writer' });
  const STATES = Object.freeze(['working', 'waiting', 'paused', 'done', 'stopped']);
  const STATE_ALIASES = Object.freeze({
    focused: 'working', running: 'working',
    thoughtful: 'waiting', idle: 'waiting', queued: 'waiting', blocked: 'waiting',
    sleepy: 'paused', happy: 'done', completed: 'done', succeeded: 'done',
    resting: 'stopped', cancelled: 'stopped', failed: 'stopped'
  });
  const SHAPES = Object.freeze(['circle', 'triangle', 'diamond', 'hexagon', 'pentagon', 'octagon', 'arch', 'lozenge', 'parallelogram', 'cross', 'quarter', 'ring']);
  const TONES = Object.freeze(['lavender', 'teal', 'blue', 'olive']);

  function identityHash(text) {
    // FNV-1a plus an avalanche mixes similar task IDs into different marks.
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    return hash >>> 0;
  }

  function seedValue(value) {
    if (typeof value === 'string' && value.length) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
  }

  function html(options = {}) {
    const value = options && typeof options === 'object' ? options : {};
    const requestedRole = typeof value.role === 'string' ? value.role.toLowerCase() : '';
    const role = Object.hasOwn(ROLES, requestedRole) ? requestedRole : Object.hasOwn(ROLE_ALIASES, requestedRole) ? ROLE_ALIASES[requestedRole] : 'researcher';
    const requestedState = typeof value.status === 'string' ? value.status.toLowerCase() : '';
    const status = STATES.includes(requestedState) ? requestedState : Object.hasOwn(STATE_ALIASES, requestedState) ? STATE_ALIASES[requestedState] : 'waiting';
    const size = typeof value.size === 'number' && Number.isFinite(value.size) ? Math.max(20, Math.min(96, Math.round(value.size))) : 40;
    const identity = identityHash(seedValue(value.agentId) || seedValue(value.seed) || 'athena-agent:' + role);
    const shape = SHAPES[identity % SHAPES.length];
    const tone = TONES[(identity >>> 16) % TONES.length];
    const turn = ((identity >>> 8) % 8) * 45;

    // Raw IDs and caller strings never enter the markup. All interpolated values
    // are closed-list selections or bounded numbers / a hexadecimal hash.
    return `<span class="aav-avatar aav-role-${role} aav-state-${status}" data-avatar-role="${role}" data-avatar-status="${status}" data-avatar-name="${ROLES[role]}" data-avatar-size="${size}" data-avatar-shape="${shape}" data-avatar-tone="${tone}" data-avatar-identity="${identity.toString(16)}" style="--aav-size:${size}px;--aav-turn:${turn}deg" aria-hidden="true"><span class="aav-glyph aav-shape-${shape}"></span></span>`;
  }

  window.AthenaAvatars = Object.freeze({ html });
})();
