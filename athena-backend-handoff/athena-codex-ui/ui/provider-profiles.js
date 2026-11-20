/* M3 provider credentials, SDK catalogs, and saved model profiles.
 * The host owns every real credential write; this panel only calls the
 * model-profiles RPC adapter. API keys are never rendered, stored in the DOM,
 * or echoed back; the OAuth surface shows only the safe authorization URL. */
(() => {
  'use strict';

  const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const LEVEL_LABELS = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const AUTH_LABELS = { not_checked: 'Credential status not checked', unconfigured: 'Not configured', configured: 'Configured', refresh_required: 'Sign-in refresh required', error: 'Credential error' };
  /* Backend OAuth terminal values are exactly succeeded | failed | cancelled. Start
   * returns only {id, status:'pending'}; the authorizeUrl arrives on polling and
     is surfaced as a user-activated link so popup blocking never blocks sign-in. */
  const OAUTH_DONE = ['succeeded'];
  const OAUTH_FAILED = ['failed', 'cancelled'];
  const PROBE_FAILED = ['failed', 'error', 'unavailable'];
  /* ~15 minutes of polling at the interval below. */
  const OAUTH_POLL_MS = 2000, OAUTH_MAX_POLLS = 450;

  const rows = value => Array.isArray(value) ? value : [];
  const text = value => value == null ? '' : String(value);
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
  const idOf = value => typeof value === 'string' && value.length ? value : null;
  const escapeHTML = value => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const elapsed = when => {
    const at = Date.parse(when);
    if (!Number.isFinite(at)) return text(when);
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' minutes ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' hours ago';
    return new Date(at).toLocaleDateString();
  };

  function validEndpoint(endpoint) {
    try {
      const url = new URL(String(endpoint).trim());
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return 'Use a full http:// or https:// URL.';
      if (url.username || url.password || url.search || url.hash) return 'Use a base URL without credentials, query parameters, or a fragment.';
      if (endpoint.length > 2048) return 'Keep the endpoint URL under 2,048 characters.';
      return '';
    } catch (_) { return 'Use a full http:// or https:// URL.'; }
  }

  function mount(slot, options = {}) {
    if (!slot) throw new TypeError('AthenaProviderProfiles.mount requires a host element.');
    const controller = new AbortController();
    const listen = (element, type, callback) => element?.addEventListener(type, callback, { signal: controller.signal });
    let destroyed = false, adapter = null, generation = 0;
    const owners = new Map();
    let providers = [], providerQuery = '', providersError = '';
    let catalog = null, catalogProvider = '', catalogQuery = '', catalogError = '';
    let list = { profiles: [], appDefaultProfileId: null, credentialMode: null, hostModel: null }, listError = '';
    /* One provider sign-in at a time, keyed by providerId. */
    let flow = null, flowPolls = 0;
    /* null | { id?, revision?, name, provider, modelId, thinkingLevel } */
    let editing = null;
    const busyActions = new Set();
    const providerNotes = new Map();
    const at = key => busyActions.has(key);

    slot.innerHTML = `
      <div class="amp-root" data-amp-mounted="false" hidden>
        <header class="amp-heading">
          <div><span class="ams-eyebrow">HOST MODEL PROFILES</span><h2>Providers &amp; saved models</h2></div>
          <span class="ams-local-badge">${icon('server')}<span data-amp-credential-mode>Host credentials</span></span>
        </header>
        <p class="ams-intro">Saved model profiles name a provider model plus a reasoning level. The app default applies to new conversations; a project or a single conversation can select its own profile. The connected host owns every credential write.</p>

        <section class="amp-section" aria-labelledby="amp-providers-title">
          <div class="ams-section-title"><h3 id="amp-providers-title">Provider credentials</h3><span>01</span></div>
          <p class="ams-section-copy">Search the providers registered by the installed Pi SDK. Sign-in methods come from the SDK and Athena's provider policy.</p>
          <label class="amp-search">${icon('search')}<input type="search" data-amp-provider-search placeholder="Search providers" aria-label="Search providers" autocomplete="off" spellcheck="false"></label>
          <div class="amp-list" role="list" data-amp-providers></div>
          <p class="amp-error" role="alert" data-amp-providers-error hidden></p>
          <details class="amp-register">
            <summary class="cursor-interaction">${icon('plus')}Register an OpenAI-compatible endpoint</summary>
            <form class="amp-register-form" novalidate>
              <div class="amp-register-grid">
                <div class="amp-field"><label for="amp-register-name">Name</label><input class="ams-input" id="amp-register-name" data-amp-register="name" maxlength="60" autocomplete="off" placeholder="Team gateway"></div>
                <div class="amp-field"><label for="amp-register-endpoint">Endpoint base URL</label><input class="ams-input" id="amp-register-endpoint" data-amp-register="endpoint" type="url" maxlength="2048" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://gateway.example/v1"></div>
                <div class="amp-field"><label for="amp-register-key">API key <span class="amp-optional">(optional)</span></label><input class="ams-input" id="amp-register-key" data-amp-register="apiKey" type="password" maxlength="8192" autocomplete="off" placeholder="Stored by the host, never displayed"></div>
              </div>
              <div class="amp-actions"><button type="button" class="ams-button cursor-interaction" data-amp-register-submit>${icon('plug-zap')}Register endpoint</button><p class="amp-status" role="status" data-amp-register-status></p></div>
            </form>
          </details>
        </section>

        <section class="amp-section" aria-labelledby="amp-catalog-title">
          <div class="ams-section-title"><h3 id="amp-catalog-title">Model catalog</h3><span>02</span></div>
          <p class="ams-section-copy">The catalog lists models registered in the SDK. Eligibility marks the models your credentials can select. Only an explicit profile verification probes a live inference.</p>
          <div class="amp-catalog-bar">
            <select class="ams-input cursor-interaction" data-amp-catalog-provider aria-label="Catalog provider"></select>
            <label class="amp-search amp-catalog-search">${icon('search')}<input type="search" data-amp-catalog-search placeholder="Search catalog models" aria-label="Search catalog models" autocomplete="off" spellcheck="false"></label>
            <button type="button" class="ams-button cursor-interaction" data-amp-catalog-refresh>${icon('refresh-cw')}Refresh</button>
          </div>
          <p class="amp-catalog-meta" data-amp-catalog-meta></p>
          <div class="amp-list" role="list" data-amp-models></div>
          <p class="amp-error" role="alert" data-amp-catalog-error hidden></p>
        </section>

        <section class="amp-section" aria-labelledby="amp-profiles-title">
          <div class="ams-section-title"><h3 id="amp-profiles-title">Saved model profiles</h3><span>03</span></div>
          <p class="amp-section-copy" data-amp-profiles-intro></p>
          <div class="amp-list" role="list" data-amp-profiles></div>
          <p class="amp-error" role="alert" data-amp-profiles-error hidden></p>
          <div class="amp-actions amp-profiles-actions">
            <button type="button" class="ams-button cursor-interaction" data-amp-profile-new>${icon('plus')}New model profile</button>
          </div>
          <form class="amp-profile-form" data-amp-profile-form novalidate hidden>
            <div class="amp-profile-form-grid">
              <div class="amp-field"><label for="amp-profile-name">Profile name</label><input class="ams-input" id="amp-profile-name" data-amp-profile-field="name" maxlength="80" autocomplete="off" placeholder="Fast writer"></div>
              <div class="amp-field"><label for="amp-profile-provider">Provider</label><select class="ams-input cursor-interaction" id="amp-profile-provider" data-amp-profile-field="provider"></select></div>
              <div class="amp-field"><label for="amp-profile-model">Model</label><select class="ams-input cursor-interaction" id="amp-profile-model" data-amp-profile-field="modelId"></select></div>
              <div class="amp-field"><label for="amp-profile-level">Reasoning level</label><select class="ams-input cursor-interaction" id="amp-profile-level" data-amp-profile-field="thinkingLevel"></select></div>
            </div>
            <p class="amp-error" role="alert" data-amp-profile-form-error hidden></p>
            <div class="amp-actions">
              <button type="button" class="ams-button ams-primary cursor-interaction" data-amp-profile-save>${icon('check')}Save profile</button>
              <button type="button" class="ams-button cursor-interaction" data-amp-profile-cancel>Cancel</button>
            </div>
          </form>
        </section>
      </div>`;
    const root = slot.querySelector('.amp-root');
    const q = selector => root.querySelector(selector);
    const listNode = key => q('[data-amp-' + key + ']');

    const workspace = () => options.getWorkspace?.() || {};
    const currentSession = () => rows(workspace().sessions).find(item => item.id === workspace().sessionId) || null;
    const currentProject = () => rows(workspace().projects).find(item => item.id === workspace().projectId) || null;
    const profileById = id => rows(list.profiles).find(item => item.id === id) || null;
    const busy = (key, value) => { if (value) busyActions.add(key); else busyActions.delete(key); render(); };
    const note = (element, message, tone) => { element.textContent = message; element.dataset.tone = tone || ''; element.hidden = !message; };
    const providerNote = (providerId, message, tone) => {
      if (message) providerNotes.set(providerId, { message, tone });
      else providerNotes.delete(providerId);
      render();
    };

    /* Per-key request ownership: only the current owner of a key may apply a
     * result or clear that key's busy flag, so overlapping independent
     * requests cannot supersede or strand each other. A distinct attachment
     * generation retires every in-flight request from a previous host. */
    async function call(key, action, after, replace = false) {
      if (!adapter || (at(key) && !replace)) return;
      const attach = generation;
      const token = (owners.get(key) || 0) + 1;
      owners.set(key, token);
      busy(key, true);
      try {
        const result = await action();
        if (destroyed || attach !== generation || owners.get(key) !== token) return null;
        if (after) await after(result);
        return result;
      } catch (error) {
        if (!destroyed && attach === generation && owners.get(key) === token) { options.toast?.(String(error?.message || error)); render(); }
        return null;
      } finally {
        if (attach === generation && owners.get(key) === token) { owners.delete(key); busy(key, false); }
      }
    }

    async function loadProviders() {
      await call('providers', () => adapter.listProviders(providerQuery), result => {
        providers = rows(result); providersError = '';
        if (catalog?.provider) providers = providers.map(provider => provider.id === catalog.provider.id ? { ...provider, ...catalog.provider } : provider);
        if (!providers.length && providerQuery) providersError = 'No provider matches this search.';
        if (!catalogProvider && providers.length) { catalogProvider = providers[0].id; void loadCatalog(false); }
        syncCatalogOptions();
      }, true);
    }
    async function saveKey(providerId) {
      const input = root.querySelector('[data-amp-key-input="' + providerId + '"]');
      const key = input ? String(input.value) : '';
      if (!key || /\s|[\x00-\x1f\x7f]/u.test(key) || key.length > 8192) {
        providerNote(providerId, 'Enter a nonempty API key without whitespace. The key is sent to the host only.', 'error');
        return;
      }
      await call('key:' + providerId, () => adapter.saveProviderApiKey(providerId, key), () => {
        input.value = ''; /* Never keep or echo the credential value in the page. */
        providerNote(providerId, 'API key stored by the host' + (list.credentialMode ? ' in the ' + list.credentialMode.replace(/_/g, ' ') + ' vault' : '') + '.', 'success');
      });
      await Promise.all([loadProviders(), loadCatalog(false)]);
    }
    async function removeKey(providerId) {
      await call('logout:' + providerId, () => adapter.logoutProvider(providerId), () => {
        providerNote(providerId, 'Credentials removed by the host.', 'success');
      });
      await Promise.all([loadProviders(), loadCatalog(false)]);
    }
    async function startOAuth(providerId) {
      if (flow) return;
      await call('oauth:' + providerId, () => adapter.startProviderOAuth(providerId), result => {
        const authUrl = text(result?.authUrl || result?.auth_url || result?.authorizeUrl);
        const flowId = idOf(result?.flowId || result?.id);
        if (!flowId) throw new Error('The host did not return a sign-in flow.');
        flow = { providerId, flowId, authUrl, status: 'pending', message: '' };
        flowPolls = 0;
        if (authUrl) window.open?.(authUrl, '_blank', 'noopener,noreferrer');
        render();
        pollOAuth();
      });
    }
    function pollOAuth() {
      if (destroyed || !flow || !adapter) return;
      const current = flow, attach = generation;
      if (flowPolls > OAUTH_MAX_POLLS) { flow = { ...current, status: 'error', message: 'Sign-in timed out. Cancel and try again.' }; render(); return; }
      adapter.getProviderOAuth(current.flowId).then(state => {
        if (destroyed || attach !== generation || !flow || flow.flowId !== current.flowId) return;
        const status = text(state?.status || state?.state).toLowerCase();
        const url = text(state?.authorizeUrl || state?.authUrl || state?.auth_url);
        flowPolls++;
        if (OAUTH_DONE.includes(status)) flow = { ...current, status: 'authorized', message: '' };
        else if (OAUTH_FAILED.includes(status)) flow = { ...current, status: 'error', message: state?.error === 'credential_save_failed'
          ? 'Sign-in was verified but the host could not save the credential.' : status === 'cancelled'
            ? 'Sign-in was cancelled.' : 'The provider rejected the sign-in or the callback could not be verified.' };
        else flow = { ...current, status: 'pending', authUrl: current.authUrl || url, message: text(state?.message) || (status && status !== 'pending' ? 'Provider sign-in status: ' + status : '') };
        render();
        if (flow?.status === 'pending') { flowTimer = setTimeout(pollOAuth, OAUTH_POLL_MS); return; }
        void loadProviders(); void loadCatalog(false); void loadList();
      }).catch(() => {
        if (destroyed || attach !== generation || !flow || flow.flowId !== current.flowId) return;
        flow = { ...current, status: 'error', message: 'The host could not be reached while checking this sign-in.' };
        render();
      });
    }
    async function cancelOAuth() {
      if (!flow) return;
      const current = flow; flow = null; clearTimeout(flowTimer); flowTimer = null;
      await call('oauth:' + current.providerId, () => adapter.cancelProviderOAuth(current.flowId));
      render();
    }
    let flowTimer = null;

    async function registerEndpoint() {
      const fields = {};
      for (const input of root.querySelectorAll('[data-amp-register]')) fields[input.dataset.ampRegister] = input.value;
      const name = String(fields.name || '').trim(), endpoint = String(fields.endpoint || '').trim(), apiKey = String(fields.apiKey || '');
      const errorNode = q('[data-amp-register-status]');
      if (!name) { note(errorNode, 'Enter a name for this endpoint.', 'error'); return; }
      const endpointError = validEndpoint(endpoint);
      if (endpointError) { note(errorNode, endpointError, 'error'); return; }
      if (apiKey && (/\s|[\x00-\x1f\x7f]/u.test(apiKey) || apiKey.length > 8192)) { note(errorNode, 'Enter an API key without whitespace, or leave it empty.', 'error'); return; }
      await call('register', () => adapter.registerCompatibleEndpoint(apiKey ? { name, endpoint, apiKey } : { name, endpoint }), () => {
        for (const input of root.querySelectorAll('[data-amp-register]')) input.value = '';
        q('.amp-register').open = false;
        note(errorNode, 'Endpoint registered by the host. Configure its key there if you left it empty.', 'success');
      });
      await loadProviders();
    }

    async function loadCatalog(refresh) {
      if (!catalogProvider) return;
      await call('catalog', () => adapter.getProviderCatalog(catalogProvider, { query: catalogQuery, refresh }), result => {
        catalog = result && rows(result.models) === result.models ? result : { ...result, models: rows(result?.models) };
        catalogError = text(result?.error) || '';
        if (catalog.provider) providers = providers.map(provider => provider.id === catalog.provider.id ? { ...provider, ...catalog.provider } : provider);
      }, true);
      render();
    }
    function syncCatalogOptions() {
      const select = q('[data-amp-catalog-provider]');
      const seen = catalogProvider;
      select.replaceChildren(...providers.map(provider => {
        const option = document.createElement('option');
        option.value = provider.id; option.textContent = provider.name || provider.id;
        if (provider.id === seen) option.selected = true;
        return option;
      }));
      if (!providers.some(provider => provider.id === seen)) catalogProvider = providers[0]?.id || '';
      if (window.HTMLElement) select.value = catalogProvider;
    }

    async function loadList() {
      await call('list', () => adapter.listModelProfiles(), result => {
        list = {
          profiles: rows(result?.profiles),
          appDefaultProfileId: idOf(result?.appDefaultProfileId),
          credentialMode: idOf(result?.credentialMode),
          hostModel: result?.hostModel || null
        };
        listError = '';
        if (!rows(list.profiles).length) listError = '';
      });
      render();
    }
    async function saveProfile() {
      if (!editing || at('profile-catalog')) return;
      const draft = { ...editing };
      const errorNode = q('[data-amp-profile-form-error]');
      const name = String(draft.name || '').trim();
      if (!name) { note(errorNode, 'Enter a profile name.', 'error'); return; }
      if (!draft.provider || !draft.modelId) { note(errorNode, 'Choose a provider and a model.', 'error'); return; }
      const input = { name, provider: draft.provider, modelId: draft.modelId, thinkingLevel: draft.thinkingLevel };
      if (draft.id) { input.id = draft.id; input.revision = draft.revision; }
      await call('profile-save', () => adapter.saveModelProfile(input), () => { editing = null; });
      if (editing === null) await loadList();
    }
    async function deleteProfile(profile) {
      await call('profile-delete:' + profile.id, () => adapter.deleteModelProfile(profile.id, profile.revision));
      await loadList();
    }
    async function setAppDefault(profile) {
      await call('app-default:' + profile.id, () => adapter.setAppModelProfile(profile.id));
      await loadList();
    }
    async function clearAppDefault() {
      await call('app-default:null', () => adapter.setAppModelProfile(null));
      await loadList();
    }
    async function setProjectDefault(profileId) {
      const projectId = idOf(workspace().projectId);
      if (!projectId) { options.toast?.('Project defaults need an open project.'); return; }
      await call('project-default', () => adapter.setProjectModelProfile(projectId, profileId));
      await loadList();
    }
    async function setConversationDefault(profileId) {
      const sessionId = idOf(workspace().sessionId);
      if (!sessionId) { options.toast?.('Conversation defaults need an open conversation.'); return; }
      await call('conversation-default', () => adapter.setConversationModelProfile(sessionId, profileId));
      await loadList();
    }
    function normalizeProbe(result) {
      if (result?.lastCheck) return result.lastCheck;
      const raw = text(result?.status || result?.result || result?.state).toLowerCase();
      if (!raw && !result?.checkedAt) return null;
      return { checkedAt: text(result?.checkedAt) || new Date().toISOString(),
        ...(PROBE_FAILED.includes(raw) ? { error: text(result?.message || result?.error) || 'The probe did not complete.' } : {}) };
    }
    async function verifyProfile(profile) {
      await call('probe:' + profile.id, () => adapter.verifyModelProfile(profile.id), result => {
        const check = normalizeProbe(result);
        if (!check) throw new Error('The host did not return a probe result for this profile.');
        list = { ...list, profiles: rows(list.profiles).map(item => item.id === profile.id ? { ...item, lastCheck: check } : item) };
      });
    }

    function methodMarkup(provider) {
      return rows(provider.methods).map(method => {
        if (method.kind === 'api_key') return '<span class="amp-method">' + icon('key') + escapeHTML(text(method.label) || 'API key') + '</span>';
        if (method.kind === 'oauth') return '<span class="amp-method">' + icon('log-in') + escapeHTML(text(method.label) || 'Sign in') + (method.enabled ? '' : ' · unavailable') + '</span>';
        return '<span class="amp-method">' + icon('server') + escapeHTML(text(method.label) || 'Host setup') + '</span>';
      }).join('');
    }
    function controlsMarkup(provider) {
      const parts = [];
      for (const method of rows(provider.methods)) {
        if (method.kind === 'api_key' && method.enabled) {
          parts.push(`<div class="amp-key-row">
            <input class="ams-input" type="password" data-amp-key-input="${escapeHTML(provider.id)}" maxlength="8192" autocomplete="off" placeholder="${escapeHTML(text(method.label) || 'API key')} · sent to the host only" aria-label="API key for ${escapeHTML(provider.name || provider.id)}">
            <button type="button" class="ams-button cursor-interaction" data-amp-save-key="${escapeHTML(provider.id)}">${icon('key-round')}Save key</button>
            <button type="button" class="ams-button cursor-interaction" data-amp-remove-key="${escapeHTML(provider.id)}">${icon('log-out')}Remove</button>
          </div>`);
        } else if (method.kind === 'oauth' && method.enabled) {
          parts.push('<div class="amp-key-row"><button type="button" class="ams-button cursor-interaction" data-amp-oauth="' + escapeHTML(provider.id) + '">' + icon('log-in') + 'Sign in with ' + escapeHTML(text(method.label) || provider.name || provider.id) + '</button></div>');
        } else if (method.reason) {
          parts.push('<p class="amp-method-reason">' + icon('info') + escapeHTML(text(method.reason)) + '</p>');
        }
      }
      return parts.join('');
    }
    function oauthMarkup(provider) {
      if (!flow || flow.providerId !== provider.id) return '';
      const done = flow.status === 'authorized';
      const failed = flow.status === 'error';
      let markup = '<div class="amp-oauth" data-amp-oauth-flow="' + escapeHTML(provider.id) + '">';
      markup += '<p class="amp-oauth-status" data-amp-oauth-status="' + escapeHTML(provider.id) + '">' + (done ? icon('check') + 'Signed in with the provider.' : failed ? icon('circle-x') + escapeHTML(flow.message || 'The sign-in did not complete.') : icon('loader') + 'Waiting for the provider sign-in to finish' + (flow.message ? ' · ' + escapeHTML(flow.message) : '…')) + '</p>';
      if (flow.authUrl && !done && !failed) markup += '<p class="amp-oauth-url"><a href="' + escapeHTML(flow.authUrl) + '" target="_blank" rel="noopener noreferrer">' + icon('external-link') + 'Open the authorization page</a></p>';
      if (!done && !failed) markup += '<button type="button" class="ams-button cursor-interaction" data-amp-oauth-cancel="' + escapeHTML(provider.id) + '">' + icon('x') + 'Cancel sign-in</button>';
      markup += '</div>';
      return markup;
    }
    function renderProviders() {
      const target = listNode('providers');
      target.replaceChildren();
      if (!providers.length && !providersError) {
        const empty = document.createElement('p'); empty.className = 'amp-empty'; empty.textContent = 'Providers appear here once the host lists them.';
        target.appendChild(empty);
      }
      for (const provider of providers) {
        const article = document.createElement('article');
        article.className = 'amp-provider'; article.dataset.ampProvider = provider.id; article.setAttribute('role', 'listitem');
        const auth = AUTH_LABELS[provider.auth] || text(provider.auth);
        article.innerHTML = `
          <header class="amp-provider-head">
            <strong>${icon(provider.id.startsWith('compatible-') ? 'server' : 'boxes')} ${escapeHTML(provider.name || provider.id)}</strong>
            <span class="amp-auth amp-auth-${escapeHTML(provider.auth)}" data-amp-auth="${escapeHTML(provider.id)}">${escapeHTML(auth)}</span>
          </header>
          <p class="amp-methods">${methodMarkup(provider)}</p>
          ${controlsMarkup(provider)}
          ${oauthMarkup(provider)}
          <p class="amp-status" role="status" data-amp-provider-status="${escapeHTML(provider.id)}" hidden></p>`;
        target.appendChild(article);
        const stored = providerNotes.get(provider.id);
        const statusNode = article.querySelector('[data-amp-provider-status]');
        if (statusNode) { statusNode.textContent = stored?.message || ''; statusNode.dataset.tone = stored?.tone || ''; statusNode.hidden = !stored; }
      }
      note(listNode('providers-error'), adapter ? providersError : '', 'error');
      q('[data-amp-credential-mode]').textContent = list.credentialMode === 'memory' ? 'Memory only · credentials clear on restart'
        : list.credentialMode ? 'Host vault · ' + list.credentialMode.replace(/_/g, ' ') : 'Host credentials';
    }

    function eligibilityLabel(model, availableIds, configured) {
      if (availableIds.includes(model.id)) return '<span class="amp-badge amp-badge-eligible">' + icon('check') + 'Eligible · credential check passed</span>';
      if (!configured) return '<span class="amp-badge amp-badge-unknown">' + icon('circle-help') + 'Eligibility unknown · configure credentials first</span>';
      return '<span class="amp-badge amp-badge-listed">' + icon('list') + 'SDK catalog only · not returned as available</span>';
    }
    function renderCatalog() {
      const meta = q('[data-amp-catalog-meta]');
      if (!catalog) { meta.textContent = ''; listNode('models').replaceChildren(); note(listNode('catalog-error'), '', ''); return; }
      const provider = catalog.provider || {};
      const availableIds = rows(catalog.availableModelIds);
      const configured = provider.auth === 'configured';
      const sourceLabel = catalog.source === 'refreshed_catalog' ? 'Refreshed catalog' : 'SDK catalog';
      meta.textContent = sourceLabel + ' for ' + (provider.name || provider.id) + ' · checked ' + elapsed(catalog.checkedAt) + (catalogError === 'refresh_failed' ? ' · catalog refresh failed; showing the last SDK catalog' : catalogError === 'availability_failed' ? ' · eligibility check failed' : '');
      const target = listNode('models');
      target.replaceChildren();
      const models = rows(catalog.models);
      if (!models.length) {
        const empty = document.createElement('p'); empty.className = 'amp-empty'; empty.textContent = 'No catalog models match this view.';
        target.appendChild(empty);
      }
      for (const model of models) {
        const article = document.createElement('article');
        article.className = 'amp-model'; article.setAttribute('role', 'listitem');
        const details = [model.api, model.id !== model.name ? model.id : '', rows(model.input).join('/'),
          model.contextWindow ? 'context ' + model.contextWindow.toLocaleString() : '',
          model.maxTokens ? 'output limit ' + model.maxTokens.toLocaleString() : '',
          rows(model.thinkingLevels).map(level => LEVEL_LABELS[level] || level).join('/')].filter(Boolean).join(' · ');
        const rate = model.cost && !text(model.provider).startsWith('compatible-')
          ? 'SDK rates (USD per 1M tokens): input ' + model.cost.input + ', output ' + model.cost.output
            + ', cache read ' + model.cost.cacheRead + ', cache write ' + model.cost.cacheWrite
          : 'Price not supplied';
        article.innerHTML = `
          <div class="amp-model-copy">
            <strong>${escapeHTML(model.name || model.id)}</strong>
            <small>${escapeHTML(details)}</small>
            <small>${escapeHTML(rate)}</small>
          </div>
          <div class="amp-model-badges">
            <span class="amp-badge amp-badge-sdk">${icon('package')}SDK catalog</span>
            ${eligibilityLabel(model, availableIds, configured)}
          </div>`;
        target.appendChild(article);
      }
    }

    function probeBadges(profile) {
      const check = profile?.lastCheck;
      if (!check || !check.checkedAt) return '';
      const badge = (name, symbol, state) => '<span class="amp-badge amp-badge-'
        + (state === 'passed' ? 'eligible' : state === 'failed' ? 'failed' : 'listed') + '">' + icon(symbol) + name
        + (state === 'passed' ? ' verified' : state === 'failed' ? ' failed' : ' not checked') + '</span>';
      return '<span class="amp-badge amp-badge-sdk">' + icon('plug-zap') + 'Checked ' + escapeHTML(elapsed(check.checkedAt)) + '</span>'
        + badge('Streaming', 'activity', check.streaming) + badge('Tools', 'wrench', check.tools);
    }
    function profileBadges(profile) {
      const badges = [];
      if (profile.id === list.appDefaultProfileId) badges.push('<span class="amp-badge amp-badge-default">' + icon('star') + 'App default</span>');
      const project = currentProject();
      if (project && idOf(project.defaultProfileId) === profile.id) badges.push('<span class="amp-badge amp-badge-default">' + icon('folder') + 'Project default</span>');
      const session = currentSession();
      if (session && idOf(session.profileId) === profile.id) badges.push('<span class="amp-badge amp-badge-default">' + icon('message-square') + 'This conversation</span>');
      badges.push(probeBadges(profile));
      return badges.join('');
    }
    function profileActions(profile) {
      const isAppDefault = profile.id === list.appDefaultProfileId;
      const project = currentProject(), session = currentSession();
      const isProjectDefault = Boolean(project) && idOf(project.defaultProfileId) === profile.id;
      const isConversation = Boolean(session) && idOf(session.profileId) === profile.id;
      return `<div class="amp-profile-actions">
        <button type="button" class="ams-button cursor-interaction" data-amp-action="app-default" data-amp-profile-id="${escapeHTML(profile.id)}" ${isAppDefault ? 'disabled' : ''}>${icon('star')}Use as app default</button>
        ${project ? `<button type="button" class="ams-button cursor-interaction" data-amp-action="${isProjectDefault ? 'project-inherit' : 'project-default'}" data-amp-profile-id="${escapeHTML(profile.id)}">${icon('folder')}${isProjectDefault ? 'Project inherits app default' : 'Use for this project'}</button>` : ''}
        ${session ? `<button type="button" class="ams-button cursor-interaction" data-amp-action="${isConversation ? 'conversation-inherit' : 'conversation'}" data-amp-profile-id="${escapeHTML(profile.id)}">${icon('message-square')}${isConversation ? 'Conversation inherits project default' : 'Use in this conversation'}</button>` : ''}
        <button type="button" class="ams-button cursor-interaction" data-amp-action="verify" data-amp-profile-id="${escapeHTML(profile.id)}" ${at('probe:' + profile.id) ? 'disabled' : ''}>${icon('plug-zap')}Verify</button>
        <button type="button" class="ams-button cursor-interaction" data-amp-action="edit" data-amp-profile-id="${escapeHTML(profile.id)}">${icon('pen-line')}Edit</button>
        <button type="button" class="ams-button cursor-interaction amp-danger" data-amp-action="delete" data-amp-profile-id="${escapeHTML(profile.id)}">${icon('trash-2')}Delete</button>
      </div>`;
    }
    function renderProfiles() {
      const intro = q('[data-amp-profiles-intro]');
      const hostModel = list.hostModel;
      const resolved = hostModel ? [hostModel.name || hostModel.modelId || hostModel.id, hostModel.provider].filter(Boolean).join(' · ') : '';
      intro.textContent = 'App default: ' + (list.appDefaultProfileId ? (profileById(list.appDefaultProfileId)?.name || 'profile ' + list.appDefaultProfileId) : 'None') + (resolved ? ' · host model: ' + resolved : ' · The host has not confirmed a model.');
      const target = listNode('profiles');
      target.replaceChildren();
      const profiles = rows(list.profiles);
      if (!profiles.length) {
        const empty = document.createElement('p'); empty.className = 'amp-empty'; empty.textContent = 'No saved profiles yet. Create one to name a provider model and a reasoning level.';
        target.appendChild(empty);
      }
      for (const profile of profiles) {
        const article = document.createElement('article');
        article.className = 'amp-profile'; article.dataset.ampProfile = profile.id; article.setAttribute('role', 'listitem');
        const detail = [profile.provider, profile.modelId, 'reasoning ' + (LEVEL_LABELS[profile.thinkingLevel] || text(profile.thinkingLevel))].filter(Boolean).join(' · ');
        article.innerHTML = `
          <div class="amp-profile-copy">
            <strong>${escapeHTML(profile.name || profile.id)}</strong>
            <small>${escapeHTML(detail)}</small>
          </div>
          <div class="amp-model-badges">${profileBadges(profile)}</div>
          ${profile.lastCheck?.error ? '<p class="amp-method-reason amp-probe-error">' + icon('info') + escapeHTML(text(profile.lastCheck.error)) + '</p>' : ''}
          ${profileActions(profile)}`;
        target.appendChild(article);
      }
      if (!profiles.some(item => item.id === list.appDefaultProfileId) && list.appDefaultProfileId) {
        const warning = document.createElement('p'); warning.className = 'amp-empty';
        warning.textContent = 'The app-default profile is missing from the host list. Choose another default.';
        target.appendChild(warning);
      }
      note(listNode('profiles-error'), adapter ? listError : '', 'error');
    }
    function renderRegisterAndForm() {
      const form = q('[data-amp-profile-form]');
      if (!editing) { form.hidden = true; return; }
      form.hidden = false;
      q('[data-amp-profile-field="name"]').value = text(editing.name);
      const providerSelect = q('[data-amp-profile-field="provider"]');
      const choices = [...providers];
      if (editing.provider && !choices.some(provider => provider.id === editing.provider)) {
        choices.unshift({ id: editing.provider, name: editing.provider });
      }
      providerSelect.replaceChildren(...choices.map(provider => {
        const option = document.createElement('option');
        option.value = provider.id; option.textContent = provider.name || provider.id;
        option.selected = provider.id === editing.provider;
        return option;
      }));
    }
    let profileModels = [];
    function selectProfileModel(id) {
      if (!editing) return;
      const model = profileModels.find(item => item.id === id);
      editing.modelId = model?.id || '';
      const levels = rows(model?.thinkingLevels).filter(level => LEVELS.includes(level));
      editing.thinkingLevel = levels.includes(editing.thinkingLevel) ? editing.thinkingLevel
        : levels.includes('medium') ? 'medium' : levels[0] || 'off';
      q('[data-amp-profile-field="thinkingLevel"]').replaceChildren(...levels.map(level => {
        const option = document.createElement('option');
        option.value = level; option.textContent = LEVEL_LABELS[level];
        option.selected = level === editing.thinkingLevel;
        return option;
      }));
    }
    function loadProfileModels() {
      if (!editing) return;
      const draft = editing;
      const provider = draft.provider;
      const preferred = draft.modelId;
      const preferredLevel = draft.thinkingLevel;
      const modelSelect = q('[data-amp-profile-field="modelId"]');
      modelSelect.replaceChildren();
      profileModels = [];
      selectProfileModel('');
      if (!provider) return;
      void call('profile-catalog', () => adapter.getProviderCatalog(provider, {}), result => {
        if (editing !== draft || draft.provider !== provider) return;
        profileModels = rows(result?.models);
        const selected = preferred ? profileModels.find(model => model.id === preferred) : profileModels[0];
        const placeholder = document.createElement('option');
        placeholder.value = ''; placeholder.textContent = 'Choose a model'; placeholder.selected = !selected;
        modelSelect.replaceChildren(placeholder, ...profileModels.map(model => {
          const option = document.createElement('option');
          option.value = model.id; option.textContent = model.name && model.name !== model.id ? model.name + ' · ' + model.id : model.id;
          option.selected = model.id === selected?.id;
          return option;
        }));
        draft.thinkingLevel = preferredLevel;
        selectProfileModel(selected?.id);
      }, true);
    }
    function render() {
      if (destroyed) return;
      root.hidden = !adapter;
      root.dataset.ampMounted = String(Boolean(adapter));
      if (!adapter) return;
      renderProviders();
      renderCatalog();
      renderProfiles();
      renderRegisterAndForm();
      const busyAny = busyActions.size > 0;
      root.dataset.busy = String(busyAny);
      q('[data-amp-catalog-refresh]').disabled = at('catalog');
      q('[data-amp-profile-new]').disabled = at('list');
      q('[data-amp-profile-save]').disabled = at('profile-save') || at('profile-catalog') || !editing?.modelId;
      options.icons?.();
    }

    listen(q('[data-amp-provider-search]'), 'input', event => {
      providerQuery = event.target.value;
      clearTimeout(providerSearchTimer);
      providerSearchTimer = setTimeout(() => { void loadProviders(); }, 180);
    });
    let providerSearchTimer = null;
    listen(q('[data-amp-catalog-provider]'), 'change', event => {
      catalogProvider = event.target.value; catalog = null; void loadCatalog(false);
    });
    listen(q('[data-amp-catalog-search]'), 'input', event => {
      catalogQuery = event.target.value; void loadCatalog(false);
    });
    listen(q('[data-amp-catalog-refresh]'), 'click', () => { void loadCatalog(true); });
    listen(q('[data-amp-register-submit]'), 'click', () => { void registerEndpoint(); });
    listen(q('[data-amp-profile-new]'), 'click', () => {
      editing = { id: null, revision: null, name: '', provider: catalogProvider || providers[0]?.id || '', modelId: '', thinkingLevel: 'medium' };
      note(q('[data-amp-profile-form-error]'), '', '');
      render();
      loadProfileModels();
      q('[data-amp-profile-field="name"]').focus?.();
    });
    listen(q('[data-amp-profile-field="provider"]'), 'change', event => {
      if (!editing) return;
      editing.provider = event.target.value;
      editing.modelId = '';
      loadProfileModels();
    });
    listen(q('[data-amp-profile-field="modelId"]'), 'change', event => { selectProfileModel(event.target.value); });
    listen(q('[data-amp-profile-field="thinkingLevel"]'), 'change', event => {
      if (editing) editing.thinkingLevel = event.target.value;
    });
    listen(q('[data-amp-profile-save]'), 'click', () => { void saveProfile(); });
    listen(q('[data-amp-profile-cancel]'), 'click', () => { editing = null; render(); });
    listen(root, 'click', event => {
      const target = event.target;
      const saveButton = target.closest?.('[data-amp-save-key]');
      if (saveButton && !saveButton.disabled) { void saveKey(saveButton.dataset.ampSaveKey); return; }
      const removeButton = target.closest?.('[data-amp-remove-key]');
      if (removeButton && !removeButton.disabled) { void removeKey(removeButton.dataset.ampRemoveKey); return; }
      const oauth = target.closest?.('[data-amp-oauth]');
      if (oauth && !oauth.disabled) { void startOAuth(oauth.dataset.ampOauth); return; }
      const cancel = target.closest?.('[data-amp-oauth-cancel]');
      if (cancel) { void cancelOAuth(); return; }
      const action = target.closest?.('[data-amp-action]');
      if (!action || action.disabled || !adapter) return;
      const profile = profileById(action.dataset.ampProfileId);
      if (!profile) return;
      if (action.dataset.ampAction === 'app-default') void setAppDefault(profile);
      if (action.dataset.ampAction === 'project-default') void setProjectDefault(profile.id);
      if (action.dataset.ampAction === 'project-inherit') void setProjectDefault(null);
      if (action.dataset.ampAction === 'conversation') void setConversationDefault(profile.id);
      if (action.dataset.ampAction === 'conversation-inherit') void setConversationDefault(null);
      if (action.dataset.ampAction === 'verify') void verifyProfile(profile);
      if (action.dataset.ampAction === 'delete') void deleteProfile(profile);
      if (action.dataset.ampAction === 'edit') {
        editing = { id: profile.id, revision: profile.revision, name: text(profile.name), provider: text(profile.provider), modelId: text(profile.modelId), thinkingLevel: profile.thinkingLevel || 'medium' };
        note(q('[data-amp-profile-form-error]'), '', '');
        render();
        loadProfileModels();
      }
    });
    listen(q('[data-amp-profile-form]'), 'submit', event => { event.preventDefault(); void saveProfile(); });
    for (const input of root.querySelectorAll('[data-amp-profile-field="name"]')) {
      listen(input, 'input', () => { if (editing) editing.name = input.value; });
    }

    function setModelProfiles(next) {
      clearTimeout(flowTimer); flowTimer = null; flow = null; flowPolls = 0;
      editing = null; profileModels = [];
      adapter = next || null; generation++; owners.clear(); busyActions.clear();
      if (!adapter) { providers = []; catalog = null; list = { profiles: [], appDefaultProfileId: null, credentialMode: null, hostModel: null }; render(); return; }
      void loadList(); void loadProviders(); void loadCatalog(false);
      render();
    }

    render();
    const api = {
      setModelProfiles,
      /* Snapshot-driven scope labels for the legacy model-scopes panel. */
      resolveScopes(snapshot) {
        if (!adapter) return null;
        const session = rows(snapshot?.sessions).find(item => item.id === snapshot?.sessionId) || null;
        const project = rows(snapshot?.projects).find(item => item.id === snapshot?.projectId) || null;
        const label = profileId => {
          const profile = profileById(profileId);
          return profile ? { name: profile.name, provider: profile.provider, modelId: profile.modelId, thinkingLevel: profile.thinkingLevel } : null;
        };
        const runModel = snapshot?.run?.model;
        return {
          appDefault: label(list.appDefaultProfileId) || list.hostModel || null,
          projectDefault: project && idOf(project.defaultProfileId) ? label(project.defaultProfileId) || 'Profile ' + project.defaultProfileId : null,
          conversation: session && idOf(session.profileId) ? label(session.profileId) || 'Profile ' + session.profileId : null,
          runLocked: runModel ? { name: runModel.name || runModel.modelId || runModel.id, provider: runModel.provider, modelId: runModel.modelId || runModel.id, thinkingLevel: runModel.thinkingLevel } : null
        };
      },
      getAppDefaultProfileId: () => list.appDefaultProfileId,
      getHostModel: () => list.hostModel || null,
      refresh: () => { if (adapter) { void loadList(); void loadProviders(); } },
      focus() { if (!destroyed) q('[data-amp-provider-search]')?.focus?.({ preventScroll: true }); },
      destroy() {
        if (destroyed) return;
        destroyed = true; generation++; owners.clear();
        clearTimeout(flowTimer); clearTimeout(providerSearchTimer);
        controller.abort();
        root.remove();
      }
    };
    return api;
  }

  window.AthenaProviderProfiles = Object.freeze({ mount });
})();
