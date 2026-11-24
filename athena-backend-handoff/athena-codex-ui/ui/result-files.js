/* Download paths are derived from host-issued scoped IDs, never local file paths. */
(() => {
  'use strict';
  const validId = value => typeof value === 'string' && /^[\w-]+$/.test(value);
  // Renderer identities mirror the published built-in contract; discovery alone
  // never selects a result schema or turns a failed process into a result.
  const builtins = Object.freeze([
    Object.freeze({ server: 'athena-measurements', tool: 'calculate_csv', alias: 'calculate_csv', resultKind: 'csv-statistics', name: 'Measurement statistics', filename: 'statistics.json', action: 'View measurement results' }),
    Object.freeze({ server: 'athena-circuits', tool: 'calculate_rc_response', alias: 'calculate_rc_response', resultKind: 'rc-step-response', name: 'RC step response', filename: 'rc-response.json', action: 'View RC response' })
  ]);
  const phases = Object.freeze({ initialize: 'Connecting', 'tools/list': 'Discovering tools', 'tools/call': 'Calculating' });
  function mcp(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    const entry = builtins.find(item => item.server === metadata.server && item.tool === metadata.tool);
    if (!entry || metadata.version !== '1.0.0' || metadata.protocol !== '2025-06-18') return null;
    const legacy = metadata.registryVersion === undefined && entry.alias === 'calculate_csv';
    if (!legacy && metadata.registryVersion !== 1) return null;
    if ((!legacy || metadata.alias !== undefined) && metadata.alias !== entry.alias
      || (!legacy || metadata.resultKind !== undefined) && metadata.resultKind !== entry.resultKind) return null;
    const name = window.AthenaActivityLabels?.text(metadata.displayName, entry.name, [entry.server, entry.tool]) || entry.name;
    return { ...entry, name };
  }
  const mcpPhase = metadata => Object.hasOwn(phases, metadata?.phase) ? phases[metadata.phase] : null;
  function publishedMcp(process, artifact) {
    return Boolean(process && artifact && process.status === 'succeeded' && process.id === artifact.processId && process.job?.artifact?.id === artifact.id);
  }
  function mcpOutput(process, artifact) {
    const entry = mcp(process?.job?.mcp), receipt = process?.job?.artifact;
    if (!entry || !publishedMcp(process, artifact) || artifact.status === 'unavailable' || receipt.name !== entry.filename
      || receipt.mimeType !== 'application/json') return null;
    for (const file of [receipt, artifact.file].filter(Boolean)) {
      if (file.name !== entry.filename || file.mimeType !== 'application/json'
        || file.mcpAlias !== undefined && file.mcpAlias !== entry.alias) return null;
    }
    return entry;
  }

  function href(conversationId, artifact, process) {
    if (!validId(conversationId) || !validId(artifact?.id) || artifact.status === 'unavailable' || (artifact.sessionId && artifact.sessionId !== conversationId)) return null;
    if ((process?.job?.mcp || artifact.file?.mcpAlias !== undefined) && !publishedMcp(process, artifact)) return null;
    if (artifact.file && (artifact.file.id !== artifact.id || (artifact.file.sessionId && artifact.file.sessionId !== conversationId)
      || (artifact.projectId && artifact.file.projectId && artifact.projectId !== artifact.file.projectId))) return null;
    const path = '/api/artifacts/' + encodeURIComponent(conversationId) + '/' + encodeURIComponent(artifact.id);
    const location = typeof artifact.location === 'string' ? artifact.location : artifact.location?.uri;
    const hasFileMetadata = typeof artifact.name === 'string' && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && /^[a-f0-9]{64}$/.test(artifact.sha256);
    return location === path || artifact.file?.id === artifact.id || hasFileMetadata ? path : null;
  }

  window.AthenaResultFiles = Object.freeze({ href, mcp, mcpPhase, mcpOutput });
})();
