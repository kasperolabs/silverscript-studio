/* ═══════════════════════════════════════════════════════
   SilverScript Studio — Wizard Engine
   BUILD MARKER: wizard-walletbook-b-2026-09-25
   Multi-step guided contract builder
   ═══════════════════════════════════════════════════════ */

const WizardEngine = (() => {
  let currentWizard = null;   // WIZARD_DATA[type]
  let currentStep = 0;
  let fieldValues = {};
  let isAnimating = false;

  // ─── Public: Launch wizard ─────────────────────────
  function open(type) {
    const wiz = WIZARD_DATA[type];
    if (!wiz) return;

    currentWizard = wiz;
    currentStep = 0;
    fieldValues = {};

    // Set defaults from all configure steps
    wiz.steps.forEach(step => {
      if (step.type === 'configure' && step.fields) {
        step.fields.forEach(f => {
          if (f.default !== undefined) fieldValues[f.name] = f.default;
        });
      }
    });
	
    // Auto-fill pubkey fields from connected wallet, then render
    resolveWalletAddress().then(addr => {
      if (addr) {
        wiz.steps.forEach(step => {
          if (step.type === 'configure' && step.fields) {
            step.fields.forEach(f => {
              const name = f.name.toLowerCase();
              const isEmpty = !fieldValues[f.name];
              if (!isEmpty) return;

				// Auto-fill pubkey_hash source field and compute hash via server
              if (f.type === 'pubkey_hash') {
                fieldValues[f.name + '_source'] = addr;
                fetch('/api/blake2b', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ input: addr })
                })
                .then(r => r.json())
                .then(data => {
                  if (data.success) {
                    fieldValues[f.name] = data.hash;
                    // Re-render if we're on the configure step
                    const step = wiz.steps[currentStep];
                    if (step && step.type === 'configure') {
                      renderStepContent();
                      attachFieldListeners(step);
                    }
                  }
                })
                .catch(() => {});
                return;
              }

              // Auto-fill "your" pubkey fields — owner, sender, funder
              if (f.type === 'text' && name.includes('pubkey') && (name.includes('owner') || name.includes('sender') || name.includes('funder'))) {
                fieldValues[f.name] = addr;
              }
            });
          }
        });
        // Re-render configure step if we're already on it
        const step = wiz.steps[currentStep];
        if (step && step.type === 'configure') {
          renderStepContent();
          attachFieldListeners(step);
        }
      }
    });

    // Wallet book for the pubkey pickers (needs a session; silently absent otherwise)
    if (typeof App !== 'undefined' && App.loadWalletBook) {
      Promise.resolve(App.loadWalletBook()).then(() => {
        const step = currentWizard && currentWizard.steps[currentStep];
        if (step && step.type === 'configure') { renderStepContent(); attachFieldListeners(step); }
      }).catch(() => {});
    }

    renderWizard();
    showWizardModal();
  }

  // ─── Navigation ────────────────────────────────────
  function next() {
    if (isAnimating) return;
    if (currentStep >= currentWizard.steps.length - 1) return;

    // Validate current step if it's configure
    if (currentWizard.steps[currentStep].type === 'configure') {
      if (!validateConfigStep()) return;
      captureFieldValues();
    }

    animateTransition('next', () => {
      currentStep++;
      renderStepContent();
      updateNavigation();
      updateProgress();
    });
  }

  function prev() {
    if (isAnimating) return;
    if (currentStep <= 0) return;

    // Save current values before going back
    if (currentWizard.steps[currentStep].type === 'configure') {
      captureFieldValues();
    }

    animateTransition('prev', () => {
      currentStep--;
      renderStepContent();
      updateNavigation();
      updateProgress();
    });
  }

  function goToStep(idx) {
    if (isAnimating || idx === currentStep) return;
    if (idx < 0 || idx >= currentWizard.steps.length) return;

    // Save if leaving configure
    if (currentWizard.steps[currentStep].type === 'configure') {
      captureFieldValues();
    }

    const dir = idx > currentStep ? 'next' : 'prev';
    animateTransition(dir, () => {
      currentStep = idx;
      renderStepContent();
      updateNavigation();
      updateProgress();
    });
  }

  // ─── Generate & Close ──────────────────────────────
  function generate() {
    if (!currentWizard) return;

    // Final capture
    const configStep = currentWizard.steps.find(s => s.type === 'configure');
    if (configStep) captureFieldValues();

    // Final validation: check all pubkey fields have real values
    const missingPubkeys = [];
    if (configStep && configStep.fields) {
      configStep.fields.forEach(f => {
        if (f.validate === 'pubkey') {
          const val = (fieldValues[f.name] || '').trim();
          if (!val || !isValidPubkeyInput(val)) {
            missingPubkeys.push(f.label || f.name);
          }
        }
        if (f.validate === 'pubkey_optional') {
          const val = (fieldValues[f.name] || '').trim();
          if (val && !isValidPubkeyInput(val)) missingPubkeys.push(f.label || f.name);
        }
      });
    }
    if (missingPubkeys.length > 0) {
      // Jump back to configure step and show errors
      const configIdx = currentWizard.steps.indexOf(configStep);
      if (configIdx >= 0) {
        currentStep = configIdx;
        renderStepContent();
        updateNavigation();
        updateProgress();
        // Trigger validation to show error messages
        validateConfigStep();
      }
      return;
    }

    const code = currentWizard.generate(fieldValues);
    const name = (fieldValues.contractName || 'contract').toLowerCase().replace(/[^a-z0-9_]/g, '') + '.sil';

    closeWizardModal();
    App.addFile(name, code);
    App.logToConsole(`✨ Created ${currentWizard.title} contract via wizard`);
  }

  function close() {
    closeWizardModal();
    currentWizard = null;
  }

  // ─── Render: Full wizard layout ────────────────────
  function renderWizard() {
    const modal = document.getElementById('wizardModalV2');
    const wiz = currentWizard;

    modal.innerHTML = `
      <div class="wiz-sidebar">
        <div class="wiz-sidebar-header">
          <div class="wiz-icon" style="color:${wiz.color}">${wiz.icon}</div>
          <div class="wiz-sidebar-title">${esc(wiz.title)}</div>
          <div class="wiz-sidebar-sub">${esc(wiz.subtitle)}</div>
        </div>
        <div class="wiz-steps-nav" id="wizStepsNav">
          ${wiz.steps.map((s, i) => `
            <button class="wiz-step-btn ${i === 0 ? 'active' : ''} ${i === 0 ? 'current' : ''}"
                    data-step="${i}" onclick="WizardEngine.goToStep(${i})">
              <span class="wiz-step-num">${i + 1}</span>
              <span class="wiz-step-label">${esc(s.title)}</span>
            </button>
          `).join('')}
        </div>
        <div class="wiz-sidebar-footer">
          <div class="wiz-progress-bar">
            <div class="wiz-progress-fill" id="wizProgressFill" style="width:${100 / wiz.steps.length}%"></div>
          </div>
          <div class="wiz-progress-text" id="wizProgressText">Step 1 of ${wiz.steps.length}</div>
        </div>
      </div>
      <div class="wiz-main">
        <div class="wiz-main-header">
          <h2 id="wizMainTitle">${esc(wiz.steps[0].title)}</h2>
          <button class="wiz-close" onclick="WizardEngine.close()" title="Close">&times;</button>
        </div>
        <div class="wiz-main-body" id="wizMainBody"></div>
        <div class="wiz-main-footer" id="wizMainFooter"></div>
      </div>
    `;

    renderStepContent();
    updateNavigation();
    updateProgress();
  }

  // ─── Render: Step content ──────────────────────────
  function renderStepContent() {
    const step = currentWizard.steps[currentStep];
    const body = document.getElementById('wizMainBody');
    const title = document.getElementById('wizMainTitle');

    title.textContent = step.title;

    switch (step.type) {
      case 'explain':  body.innerHTML = renderExplainStep(step); break;
      case 'diagram':  body.innerHTML = renderDiagramStep(step); break;
      case 'configure': body.innerHTML = renderConfigureStep(step); break;
      case 'review':   body.innerHTML = renderReviewStep(); break;
    }

    // Re-attach event listeners for configure step
    if (step.type === 'configure') {
      attachFieldListeners(step);
    }

    // Scroll to top
    body.scrollTop = 0;
  }

  // ─── Step Renderers ────────────────────────────────

  function renderExplainStep(step) {
    const c = step.content;
    return `
      <div class="wiz-explain">
        <div class="wiz-analogy">
          <div class="wiz-analogy-icon">${c.analogy.icon}</div>
          <div class="wiz-analogy-content">
            <div class="wiz-analogy-title">${c.analogy.title}</div>
            <div class="wiz-analogy-text">${c.analogy.text}</div>
          </div>
        </div>

        <div class="wiz-bullets">
          ${c.bullets.map(b => `
            <div class="wiz-bullet">
              <span class="wiz-bullet-icon">${b.icon}</span>
              <span class="wiz-bullet-text">${b.text}</span>
            </div>
          `).join('')}
        </div>

        <div class="wiz-who-uses">
          <div class="wiz-who-label">Who uses this?</div>
          <div class="wiz-who-text">${c.whoUsesThis}</div>
        </div>
      </div>
    `;
  }

  function renderDiagramStep(step) {
    const c = step.content;
    return `
      <div class="wiz-diagram">
        <div class="wiz-flow">
          ${c.flow.map((f, i) => `
            <div class="wiz-flow-step ${f.label === 'OR' ? 'wiz-flow-or' : ''}">
              <div class="wiz-flow-icon">${f.icon}</div>
              <div class="wiz-flow-content">
                <div class="wiz-flow-label">${esc(f.label)}</div>
                ${f.desc ? `<div class="wiz-flow-desc">${esc(f.desc)}</div>` : ''}
              </div>
            </div>
            ${i < c.flow.length - 1 && c.flow[i+1].label !== 'OR' && f.label !== 'OR' ? '<div class="wiz-flow-arrow">→</div>' : ''}
          `).join('')}
        </div>

        <div class="wiz-code-preview">
          <div class="wiz-code-label">The code</div>
          <pre class="wiz-code">${esc(c.codePreview)}</pre>
        </div>

        <div class="wiz-concepts">
          <div class="wiz-concepts-label">Key concepts</div>
          ${c.concepts.map(con => `
            <div class="wiz-concept">
              <code class="wiz-concept-term">${esc(con.term)}</code>
              <span class="wiz-concept-def">${con.definition}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderConfigureStep(step) {
    return `
      <div class="wiz-configure">
        ${step.fields.map(f => {
          const hidden = f.showIf ? !checkShowIf(f.showIf) : false;
          return `
            <div class="wiz-field ${hidden ? 'wiz-field-hidden' : ''}"
                 ${f.showIf ? `data-show-field="${f.showIf.field}" data-show-value="${f.showIf.value}"` : ''}>
              <label class="wiz-field-label" for="wizf_${f.name}">${f.label}</label>
              ${renderFieldInput(f)}
              ${f.hint ? `<div class="wiz-field-hint">${f.hint}</div>` : ''}
              <div class="wiz-field-error" id="wizferr_${f.name}"></div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderFieldInput(f) {
    const val = fieldValues[f.name] !== undefined ? fieldValues[f.name] : (f.default || '');

    if (f.type === 'tkas_picker') {
      const options = f.options || [1, 2, 5, 10];
      const selected = parseInt(val) || options[0];
      return `
        <div class="deploy-tkas-picker wiz-tkas-picker">
          ${options.map(n => `
            <button type="button"
                    class="deploy-tkas-btn ${n === selected ? 'active' : ''}"
                    data-field="${f.name}" data-tkas="${n}"
                    onclick="WizardEngine.selectTkasPicker('${f.name}', ${n})">
              ${n} TKAS
            </button>
          `).join('')}
        </div>
      `;
    }

    if (f.type === 'select') {
      return `
        <div class="wiz-select-group">
          ${f.options.map(o => `
            <button type="button"
                    class="wiz-select-btn ${val === o.value ? 'selected' : ''}"
                    data-field="${f.name}" data-value="${esc(o.value)}"
                    onclick="WizardEngine.selectOption('${f.name}', '${esc(o.value)}')">
              <span class="wiz-select-radio">${val === o.value ? '●' : '○'}</span>
              <span class="wiz-select-label">${o.label}</span>
            </button>
          `).join('')}
        </div>
      `;
    }

    if (f.type === 'datetime') {
        // Default: text (pubkey fields get the address-book hint when there is no session)
    const bookHint = (f.validate === 'pubkey' || f.validate === 'pubkey_optional')
      && typeof App !== 'undefined' && App.getWalletBook && App.getWalletBook().length === 0
      ? `<div class="wiz-field-hint" style="margin-top:6px">Connect a wallet to pick from your address book instead of pasting.</div>`
      : '';
    return `<input id="wizf_${f.name}" type="text" class="wiz-input"
                   value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"
                   data-field="${f.name}" />${bookHint}`;
    }

    if (f.type === 'number') {
	  const minVal = f.min !== undefined ? f.min : 0;
	  const maxVal = f.max !== undefined ? ` max="${f.max}"` : '';
	  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
	  return `<input id="wizf_${f.name}" type="number" class="wiz-input wiz-input-no-spin"
					 value="${esc(val)}" min="${minVal}"${maxVal}${ph} step="1"
					 data-field="${f.name}" />`;
	}

    if (f.type === 'arbiter_picker') {
      // Renders a loading placeholder, then fetches and fills with arbiter cards
      return `
        <div class="wiz-arbiter-picker" id="wizf_${f.name}_picker" data-field="${f.name}">
          <div class="wiz-arbiter-loading">Loading arbiters…</div>
        </div>
        <input type="hidden" id="wizf_${f.name}" class="wiz-input" data-field="${f.name}" value="${esc(val)}" />
        <div class="wiz-arbiter-manual" style="margin-top:8px;">
          <button type="button" class="wiz-arbiter-toggle-manual" onclick="WizardEngine.toggleArbiterManual('${f.name}')">
            Or enter a pubkey manually ▾
          </button>
          <div class="wiz-arbiter-manual-input" id="wizf_${f.name}_manual_wrap" style="display:none;">
            <input type="text" id="wizf_${f.name}_manual"
                   class="wiz-input-manual" placeholder="Kaspa address or public key"
                   oninput="WizardEngine.arbiterManualInput('${f.name}', this.value)" />
          </div>
        </div>
      `;
    }

	if (f.type === 'pubkey_hash') {
      const sourceVal = fieldValues[f.name + '_source'] || '';
      return `
        <div class="wiz-pkh-wrapper">
          <div class="wiz-pkh-explain">
            <span class="wiz-pkh-explain-icon">💡</span>
            <span>Paste your <strong>Kaspa address</strong> below. We'll extract the public key and compute its BLAKE2b hash — that's what gets baked into the contract. Your actual public key stays hidden until you spend.</span>
          </div>
          <div class="wiz-pkh-input-row">
            <input id="wizf_${f.name}_source" type="text" class="wiz-input wiz-pkh-source"
                   value="${esc(sourceVal)}"
                   placeholder="kaspa:qr… or kaspatest:qr…"
                   data-field="${f.name}_source" />
            <button type="button" class="wiz-pkh-calc-btn" onclick="WizardEngine.computePubkeyHash('${f.name}')">
              #️⃣ Hash it
            </button>
          </div>
          <input type="hidden" id="wizf_${f.name}" class="wiz-input" data-field="${f.name}" value="${esc(val)}" />
          <div id="wizf_${f.name}_result" class="wiz-pkh-result" style="${val ? '' : 'display:none'}">
            <div class="wiz-pkh-result-label">BLAKE2b hash (stored in contract):</div>
            <div class="wiz-pkh-result-steps">
              <div class="wiz-pkh-step">
                <span class="wiz-pkh-step-num">1</span>
                <span class="wiz-pkh-step-text">Public key extracted from your address</span>
              </div>
              <div class="wiz-pkh-step">
                <span class="wiz-pkh-step-num">2</span>
                <span class="wiz-pkh-step-text">BLAKE2b-256 hash computed (32 bytes)</span>
              </div>
            </div>
            <code class="wiz-pkh-result-hash" id="wizf_${f.name}_hashDisplay">${esc(val)}</code>
            <div class="wiz-pkh-result-note">This hash is what goes into <code>byte[32] pkh</code>. When you spend, you'll reveal your actual public key to prove it matches.</div>
          </div>
          <div class="wiz-field-error" id="wizferr_${f.name}"></div>
        </div>
      `;
    }

    // Pubkey fields: the same wallet-book dropdown the deploy form uses, with wizard callbacks
    if ((f.validate === 'pubkey' || f.validate === 'pubkey_optional') && typeof App !== 'undefined' && App.renderWalletDropdown) {
      const book = walletBookList();
      if (book.length > 0) {
        const cur = String(val || '').trim();
        const match = book.find(w => sameKey(w, cur)) || null;
        const pasting = !match && (cur !== '' || !!pasteMode[f.name]);
        const handlers = {
          select: 'WizardEngine.pickWalletId',
          paste:  `WizardEngine.pickWallet('${f.name}', '__paste')`,
          manage: `WizardEngine.pickWallet('${f.name}', '__add')`
        };
        return `
          <div id="wizf_${f.name}_wrap" class="wiz-pk-wrap ${pasting ? 'pasting' : ''}">
            ${App.renderWalletDropdown(f.name, match, handlers)}
            <input id="wizf_${f.name}" type="text" class="wiz-input wiz-pk-paste"
                   value="${esc(val)}" placeholder="${esc(f.placeholder || 'Kaspa address or public key')}"
                   data-field="${f.name}" style="${pasting ? '' : 'display:none'}" />
          </div>`;
      }
    }

    // Default: text
    return `<input id="wizf_${f.name}" type="text" class="wiz-input"
                   value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"
                   data-field="${f.name}" />`;
  }

  function renderReviewStep() {
    // Capture latest values
    const configStep = currentWizard.steps.find(s => s.type === 'configure');
    if (configStep) captureFieldValues();

    const code = currentWizard.generate(fieldValues);
    const annotations = currentWizard.annotations ? currentWizard.annotations(fieldValues) : [];
    const lines = code.split('\n');

    // Build annotated code view
    const annotatedLines = lines.map((line, i) => {
      const ann = annotations.find(a => line.includes(a.line));
      return { code: line, annotation: ann ? ann.text : null };
    });

    return `
      <div class="wiz-review">
        <div class="wiz-review-summary">
          <div class="wiz-review-icon" style="color:${currentWizard.color}">${currentWizard.icon}</div>
          <div class="wiz-review-info">
            <div class="wiz-review-name">${esc(fieldValues.contractName || currentWizard.title)}</div>
            <div class="wiz-review-type">${esc(currentWizard.title)}</div>
          </div>
        </div>

        <div class="wiz-review-code-container">
          <div class="wiz-review-code-header">
            <span>Generated SilverScript</span>
            <span class="wiz-review-filename">${(fieldValues.contractName || 'contract').toLowerCase()}.sil</span>
          </div>
          <div class="wiz-review-code">
            ${annotatedLines.map((l, i) => `
              <div class="wiz-code-line ${l.annotation ? 'has-annotation' : ''}">
                <span class="wiz-line-num">${i + 1}</span>
                <span class="wiz-line-code">${highlightSilverScript(l.code)}</span>
                ${l.annotation ? `<span class="wiz-line-annotation" title="${esc(l.annotation)}">💡</span>` : ''}
              </div>
              ${l.annotation ? `<div class="wiz-annotation-row">${l.annotation}</div>` : ''}
            `).join('')}
          </div>
        </div>

        <div class="wiz-review-params">
          <div class="wiz-review-params-title">Configuration summary</div>
          ${Object.entries(fieldValues).map(([k, v]) => {
            // Find the field definition for a nice label
            let label = k;
            currentWizard.steps.forEach(s => {
              if (s.fields) {
                const fld = s.fields.find(f => f.name === k);
                if (fld) label = fld.label;
              }
            });
            // Skip hidden fields
            const fld = findFieldDef(k);
            if (fld && fld.showIf && !checkShowIf(fld.showIf)) return '';
            // Format tkas_picker values with unit
            let displayVal = String(v);
            if (fld && fld.type === 'tkas_picker') displayVal = v + ' TKAS';
            return `
              <div class="wiz-param-row">
                <span class="wiz-param-key">${esc(label)}</span>
                <span class="wiz-param-val">${esc(displayVal)}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // ─── Syntax highlighting (lightweight) ─────────────
  function highlightSilverScript(line) {
    if (!line.trim()) return '&nbsp;';

    let s = esc(line);

    // Comments
    s = s.replace(/(\/\/.*)$/, '<span class="hl-comment">$1</span>');

    // Strings
    s = s.replace(/(&quot;[^&]*&quot;)/g, '<span class="hl-string">$1</span>');

    // Keywords
    const kws = ['pragma', 'silverscript', 'contract', 'entrypoint', 'function', 'require', 'if', 'else', 'for', 'return', 'new', 'int', 'constant'];
    kws.forEach(k => {
      s = s.replace(new RegExp(`\\b(${k})\\b`, 'g'), '<span class="hl-keyword">$1</span>');
    });

    // Types
    const types = ['pubkey', 'sig', 'datasig', 'bool', 'string', 'byte\\[\\d*\\]', 'int\\b'];
    types.forEach(t => {
      s = s.replace(new RegExp(`\\b(${t})`, 'g'), '<span class="hl-type">$1</span>');
    });

    // Builtins
    const builtins = ['checkSig', 'blake2b', 'sha256', 'date', 'ScriptPubKeyP2PK', 'ScriptPubKeyP2SH'];
    builtins.forEach(b => {
      s = s.replace(new RegExp(`\\b(${b})\\b`, 'g'), '<span class="hl-builtin">$1</span>');
    });

    // Introspection
    s = s.replace(/\b(tx\.(?:outputs|inputs|time|locktime|version))/g, '<span class="hl-introspection">$1</span>');
    s = s.replace(/\b(this\.(?:age|activeInputIndex|activeScriptPubKey))/g, '<span class="hl-introspection">$1</span>');

    // Numbers
    s = s.replace(/\b(\d+)\b/g, '<span class="hl-number">$1</span>');

    // Units
    s = s.replace(/\b(litras|grains|kas|seconds|minutes|hours|days|weeks)\b/g, '<span class="hl-unit">$1</span>');

    return s;
  }

  // ─── UI Updates ────────────────────────────────────
  function updateNavigation() {
    const footer = document.getElementById('wizMainFooter');
    const isFirst = currentStep === 0;
    const isLast = currentStep === currentWizard.steps.length - 1;

    footer.innerHTML = `
      <div class="wiz-nav-left">
        ${!isFirst ? `<button class="wiz-btn wiz-btn-ghost" onclick="WizardEngine.prev()">
          <span class="wiz-btn-arrow">←</span> Back
        </button>` : ''}
      </div>
      <div class="wiz-nav-right">
        ${isLast
          ? `<button class="wiz-btn wiz-btn-primary wiz-btn-create" onclick="WizardEngine.generate()">
               <span class="wiz-btn-spark">⚡</span> Create Contract
             </button>`
          : `<button class="wiz-btn wiz-btn-primary" onclick="WizardEngine.next()">
               Continue <span class="wiz-btn-arrow">→</span>
             </button>`
        }
      </div>
    `;

    // Update step nav active states
    document.querySelectorAll('.wiz-step-btn').forEach((btn, i) => {
      btn.classList.toggle('active', i <= currentStep);
      btn.classList.toggle('current', i === currentStep);
    });
  }

  function updateProgress() {
    const fill = document.getElementById('wizProgressFill');
    const text = document.getElementById('wizProgressText');
    const pct = ((currentStep + 1) / currentWizard.steps.length) * 100;
    fill.style.width = pct + '%';
    text.textContent = `Step ${currentStep + 1} of ${currentWizard.steps.length}`;
  }

  // ─── Field Logic ───────────────────────────────────
  function captureFieldValues() {
    document.querySelectorAll('.wiz-input').forEach(input => {
      const name = input.dataset.field;
      if (name) {
        let val = input.value;
        // Auto-convert Kaspa addresses to pubkeys for pubkey fields
        if (name.toLowerCase().includes('pubkey') && val && (val.startsWith('kaspa:') || val.startsWith('kaspatest:'))) {
          const convert = typeof App !== 'undefined' && App.kaspaAddressToPubkey ? App.kaspaAddressToPubkey(val) : null;
          if (convert) {
            val = convert;
            input.value = convert;
          }
        }
        fieldValues[name] = val;
      }
    });
  }

  function selectTkasPicker(fieldName, tkas) {
    fieldValues[fieldName] = String(tkas);

    // Update button active states within this picker
    document.querySelectorAll(`.wiz-tkas-picker [data-field="${fieldName}"]`).forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.tkas) === tkas);
    });
  }

  function selectOption(fieldName, value) {
    fieldValues[fieldName] = value;

    // Update button states
    document.querySelectorAll(`[data-field="${fieldName}"]`).forEach(btn => {
      const isSelected = btn.dataset.value === value;
      btn.classList.toggle('selected', isSelected);
      const radio = btn.querySelector('.wiz-select-radio');
      if (radio) radio.textContent = isSelected ? '●' : '○';
    });

    // Update conditional field visibility
    updateConditionalFields();
  }

  function attachFieldListeners(step) {
    // Text/number inputs update values on change
    document.querySelectorAll('.wiz-input').forEach(input => {
      if (!input.dataset.field) return;   // the wallet-book <select> styles as an input but is not a field
      input.addEventListener('input', () => {
        fieldValues[input.dataset.field] = input.value;
      });
    });

    // Arbiter pickers — fetch and render
    if (step.fields) {
      step.fields.forEach(f => {
        if (f.type === 'arbiter_picker') _fetchAndRenderArbiters(f.name);
      });
    }
  }

  // ─── Arbiter Picker Logic ──────────────────────────
  let _arbiterCache = null;

  async function _fetchAndRenderArbiters(fieldName) {
    const container = document.getElementById(`wizf_${fieldName}_picker`);
    if (!container) return;

    try {
      if (!_arbiterCache) {
        const res = await fetch('/api/arbiters');
        const data = await res.json();
        _arbiterCache = data.success ? data.arbiters : [];
      }

      if (_arbiterCache.length === 0) {
        container.innerHTML = '<div class="wiz-arbiter-empty">No arbiters available. Enter a pubkey manually below.</div>';
        return;
      }

      const currentVal = fieldValues[fieldName] || '';
      container.innerHTML = _arbiterCache.map(a => `
        <div class="wiz-arbiter-card ${currentVal === a.pubkey ? 'selected' : ''}"
             onclick="WizardEngine.selectArbiter('${fieldName}', '${a.pubkey}', this)"
             data-pubkey="${a.pubkey}">
          <div class="wiz-arb-header">
            <div class="wiz-arb-name">${esc(a.name)}</div>
            <div class="wiz-arb-fee">${a.feePct}% fee</div>
          </div>
          <div class="wiz-arb-desc">${esc(a.description)}</div>
          <div class="wiz-arb-meta">
            <span title="Response time">⏱ ${esc(a.responseTime)}</span>
            <span title="Disputes resolved">✓ ${a.resolvedCount} resolved</span>
            ${a.speciality ? `<span title="Speciality">◉ ${esc(a.speciality)}</span>` : ''}
          </div>
        </div>
      `).join('');
    } catch (e) {
      container.innerHTML = '<div class="wiz-arbiter-empty">Could not load arbiters. Enter a pubkey manually below.</div>';
    }
  }

  function selectArbiter(fieldName, pubkey, cardEl) {
    fieldValues[fieldName] = pubkey;
    // Update hidden input
    const hidden = document.getElementById(`wizf_${fieldName}`);
    if (hidden) hidden.value = pubkey;
    // Update card selection
    const container = cardEl.parentElement;
    container.querySelectorAll('.wiz-arbiter-card').forEach(c => c.classList.remove('selected'));
    cardEl.classList.add('selected');
    // Clear manual input if it was used
    const manualInput = document.getElementById(`wizf_${fieldName}_manual`);
    if (manualInput) manualInput.value = '';
    // Clear any validation error
    const errEl = document.getElementById(`wizferr_${fieldName}`);
    if (errEl) errEl.textContent = '';
  }

  function toggleArbiterManual(fieldName) {
    const wrap = document.getElementById(`wizf_${fieldName}_manual_wrap`);
    if (!wrap) return;
    const visible = wrap.style.display !== 'none';
    wrap.style.display = visible ? 'none' : 'block';
  }

  function arbiterManualInput(fieldName, value) {
    fieldValues[fieldName] = value.trim();
    const hidden = document.getElementById(`wizf_${fieldName}`);
    if (hidden) hidden.value = value.trim();
    // Deselect any arbiter card
    const picker = document.getElementById(`wizf_${fieldName}_picker`);
    if (picker) picker.querySelectorAll('.wiz-arbiter-card').forEach(c => c.classList.remove('selected'));
  }

  function updateConditionalFields() {
    document.querySelectorAll('.wiz-field[data-show-field]').forEach(el => {
      const field = el.dataset.showField;
      const value = el.dataset.showValue;
      const show = fieldValues[field] === value;
      el.classList.toggle('wiz-field-hidden', !show);
    });
  }

  function checkShowIf(showIf) {
    return fieldValues[showIf.field] === showIf.value;
  }

  function findFieldDef(name) {
    for (const step of currentWizard.steps) {
      if (step.fields) {
        const f = step.fields.find(fld => fld.name === name);
        if (f) return f;
      }
    }
    return null;
  }

  // ─── Wallet book picker for pubkey fields ──────────
  const pasteMode = {};          // field name → user chose "paste"
  let _pendingAddField = null;   // field waiting for a wallet added via the drawer

  function walletBookList() {
    if (typeof App === 'undefined' || !App.getWalletBook) return [];
    const b = App.getWalletBook();
    return Array.isArray(b) ? b : [];
  }
  function stripNet(a) { return String(a || '').replace(/^kaspa(test)?:/, '').toLowerCase(); }
  function sameKey(w, v) {
    if (!v) return false;
    const x = stripNet(v).replace(/^0x/, '');
    if (stripNet(w.address) === x || String(w.pubkey_hex || '').toLowerCase() === x) return true;
    if (!w.pubkey_hex && typeof App !== 'undefined' && App.kaspaAddressToPubkey) {
      const pk = App.kaspaAddressToPubkey(w.address);
      if (pk && String(pk).toLowerCase() === x) return true;
    }
    return false;
  }
  function shortAddr(a) {
    const s = String(a || '');
    return s.length > 18 ? s.slice(0, 10) + '…' + s.slice(-6) : s;
  }

  function rerenderPubkeyField(fieldName) {
    const f = findFieldDef(fieldName);
    const wrap = document.getElementById(`wizf_${fieldName}_wrap`);
    if (!f || !wrap) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderFieldInput(f);
    const fresh = tmp.firstElementChild;
    wrap.replaceWith(fresh);
    const input = fresh.querySelector('.wiz-input[data-field]');
    if (input) input.addEventListener('input', () => { fieldValues[input.dataset.field] = input.value; });
    const errEl = document.getElementById(`wizferr_${fieldName}`);
    if (errEl) errEl.textContent = '';
  }

  // Item click in the dropdown: (fieldName, walletId), same signature as the deploy form's handler
  function pickWalletId(fieldName, walletId) {
    const w = walletBookList().find(x => x.id === walletId);
    if (!w) return;
    pasteMode[fieldName] = false;
    fieldValues[fieldName] = w.address;
    rerenderPubkeyField(fieldName);
  }

  function pickWallet(fieldName, value) {
    if (value === '__add') {
      _pendingAddField = fieldName;
      document.querySelectorAll('.wallet-dropdown-panel').forEach(p => p.classList.remove('show'));
      document.querySelectorAll('.wallet-dropdown-trigger').forEach(t => t.classList.remove('open'));
      if (typeof App !== 'undefined' && App.openWalletDrawer) App.openWalletDrawer();
      return;
    }
    if (value === '__paste') {
      pasteMode[fieldName] = true;
      fieldValues[fieldName] = '';
      rerenderPubkeyField(fieldName);
      const input = document.getElementById(`wizf_${fieldName}`);
      if (input) input.focus();
    }
  }

  // Called by App after a wallet is saved from the drawer. Returns true when a wizard field took it.
  function walletBookChanged(newWallet) {
    if (!currentWizard) return false;
    const step = currentWizard.steps[currentStep];
    const target = _pendingAddField;
    _pendingAddField = null;
    if (target && newWallet && newWallet.address) {
      pasteMode[target] = false;
      fieldValues[target] = newWallet.address;
    }
    if (step && step.type === 'configure') { captureFieldValues(); renderStepContent(); attachFieldListeners(step); }
    return !!target;
  }

  function validateConfigStep() {
    let valid = true;
    const step = currentWizard.steps[currentStep];
    if (!step.fields) return true;

    captureFieldValues();

    step.fields.forEach(f => {
      const errEl = document.getElementById(`wizferr_${f.name}`);
      if (!errEl) return;
      errEl.textContent = '';

      // Skip hidden fields
      if (f.showIf && !checkShowIf(f.showIf)) return;

      const val = (fieldValues[f.name] || '').trim();

      if (f.validate === 'identifier' && val) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(val)) {
          errEl.textContent = 'Must be a valid identifier (letters, numbers, underscores, start with letter)';
          valid = false;
        }
      }

      // Optional key: blank is fine, anything typed must be a real key
      if (f.validate === 'pubkey_optional' && val && !isValidPubkeyInput(val)) {
        errEl.textContent = 'Enter a valid Kaspa address (kaspa:… / kaspatest:…) or 64-char hex public key, or leave blank';
        valid = false;
      }

      if (f.validate === 'pubkey' || f.type === 'arbiter_picker') {
        if (!val) {
          errEl.textContent = f.type === 'arbiter_picker'
            ? 'Required — select an arbiter or enter a public key manually'
            : 'Required — enter a Kaspa address or 32-byte hex public key';
          valid = false;
        } else if (!isValidPubkeyInput(val)) {
          errEl.textContent = 'Enter a valid Kaspa address (kaspa:… / kaspatest:…) or 64-char hex public key';
          valid = false;
        }
      }
	  
	  if (f.validate === 'pubkey_hash') {
        if (!val || !/^[0-9a-fA-F]{64}$/.test(val)) {
          errEl.textContent = 'Click "Hash it" to compute the BLAKE2b hash from your address';
          valid = false;
        }
      }

      if (f.type === 'number' && val !== undefined && val !== '') {
        if (isNaN(parseInt(val)) || parseInt(val) < 0) {
          errEl.textContent = 'Must be a positive number';
          valid = false;
        }
      }
    });

    return valid;
  }

  // Quick check: is this plausibly a Kaspa address or hex pubkey?
  function isValidPubkeyInput(val) {
    if (!val) return false;
    // Kaspa address (mainnet or testnet)
    if (/^kaspa(test)?:[a-z0-9]{61,63}$/.test(val)) return true;
    // Hex pubkey (with or without 0x prefix), 64 hex chars = 32 bytes
    const hex = val.replace(/^0x/i, '');
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return true;
    return false;
  }

  // ─── Animation ─────────────────────────────────────
  function animateTransition(direction, callback) {
    isAnimating = true;
    const body = document.getElementById('wizMainBody');

    body.classList.add('wiz-slide-out-' + direction);

    setTimeout(() => {
      callback();
      body.classList.remove('wiz-slide-out-' + direction);
      body.classList.add('wiz-slide-in-' + direction);

      setTimeout(() => {
        body.classList.remove('wiz-slide-in-' + direction);
        isAnimating = false;
      }, 200);
    }, 150);
  }

  // ─── Modal Show/Hide ───────────────────────────────
  function showWizardModal() {
    document.getElementById('wizardOverlay').classList.add('visible');
    document.getElementById('wizardModalV2').classList.add('visible');
    // Escape to close
    document._wizEscHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', document._wizEscHandler);
  }

  function closeWizardModal() {
    document.getElementById('wizardOverlay').classList.remove('visible');
    document.getElementById('wizardModalV2').classList.remove('visible');
    if (document._wizEscHandler) {
      document.removeEventListener('keydown', document._wizEscHandler);
      document._wizEscHandler = null;
    }
  }

  // ─── Helpers ───────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Pubkey Hash Calculator ───────────────────────
  function computePubkeyHash(fieldName) {
    const sourceInput = document.getElementById(`wizf_${fieldName}_source`);
    const hiddenInput = document.getElementById(`wizf_${fieldName}`);
    const resultDiv = document.getElementById(`wizf_${fieldName}_result`);
    const hashDisplay = document.getElementById(`wizf_${fieldName}_hashDisplay`);
    const errEl = document.getElementById(`wizferr_${fieldName}`);
    if (!sourceInput) return;

    const raw = sourceInput.value.trim();
    if (!raw) {
      if (errEl) errEl.textContent = 'Enter a Kaspa address or public key first';
      if (resultDiv) resultDiv.style.display = 'none';
      return;
    }
    if (errEl) errEl.textContent = '';

    // Compute hash server-side
    const btn = sourceInput.parentElement.querySelector('.wiz-pkh-calc-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Hashing…'; }

    fetch('/api/blake2b', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: raw })
    })
    .then(res => res.json())
    .then(data => {
      if (btn) { btn.disabled = false; btn.textContent = '#️⃣ Hash it'; }

      if (!data.success) {
        if (errEl) errEl.textContent = data.error || 'Could not compute hash';
        if (resultDiv) resultDiv.style.display = 'none';
        return;
      }

      hiddenInput.value = data.hash;
      fieldValues[fieldName] = data.hash;
      fieldValues[fieldName + '_source'] = raw;

      resultDiv.style.display = '';
      hashDisplay.textContent = data.hash;
    })
    .catch(err => {
      if (btn) { btn.disabled = false; btn.textContent = '#️⃣ Hash it'; }
      if (errEl) errEl.textContent = 'Network error — please try again';
      if (resultDiv) resultDiv.style.display = 'none';
    });
  }

  // ─── Wallet address resolution ─────────────────────
  // Tries multiple sources to get the connected wallet's address:
  //   1. Wallet extension API (freshest — getAccounts / getAccount)
  //   2. KasperoConnect stored user data (currentUser.address)
  //   3. App.getUserPubkey() fallback (may be hex pubkey from JWT)
  async function resolveWalletAddress() {
    try {
      const wallet = typeof localStorage !== 'undefined' ? localStorage.getItem('kc_wallet') : null;
      // Try the wallet extension directly
      if (wallet === 'kasware' && typeof window.kasware !== 'undefined') {
        const accts = await window.kasware.getAccounts();
        if (accts && accts.length > 0) return accts[0];
      }
      if (wallet === 'kastle' && typeof window.kastle !== 'undefined') {
        const info = await window.kastle.getAccount();
        if (info && info.address) return info.address;
      }
      // Fall back to stored user data
      const kcUser = typeof localStorage !== 'undefined' ? localStorage.getItem('kc_user') : null;
      if (kcUser) {
        const parsed = JSON.parse(kcUser);
        if (parsed.address) return parsed.address;
      }
      // Last resort: raw pubkey from App
      if (typeof App !== 'undefined' && App.getUserPubkey) {
        const pk = App.getUserPubkey();
        if (pk) return pk;
      }
    } catch (_) { /* wallet not available — no autofill */ }
    return null;
  }

  // ─── Public API ────────────────────────────────────
  return {
    open, close, next, prev, goToStep,
    generate, selectOption, selectTkasPicker,
    selectArbiter, toggleArbiterManual, arbiterManualInput,
    pickWallet, pickWalletId, walletBookChanged,
	computePubkeyHash
  };
})();
