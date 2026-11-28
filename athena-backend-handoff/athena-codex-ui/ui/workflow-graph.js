/* Read-only Workflow graph. Edges come only from TaskManager's reported relations.
 * waitFor() records children in the parent's dependencies: child -> coordinator.
 * A delegation association is laid out in that same direction, without an arrow,
 * until a dependency is reported. It never claims that the child ran first.
 * Attempts/processes keep their own recorded status; the task is not their status.
 */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const STATUS = { ready: 'Ready', queued: 'Queued', running: 'Running', cancelling: 'Cancelling', paused: 'Paused', blocked: 'Waiting', succeeded: 'Complete', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out', interrupted: 'Interrupted' };
  const status = value => STATUS[value] || 'Not reported';
  const statusKey = value => Object.hasOwn(STATUS, value) ? value : 'unknown';
  const ownScope = (item, snapshot) => ![['projectId', snapshot.projectId], ['sessionId', snapshot.sessionId], ['runId', snapshot.run?.id]].some(([key, value]) => item[key] && value && item[key] !== value);
  const array = value => Array.isArray(value) ? value : [];

  function project(snapshot = {}) {
    const nodes = [], byId = new Map(), edges = [], missing = [], duplicates = [], edgeKeys = new Set();
    for (const task of array(snapshot.tasks)) {
      if (!task || typeof task.id !== 'string' || !task.id || !ownScope(task, snapshot)) continue;
      if (byId.has(task.id)) { duplicates.push(task.id); continue; }
      const node = { id: task.id, task, index: nodes.length, attempts: [], processes: [], dependencies: [], delegatedBy: null, childCount: 0 };
      nodes.push(node); byId.set(node.id, node);
    }
    const addEdge = (source, target, kind) => {
      const key = JSON.stringify([source, target]);
      if (edgeKeys.has(key)) return;
      if (!byId.has(source) || !byId.has(target)) { missing.push({ source, target, kind }); return; }
      edgeKeys.add(key); edges.push({ source, target, kind });
    };
    // Dependency edges take precedence over an association for the same pair.
    for (const node of nodes) {
      node.dependencies = [...new Set(array(node.task.dependencies).filter(id => typeof id === 'string' && id))];
      for (const id of node.dependencies) addEdge(id, node.id, 'dependency');
    }
    for (const node of nodes) {
      const parent = node.task.parentTaskId;
      if (typeof parent === 'string' && parent) {
        node.delegatedBy = parent;
        if (byId.has(parent)) byId.get(parent).childCount++;
        addEdge(node.id, parent, 'delegation');
      }
      node.attempts = array(snapshot.attempts).filter(item => item?.taskId === node.id && ownScope(item, snapshot));
      node.processes = array(snapshot.processes).filter(item => item?.taskId === node.id && ownScope(item, snapshot));
    }

    // Condense strongly connected components before ranking. A bad dependency
    // cycle remains visible as a cycle; its members never get a made-up order.
    const outgoing = new Map(nodes.map(node => [node.id, []]));
    edges.forEach(edge => outgoing.get(edge.source).push(edge.target));
    let serial = 0;
    const indices = new Map(), low = new Map(), stack = [], onStack = new Set(), components = [];
    function visit(id) {
      indices.set(id, serial); low.set(id, serial++); stack.push(id); onStack.add(id);
      for (const target of outgoing.get(id)) {
        if (!indices.has(target)) { visit(target); low.set(id, Math.min(low.get(id), low.get(target))); }
        else if (onStack.has(target)) low.set(id, Math.min(low.get(id), indices.get(target)));
      }
      if (low.get(id) !== indices.get(id)) return;
      const members = []; let member;
      do { member = stack.pop(); onStack.delete(member); members.push(member); } while (member !== id);
      components.push(members.sort((a, b) => byId.get(a).index - byId.get(b).index));
    }
    nodes.forEach(node => { if (!indices.has(node.id)) visit(node.id); });
    const componentOf = new Map();
    components.forEach((members, index) => members.forEach(id => componentOf.set(id, index)));
    const componentEdges = components.map(() => new Set()), indegree = components.map(() => 0), rank = components.map(() => 0);
    edges.forEach(edge => {
      const from = componentOf.get(edge.source), to = componentOf.get(edge.target);
      edge.cyclic = from === to && (components[from].length > 1 || edge.source === edge.target);
      if (from !== to && !componentEdges[from].has(to)) { componentEdges[from].add(to); indegree[to]++; }
    });
    const queue = components.map((_, index) => index).filter(index => indegree[index] === 0);
    for (let i = 0; i < queue.length; i++) {
      const from = queue[i];
      for (const to of componentEdges[from]) { rank[to] = Math.max(rank[to], rank[from] + 1); if (--indegree[to] === 0) queue.push(to); }
    }
    const cyclicIds = new Set(edges.filter(edge => edge.cyclic).flatMap(edge => [edge.source, edge.target]));
    const layers = [];
    nodes.forEach(node => {
      node.rank = rank[componentOf.get(node.id)]; node.cyclic = cyclicIds.has(node.id);
      (layers[node.rank] ||= []).push(node);
    });
    // At most four cards in a row; large levels wrap without inventing edges.
    const cardWidth = 224, gap = 24, margin = 24, maxColumns = 4;
    const rowColumns = Math.max(1, ...layers.map(layer => Math.min(maxColumns, layer.length)));
    const width = margin * 2 + rowColumns * cardWidth + (rowColumns - 1) * gap;
    let y = margin;
    for (const layer of layers) {
      for (let start = 0; start < layer.length; start += maxColumns) {
        const row = layer.slice(start, start + maxColumns), left = (width - (row.length * cardWidth + (row.length - 1) * gap)) / 2;
        let maxHeight = 0;
        row.forEach((node, index) => {
          const processRows = Math.min(2, node.processes.length);
          node.height = 116 + (node.attempts.length > 1 ? 24 : 0) + (processRows ? processRows * 31 + 8 : 0) + (node.processes.length > 2 ? 24 : 0);
          node.width = cardWidth; node.x = left + index * (cardWidth + gap); node.y = y;
          maxHeight = Math.max(maxHeight, node.height);
        });
        y += maxHeight + 68;
      }
    }
    return { nodes, edges, missing, duplicates, cyclicIds: [...cyclicIds], layers, width, height: Math.max(180, y - 68 + margin) };
  }

  function render(model, options = {}) {
    if (!model.nodes.length) return '<div class="awg-empty"><span aria-hidden="true">◇</span><p>No workflow tasks yet</p><small>Reported tasks and their relationships will appear here.</small></div>';
    const byId = new Map(model.nodes.map(node => [node.id, node]));
    const title = item => options.taskTitle?.(item) || window.AthenaActivityLabels?.task(item, model.nodes.map(node => node.task)) || 'Task';
    const clean = (value, fallback, ids) => window.AthenaActivityLabels?.text(value, fallback, ids) || fallback;
    const knownIds = model.nodes.flatMap(node => [node.id, node.task.parentTaskId, node.task.attemptId, node.task.agentSessionId, ...node.attempts.map(attempt => attempt.id), ...node.processes.flatMap(process => [process.id, process.toolId, process.attemptId, process.agentSessionId])]);
    const processName = process => {
      const job = process.job || process;
      if (job.codeMode) return 'Research comparison';
      return clean(window.AthenaResultFiles?.mcp(job.mcp)?.name || job.program, job.mcp ? 'Engineering calculation' : 'Background process', knownIds);
    };
    const nodeTitle = id => byId.has(id) ? title(byId.get(id).task) : 'Unavailable task';
    function edgePath(edge) {
      const from = byId.get(edge.source), to = byId.get(edge.target);
      const x1 = from.x + from.width / 2, y1 = from.y + from.height, x2 = to.x + to.width / 2, y2 = to.y;
      if (edge.cyclic) {
        if (edge.source === edge.target) return 'M ' + (from.x + from.width) + ' ' + (from.y + 32) + ' C ' + (from.x + from.width + 22) + ' ' + (from.y + 32) + ', ' + (from.x + from.width + 22) + ' ' + (from.y + from.height - 24) + ', ' + (from.x + from.width) + ' ' + (from.y + from.height - 24);
        return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + 28) + ', ' + x2 + ' ' + (to.y + to.height + 28) + ', ' + x2 + ' ' + (to.y + to.height);
      }
      const mid = y1 + (y2 - y1) / 2;
      return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + mid + ', ' + x2 + ' ' + mid + ', ' + x2 + ' ' + y2;
    }
    const warnings = [model.missing.length ? 'Some linked tasks are not available in this run.' : '', model.cyclicIds.length ? 'Circular relationships were reported. These tasks are grouped without a claimed execution order.' : '', model.duplicates.length ? 'Duplicate task records were reported; each task is shown once.' : ''].filter(Boolean);
    const summary = model.nodes.filter(node => node.task.status === 'succeeded').length + ' complete · ' + model.nodes.filter(node => ['running', 'queued', 'cancelling'].includes(node.task.status)).length + ' active · ' + model.nodes.filter(node => ['failed', 'cancelled', 'timed_out', 'paused', 'interrupted'].includes(node.task.status)).length + ' stopped';
    return '<section class="awg" aria-label="Workflow graph">'
      + '<div class="awg-controls"><span class="awg-summary">' + esc(summary) + '</span><div role="group" aria-label="Graph zoom"><button type="button" data-awv-action="graph-zoom-out" data-awv-focus="graph-zoom-out" aria-label="Zoom out workflow graph">−</button><output data-awg-zoom aria-label="Graph zoom">100%</output><button type="button" data-awv-action="graph-zoom-in" data-awv-focus="graph-zoom-in" aria-label="Zoom in workflow graph">+</button><button type="button" data-awv-action="graph-fit" data-awv-focus="graph-fit">Fit</button><button type="button" data-awv-action="graph-actual" data-awv-focus="graph-actual" aria-label="Show workflow graph at actual size">1:1</button></div></div>'
      + (warnings.length ? '<p class="awg-warning" role="status">' + warnings.map(esc).join(' ') + '</p>' : '')
      + '<div class="awg-viewport" data-awg-viewport tabindex="0" aria-label="Workflow graph. Scroll to explore. Use Tab to select a task or process."><div class="awg-plane" data-awg-plane style="width:' + model.width + 'px;height:' + model.height + 'px"><div class="awg-canvas" data-awg-canvas style="width:' + model.width + 'px;height:' + model.height + 'px">'
      + '<svg class="awg-edges" width="' + model.width + '" height="' + model.height + '" viewBox="0 0 ' + model.width + ' ' + model.height + '" aria-hidden="true"><defs><marker id="awg-dependency-arrow" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z"/></marker></defs>'
      + model.edges.map(edge => '<path data-awg-edge="' + esc(edge.kind) + '" class="awg-edge awg-edge-' + edge.kind + (edge.cyclic ? ' awg-edge-cyclic' : '') + '" d="' + edgePath(edge) + '"' + (edge.kind === 'dependency' ? ' marker-end="url(#awg-dependency-arrow)"' : '') + '/>').join('') + '</svg>'
      + '<div class="awg-nodes" role="list" aria-label="Tasks and their recorded work">' + model.nodes.map(node => {
        const selected = options.selectedTaskId === node.id, attempts = node.attempts;
        const current = attempts.find(attempt => attempt.id === node.task.attemptId);
        const currentIndex = current ? attempts.indexOf(current) + 1 : null;
        const relation = (node.dependencies.length ? 'Depends on ' + node.dependencies.map(nodeTitle).join(', ') + '. ' : '') + (node.delegatedBy ? 'Delegated by ' + nodeTitle(node.delegatedBy) + '. ' : '');
        const caption = node.childCount ? 'Coordinator · ' + node.childCount + (node.childCount === 1 ? ' child' : ' children') : node.delegatedBy ? 'Delegated task' : 'Task';
        const owner = clean(options.taskOwner?.(node.task), '', knownIds);
        const prior = attempts.filter(attempt => attempt.id !== node.task.attemptId).map(attempt => status(attempt.status)).join(', ');
        return '<article class="awg-node' + (selected ? ' awg-node-selected' : '') + (node.cyclic ? ' awg-node-cyclic' : '') + '" role="listitem" data-awg-node="' + esc(node.id) + '" data-awg-status="' + statusKey(node.task.status) + '" style="left:' + node.x + 'px;top:' + node.y + 'px;width:' + node.width + 'px;height:' + node.height + 'px">'
          + '<button type="button" class="awg-task" data-awv-task="' + esc(node.id) + '" data-awv-focus="task-' + esc(node.id) + '" aria-pressed="' + selected + '" title="' + esc(title(node.task)) + '"><span class="awg-node-kicker">' + esc(caption) + '<span class="awg-status" data-status="' + statusKey(node.task.status) + '">' + esc(status(node.task.status)) + '</span></span><span class="awg-title">' + (options.avatar ? '<span class="awg-avatar">' + options.avatar(node.task) + '</span>' : '') + '<strong>' + esc(title(node.task)) + '</strong></span><span class="awg-node-meta">' + esc([owner, currentIndex ? 'Attempt ' + currentIndex : ''].filter(Boolean).join(' · ') || 'Select to inspect this task') + '</span><span class="awv-sr-only">' + esc(relation) + '</span></button>'
          + (attempts.length > 1 ? '<p class="awg-attempt-history" title="' + esc('Previous attempts: ' + prior) + '">' + esc(attempts.length + ' attempts · Previous: ' + prior) + '</p>' : '')
          + (node.processes.length ? '<div class="awg-processes" aria-label="Recorded processes">' + node.processes.slice(0, 2).map(process => '<button type="button" data-awv-open-process="' + esc(process.id) + '" data-awv-focus="graph-process-' + esc(process.id) + '" title="' + esc(processName(process) + ' · ' + status(process.status)) + '"><span>' + esc(processName(process)) + '</span><small data-status="' + statusKey(process.status) + '">' + esc(status(process.status)) + '</small></button>').join('') + '</div>' : '')
          + (node.processes.length > 2 ? '<button type="button" class="awg-more" data-awv-task="' + esc(node.id) + '" data-awv-focus="graph-more-' + esc(node.id) + '">View all ' + node.processes.length + ' processes</button>' : '') + '</article>';
      }).join('') + '</div></div></div></div>'
      + '<div class="awg-legend"><span><i class="awg-legend-dependency" aria-hidden="true"></i>Recorded dependency</span><span><i class="awg-legend-delegation" aria-hidden="true"></i>Delegation</span></div><p class="awg-note">Arrows show reported dependencies. Dotted links show delegation, not execution order. Select a task for its attempts, tools and results.</p></section>';
  }
  window.AthenaWorkflowGraph = Object.freeze({ project, render });
})();
