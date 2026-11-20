/* Download paths are derived from host-issued scoped IDs, never local file paths. */
(() => {
  'use strict';
  const validId = value => typeof value === 'string' && /^[\w-]+$/.test(value);

  function href(conversationId, artifact) {
    if (!validId(conversationId) || !validId(artifact?.id) || artifact.status === 'unavailable' || (artifact.sessionId && artifact.sessionId !== conversationId)) return null;
    if (artifact.file && (artifact.file.id !== artifact.id || (artifact.file.sessionId && artifact.file.sessionId !== conversationId)
      || (artifact.projectId && artifact.file.projectId && artifact.projectId !== artifact.file.projectId))) return null;
    const path = '/api/artifacts/' + encodeURIComponent(conversationId) + '/' + encodeURIComponent(artifact.id);
    const location = typeof artifact.location === 'string' ? artifact.location : artifact.location?.uri;
    const hasFileMetadata = typeof artifact.name === 'string' && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && /^[a-f0-9]{64}$/.test(artifact.sha256);
    return location === path || artifact.file?.id === artifact.id || hasFileMetadata ? path : null;
  }

  window.AthenaResultFiles = Object.freeze({ href });
})();
