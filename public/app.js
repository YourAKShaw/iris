// Iris web client. No framework, no third-party requests.
// Every string from the server (website text, model output) is rendered with textContent, never innerHTML.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('run-form');
  const urlInput = $('url');
  const recipientInput = $('recipient');
  const offerInput = $('offer');
  const submitButton = $('submit');
  const log = $('log');
  const errorBox = $('error');
  const results = $('results');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const REPO_URL = 'https://github.com/YourAKShaw/iris#-quick-start';

  let running = false;
  let lastMarkdown = '';
  let lastSlug = 'iris';

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child);
    }
    return node;
  }

  function safeHref(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function shortUrl(value) {
    try {
      const url = new URL(value);
      const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
      return url.hostname.replace(/^www\./, '') + path;
    } catch {
      return value;
    }
  }

  const factNumber = (id) => String(id).replace(/^s/, '');
  const PROVIDER_NAMES = { groq: 'Groq', gemini: 'Gemini', openrouter: 'OpenRouter', ollama: 'Ollama', openai: 'OpenAI', custom: 'a custom endpoint' };

  function joinWords(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  // ---------- Progress log ----------

  function logLine(message) {
    for (const item of log.querySelectorAll('li.active')) {
      item.classList.remove('active');
      item.classList.add('done');
    }
    const item = el('li', { class: 'active' }, el('span', { class: 'mark', 'aria-hidden': 'true' }), el('span', { text: message }));
    log.append(item);
  }

  function finishLog(failed) {
    for (const item of log.querySelectorAll('li.active')) {
      item.classList.remove('active');
      item.classList.add(failed ? 'failed' : 'done');
    }
  }

  // ---------- Errors ----------

  function showError(error) {
    errorBox.replaceChildren();
    errorBox.append(el('p', { text: error.message || 'Something went wrong. Try again.' }));
    const quota = error.code === 'RATE_LIMITED' || error.code === 'LLM_RATE_LIMITED';
    if (quota) {
      const link = el('a', { href: REPO_URL, text: 'Run Iris on your own machine with a free API key' });
      errorBox.append(el('p', {}, link, '.'));
    }
    errorBox.hidden = false;
  }

  // ---------- Results ----------

  function linkFact(id, on) {
    const fact = document.getElementById('fact-' + id);
    if (fact) fact.classList.toggle('linked', on);
  }

  function refButton(id) {
    const button = el('button', { type: 'button', class: 'ref', 'aria-label': 'Show fact ' + factNumber(id), text: factNumber(id) });
    button.addEventListener('mouseenter', () => linkFact(id, true));
    button.addEventListener('mouseleave', () => linkFact(id, false));
    button.addEventListener('focus', () => linkFact(id, true));
    button.addEventListener('blur', () => linkFact(id, false));
    button.addEventListener('click', () => {
      const fact = document.getElementById('fact-' + id);
      if (!fact) return;
      fact.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
      linkFact(id, true);
      setTimeout(() => linkFact(id, false), 1400);
    });
    return button;
  }

  function renderFacts(result) {
    const facts = $('facts');
    facts.replaceChildren();
    result.signals.forEach((signal, index) => {
      const href = safeHref(signal.sourceUrl);
      const mark = el('mark', { text: signal.quote });
      mark.style.setProperty('--i', String(index));
      const source = el(
        'p',
        { class: 'source' },
        signal.category.charAt(0).toUpperCase() + signal.category.slice(1) + ', from ',
        href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow', text: shortUrl(href) }) : shortUrl(signal.sourceUrl),
      );
      facts.append(
        el(
          'li',
          { class: 'fact', id: 'fact-' + signal.id },
          el('span', { class: 'num', 'aria-label': 'Fact ' + factNumber(signal.id), text: factNumber(signal.id) }),
          el('div', {}, el('p', { class: 'claim', text: signal.claim }), el('p', { class: 'quote' }, '“', mark, '”'), source),
        ),
      );
    });

    const { signalsVerified, signalsProposed } = result.stats;
    $('evidence-note').textContent =
      signalsVerified === signalsProposed
        ? `All ${signalsVerified} claims matched the site’s text word for word.`
        : `${signalsVerified} of ${signalsProposed} claims matched the site’s text word for word. The rest were dropped.`;

    const dropped = $('dropped');
    dropped.replaceChildren();
    if (result.dropped.length) {
      const list = el('ul');
      for (const item of result.dropped) list.append(el('li', {}, el('s', { text: item.claim }), ' ', item.reason + '.'));
      const count = result.dropped.length;
      dropped.append(
        el(
          'details',
          { class: 'dropped' },
          el('summary', { text: `${count} claim${count === 1 ? ' was' : 's were'} dropped because the quote isn’t on the site` }),
          list,
        ),
      );
    }

    const hypotheses = $('hypotheses');
    hypotheses.replaceChildren();
    for (const h of result.hypotheses) {
      const refs = h.basedOn.map((id) => 'fact ' + factNumber(id));
      hypotheses.append(
        el(
          'li',
          {},
          el('p', { class: 'statement', text: h.statement }),
          el('p', { class: 'basis', text: `Rests on ${joinWords(refs)}. ${h.confidence.charAt(0).toUpperCase() + h.confidence.slice(1)} confidence.` }),
        ),
      );
    }
    $('guesses').hidden = result.hypotheses.length === 0;
  }

  function selectTab(index, focus) {
    const tabs = $('tabs').querySelectorAll('[role="tab"]');
    const panels = $('panels').querySelectorAll('[role="tabpanel"]');
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
      if (selected && focus) tab.focus();
    });
  }

  async function copyText(text, button) {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed. Select the text instead.';
    }
    setTimeout(() => {
      button.textContent = original;
    }, 1800);
  }

  function renderDrafts(result) {
    const tabs = $('tabs');
    const panels = $('panels');
    tabs.replaceChildren();
    panels.replaceChildren();

    result.emails.forEach((email, index) => {
      const tabId = 'tab-' + index;
      const panelId = 'panel-' + index;
      const tab = el('button', { type: 'button', role: 'tab', id: tabId, class: 'tab', 'aria-controls': panelId, text: email.angle || 'Email ' + (index + 1) });
      tab.addEventListener('click', () => selectTab(index, false));
      tab.addEventListener('keydown', (event) => {
        const count = result.emails.length;
        let next = null;
        if (event.key === 'ArrowRight') next = (index + 1) % count;
        else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = count - 1;
        if (next !== null) {
          event.preventDefault();
          selectTab(next, true);
        }
      });
      tabs.append(tab);

      const copyButton = el('button', { type: 'button', class: 'quiet', text: 'Copy email' });
      copyButton.addEventListener('click', () => copyText(`Subject: ${email.subject}\n\n${email.body}`, copyButton));

      const cites = el('p', { class: 'cites' }, email.basedOn.length === 1 ? 'Built on fact' : 'Built on facts');
      for (const id of email.basedOn) cites.append(refButton(id));

      panels.append(
        el(
          'div',
          { role: 'tabpanel', id: panelId, class: 'panel', 'aria-labelledby': tabId, tabindex: '0' },
          el('h4', { text: email.angle || 'Email ' + (index + 1) }),
          el('p', { class: 'subject' }, el('span', { class: 'label', text: 'Subject' }), el('strong', { text: email.subject })),
          el('p', { class: 'body', text: email.body }),
          el('div', { class: 'panel-foot' }, cites, copyButton),
        ),
      );
    });
    selectTab(0, false);

    const warnings = $('warnings');
    warnings.textContent = result.warnings.join(' ');
    warnings.hidden = result.warnings.length === 0;
  }

  function renderMeta(result, cached) {
    const meta = $('run-meta');
    meta.replaceChildren();
    const tokens = result.stats.promptTokens + result.stats.completionTokens;
    const items = [
      `${result.stats.model} on ${PROVIDER_NAMES[result.stats.provider] || result.stats.provider}`,
      `${result.stats.pagesRead} page${result.stats.pagesRead === 1 ? '' : 's'} read`,
      tokens ? `${tokens.toLocaleString('en-US')} tokens` : null,
      `${(result.stats.durationMs / 1000).toFixed(1)} seconds`,
    ];
    for (const item of items) if (item) meta.append(el('span', { text: item }));
    if (cached) meta.append(el('span', { class: 'cached', text: 'Served from cache' }));
  }

  function renderResult(result, markdown, cached) {
    $('company-name').textContent = result.company.name;
    $('company-line').textContent = result.company.oneLiner;
    renderFacts(result);
    renderDrafts(result);
    renderMeta(result, cached);
    lastMarkdown = markdown || '';
    lastSlug = (result.company.name || 'iris').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'iris';
    $('download').hidden = !lastMarkdown;
    results.hidden = false;
    results.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  $('download').addEventListener('click', () => {
    if (!lastMarkdown) return;
    const blob = new Blob([lastMarkdown], { type: 'text/markdown;charset=utf-8' });
    const link = el('a', { href: URL.createObjectURL(blob), download: lastSlug + '-iris-brief.md' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });

  // ---------- Running ----------

  async function readEvents(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  }

  function setRunning(value) {
    running = value;
    submitButton.disabled = value;
    submitButton.textContent = value ? 'Researching…' : 'Research';
    for (const button of document.querySelectorAll('.example')) button.disabled = value;
  }

  async function run() {
    if (running) return;
    const url = urlInput.value.trim();
    errorBox.hidden = true;
    if (!url) {
      showError({ message: 'Enter a company website, for example acme.com.' });
      urlInput.focus();
      return;
    }

    setRunning(true);
    log.replaceChildren();
    results.hidden = true;
    let finished = false;

    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, recipient: recipientInput.value.trim(), offer: offerInput.value.trim() }),
      });

      const type = response.headers.get('content-type') || '';
      if (!type.includes('application/x-ndjson')) {
        const payload = await response.json().catch(() => ({}));
        showError(payload.error || { message: `The server answered with HTTP ${response.status}.` });
        finished = true;
        return;
      }

      await readEvents(response, (event) => {
        if (event.type === 'progress') logLine(event.message);
        else if (event.type === 'result') {
          finished = true;
          finishLog(false);
          renderResult(event.result, event.markdown, event.cached);
        } else if (event.type === 'error') {
          finished = true;
          finishLog(true);
          showError(event.error);
        }
      });

      if (!finished) {
        finishLog(true);
        showError({ message: 'The connection closed before Iris finished. Try again.' });
      }
    } catch {
      finishLog(true);
      showError({ message: 'Could not reach the Iris server. Check your connection and try again.' });
    } finally {
      setRunning(false);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run();
  });

  for (const button of document.querySelectorAll('.example')) {
    button.addEventListener('click', () => {
      urlInput.value = button.dataset.url || '';
      run();
    });
  }

  // Prefill the offer and show today's remaining demo runs.
  fetch('/api/meta')
    .then((response) => (response.ok ? response.json() : null))
    .then((meta) => {
      if (!meta) return;
      if (!offerInput.value) offerInput.value = meta.sender.offer;
      offerInput.placeholder = `What ${meta.sender.company} sells, in a sentence or two`;
      $('quota').textContent = `${meta.limits.dailyRemaining} demo runs left today.`;
    })
    .catch(() => {});
})();
